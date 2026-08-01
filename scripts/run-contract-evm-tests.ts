import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainRelative = "contracts/Refuel402ExactPermit2Proxy.sol";
const harnessRelative = "contracts/test/Refuel402ExactPermit2ProxyHarness.sol";
const compilerPackage = "solc@0.8.28";

function compile() {
  const input = {
    language: "Solidity",
    sources: {
      [mainRelative]: { content: fs.readFileSync(path.join(root, mainRelative), "utf8") },
      [harnessRelative]: { content: fs.readFileSync(path.join(root, harnessRelative), "utf8") },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      metadata: { bytecodeHash: "none", appendCBOR: false },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const result = spawnSync(
    "npm",
    ["exec", "--yes", `--package=${compilerPackage}`, "--", "solcjs", "--standard-json"],
    { cwd: root, input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`solcjs failed: ${result.stderr || result.stdout}`);
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart < 0) throw new Error("solcjs returned no JSON output");
  const output = JSON.parse(result.stdout.slice(jsonStart));
  const errors = (output.errors ?? []).filter((entry: any) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry: any) => entry.formattedMessage ?? entry.message).join("\n"));
  return output.contracts as Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
}

const compiled = compile();
function contract(source: string, name: string) {
  const value = compiled[source]?.[name];
  if (!value?.abi || !value.evm?.bytecode?.object) throw new Error(`missing compiler output for ${name}`);
  return { abi: value.abi, bytecode: `0x${value.evm.bytecode.object}` as Hex };
}

const proxyArtifact = contract(mainRelative, "Refuel402ExactPermit2Proxy");
const tokenArtifact = contract(harnessRelative, "MockRefuelToken");
const permit2Artifact = contract(harnessRelative, "MockPermit2");
const wrapperArtifact = contract(harnessRelative, "MockRefuelWrapper");
const routerArtifact = contract(harnessRelative, "MockExactOutputRouter");
const trackedArtifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/artifacts/Refuel402ExactPermit2Proxy.json"), "utf8"));
if (trackedArtifact.bytecode.toLowerCase() !== proxyArtifact.bytecode.toLowerCase()) {
  throw new Error("executable EVM test bytecode differs from the tracked compiled proxy artifact; run contracts:compile first");
}
if (JSON.stringify(trackedArtifact.abi) !== JSON.stringify(proxyArtifact.abi)) {
  throw new Error("executable EVM test ABI differs from the tracked compiled proxy artifact");
}

const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("no fixture port"));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const anvil = spawn(path.join(root, "node_modules", ".bin", "anvil"), [
  "--host", "127.0.0.1",
  "--port", String(port),
  "--chain-id", "296",
  "--hardfork", "cancun",
  "--silent",
], { cwd: root, stdio: "ignore" });
const stopAnvil = () => { if (!anvil.killed) anvil.kill("SIGTERM"); };
process.once("exit", stopAnvil);
process.once("SIGINT", () => { stopAnvil(); process.exit(130); });
process.once("SIGTERM", () => { stopAnvil(); process.exit(143); });
const rpcUrl = `http://127.0.0.1:${port}`;
for (let attempt = 0; ; attempt += 1) {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (response.ok) break;
  } catch {}
  if (attempt === 99) throw new Error("anvil EVM fixture did not start");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const chain = defineChain({
  id: 296,
  name: "Refuel402 EVM fixture",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ chain, transport });
const accounts = await walletClient.getAddresses();
const [deployer, owner, relayer, facilitator] = accounts.map((account) => getAddress(account.toLowerCase()));
if (!deployer || !owner || !relayer || !facilitator) throw new Error("anvil fixture accounts unavailable");

