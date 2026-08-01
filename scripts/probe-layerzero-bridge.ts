import { getAddress } from "viem";
import { quoteLayerZero } from "../server/src/bridge.js";
import { loadSupportCatalog } from "../server/src/support.js";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const account = getAddress(arg("--account") ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const assetId = arg("--asset") ?? "layerzero:mainnet:wbtc";
const amount = BigInt(arg("--amount") ?? (assetId.endsWith(":usdt0") ? "10000000" : "10000"));
const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === assetId);
if (!asset) throw new Error(`mainnet LayerZero support asset ${assetId} is missing`);
const origin = asset.originTokens?.find((candidate) => candidate.chainId === "1");
if (!origin) throw new Error(`Ethereum origin mapping for ${assetId} is missing`);

const quote = await quoteLayerZero({
  mode: "mainnet",
  provider: "layerzero",
  originChainId: "1",
  originToken: getAddress(origin.address),
  amount,
  account,
  asset,
  slippageBps: 100,
});

console.log(JSON.stringify({
  schema: "refuel402.layerzero-direct-bridge-proof.v1",
  checkedAt: new Date().toISOString(),
  provider: quote.provider,
  source: quote.source,
  quoteId: quote.quoteId,
  originChainId: quote.originChainId,
  destinationChainId: quote.destinationChainId,
  fromAddress: quote.fromAddress,
  toAddress: quote.toAddress,
  originToken: quote.originToken,
  destinationToken: quote.destinationToken,
  fromAmount: quote.fromAmount,
  expectedDestinationAmount: quote.expectedDestinationAmount,
  minimumDestinationAmount: quote.minimumDestinationAmount,
  fees: quote.fees,
  normalized: quote.normalized,
  originApproval: quote.originApproval,
  transaction: quote.transaction,
  expiresAt: quote.expiresAt,
}, null, 2));
