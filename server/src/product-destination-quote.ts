import type { BridgeQuote } from "./bridge.js";
import { buildCombinedQuote } from "./combined-quote.js";
import type { Mirror } from "./mirror.js";
import { ProductLifecycleConflictError, type ProductLifecycleStore } from "./product-lifecycle-store.js";
import { hydrateSaucerSupportCatalog } from "./saucer-api.js";
import { intersectSupport, loadSupportCatalog, probeRuntimeGates } from "./support.js";

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("stored quote record is invalid");
  return value as Record<string, any>;
}

export function createProductDestinationQuoteRefresher(options: {
  store: ProductLifecycleStore;
  mirrors: Record<"testnet" | "mainnet", Mirror>;
}) {
  return async (journeyId: string) => {
    const journey = await options.store.getJourney(journeyId);
    if (!journey) throw new Error("journey does not exist");
    const original = await options.store.getQuote(journey.quoteId);
    if (!original) throw new Error("journey quote does not exist");
    const arrival = [...journey.events].reverse().find((event) => event.type === "bridge_arrived");
    if (!arrival) throw new Error("bridge arrival is not confirmed");
    const received = String(arrival.record.destinationAmountReceived ?? "");
    if (!/^\d+$/.test(received) || BigInt(received) <= 0n) throw new Error("bridge arrival amount is invalid");

    const originalRecord = record(original.record);
    const originalRefuelCap = originalRecord.refuelCap && typeof originalRecord.refuelCap === "object"
      ? record(originalRecord.refuelCap)
      : {};
    const catalog = process.env.SAUCERSWAP_API_KEY
      ? await hydrateSaucerSupportCatalog(loadSupportCatalog(journey.mode))
      : loadSupportCatalog(journey.mode);
    const asset = catalog.assets.find((candidate) => candidate.id === journey.assetId);
    if (!asset) throw new Error("journey asset is no longer supported");
    const gates = await probeRuntimeGates(journey.mode, options.mirrors[journey.mode]);
    const runtimeAsset = intersectSupport(asset, gates);
    if (!runtimeAsset.runtime.quoteReady) throw new Error("destination route is not currently quote-ready");

    const oldBridge = record(originalRecord.bridge) as BridgeQuote;
    const bridge: BridgeQuote = {
      ...oldBridge,
      expectedDestinationAmount: received,
      minimumDestinationAmount: received,
      expiresAt: Math.floor(Date.now() / 1000) + Number(process.env.BRIDGE_ARRIVAL_PROOF_TTL_SEC ?? 300),
      normalized: {
        ...oldBridge.normalized,
        slippage: {
          ...oldBridge.normalized.slippage,
          expectedDestinationAmount: received,
          minimumDestinationAmount: received,
        },
        evidence: {
          ...oldBridge.normalized.evidence,
          observedAt: new Date().toISOString(),
        },
      },
    };
    const desiredHbarTinybar = BigInt(String(record(record(originalRecord.amountLedger).hbar).exactOutputTinybar));
    const quote = await buildCombinedQuote({
      mode: journey.mode,
      requestedProvider: journey.requestedProvider,
      supportEvidenceAt: catalog.evidenceAt,
      account: journey.account,
      asset,
      runtimeAsset,
      bridge,
      desiredHbarTinybar,
      slippageBps: Number(record(originalRecord.destination).slippageBps ?? 100),
      refuelProtection: {
        preset: ["flexible", "balanced", "strict", "custom"].includes(String(originalRefuelCap.preset))
          ? originalRefuelCap.preset
          : "flexible",
        customMaxAmountIn: originalRefuelCap.preset === "custom" && /^\d+$/.test(String(originalRefuelCap.maxAmountIn))
          ? BigInt(String(originalRefuelCap.maxAmountIn))
          : null,
      },
      mirror: options.mirrors[journey.mode],
    });
    if (!quote.capabilities.execute || quote.blockers.length > 0) {
      // Typed, not a bare Error. This is a refusal the owner can act on — the
      // route is temporarily not executable and the bridged asset is untouched —
      // but it used to fall through to the generic 500 handler and reach them as
      // "product lifecycle request failed", which says nothing about what to do.
      throw new ProductLifecycleConflictError(
        "QUOTE_NOT_EXECUTABLE",
        quote.blockers.length > 0
          ? `Nothing was signed or spent: the conversion route is not currently executable (${quote.blockers.join(", ")}). Your bridged balance is untouched — refresh again in a moment.`
          : "Nothing was signed or spent: the conversion route is not currently executable. Your bridged balance is untouched — refresh again in a moment.",
      );
    }
    return options.store.recordDestinationQuoteRefresh({
      journeyId,
      quote: quote as unknown as Record<string, unknown>,
    });
  };
}
