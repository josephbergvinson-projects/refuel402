import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { NETWORKS, type NetworkName } from "../server/src/config.js";
import { loadSupportCatalog, productContractAddresses } from "../server/src/support.js";
import { encodeExactOutputPath } from "../client/src/txbuilder.js";
import { Mirror } from "../server/src/mirror.js";

const envFile = process.env.CHAIN_PROOF_ENV_FILE;
let proofAccount = process.env.DEMO_USER_EVM_ADDRESS;
if (!proofAccount && envFile) {
  const line = fs.readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("DEMO_USER_EVM_ADDRESS="));
  proofAccount = line?.slice("DEMO_USER_EVM_ADDRESS=".length).trim();
}

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const erc20ReadAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const associatedSelector = "0x4d8fdd6d" as Hex;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error || body.result === undefined) {
    throw new Error(body.error?.message ?? `RPC ${method} failed (${response.status})`);
  }
  return body.result;
}

function hasCode(code: Hex): boolean {
  return code !== "0x" && !/^0x0+$/.test(code);
}

async function codeRecord(url: string, label: string, address: Address) {
  const code = await rpc<Hex>(url, "eth_getCode", [address, "latest"]);
  return { label, address, hasCode: hasCode(code), byteLength: Math.max(0, (code.length - 2) / 2) };
}

async function mirrorJson(base: string, path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`mirror ${path} failed (${response.status})`);
  return response.json();
}

