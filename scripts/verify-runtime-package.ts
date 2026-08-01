import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "package.json",
  "server/src/index.ts",
  "server/src/evm-facilitator.ts",
  "scripts/run-local-evm-facilitator.ts",
  "contracts/Refuel402ExactPermit2Proxy.sol",
  "contracts/artifacts/Refuel402ExactPermit2Proxy.json",
  "contracts/deployments.json",
  "config/support.testnet.json",
  "config/support.mainnet.json",
  "dist/web/index.html",
];
const runtimePackages = [
  "@hashgraph/hedera-agent-kit",
  "@hiero-ledger/sdk",
  "@x402/core",
  "@x402/evm",
  "@x402/hedera",
  "dotenv",
  "express",
  "pg",
  "protobufjs",
  "tsx",
  "viem",
  "zod",
];
const forbiddenDevPackages = ["vite", "vitest", "typescript", "@types/express", "@types/pg"];

const missingFiles = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
const missingPackages = runtimePackages.filter((name) => !fs.existsSync(path.join(root, "node_modules", name, "package.json")));
const installedDevPackages = forbiddenDevPackages.filter((name) => fs.existsSync(path.join(root, "node_modules", name, "package.json")));

if (missingFiles.length || missingPackages.length || installedDevPackages.length) {
  throw new Error(JSON.stringify({
    code: "RUNTIME_PACKAGE_INVALID",
    missingFiles,
    missingPackages,
    installedDevPackages,
  }));
}

console.log(JSON.stringify({
  ok: true,
  schema: "refuel402.runtime-package-proof.v1",
  requiredFileCount: requiredFiles.length,
  runtimePackageCount: runtimePackages.length,
  productionDependenciesOnly: true,
  entrypoints: {
    api: "npm run server",
    facilitator: "npm run facilitator:self-host",
  },
  ports: { api: 4020, facilitator: 4402 },
}));
