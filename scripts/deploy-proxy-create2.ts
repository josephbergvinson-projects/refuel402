import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  formatEther,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roleEnvFile = process.env.REFUEL402_ROLE_ENV_FILE;
if (roleEnvFile) dotenv.config({ path: roleEnvFile, override: false });
const execute = process.argv.includes("--execute");
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : null;
const modeIndex = process.argv.indexOf("--mode");
const modeRaw = modeIndex >= 0 ? process.argv[modeIndex + 1] : "testnet";
if (modeRaw !== "testnet" && modeRaw !== "mainnet") throw new Error("--mode must be testnet or mainnet");
const mode = modeRaw;
const suffix = mode === "mainnet" ? "MAINNET" : "TESTNET";
const rpcUrl = mode === "mainnet"
  ? process.env.MAINNET_RPC_URL ?? "https://mainnet.hashio.io/api"
  : process.env.FACILITATOR_RPC_URL ?? process.env.TESTNET_RPC_URL ?? "https://testnet.hashio.io/api";
const chainId = mode === "mainnet" ? 295 : 296;
const chain = defineChain({
  id: chainId,
  name: mode === "mainnet" ? "Hedera Mainnet" : "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const factory = getAddress(process.env.CREATE2_FACTORY_ADDRESS ?? "0x4e59b44847b379578588920cA78FbF26c0B4956C");
const canonicalFactoryRuntime = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as Hex;
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "artifacts", "Refuel402ExactPermit2Proxy.json"), "utf8")) as {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};
const deploymentsPath = path.join(root, "contracts", "deployments.json");
const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8")) as any;
const config = deployments.networks[mode];
const permit2 = getAddress(config.permit2);
const facilitator = getAddress(process.env.FACILITATOR_EVM_ADDRESS ?? process.env[`REFUEL402_${suffix}_FACILITATOR_EVM_ADDRESS`] ?? "");
const paymentRecipient = getAddress(process.env.X402_PAYMENT_RECIPIENT ?? process.env[`REFUEL402_${suffix}_SPONSOR_EVM_ADDRESS`] ?? "");
const deployerAddress = getAddress(process.env[`REFUEL402_${suffix}_DEPLOYER_EVM_ADDRESS`] ?? "");
const salt = config.create2Salt as Hex;
const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [permit2, facilitator] });
const initCodeHash = keccak256(initCode);
const expectedAddress = getCreate2Address({ from: factory, salt, bytecodeHash: initCodeHash });

function expectedRuntimeBytecode(): Hex {
  let hex = artifact.deployedBytecode.slice(2);
  const values: Record<string, Address> = { permit2, facilitator };
  for (const [name, refs] of Object.entries(artifact.immutableReferences)) {
    const value = values[name];
    if (!value) throw new Error(`unmapped immutable reference: ${name}`);
    const word = value.slice(2).toLowerCase().padStart(64, "0");
    for (const ref of refs) {
      if (ref.length !== 32) throw new Error(`unsupported immutable length for ${name}`);
      const start = ref.start * 2;
      hex = `${hex.slice(0, start)}${word}${hex.slice(start + ref.length * 2)}`;
    }
  }
  return `0x${hex}` as Hex;
}

const expectedRuntime = expectedRuntimeBytecode();
const expectedRuntimeHash = keccak256(expectedRuntime);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }) });
const [factoryCode, permit2Code, existingCode, deployerBalance] = await Promise.all([
  publicClient.getCode({ address: factory }),
  publicClient.getCode({ address: permit2 }),
  publicClient.getCode({ address: expectedAddress }),
  publicClient.getBalance({ address: deployerAddress }),
]);
if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== keccak256(canonicalFactoryRuntime)) {
  throw new Error("CREATE2 factory runtime does not match the canonical deterministic deployment proxy");
}
const permit2RuntimePresent = !!permit2Code && permit2Code !== "0x";
if (!permit2RuntimePresent && execute) throw new Error(`Permit2 runtime is absent on Hedera ${mode}`);

