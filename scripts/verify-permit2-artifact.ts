import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, type Hex } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "artifacts", "Permit2.json"), "utf8")) as {
  schema: string;
  contractName: string;
  sourceRepository: string;
  sourceCommit: string;
  compiler: {
    version: string;
    optimizer: boolean;
    optimizerRuns: number;
    viaIR: boolean;
    metadataBytecodeHash: string;
  };
  abi: unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};
if (artifact.schema !== "refuel402.permit2-artifact.v1" || artifact.contractName !== "Permit2") {
  throw new Error("Permit2 artifact identity is invalid");
}
if (
  artifact.sourceRepository !== "https://github.com/Uniswap/permit2.git" ||
  artifact.sourceCommit !== "cc56ad0f3439c502c246fc5cfcc3db92bb8b7219" ||
  !artifact.compiler.version.startsWith("0.8.17+") ||
  artifact.compiler.optimizer !== true ||
  artifact.compiler.optimizerRuns !== 1_000_000 ||
  artifact.compiler.viaIR !== true ||
  artifact.compiler.metadataBytecodeHash !== "none"
) {
  throw new Error("Permit2 source/compiler provenance is invalid");
}
if (
  !Array.isArray(artifact.abi) ||
  artifact.bytecode === "0x" ||
  artifact.deployedBytecode === "0x" ||
  Object.keys(artifact.immutableReferences ?? {}).length === 0
) {
  throw new Error("Permit2 artifact payload is incomplete");
}
const canonicalAddress = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const localCreationHash = keccak256(artifact.bytecode);
const localRuntimeTemplateHash = keccak256(artifact.deployedBytecode);
let canonicalCreationHash: Hex | null = null;
let canonicalRuntimeTemplateHash: Hex | null = null;
let canonicalCreationMatches: boolean | null = null;
let canonicalRuntimeTemplateMatches: boolean | null = null;
if (!process.argv.includes("--source-only")) {
  const referenceUrl = process.env.PERMIT2_REFERENCE_URL ??
    `https://sourcify.dev/server/v2/contract/1/${canonicalAddress}?fields=all`;
  const response = await fetch(referenceUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`canonical Permit2 verification reference failed (${response.status})`);
  const reference = await response.json() as {
    creationMatch?: string;
    runtimeMatch?: string;
    creationBytecode?: { recompiledBytecode?: Hex };
    runtimeBytecode?: { recompiledBytecode?: Hex; transformations?: { reason?: string }[] };
  };
  const canonicalCreation = reference.creationBytecode?.recompiledBytecode;
  const canonicalRuntimeTemplate = reference.runtimeBytecode?.recompiledBytecode;
  if (
    reference.creationMatch !== "match" ||
    reference.runtimeMatch !== "match" ||
    !canonicalCreation ||
    !canonicalRuntimeTemplate ||
    !reference.runtimeBytecode?.transformations?.some((entry) => entry.reason === "immutable")
  ) {
    throw new Error("canonical Permit2 verification reference is incomplete");
  }
  canonicalCreationHash = keccak256(canonicalCreation);
  canonicalRuntimeTemplateHash = keccak256(canonicalRuntimeTemplate);
  canonicalCreationMatches = canonicalCreationHash === localCreationHash;
  canonicalRuntimeTemplateMatches = canonicalRuntimeTemplateHash === localRuntimeTemplateHash;
  if (!canonicalCreationMatches || !canonicalRuntimeTemplateMatches) {
    throw new Error("compiled Permit2 creation/runtime template differs from the canonical verified deployment");
  }
}
console.log(JSON.stringify({
  schema: "refuel402.permit2-artifact-proof.v1",
  checkedAt: new Date().toISOString(),
  sourceCommit: artifact.sourceCommit,
  compilerVersion: artifact.compiler.version,
  creationBytecodeHash: localCreationHash,
  runtimeTemplateHash: localRuntimeTemplateHash,
  runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
  immutableReferenceCount: Object.values(artifact.immutableReferences).flat().length,
  canonicalAddress,
  canonicalCreationHash,
  canonicalRuntimeTemplateHash,
  canonicalCreationMatches,
  canonicalRuntimeTemplateMatches,
  acceptanceLevel: canonicalCreationMatches && canonicalRuntimeTemplateMatches ? "live_proof" : "local_component",
}, null, 2));
