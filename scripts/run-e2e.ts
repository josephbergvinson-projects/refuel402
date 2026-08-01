// Canonical e2e entrypoint. The integration harness and live proof both invoke
// the exact POST /v1/fuel wrapper. The old direct SponsorClient primitive proof
// remains available only as `npm run diagnostic:sponsor-primitive` and is not
// acceptance evidence.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(script: string): void {
  const result = spawnSync(process.execPath, [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "scripts", script),
  ], { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("run-e2e-harness.ts");
if (process.env.LIVE_E2E !== "1") {
  console.log("Integration harness passed. Set LIVE_E2E=1 only with a funded, personally owned testnet account to run live proof.");
  process.exit(0);
}
if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
  throw new Error("live mainnet proof is disabled and requires a separately reviewed deployment and transaction approval");
}
run("run-live-e2e.ts");
