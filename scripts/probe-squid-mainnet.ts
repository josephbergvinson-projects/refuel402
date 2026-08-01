import { getAddress } from "viem";
import { quoteSquid } from "../server/src/bridge.js";
import { loadSupportCatalog } from "../server/src/support.js";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const accountRaw = arg("--account");
if (!accountRaw) throw new Error("--account is required");
const account = getAddress(accountRaw);
const amount = BigInt(arg("--amount") ?? "1000000");
const assetId = arg("--asset") ?? "axelar:mainnet:usdc";
const originChainId = arg("--origin-chain") ?? "1";
const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === assetId);
if (!asset) throw new Error(`${assetId} is absent from the support catalog`);
const originToken = asset.originTokens?.find((candidate) => candidate.chainId === originChainId);
if (!originToken) throw new Error(`${originChainId} origin token for ${assetId} is absent from the support catalog`);
const quote = await quoteSquid({
  mode: "mainnet",
  provider: "axelar",
  originChainId,
  originToken: getAddress(originToken.address),
  amount,
  account,
  asset,
  slippageBps: 100,
});
console.log(JSON.stringify({
  schema: "refuel402.squid-mainnet-route-proof.v1",
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
  estimatedSeconds: quote.estimatedSeconds,
  feeCount: quote.fees.length,
  transactionTarget: quote.transaction?.to ?? null,
  expiresAt: quote.expiresAt,
}, null, 2));
