import { getAddress } from "viem";
import { quoteLayerZero } from "../server/src/bridge.js";
import { buildCombinedQuote } from "../server/src/combined-quote.js";
import { NETWORKS } from "../server/src/config.js";
import { Mirror } from "../server/src/mirror.js";
import { hydrateSaucerSupportCatalog } from "../server/src/saucer-api.js";
import { defaultRuntimeGates, intersectSupport, loadSupportCatalog } from "../server/src/support.js";

const account = getAddress(process.argv[2] ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const catalog = await hydrateSaucerSupportCatalog(loadSupportCatalog("mainnet"));
const asset = catalog.assets.find((candidate) => candidate.id === "layerzero:mainnet:wbtc");
if (!asset) throw new Error("mainnet LayerZero WBTC asset is missing");
const origin = asset.originTokens?.find((candidate) => candidate.chainId === "1");
if (!origin) throw new Error("Ethereum WBTC origin mapping is missing");
const network = NETWORKS.mainnet;
const mirror = new Mirror(network.mirrorBase, network.rpcUrl, network.quoteMirrorBase);
const bridge = await quoteLayerZero({
  mode: "mainnet",
  provider: "layerzero",
  originChainId: "1",
  originToken: getAddress(origin.address),
  amount: 100_000n,
  account,
  asset,
  slippageBps: 100,
});
const quote = await buildCombinedQuote({
  mode: "mainnet",
  requestedProvider: "layerzero",
  supportEvidenceAt: catalog.evidenceAt,
  account,
  asset,
  runtimeAsset: intersectSupport(asset, defaultRuntimeGates("mainnet")),
  bridge,
  desiredHbarTinybar: 100_000_000n,
  slippageBps: 100,
  mirror,
});

console.log(JSON.stringify({
  schema: "refuel402.live-readonly-quote-model-proof.v1",
  checkedAt: new Date().toISOString(),
  account,
  provider: quote.bridge.provider,
  providerSource: quote.bridge.source,
  desiredHbarTinybar: quote.destination.desiredHbarTinybar,
  maximumFeasibleHbar: quote.destination.maximumFeasibleHbar,
  affordability: quote.destination.affordability,
  routePresentation: quote.destination.routePresentation,
  amountLedger: quote.amountLedger,
  costSummary: quote.costLedger.summary,
  costEntryCount: quote.costLedger.entries.length,
  blockers: quote.blockers,
  quoteCapability: quote.capabilities.quote,
  executionCapability: quote.capabilities.execute,
  expiresAt: quote.expiresAt,
}, null, 2));
