import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allowedPackages = ["express", "tsx", "viem"];
const requiredFiles = [
  "package.json",
  "package-lock.json",
  "server/src/evm-facilitator.ts",
  "scripts/run-local-evm-facilitator.ts",
  "scripts/verify-facilitator-runtime.ts",
  "contracts/artifacts/Refuel402ExactPermit2Proxy.json",
];
const forbiddenPackages = [
  "@hashgraph/hedera-agent-kit",
  "@hiero-ledger/sdk",
  "@grpc/grpc-js",
  "protobufjs",
  "typescript",
  "vite",
  "vitest",
];
const dependencyNames = Object.keys(packageJson.dependencies ?? {}).sort();
const missingFiles = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
const missingPackages = allowedPackages.filter((name) => !fs.existsSync(path.join(root, "node_modules", name, "package.json")));
const installedForbiddenPackages = forbiddenPackages.filter((name) => fs.existsSync(path.join(root, "node_modules", name, "package.json")));
const unexpectedDependencies = dependencyNames.filter((name) => !allowedPackages.includes(name));
if (
  missingFiles.length ||
  missingPackages.length ||
  installedForbiddenPackages.length ||
  unexpectedDependencies.length ||
  Object.keys(packageJson.devDependencies ?? {}).length > 0
) {
  throw new Error(JSON.stringify({
    code: "FACILITATOR_RUNTIME_PACKAGE_INVALID",
    missingFiles,
    missingPackages,
    installedForbiddenPackages,
    unexpectedDependencies,
    devDependencyCount: Object.keys(packageJson.devDependencies ?? {}).length,
  }));
}
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
console.log(JSON.stringify({
  ok: true,
  schema: "refuel402.facilitator-runtime-package-proof.v1",
  dependencies: dependencyNames,
  productionDependenciesOnly: true,
  packageLockSha256: sha256("package-lock.json"),
  contractArtifactSha256: sha256("contracts/artifacts/Refuel402ExactPermit2Proxy.json"),
  startCommand: "npm start",
  listen: { defaultHost: "0.0.0.0", defaultPort: 4402 },
  executionDefault: "disabled",
}));
