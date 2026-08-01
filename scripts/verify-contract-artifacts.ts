import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeDeployData, getAddress, keccak256, type Abi, type Hex } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "contracts", "Refuel402ExactPermit2Proxy.sol");
const deploymentPath = path.join(root, "contracts", "deployments.json");
const artifactPath = process.argv.includes("--artifact")
  ? path.resolve(process.argv[process.argv.indexOf("--artifact") + 1] ?? "")
  : path.join(root, "contracts", "artifacts", "Refuel402ExactPermit2Proxy.json");
const sourceOnly = process.argv.includes("--source-only");

const source = fs.readFileSync(sourcePath);
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as Record<string, any>;
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
const result: Record<string, unknown> = {
  schema: "refuel402.contract-artifact-proof.v1",
  contract: "Refuel402ExactPermit2Proxy",
  sourceSha256,
  compiler: deployment.compiler,
  bytecodeVerified: false,
  deployments: Object.fromEntries(Object.entries(deployment.networks).map(([mode, config]: [string, any]) => [mode, {
    chainId: config.chainId,
    permit2: getAddress(config.permit2),
    proxy: getAddress(config.proxy),
    permit2State: config.permit2State,
    proxyState: config.proxyState,
    facilitatorConfigured: !!config.facilitator,
    create2Salt: config.create2Salt,
  }])),
  liveDeploymentAuthorized: false,
};

if (fs.existsSync(artifactPath)) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi?: Abi;
    bytecode?: Hex | { object?: string };
    deployedBytecode?: Hex | { object?: string };
    metadata?: string;
    compiler?: { version?: string };
    sourceSha256?: string;
  };
  const bytecode = typeof artifact.bytecode === "string"
    ? artifact.bytecode
    : artifact.bytecode?.object ? `0x${artifact.bytecode.object.replace(/^0x/, "")}` as Hex : null;
  const deployedBytecode = typeof artifact.deployedBytecode === "string"
    ? artifact.deployedBytecode
    : artifact.deployedBytecode?.object ? `0x${artifact.deployedBytecode.object.replace(/^0x/, "")}` as Hex : null;
  if (!artifact.abi || !bytecode || bytecode === "0x" || !deployedBytecode || deployedBytecode === "0x") {
    throw new Error("compiled contract artifact is missing ABI or bytecode");
  }
  if (artifact.sourceSha256 && artifact.sourceSha256 !== sourceSha256) {
    throw new Error("compiled artifact source hash does not match the canonical Solidity source");
  }
  const constructors = Object.fromEntries(Object.entries(deployment.networks).map(([mode, config]: [string, any]) => {
    if (!config.facilitator) return [mode, { ready: false, reason: "FACILITATOR_ADDRESS_NOT_CONFIGURED" }];
    const data = encodeDeployData({
      abi: artifact.abi!,
      bytecode,
      args: [getAddress(config.permit2), getAddress(config.facilitator)],
    });
    return [mode, {
      ready: true,
      initCodeHash: keccak256(data),
      runtimeBytecodeHash: keccak256(deployedBytecode),
      permit2: getAddress(config.permit2),
      facilitator: getAddress(config.facilitator),
    }];
  }));
  Object.assign(result, {
    bytecodeVerified: true,
    compilerVersion: artifact.compiler?.version ?? deployment.compiler.version,
    creationBytecodeHash: keccak256(bytecode),
    runtimeBytecodeHash: keccak256(deployedBytecode),
    abiSha256: crypto.createHash("sha256").update(JSON.stringify(artifact.abi)).digest("hex"),
    constructors,
  });
} else if (!sourceOnly) {
  throw new Error(`compiled artifact not found: ${artifactPath}; run the reviewed Solidity 0.8.28 compiler path before bytecode acceptance`);
}

const outputDir = path.join(root, "proofs", "local");
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, "contract-artifact-proof.json");
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: true, output, sourceSha256, bytecodeVerified: result.bytecodeVerified }));
