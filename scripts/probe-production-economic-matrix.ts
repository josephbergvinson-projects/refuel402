import { getAddress } from "viem";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const stage = Number(arg("--stage") ?? "50");
if (![10, 25, 50].includes(stage)) throw new Error("--stage must be 10, 25, or 50");
const base = new URL(arg("--base") ?? "https://refuel402-api-production.up.railway.app");
const account = getAddress(arg("--account") ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const expectedCapTinybar = BigInt(stage) * 100_000_000n;

type Case = {
  id: string;
  provider: "axelar" | "layerzero";
  assetId: string;
  originToken: `0x${string}`;
  amountBaseUnits: string;
  desiredHbar: string;
  expectedVenue?: "v1" | "v2";
  expectedBridgeRoute?: string;
  expectedRiskCodes?: string[];
};

const wbtc: Case = {
  id: `wbtc-${stage}`,
  provider: "layerzero",
  assetId: "layerzero:mainnet:wbtc",
  originToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  amountBaseUnits: "100000",
  desiredHbar: String(stage),
  expectedVenue: "v2",
  expectedBridgeRoute: "ethereum-wbtc-to-hedera-wbtc-oft-v2",
};
const usdt0: Case = {
  id: `usdt0-${stage}`,
  provider: "layerzero",
  assetId: "layerzero:mainnet:usdt0",
  originToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  amountBaseUnits: "100000000",
  desiredHbar: String(stage),
  expectedBridgeRoute: "ethereum-usdt-to-hedera-usdt0-oft-v3",
  expectedRiskCodes: ["TOKEN_ADMIN_KEY_PRESENT", "TOKEN_FREEZE_KEY_PRESENT"],
};
const lcx: Case = {
  id: "lcx-3",
  provider: "axelar",
  assetId: "axelar:mainnet:lcx",
  originToken: "0x8cd41041505885ef0ad3858181d66f17be8aae7e",
  amountBaseUnits: "40000000000000000000",
  desiredHbar: "3",
  expectedVenue: "v1",
};
const cases = stage === 10 ? [wbtc] : stage === 25 ? [usdt0] : [wbtc, usdt0, lcx];

async function json(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, base), {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

const options = await json("/v1/product/options?mode=mainnet");
if (!options.response.ok) throw new Error(`options returned ${options.response.status}`);
if (BigInt(options.body.limits?.maximumConfiguredHbarTinybar ?? -1) !== expectedCapTinybar) {
  throw new Error(`live cap ${options.body.limits?.maximumConfiguredHbarTinybar} does not equal stage ${expectedCapTinybar}`);
}

const results = [];
for (const matrixCase of cases) {
  const quoted = await json("/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://refuel402.pages.dev" },
    body: JSON.stringify({
      mode: "mainnet",
      routeMode: "bridge_plus_refuel",
      account,
      provider: matrixCase.provider,
      assetId: matrixCase.assetId,
      originChainId: "1",
      originToken: matrixCase.originToken,
      amountBaseUnits: matrixCase.amountBaseUnits,
      desiredHbar: matrixCase.desiredHbar,
      slippageBps: 100,
    }),
  });
  if (!quoted.response.ok) throw new Error(`${matrixCase.id} quote failed ${quoted.response.status}: ${quoted.body.code ?? quoted.body.message ?? "unknown"}`);
  const quote = quoted.body;
  const desiredTinybar = BigInt(quote.destination?.desiredHbarTinybar ?? -1);
  const expectedDesiredTinybar = BigInt(matrixCase.desiredHbar) * 100_000_000n;
  if (desiredTinybar !== expectedDesiredTinybar) throw new Error(`${matrixCase.id} exact output mismatch`);
  if (BigInt(quote.feasibility?.maximumTinybar ?? -1) < desiredTinybar) throw new Error(`${matrixCase.id} maximum feasibility is below desired output`);
  if (quote.capabilities?.quote !== true || quote.capabilities?.execute !== true || (quote.blockers ?? []).length !== 0) {
    throw new Error(`${matrixCase.id} is not terminally quote/execution ready`);
  }
  const sponsor = quote.x402?.sponsorPolicy;
  const sponsorExposure = BigInt(quote.x402?.maxSponsorExposureTinybar ?? -1);
  const perRequest = BigInt(sponsor?.configuredPerRequestCapTinybar ?? -1);
  const daily = BigInt(sponsor?.dailyExposureCapTinybar ?? -1);
  const reserve = BigInt(sponsor?.reserveFloorTinybar ?? -1);
  const balance = BigInt(sponsor?.balanceTinybar ?? -1);
  if (sponsorExposure <= 0n || sponsorExposure > perRequest || sponsorExposure > daily) {
    throw new Error(`${matrixCase.id} sponsor exposure escapes per-request/daily policy`);
  }
  if (balance - sponsorExposure < reserve) throw new Error(`${matrixCase.id} sponsor reserve would be violated`);
  if (quote.amountLedger?.allInvariantsHold !== true) throw new Error(`${matrixCase.id} destination conservation failed`);
  const venue = quote.destination?.saucerApiEvidence?.selectedRoute?.venue ?? null;
  if (matrixCase.expectedVenue && venue !== matrixCase.expectedVenue) throw new Error(`${matrixCase.id} expected Saucer ${matrixCase.expectedVenue}, got ${venue}`);
  const bridgeRoute = quote.bridge?.normalized?.evidence?.routeId ?? null;
  if (matrixCase.expectedBridgeRoute && bridgeRoute !== matrixCase.expectedBridgeRoute) {
    throw new Error(`${matrixCase.id} expected bridge route ${matrixCase.expectedBridgeRoute}, got ${bridgeRoute}`);
  }
  const riskCodes = (quote.asset?.riskDisclosures ?? []).map((risk: any) => risk.code).sort();
  if (matrixCase.expectedRiskCodes && JSON.stringify(riskCodes) !== JSON.stringify([...matrixCase.expectedRiskCodes].sort())) {
    throw new Error(`${matrixCase.id} token-authority disclosures are missing`);
  }
  results.push({
    id: matrixCase.id,
    quoteId: quote.quoteId,
    bridgeSource: quote.bridge?.source,
    bridgeRoute,
    saucerVenue: venue,
    saucerRouteId: quote.destination?.saucerApiEvidence?.selectedRoute?.routeId ?? null,
    desiredHbarTinybar: quote.destination?.desiredHbarTinybar,
    maximumFeasibleTinybar: quote.feasibility?.maximumTinybar,
    paymentAssetAmountInMaximum: quote.destination?.paymentAssetAmountInMaximum,
    minimumDestinationArrival: quote.bridge?.minimumDestinationAmount,
    destinationEffectiveDifference: quote.amountLedger?.destination?.effectiveDifference,
    sponsorExposureTinybar: quote.x402?.maxSponsorExposureTinybar,
    perRequestCapTinybar: sponsor?.configuredPerRequestCapTinybar,
    dailyCapTinybar: sponsor?.dailyExposureCapTinybar,
    reserveFloorTinybar: sponsor?.reserveFloorTinybar,
    sponsorBalanceTinybar: sponsor?.balanceTinybar,
    riskCodes,
    walletTransactionSubmitted: false,
  });
}

