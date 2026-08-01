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
  encodeAbiParameters,
  formatEther,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  padHex,
  stringToHex,
  toHex,
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
const chainId = 295;
const rpcUrl = process.env.MAINNET_RPC_URL ?? "https://mainnet.hashio.io/api";
const chain = defineChain({
  id: chainId,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const factory = getAddress(process.env.CREATE2_FACTORY_ADDRESS ?? "0x4e59b44847b379578588920cA78FbF26c0B4956C");
const canonicalFactoryRuntime = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as Hex;
const canonicalCreationHash = "0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8" as Hex;
const canonicalPermit2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "artifacts", "Permit2.json"), "utf8")) as {
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
  sourceCommit: string;
  compiler: Record<string, unknown>;
};
if (keccak256(artifact.bytecode) !== canonicalCreationHash) {
  throw new Error("Permit2 creation bytecode does not match the canonical verified artifact");
}
const references = Object.values(artifact.immutableReferences).flat().sort((left, right) => left.start - right.start);
if (
  references.length !== 2 ||
  references[0]?.start !== 6945 ||
  references[1]?.start !== 6983 ||
  references.some((reference) => reference.length !== 32)
) {
  throw new Error("Permit2 immutable reference layout differs from the verified artifact");
}
const salt = (process.env.PERMIT2_CREATE2_SALT ?? keccak256(stringToHex("refuel402-permit2-hedera-mainnet-v1"))) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("Permit2 CREATE2 salt is invalid");
const expectedAddress = getCreate2Address({ from: factory, salt, bytecodeHash: canonicalCreationHash });
const typeHash = keccak256(stringToHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
const nameHash = keccak256(stringToHex("Permit2"));
const domainSeparator = keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
  [typeHash, nameHash, BigInt(chainId), expectedAddress],
));
function patchWord(runtime: Hex, start: number, value: Hex): Hex {
  const raw = runtime.slice(2);
  const replacement = padHex(value, { size: 32 }).slice(2);
  const offset = start * 2;
  return `0x${raw.slice(0, offset)}${replacement}${raw.slice(offset + 64)}` as Hex;
}
let expectedRuntime = patchWord(artifact.deployedBytecode, references[0]!.start, toHex(BigInt(chainId)));
expectedRuntime = patchWord(expectedRuntime, references[1]!.start, domainSeparator);
const expectedRuntimeHash = keccak256(expectedRuntime);
const deployerAddress = getAddress(process.env.REFUEL402_MAINNET_DEPLOYER_EVM_ADDRESS ?? "");
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }) });
const [factoryCode, canonicalCode, expectedCode, deployerBalance] = await Promise.all([
  publicClient.getCode({ address: factory }),
  publicClient.getCode({ address: canonicalPermit2 }),
  publicClient.getCode({ address: expectedAddress }),
  publicClient.getBalance({ address: deployerAddress }),
]);
if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== keccak256(canonicalFactoryRuntime)) {
  throw new Error("CREATE2 factory runtime does not match the canonical deterministic deployment proxy");
}
if (canonicalCode && canonicalCode !== "0x") {
  throw new Error("canonical Permit2 address now has code; verify and reuse it instead of deploying a custom address");
}
const baseProof = {
  schema: "refuel402.permit2-create2-proof.v1",
  checkedAt: new Date().toISOString(),
  mode: "mainnet",
  chainId,
  executeRequested: execute,
  sourceCommit: artifact.sourceCommit,
  compiler: artifact.compiler,
  factory: {
    address: factory,
    runtimeHash: keccak256(factoryCode),
    canonicalRuntimeHash: keccak256(canonicalFactoryRuntime),
    verified: true,
  },
  canonicalAddress: { address: canonicalPermit2, codePresent: false },
  deployer: { address: deployerAddress, balanceHbar: formatEther(deployerBalance) },
  create2: { salt, initCodeHash: canonicalCreationHash, expectedAddress },
  runtime: {
    expectedHash: expectedRuntimeHash,
    byteLength: (expectedRuntime.length - 2) / 2,
    chainIdImmutable: chainId,
    domainSeparatorImmutable: domainSeparator,
  },
  transactionBudget: {
    maxGas: Number(process.env.PERMIT2_DEPLOY_MAX_GAS ?? 15_000_000),
    maxHbar: process.env.PERMIT2_DEPLOY_MAX_HBAR ?? "25",
  },
};
async function verify(code: Hex | undefined) {
  if (!code || code === "0x") return { deployed: false };
  return {
    deployed: true,
    runtimeHash: keccak256(code),
    runtimeMatches: keccak256(code) === expectedRuntimeHash,
  };
}
let proof: Record<string, unknown>;
if (expectedCode && expectedCode !== "0x") {
  const readback = await verify(expectedCode);
  if (!readback.runtimeMatches) throw new Error("existing Permit2 CREATE2 target runtime differs from the expected artifact");
  proof = { ...baseProof, state: "already_deployed_verified", readback };
} else if (!execute) {
  proof = { ...baseProof, state: "planned_not_submitted", readback: { deployed: false } };
} else {
  const rawPrivateKey = process.env.REFUEL402_MAINNET_DEPLOYER_PRIVATE_KEY;
  const normalizedPrivateKey = rawPrivateKey
    ? PrivateKey.fromStringECDSA(rawPrivateKey.replace(/^0x/, "")).toStringRaw()
    : undefined;
  const privateKey = normalizedPrivateKey ? `0x${normalizedPrivateKey}` as Hex : undefined;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("mainnet deployer private key is unavailable");
  const account = privateKeyToAccount(privateKey);
  if (account.address !== deployerAddress) throw new Error("mainnet deployer private key does not match the bound deployer address");
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 20_000 }) });
  const data = concatHex([salt, artifact.bytecode]);
  const estimatedGas = await publicClient.estimateGas({ account: deployerAddress, to: factory, data });
  const maxGas = BigInt(process.env.PERMIT2_DEPLOY_MAX_GAS ?? 15_000_000);
  if (estimatedGas > maxGas) throw new Error("Permit2 CREATE2 deployment gas estimate exceeds the manifest cap");
  const gasPrice = await publicClient.getGasPrice();
  const maximumCost = estimatedGas * gasPrice;
  const maximumHbar = BigInt(Math.floor(Number(process.env.PERMIT2_DEPLOY_MAX_HBAR ?? "25") * 1e8)) * 10n ** 10n;
  if (maximumCost > maximumHbar || maximumCost > deployerBalance) {
    throw new Error("Permit2 CREATE2 deployment exceeds the HBAR transaction budget or deployer balance");
  }
  const transactionHash = await wallet.sendTransaction({ to: factory, data, gas: estimatedGas });
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1, timeout: 180_000 });
  } catch {
    throw new Error(`PERMIT2_DEPLOYMENT_OUTCOME_UNKNOWN:${transactionHash}`);
  }
  if (receipt.status !== "success") throw new Error(`PERMIT2_DEPLOYMENT_REVERTED:${transactionHash}`);
  const readback = await verify(await publicClient.getCode({ address: expectedAddress }));
  if (!readback.runtimeMatches) throw new Error(`PERMIT2_DEPLOYMENT_READBACK_FAILED:${transactionHash}`);
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
