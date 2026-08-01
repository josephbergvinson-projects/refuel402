import { getAddress } from "viem";
import { NETWORKS } from "../server/src/config.js";
import { Mirror } from "../server/src/mirror.js";
import { saucerQuoteSimulationCaller } from "../server/src/combined-quote.js";
import { parseDecimalUnits } from "../server/src/planner.js";
import { quoteBestSaucerRoute } from "../server/src/saucer-api.js";
import { loadSupportCatalog, type ProductMode } from "../server/src/support.js";
import { loadSaucerApiCredential } from "./lib/load-saucer-secret.js";

loadSaucerApiCredential();

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const mode = (arg("--mode") === "testnet" ? "testnet" : "mainnet") as ProductMode;
const assetId = arg("--asset");
const desiredHbar = arg("--hbar") ?? "5";
const account = arg("--account");
if (!assetId) throw new Error("--asset is required");
const quoteFrom = account ? getAddress(account) : saucerQuoteSimulationCaller();
if (!quoteFrom) throw new Error("--account or SAUCERSWAP_QUOTE_CALLER/SPONSOR_EVM_ADDRESS is required for a faithful Mirror contract-call simulation");
const asset = loadSupportCatalog(mode).assets.find((candidate) => candidate.id === assetId);
if (!asset) throw new Error("asset is not present in the selected support catalog");
const desiredHbarTinybar = parseDecimalUnits(desiredHbar, 8);
const network = NETWORKS[mode];
const mirror = new Mirror(network.mirrorBase, network.rpcUrl, network.quoteMirrorBase);
const selected = await quoteBestSaucerRoute({
  mode,
  asset,
  desiredHbarTinybar,
  simulationKey: mirror.quoteSimulationIdentity(),
  simulationSchedulerEnforcesSpacing: true,
  quoteExactOutput: (quoter, path, amountOut) => mirror.quoteExactOutput(quoter, path, amountOut, quoteFrom),
  quoteV1ExactOutput: (router, path, amountOut) => mirror.quoteV1ExactOutput(router, path, amountOut, quoteFrom),
});

console.log(JSON.stringify({
  schema: "refuel402.saucer-route-proof.v1",
  checkedAt: new Date().toISOString(),
  mode,
  assetId,
  desiredHbar,
  route: selected.route,
  exact: {
    amountIn: selected.exact.amountIn.toString(),
    gasEstimate: selected.exact.gasEstimate.toString(),
  },
  evidence: selected.evidence,
}, null, 2));