let aboveCap = null;
if (stage === 50) {
  const rejected = await json("/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://refuel402.pages.dev" },
    body: JSON.stringify({
      mode: "mainnet",
      routeMode: "bridge_plus_refuel",
      account,
      provider: "layerzero",
      assetId: wbtc.assetId,
      originChainId: "1",
      originToken: wbtc.originToken,
      amountBaseUnits: wbtc.amountBaseUnits,
      desiredHbar: "50.00000001",
      slippageBps: 100,
    }),
  });
  if (rejected.response.status !== 422 || rejected.body.code !== "DESIRED_HBAR_EXCEEDS_MAXIMUM") {
    throw new Error(`above-cap request did not fail closed: ${rejected.response.status} ${rejected.body.code ?? "unknown"}`);
  }
  aboveCap = { status: rejected.response.status, code: rejected.body.code, maximumTinybar: rejected.body.details?.maximumTinybar };
}

console.log(JSON.stringify({
  schema: "refuel402.production-economic-matrix.v1",
  checkedAt: new Date().toISOString(),
  stageHbar: stage,
  configuredMaximumTinybar: expectedCapTinybar.toString(),
  results,
  aboveCap,
  mutationBoundary: "quote_records_only_no_journey_no_wallet_no_submission",
}, null, 2));
