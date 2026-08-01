import { getAddress } from "viem";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const base = new URL(arg("--base") ?? "https://refuel402-api-production.up.railway.app");
const account = getAddress(arg("--account") ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

async function json(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(120_000) });
  const body = await response.json().catch(() => ({})) as any;
  return { response, body };
}

async function quote(input: Record<string, unknown>) {
  return json("/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://refuel402.pages.dev" },
    body: JSON.stringify({ mode: "mainnet", routeMode: "bridge_plus_refuel", account, slippageBps: 100, ...input }),
  });
}

const options = await json("/v1/product/options?mode=mainnet");
if (!options.response.ok) throw new Error(`options failed ${options.response.status}`);
const configuredMaximumTinybar = BigInt(options.body.limits?.maximumConfiguredHbarTinybar ?? -1);
if (configuredMaximumTinybar !== 5_000_000_000n) throw new Error(`unexpected live maximum ${configuredMaximumTinybar}`);

const supported = [];
const blocked = [];
for (const asset of options.body.assets ?? []) {
  const origins = asset.originTokens ?? [];
  if (!asset.runtime?.quoteReady) {
    blocked.push({
      assetId: asset.id,
      provider: asset.provider,
      originPairs: origins.map((origin: any) => ({ chainId: origin.chainId, token: origin.address })),
      blockers: asset.runtime?.blockers ?? [],
    });
    continue;
  }
  for (const origin of origins) {
    // Forty whole origin tokens covers the one-HBAR affordability floor across
    // the generated matrix while staying inside the currently proven LCX provider amount band.
    const amountBaseUnits = (40n * 10n ** BigInt(origin.decimals)).toString();
    const result = await quote({
      provider: asset.provider,
      assetId: asset.id,
      originChainId: origin.chainId,
      originToken: origin.address,
      amountBaseUnits,
      desiredHbar: "1",
    });
    if (!result.response.ok) {
      throw new Error(`${asset.id}/${origin.chainId} failed ${result.response.status}: ${result.body.code ?? result.body.message ?? "unknown"}`);
    }
    const value = result.body;
    const selected = value.destination?.saucerApiEvidence?.selectedRoute;
    if (!value.bridge?.transaction || !value.bridge?.normalized?.evidence?.responseHash) {
      throw new Error(`${asset.id}/${origin.chainId} lacks provider transaction/evidence`);
    }
    if (!selected || !["v1", "v2"].includes(selected.venue) || !/^[0-9a-f]{64}$/.test(value.destination?.routeBinding ?? "")) {
      throw new Error(`${asset.id}/${origin.chainId} lacks a bound fresh Saucer route`);
    }
    if (value.x402?.transferMethod !== "permit2" || value.x402?.scheme !== "exact" || value.capabilities?.execute !== true) {
      throw new Error(`${asset.id}/${origin.chainId} lacks x402/execution readiness`);
    }
    if (value.amountLedger?.allInvariantsHold !== true || (value.blockers ?? []).length !== 0) {
      throw new Error(`${asset.id}/${origin.chainId} failed conservation or retained blockers`);
    }
    supported.push({
      assetId: asset.id,
      provider: asset.provider,
      originChainId: origin.chainId,
      originToken: origin.address,
      quoteId: value.quoteId,
      providerSource: value.bridge.source,
      providerRouteId: value.bridge.normalized.evidence.routeId,
      providerTransactionTarget: value.bridge.transaction.to,
      destinationToken: value.asset.destination.address,
      saucerGraphHash: value.destination.saucerApiEvidence.graphHash,
      saucerVenue: selected.venue,
      saucerRouteId: selected.routeId,
      routeBinding: value.destination.routeBinding,
      priceImpactBps: value.destination.priceImpactBps,
      maximumFeasibleTinybar: value.feasibility.maximumTinybar,
      x402TransferMethod: value.x402.transferMethod,
      policyTargets: value.x402.executionLegs.map((leg: any) => ({ id: leg.id, payer: leg.payer })),
      conservation: value.amountLedger.allInvariantsHold,
      walletTransactionSubmitted: false,
    });
  }
}

const acceptanceCases = [
  supported.find((row) => row.provider === "axelar" && row.assetId === "axelar:mainnet:usdc"),
  supported.find((row) => row.provider === "layerzero" && row.assetId === "layerzero:mainnet:wbtc"),
];
if (acceptanceCases.some((row) => !row)) throw new Error("50-HBAR Axelar/LayerZero acceptance routes are missing");
const fifty = [];
for (const route of acceptanceCases as NonNullable<(typeof acceptanceCases)[number]>[]) {
  const asset = options.body.assets.find((candidate: any) => candidate.id === route.assetId);
  const origin = asset.originTokens.find((candidate: any) => candidate.chainId === route.originChainId);
  const common = {
    provider: route.provider,
    assetId: route.assetId,
    originChainId: route.originChainId,
    originToken: route.originToken,
    amountBaseUnits: (100n * 10n ** BigInt(origin.decimals)).toString(),
  };
  const accepted = await quote({ ...common, desiredHbar: "50" });
  if (!accepted.response.ok || accepted.body.feasibility?.maximumTinybar !== "5000000000") {
    throw new Error(`${route.assetId} did not accept exactly 50 HBAR: ${accepted.response.status} ${accepted.body.code ?? "unknown"}`);
  }
  const rejected = await quote({ ...common, desiredHbar: "50.00000001" });
  if (rejected.response.status !== 422 || rejected.body.code !== "DESIRED_HBAR_EXCEEDS_MAXIMUM" || rejected.body.details?.limitingConstraint !== "CONFIGURED_MAX_HBAR") {
    throw new Error(`${route.assetId} did not reject 50.00000001 at the configured cap`);
  }
  fifty.push({
    assetId: route.assetId,
    provider: route.provider,
    acceptedQuoteId: accepted.body.quoteId,
    acceptedMaximumTinybar: accepted.body.feasibility.maximumTinybar,
    rejectedStatus: rejected.response.status,
    rejectedCode: rejected.body.code,
    rejectedConstraint: rejected.body.details.limitingConstraint,
    walletTransactionSubmitted: false,
  });
}

console.log(JSON.stringify({
  schema: "refuel402.production-provider-saucer-matrix.v1",
  checkedAt: new Date().toISOString(),
  configuredMaximumTinybar: configuredMaximumTinybar.toString(),
  generatedFrom: "live product options intersected with mapped origin tokens and fresh quote/readback",
  supported,
  blocked,
  fiftyHbarBoundary: fifty,
  mutationBoundary: "quote_records_only_no_journey_no_wallet_no_submission",
}, null, 2));