async function deploy(artifact: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = [], value = 0n): Promise<Address> {
  const hash = await walletClient.deployContract({
    account: deployer,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    value,
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("fixture deployment failed");
  return receipt.contractAddress;
}

async function write(input: {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
  value?: bigint;
}) {
  const hash = await walletClient.writeContract({
    ...input,
    account: input.account ?? deployer,
    args: input.args ?? [],
    gas: 12_000_000n,
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${input.functionName} reverted unexpectedly`);
  return receipt;
}

async function expectRevert(input: Parameters<typeof write>[0], label: string) {
  const hash = await walletClient.writeContract({
    ...input,
    account: input.account ?? deployer,
    args: input.args ?? [],
    gas: 12_000_000n,
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "reverted") throw new Error(`${label} did not revert`);
}

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return publicClient.readContract({ address, abi, functionName, args } as any) as Promise<T>;
}

function exactOutputPath(output: Address, input: Address, fee = 3_000): Hex {
  return concatHex([output, toHex(fee, { size: 3 }), input]);
}

function permit(token: Address, amount: bigint, nonce: bigint, deadline: bigint) {
  return { permitted: { token, amount }, nonce, deadline };
}

function authorization(input: {
  token: Address;
  maxAmountIn: bigint;
  exactHbarTinybar: bigint;
  serviceFeeAmount: bigint;
  journeyNonce: bigint;
  deadline: bigint;
  routeHash: Hex;
}) {
  return { owner, recipient: owner, ...input };
}

async function tokenBalance(token: Address, account: Address) {
  return read<bigint>(token, tokenArtifact.abi, "balanceOf", [account]);
}

async function prepareToken(name: string, symbol: string) {
  return deploy(tokenArtifact, [name, symbol]);
}

async function fundRouter(router: Address, amount: bigint, delivery: bigint) {
  await write({ address: router, abi: routerArtifact.abi, functionName: "setExecution", args: [amount, delivery, false], value: 1_000_000n });
}

const permit2 = await deploy(permit2Artifact);
const whbar = await prepareToken("Wrapped HBAR", "WHBAR");
const deadline = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
const proofs: Record<string, unknown> = {};

// Direct HTS route: the same token is both raw input and router input. A one-unit
// unsolicited balance must survive untouched while the current call's delta is
// charged, swapped and refunded.
{
  const token = await prepareToken("Direct HTS", "DHTS");
  const router = await deploy(routerArtifact, [token], 1_000_000n);
  const proxy = await deploy(proxyArtifact, [permit2, facilitator]);
  await write({ address: token, abi: tokenArtifact.abi, functionName: "mint", args: [owner, 1_001n] });
  await write({ address: token, abi: tokenArtifact.abi, functionName: "transfer", args: [proxy, 1n], account: owner });
  await write({ address: token, abi: tokenArtifact.abi, functionName: "approve", args: [permit2, 1_000n], account: owner });
  await fundRouter(router, 700n, 100n);
  const route = { wrapper: "0x0000000000000000000000000000000000000000", htsToken: token, router, whbar, wrapperRate: 1n, swapPath: exactOutputPath(whbar, token) };
  const routeHash = await read<Hex>(proxy, proxyArtifact.abi, "refuelRouteHash", [route]);
  const auth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 1n, deadline, routeHash });
  const ownerHbarBefore = await publicClient.getBalance({ address: owner });
  const receipt = await write({
    address: proxy,
    abi: proxyArtifact.abi,
    functionName: "executeRefuel",
    args: [auth, permit(token, 1_000n, 1n, deadline), route, 900n, 900n, "0x"],
    account: relayer,
  });
  const events = parseEventLogs({ abi: proxyArtifact.abi, logs: receipt.logs, eventName: "RefuelExecuted" });
  const event = events[0]?.args as any;
  if (!event || event.spent !== 800n || event.refunded !== 200n || event.hbarDelivered !== 100n) {
    throw new Error("direct-route RefuelExecuted accounting mismatch");
  }
  if (
    await tokenBalance(token, proxy) !== 1n ||
    await tokenBalance(token, owner) !== 200n ||
    await tokenBalance(token, facilitator) !== 100n ||
    await tokenBalance(token, router) !== 700n ||
    (await publicClient.getBalance({ address: owner })) - ownerHbarBefore !== 100n
  ) throw new Error("direct-route donation/refund/conservation proof failed");
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [auth, permit(token, 1_000n, 1n, deadline), route, 900n, 900n, "0x"], account: relayer }, "refuel replay");
  proofs.directDonation = { preexistingRaw: "1", spent: "800", refunded: "200", exactHbarDelivered: "100", proxyBalanceAfter: "1", replayRejected: true };

  // Revert atomicity: below-minimum HBAR reverts after the token pull/swap path,
  // but consumed state and every balance return to their pre-call values.
  await write({ address: token, abi: tokenArtifact.abi, functionName: "mint", args: [owner, 1_000n] });
  await write({ address: token, abi: tokenArtifact.abi, functionName: "approve", args: [permit2, 1_000n], account: owner });
  await write({ address: router, abi: routerArtifact.abi, functionName: "setExecution", args: [700n, 99n, false] });
  const atomicAuth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 2n, deadline, routeHash });
  const atomicId = await read<Hex>(proxy, proxyArtifact.abi, "refuelAuthorizationId", [atomicAuth]);
  const before = {
    owner: await tokenBalance(token, owner),
    proxy: await tokenBalance(token, proxy),
    facilitator: await tokenBalance(token, facilitator),
    router: await tokenBalance(token, router),
  };
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [atomicAuth, permit(token, 1_000n, 2n, deadline), route, 900n, 900n, "0x"], account: relayer }, "minimum HBAR delivery");
  const after = {
    owner: await tokenBalance(token, owner),
    proxy: await tokenBalance(token, proxy),
    facilitator: await tokenBalance(token, facilitator),
    router: await tokenBalance(token, router),
  };
  if (JSON.stringify(before, (_key, value) => typeof value === "bigint" ? value.toString() : value) !== JSON.stringify(after, (_key, value) => typeof value === "bigint" ? value.toString() : value)) {
    throw new Error("reverted refuel changed token balances");
  }
  if (await read<boolean>(proxy, proxyArtifact.abi, "consumedRefuelAuthorizations", [atomicId])) {
    throw new Error("reverted refuel consumed its authorization");
  }
  proofs.revertAtomicity = { belowMinimumRejected: true, consumed: false, balancesUnchanged: true };

  const expiredAuth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 3n, deadline: 1n, routeHash });
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [expiredAuth, permit(token, 1_000n, 3n, 1n), route, 900n, 900n, "0x"], account: relayer }, "expired authorization");
  const changedRoute = { ...route, swapPath: exactOutputPath(whbar, token, 500) };
  const routeMismatchAuth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 4n, deadline, routeHash });
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [routeMismatchAuth, permit(token, 1_000n, 4n, deadline), changedRoute, 900n, 900n, "0x"], account: relayer }, "route binding");
  const feeAuth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 1_000n, journeyNonce: 5n, deadline, routeHash });
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [feeAuth, permit(token, 1_000n, 5n, deadline), route, 900n, 900n, "0x"], account: relayer }, "fee cap");
  const capAuth = authorization({ token, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 6n, deadline, routeHash });
  await expectRevert({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [capAuth, permit(token, 999n, 6n, deadline), route, 900n, 900n, "0x"], account: relayer }, "permit cap");
  proofs.guards = { deadline: true, routeBinding: true, serviceFeeCap: true, permitCap: true };
}

// Wrapper route: one raw-token unit and one wrapped-HTS unit are present before
// the call. Both baselines must remain exactly intact after wrap/swap/refund.
{
  const raw = await prepareToken("Raw", "RAW");
  const hts = await prepareToken("Wrapped HTS", "WHTS");
  const wrapper = await deploy(wrapperArtifact, [raw, hts, 2n]);
  const router = await deploy(routerArtifact, [hts], 1_000_000n);
  const proxy = await deploy(proxyArtifact, [permit2, facilitator]);
  await write({ address: raw, abi: tokenArtifact.abi, functionName: "mint", args: [owner, 1_001n] });
  await write({ address: hts, abi: tokenArtifact.abi, functionName: "mint", args: [owner, 1n] });
  await write({ address: raw, abi: tokenArtifact.abi, functionName: "transfer", args: [proxy, 1n], account: owner });
  await write({ address: hts, abi: tokenArtifact.abi, functionName: "transfer", args: [proxy, 1n], account: owner });
  await write({ address: raw, abi: tokenArtifact.abi, functionName: "approve", args: [permit2, 1_000n], account: owner });
  await fundRouter(router, 300n, 100n);
  const route = { wrapper, htsToken: hts, router, whbar, wrapperRate: 2n, swapPath: exactOutputPath(whbar, hts) };
  const routeHash = await read<Hex>(proxy, proxyArtifact.abi, "refuelRouteHash", [route]);
  const auth = authorization({ token: raw, maxAmountIn: 1_000n, exactHbarTinybar: 100n, serviceFeeAmount: 100n, journeyNonce: 20n, deadline, routeHash });
  const receipt = await write({ address: proxy, abi: proxyArtifact.abi, functionName: "executeRefuel", args: [auth, permit(raw, 1_000n, 20n, deadline), route, 800n, 400n, "0x"], account: relayer });
  const event = parseEventLogs({ abi: proxyArtifact.abi, logs: receipt.logs, eventName: "RefuelExecuted" })[0]?.args as any;
  if (!event || event.spent !== 700n || event.refunded !== 300n || event.hbarDelivered !== 100n) {
    throw new Error("wrapper-route RefuelExecuted accounting mismatch");
  }
  const wrapperBalances = {
    proxyRaw: await tokenBalance(raw, proxy),
    proxyHts: await tokenBalance(hts, proxy),
    ownerRaw: await tokenBalance(raw, owner),
    ownerHts: await tokenBalance(hts, owner),
    facilitatorRaw: await tokenBalance(raw, facilitator),
    routerHts: await tokenBalance(hts, router),
  };
  if (
    wrapperBalances.proxyRaw !== 1n ||
    wrapperBalances.proxyHts !== 1n ||
    wrapperBalances.ownerRaw !== 100n ||
    wrapperBalances.ownerHts !== 100n ||
    wrapperBalances.facilitatorRaw !== 100n ||
    wrapperBalances.routerHts !== 300n
  ) throw new Error(`wrapper-route donation/refund/conservation proof failed: ${JSON.stringify(wrapperBalances, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`);
  proofs.wrapperDonation = { preexistingRaw: "1", preexistingHts: "1", spent: "700", refunded: "300", proxyRawAfter: "1", proxyHtsAfter: "1", noNewProxyDust: true };
}

stopAnvil();
console.log(JSON.stringify({
  ok: true,
  schema: "refuel402.contract-evm-proof.v1",
  chainId: 296,
  exactTrackedBytecode: true,
  exactTrackedInterface: true,
  proofs,
}, null, 2));