async function networkProof(mode: NetworkName) {
  const network = NETWORKS[mode];
  const catalog = loadSupportCatalog(mode);
  const mirror = new Mirror(network.mirrorBase, network.rpcUrl, network.quoteMirrorBase);
  const productContracts = productContractAddresses(mode);
  const contracts = [
    await codeRecord(network.rpcUrl, "permit2", productContracts.permit2),
    await codeRecord(network.rpcUrl, "x402_exact_proxy", productContracts.proxy),
    await codeRecord(network.rpcUrl, "saucer_v2_router", network.router),
    await codeRecord(network.rpcUrl, "saucer_v2_quoter", network.quoter),
    await codeRecord(network.rpcUrl, "saucer_v2_factory", network.factory),
    await codeRecord(network.rpcUrl, "whbar", network.whbarToken),
  ];
  if (network.v1Router) contracts.push(await codeRecord(network.rpcUrl, "saucer_v1_router", network.v1Router));
  const tokens = [] as Record<string, unknown>[];
  const pools = [] as Record<string, unknown>[];
  const quoteSimulations = [] as Record<string, unknown>[];
  const seenContracts = new Set(contracts.map((row) => row.address.toLowerCase()));
  const seenTokens = new Set<string>();
  const seenPools = new Set<string>();

  for (const asset of catalog.assets.filter((candidate) => candidate.saucer.status === "verified")) {
    const destinationAddress = getAddress(asset.destination.address);
    if (!seenContracts.has(destinationAddress.toLowerCase())) {
      contracts.push(await codeRecord(network.rpcUrl, `${asset.id}:destination`, destinationAddress));
      seenContracts.add(destinationAddress.toLowerCase());
    }
    if (asset.destination.wrapper) {
      const wrapperAddress = getAddress(asset.destination.wrapper.address);
      if (!seenContracts.has(wrapperAddress.toLowerCase())) {
        contracts.push(await codeRecord(network.rpcUrl, `${asset.id}:wrapper`, wrapperAddress));
        seenContracts.add(wrapperAddress.toLowerCase());
      }
    }
    const tokenId = asset.destination.wrapper?.htsTokenId ?? asset.destination.tokenId;
    if (tokenId && !seenTokens.has(tokenId)) {
      const body = await mirrorJson(network.mirrorBase, `/api/v1/tokens/${encodeURIComponent(tokenId)}`) as Record<string, unknown>;
      const customFees = body.custom_fees && typeof body.custom_fees === "object"
        ? Object.values(body.custom_fees as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
        : [];
      tokens.push({
        tokenId,
        symbol: body.symbol ?? null,
        decimals: body.decimals ?? null,
        type: body.type ?? null,
        pauseStatus: body.pause_status ?? null,
        freezeDefault: body.freeze_default ?? null,
        keys: {
          admin: !!body.admin_key,
          kyc: !!body.kyc_key,
          freeze: !!body.freeze_key,
          pause: !!body.pause_key,
          feeSchedule: !!body.fee_schedule_key,
        },
        customFeeCount: customFees.length,
      });
      seenTokens.add(tokenId);
    }

    let current = getAddress(asset.destination.wrapper?.htsAddress ?? asset.destination.address);
    const forwardTokens = [current, ...asset.saucer.route.map((hop) => getAddress(hop.toToken))];
    const venues = new Set(asset.saucer.route.map((hop) => hop.venue ?? "v2"));
    if (venues.size !== 1) throw new Error(`${asset.id} has a mixed-venue route`);
    const venue = [...venues][0] ?? "v2";
    for (let index = 0; index < asset.saucer.route.length; index += 1) {
      const next = forwardTokens[index + 1]!;
      const hop = asset.saucer.route[index]!;
      let pool: Address;
      if (venue === "v1") {
        const contractId = String(hop.contractId ?? "");
        const contractNumber = contractId.match(/^0\.0\.(\d+)$/)?.[1];
        if (!contractNumber) throw new Error(`${asset.id} V1 route is missing a numeric pool contract id`);
        pool = getAddress(toHex(BigInt(contractNumber), { size: 20 }));
      } else {
        const data = encodeFunctionData({
          abi: factoryAbi,
          functionName: "getPool",
          args: [current, next, hop.fee],
        });
        const result = await rpc<Hex>(network.rpcUrl, "eth_call", [{ to: network.factory, data }, "latest"]);
        pool = getAddress(decodeFunctionResult({ abi: factoryAbi, functionName: "getPool", data: result }));
      }
      if (!seenPools.has(pool.toLowerCase())) {
        const code = await codeRecord(network.rpcUrl, `${asset.id}:${venue}:pool:${index}`, pool);
        pools.push({ ...code, venue, tokenA: current, tokenB: next, fee: hop.fee, contractId: hop.contractId ?? null });
        seenPools.add(pool.toLowerCase());
      }
      current = next;
    }

    try {
      const quote = venue === "v1"
        ? await mirror.quoteV1ExactOutput(network.v1Router!, forwardTokens, 100_000_000n)
        : await mirror.quoteExactOutput(
            network.quoter,
            encodeExactOutputPath(forwardTokens, asset.saucer.route.map((hop) => hop.fee)),
            100_000_000n,
          );
      quoteSimulations.push({
        assetId: asset.id,
        venue,
        exactOutputTinybar: "100000000",
        amountIn: quote.amountIn.toString(),
        gasEstimate: quote.gasEstimate.toString(),
        ok: true,
      });
    } catch (error) {
      quoteSimulations.push({
        assetId: asset.id,
        venue,
        ok: false,
        reason: error instanceof Error ? error.message : "quote simulation failed",
      });
    }
  }

  const accountAddress = proofAccount;
  let account: Record<string, unknown> | null = null;
  if (accountAddress && /^0x[0-9a-fA-F]{40}$/.test(accountAddress)) {
    const address = getAddress(accountAddress);
    const fingerprint = createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 12);
    const mirrorAccount = await mirror.account(address);
    const associations = await mirrorJson(
      network.mirrorBase,
      `/api/v1/accounts/${encodeURIComponent(address)}/tokens?limit=100`,
    ).catch(() => null) as { tokens?: unknown[] } | null;
    const whbarBalanceData = encodeFunctionData({ abi: erc20ReadAbi, functionName: "balanceOf", args: [address] });
    const whbarBalance = await rpc<Hex>(network.rpcUrl, "eth_call", [
      { to: network.whbarToken, data: whbarBalanceData },
      "latest",
    ]).catch(() => null);
    const associated = await rpc<Hex>(network.rpcUrl, "eth_call", [
      { from: address, to: network.whbarToken, data: associatedSelector },
      "latest",
    ]).catch(() => null);
    account = {
      addressFingerprint: fingerprint,
      exists: !!mirrorAccount,
      accountId: mirrorAccount?.account ?? null,
      evmAliasMatches: mirrorAccount?.evm_address
        ? String(mirrorAccount.evm_address).toLowerCase() === address.toLowerCase()
        : null,
      keyPresent: !!mirrorAccount?.key,
      balancePositive: mirrorAccount ? BigInt(mirrorAccount.balance.balance) > 0n : false,
      associationCount: associations?.tokens?.length ?? null,
      whbarBalanceCallSucceeded: whbarBalance !== null,
      whbarAssociationCallSucceeded: associated !== null,
      whbarAssociated: associated ? BigInt(associated) === 1n : null,
    };
  }

  return {
    mode,
    chainId: network.chainId,
    contracts,
    pools,
    tokens,
    quoteSimulations,
    account,
  };
}

const proof = {
  schema: "refuel402.chain-readonly-proof.v1",
  checkedAt: new Date().toISOString(),
  nonMutating: true,
  networks: await Promise.all([networkProof("testnet"), networkProof("mainnet")]),
};
console.log(JSON.stringify(proof, null, 2));
if (proof.networks.some((network) =>
  network.contracts.some((contract) =>
    ["saucer_v1_router", "saucer_v2_router", "saucer_v2_quoter", "saucer_v2_factory", "whbar"].includes(contract.label) && !contract.hasCode,
  ) || network.pools.some((pool) => !pool.hasCode)
)) process.exitCode = 1;
