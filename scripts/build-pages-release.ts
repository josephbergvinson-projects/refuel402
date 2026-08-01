import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiValue = process.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
if (!apiValue) throw new Error("VITE_API_BASE_URL is required for the production Pages build");
const api = new URL(apiValue);
if (api.protocol !== "https:") throw new Error("VITE_API_BASE_URL must use HTTPS for the production Pages build");

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error("npm_execpath is unavailable; invoke this wrapper through npm run build:pages");
execFileSync(process.execPath, [npmExecPath, "run", "build:web"], {
  cwd: root,
  env: { ...process.env, VITE_API_BASE_URL: apiValue },
  stdio: "inherit",
});

const dist = path.join(root, "dist", "web");
const indexPath = path.join(dist, "index.html");
const headersPath = path.join(dist, "_headers");
const index = fs.readFileSync(indexPath, "utf8");
const headers = fs.readFileSync(headersPath, "utf8");
const entryMatch = index.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/);
if (!entryMatch) throw new Error("production Pages entry bundle was not found in index.html");
const entryRelative = entryMatch[1]!.replace(/^\//, "");
const entryPath = path.join(dist, entryRelative);
const entry = fs.readFileSync(entryPath, "utf8");
if (!entry.includes(apiValue)) throw new Error("production Pages entry bundle does not contain VITE_API_BASE_URL");
if (!headers.includes(`connect-src 'self' ${api.origin}`)) {
  throw new Error("production Pages CSP does not allow the configured API origin");
}

const files = fs.readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(dist, path.join(entry.parentPath, entry.name)))
  .sort();
const manifest = files.map((relative) => {
  const body = fs.readFileSync(path.join(dist, relative));
  return {
    path: relative,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
});
const proof = {
  schema: "refuel402.pages-production-build.v1",
  apiBase: apiValue,
  apiOrigin: api.origin,
  entry: entryRelative,
  entryContainsApiBase: true,
  cspContainsApiOrigin: true,
  files: manifest,
};
const proofPath = process.env.PAGES_BUILD_PROOF_PATH;
if (proofPath) {
  const resolved = path.resolve(proofPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(proof, null, 2)}\n`);
}
console.log(JSON.stringify({
  ...proof,
  files: manifest.length,
  proofPath: proofPath ? path.resolve(proofPath) : null,
}));
