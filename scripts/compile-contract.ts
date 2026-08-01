import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "contracts/Refuel402ExactPermit2Proxy.sol";
const sourcePath = path.join(root, sourceRelative);
const source = fs.readFileSync(sourcePath, "utf8");
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
const compilerPackage = "solc@0.8.28";
function compile(selection: string[]): Record<string, any> {
  const input = {
    language: "Solidity",
    sources: { [sourceRelative]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      metadata: { bytecodeHash: "none", appendCBOR: false },
      // solcjs can truncate one large standard-json write near 64 KiB. Compile
      // deterministic output slices separately, then bind them into one artifact.
      outputSelection: { "*": { "*": selection } },
    },
  };
  const compiled = spawnSync(
    "npm",
    ["exec", "--yes", `--package=${compilerPackage}`, "--", "solcjs", "--standard-json"],
    { cwd: root, input: JSON.stringify(input), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (compiled.status !== 0) throw new Error(`solcjs failed: ${compiled.stderr || compiled.stdout}`);
  const jsonStart = compiled.stdout.indexOf("{");
  if (jsonStart < 0) throw new Error("solcjs returned no JSON output");
  const output = JSON.parse(compiled.stdout.slice(jsonStart)) as Record<string, any>;
  const errors = (output.errors ?? []).filter((entry: any) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry: any) => entry.formattedMessage ?? entry.message).join("\n"));
  const contract = output.contracts?.[sourceRelative]?.Refuel402ExactPermit2Proxy;
  if (!contract) throw new Error("compiler output is missing the proxy contract");
  return contract;
}

const abiContract = compile(["abi"]);
const creationContract = compile(["evm.bytecode.object"]);
const runtimeContract = compile(["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"]);
if (!abiContract.abi || !creationContract.evm?.bytecode?.object || !runtimeContract.evm?.deployedBytecode?.object) {
  throw new Error("compiler output is missing ABI or bytecode");
}
const rawImmutableReferences = runtimeContract.evm.deployedBytecode.immutableReferences ?? {};
const immutableNames = [...source.matchAll(/\b[A-Za-z_][A-Za-z0-9_.]*\s+public\s+immutable\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)]
  .map((match) => match[1]!);
const immutableIds = Object.keys(rawImmutableReferences).sort((left, right) => Number(left) - Number(right));
if (immutableNames.length !== immutableIds.length) {
  throw new Error("compiler immutable references do not match canonical source declarations");
}
const immutableReferences = Object.fromEntries(immutableIds.map((id, index) => [
  immutableNames[index]!,
  rawImmutableReferences[id],
]));

const compilerVersion = execFileSync(
  "npm",
  ["exec", "--yes", `--package=${compilerPackage}`, "--", "solcjs", "--version"],
  { cwd: root, encoding: "utf8" },
).trim();
const artifact = {
  schema: "refuel402.solidity-artifact.v1",
  contractName: "Refuel402ExactPermit2Proxy",
  source: sourceRelative,
  sourceSha256,
  compiler: { version: compilerVersion, optimizer: true, runs: 200, evmVersion: "cancun", metadataBytecodeHash: "none", appendCBOR: false },
  abi: abiContract.abi,
  bytecode: `0x${creationContract.evm.bytecode.object}`,
  deployedBytecode: `0x${runtimeContract.evm.deployedBytecode.object}`,
  immutableReferences,
};
const artifactDir = path.join(root, "contracts", "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, "Refuel402ExactPermit2Proxy.json");
fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ ok: true, artifact: artifactPath, sourceSha256, compilerVersion }));
