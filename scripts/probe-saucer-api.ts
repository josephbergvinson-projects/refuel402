import { loadSupportCatalog } from "../server/src/support.js";
import { verifySaucerApiAsset } from "../server/src/saucer-api.js";
import { loadSaucerApiCredential } from "./lib/load-saucer-secret.js";

loadSaucerApiCredential();

const requested = process.argv.slice(2);
const assets = loadSupportCatalog("mainnet").assets.filter((asset) =>
  requested.length === 0 ? asset.saucer.status === "verified" : requested.includes(asset.id),
);
if (assets.length === 0) throw new Error("no matching support-catalog assets");

const results = [];
for (const asset of assets) {
  try {
    results.push({ assetId: asset.id, ok: true, evidence: await verifySaucerApiAsset(asset) });
  } catch (error) {
    results.push({
      assetId: asset.id,
      ok: false,
      error: error instanceof Error ? error.message : "unknown SaucerSwap API error",
    });
  }
}
console.log(JSON.stringify({
  schema: "refuel402.saucer-api-proof.v1",
  checkedAt: new Date().toISOString(),
  results,
}, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