const baseProof: Record<string, unknown> = {
  schema: "refuel402.proxy-create2-proof.v1",
  checkedAt: new Date().toISOString(),
  mode,
  chainId,
  executeRequested: execute,
  factory: {
    address: factory,
    runtimeHash: keccak256(factoryCode),
    canonicalRuntimeHash: keccak256(canonicalFactoryRuntime),
    verified: true,
  },
  constructor: { permit2, permit2RuntimePresent, facilitator },
  paymentRecipient,
  deployer: { address: deployerAddress, balanceHbar: formatEther(deployerBalance) },
  create2: { salt, initCodeHash, expectedAddress },
  runtime: { expectedHash: expectedRuntimeHash, byteLength: (expectedRuntime.length - 2) / 2 },
  transactionBudget: {
    maxGas: Number(process.env.PROXY_DEPLOY_MAX_GAS ?? 3_500_000),
    maxHbar: process.env.PROXY_DEPLOY_MAX_HBAR ?? "20",
  },
};

async function verify(address: Address) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") return { deployed: false };
  const [livePermit2, liveFacilitator] = await Promise.all([
    publicClient.readContract({ address, abi: artifact.abi, functionName: "permit2" }) as Promise<Address>,
    publicClient.readContract({ address, abi: artifact.abi, functionName: "facilitator" }) as Promise<Address>,
  ]);
  const runtimeHash = keccak256(code);
  return {
    deployed: true,
    runtimeHash,
    runtimeMatches: runtimeHash === expectedRuntimeHash,
    permit2: getAddress(livePermit2),
    permit2Matches: getAddress(livePermit2) === permit2,
    facilitator: getAddress(liveFacilitator),
    facilitatorMatches: getAddress(liveFacilitator) === facilitator,
  };
}

let proof: Record<string, unknown>;
if (existingCode && existingCode !== "0x") {
  const readback = await verify(expectedAddress);
  if (!readback.runtimeMatches || !readback.permit2Matches || !readback.facilitatorMatches) {
    const mismatchProof = { ...baseProof, state: "existing_readback_mismatch", readback };
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(mismatchProof, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(JSON.stringify(mismatchProof, null, 2));
    process.exit(2);
  }
  proof = { ...baseProof, state: "already_deployed_verified", readback };
} else if (!execute) {
  proof = { ...baseProof, state: "planned_not_submitted", readback: { deployed: false } };
} else {
  const rawPrivateKey = process.env[`REFUEL402_${suffix}_DEPLOYER_PRIVATE_KEY`];
  const normalizedPrivateKey = rawPrivateKey
    ? PrivateKey.fromStringECDSA(rawPrivateKey.replace(/^0x/, "")).toStringRaw()
    : undefined;
  const privateKey = normalizedPrivateKey ? `0x${normalizedPrivateKey}` as Hex : undefined;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error(`${mode} deployer private key is unavailable`);
  const account = privateKeyToAccount(privateKey);
  if (account.address !== deployerAddress) throw new Error(`${mode} deployer private key does not match the bound deployer address`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 20_000 }) });
  const data = concatHex([salt, initCode]);
  const estimatedGas = await publicClient.estimateGas({ account: deployerAddress, to: factory, data });
  const maxGas = BigInt(process.env.PROXY_DEPLOY_MAX_GAS ?? 3_500_000);
  if (estimatedGas > maxGas) throw new Error("CREATE2 deployment gas estimate exceeds the manifest cap");
  const gasPrice = await publicClient.getGasPrice();
  const maximumCost = estimatedGas * gasPrice;
  const maximumHbar = BigInt(Math.floor(Number(process.env.PROXY_DEPLOY_MAX_HBAR ?? "20") * 1e8)) * 10n ** 10n;
  if (maximumCost > maximumHbar || maximumCost > deployerBalance) {
    throw new Error("CREATE2 deployment exceeds the HBAR transaction budget or deployer balance");
  }
  const transactionHash = await wallet.sendTransaction({ to: factory, data, gas: estimatedGas });
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1, timeout: 120_000 });
  } catch {
    throw new Error(`CREATE2_DEPLOYMENT_OUTCOME_UNKNOWN:${transactionHash}`);
  }
  if (receipt.status !== "success") throw new Error(`CREATE2_DEPLOYMENT_REVERTED:${transactionHash}`);
  const readback = await verify(expectedAddress);
  if (!readback.runtimeMatches || !readback.permit2Matches || !readback.facilitatorMatches) {
    throw new Error(`CREATE2_DEPLOYMENT_READBACK_FAILED:${transactionHash}`);
  }
  proof = {
    ...baseProof,
    state: "deployed_verified",
    transaction: {
      hash: transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    },
    readback,
  };
}

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(proof, null, 2));
