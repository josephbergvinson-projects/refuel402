import crypto from "node:crypto";
import { getAddress, type Address } from "viem";
import { reconcileCanonicalAmounts } from "./amount-domain.js";
import type { BridgeQuote } from "./bridge.js";
import { buildQuoteCostLedger } from "./quote-cost-ledger.js";
import type {
  ProductAssetOption,
  ProductMode,
  ProviderSelectionId,
  SupportAsset,
} from "./support.js";

export type BridgeOnlyQuoteInput = {
  mode: ProductMode;
  requestedProvider: ProviderSelectionId;
  supportEvidenceAt: string;
  account: Address;
  asset: SupportAsset;
  runtimeAsset: ProductAssetOption;
  bridge: BridgeQuote;
};

export function composeBridgeOnlyQuote(input: BridgeOnlyQuoteInput) {
  const account = getAddress(input.account);
  if (getAddress(input.bridge.fromAddress) !== account || getAddress(input.bridge.toAddress) !== account) {
    throw new Error("bridge sender and Hedera destination must equal the connected MetaMask account");
  }
  const expectedArrival = BigInt(input.bridge.expectedDestinationAmount);
  const minimumArrival = BigInt(input.bridge.minimumDestinationAmount);
  const sourceSymbol = input.bridge.normalized.sourceAmount.symbol;
  const providerFeeSource = input.bridge.fees
    .filter((fee) => fee.category === "provider" && fee.symbol === sourceSymbol)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  const providerGasRelayerSource = input.bridge.fees
    .filter((fee) => fee.category === "gas_relayer" && fee.symbol === sourceSymbol)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  const amountLedger = reconcileCanonicalAmounts({
    sourceInput: BigInt(input.bridge.fromAmount),
    providerFeeSource,
    providerGasRelayerSource,
    destinationArrivalInSourceUnits:
      input.bridge.normalized.sourceAmount.decimals === input.bridge.normalized.destinationAsset.decimals
        ? expectedArrival
        : null,
    grossDestination: expectedArrival,
    minimumDestination: minimumArrival,
    x402ProtocolFee: 0n,
    destinationSwapInput: 0n,
    destinationSwapInputExpected: 0n,
    exactHbarTinybar: 0n,
    minimumHbarTinybar: 0n,
    minimumRetainedBps: 0,
  });
  const blockers = [...input.runtimeAsset.runtime.blockers];
  if (input.bridge.expiresAt <= Math.floor(Date.now() / 1_000)) blockers.push("STALE_QUOTE");
  if (!input.bridge.transaction) blockers.push("PROVIDER_EXECUTION_ADAPTER_NOT_PROVEN");
  const expiresAt = input.bridge.expiresAt;
  const quoteId = crypto.createHash("sha256").update(JSON.stringify({
    routeMode: "bridge_only",
    mode: input.mode,
    account,
    requestedProvider: input.requestedProvider,
    selectedProvider: input.bridge.provider,
    assetId: input.asset.id,
    originChainId: input.bridge.originChainId,
    providerQuoteId: input.bridge.quoteId,
    bridgeAmount: input.bridge.fromAmount,
    expiresAt,
  })).digest("hex");
  const retained = BigInt(amountLedger.destination.remainingAtMinimum);
  const costLedger = buildQuoteCostLedger({
    bridge: input.bridge,
    asset: input.asset,
    sourceAmount: {
      symbol: input.bridge.normalized.sourceAmount.symbol,
      decimals: input.bridge.normalized.sourceAmount.decimals,
      address: input.bridge.normalized.sourceAmount.token,
      native: input.bridge.normalized.sourceAmount.native,
    },
    minimumArrival,
    retainedAtMinimum: retained,
    x402FeeAmount: 0n,
    x402FeeUsd: 0,
    marketEvidenceAt: null,
    swapInputExact: 0n,
    swapInputMaximum: 0n,
    paymentAssetSwapInputMaximum: 0n,
    slippageBufferPaymentAsset: 0n,
    priceImpactBps: 0,
    saucerRoute: null,
    sponsoredLegs: [],
    maximumSponsorExposureTinybar: 0n,
    desiredHbarTinybar: 0n,
  });
  return {
    schema: "refuel402.product-quote.v2",
    routeMode: "bridge_only" as const,
    quoteId,
    mode: input.mode,
    account,
    providerSelection: {
      requested: input.requestedProvider,
      selected: input.bridge.provider,
      strategy: input.requestedProvider === "auto" ? "best_eligible_quote" : "explicit",
      comparisonGroup: input.asset.comparisonGroup ?? input.asset.id,
      compared: [input.bridge.provider],
    },
    assetSelection: {
      requestedAssetId: input.asset.id,
      selectedAssetId: input.asset.id,
      assetPreserved: true,
    },
    support: {
      evidenceAt: input.supportEvidenceAt,
      assetId: input.asset.id,
      originChainId: input.bridge.originChainId,
    },
    sameAddress: {
      bridgeFrom: account,
      bridgeTo: account,
      hederaDestination: account,
      x402Payer: null,
      hbarRecipient: null,
      valid: true,
    },
    asset: {
      id: input.asset.id,
      provider: input.asset.provider,
      symbol: input.asset.symbol,
      destination: input.asset.destination,
      riskDisclosures: input.asset.riskDisclosures ?? [],
    },
    bridge: input.bridge,
    destination: {
      desiredHbarTinybar: "0",
      desiredHbar: "0",
      hbarOutput: {
        kind: "unavailable" as const,
        estimatedTinybar: "0",
        minimumTinybar: "0",
        status: "not_claimed" as const,
      },
      route: [],
      routePresentation: null,
      maximumFeasibleHbar: {
        tinybar: "0",
        hbar: "0",
        desiredTinybar: "0",
        headroomTinybar: "0",
        limitingConstraint: "ROUTE_UNAVAILABLE",
        solverResolutionTinybar: "0",
        candidateBudget: 0,
        candidatesEvaluated: 0,
        routeScope: "bridge_only",
        boundKind: "no_hbar_claim",
      },
      affordability: null,
      amountIn: "0",
      amountInMaximum: "0",
      paymentAssetAmountInMaximum: "0",
      gasEstimate: "0",
      slippageBps: input.bridge.normalized.slippage.requestedBps,
      priceImpactBps: 0,
      simulatedAt: null,
      expiresAt: null,
      saucerApiEvidence: null,
      availability: {
        status: "unavailable",
        reason: input.asset.saucer.status === "no_route"
          ? "NO_EXECUTABLE_SAUCER_ROUTE"
          : "REFUEL_NOT_SELECTED_OR_UNAVAILABLE",
      },
    },
    x402: {
      enabled: false,
      feeAmount: "0",
      feeUsd: 0,
      sponsorPolicy: null,
    },
    amountLedger,
    outcome: {
      grossDestinationArrival: expectedArrival.toString(),
      expectedArrival: expectedArrival.toString(),
      minimumArrival: minimumArrival.toString(),
      x402ProtocolFee: "0",
      destinationSwapInputMaximum: "0",
      maximumDebit: "0",
      minimumRetainedByPolicy: "0",
      destinationAssetRemaining: minimumArrival.toString(),
      retainedAtMinimumArrival: minimumArrival.toString(),
      totalEffectiveDifference: amountLedger.destination.effectiveDifference,
      hbarMinimumTinybar: "0",
      status: "estimate",
    },
    feasibility: {
      schema: "refuel402.bridge-only-feasibility.v1",
      maximumTinybar: "0",
      desiredTinybar: "0",
      headroomTinybar: "0",
      limitingConstraint: "ROUTE_UNAVAILABLE",
      resolutionTinybar: "0",
      candidateBudget: 0,
      candidatesEvaluated: 0,
      boundKind: "no_hbar_claim",
      desiredAssessment: null,
      maximumAssessment: null,
      maximumComponents: null,
    },
    costLedger,
    consent: {
      bridgeTransactionRequired: true,
      refuelConsentRequired: false,
      hbarClaim: "none",
    },
    capabilities: {
      quote: !blockers.includes("STALE_QUOTE"),
      execute: input.runtimeAsset.runtime.executable && blockers.length === 0 && !!input.bridge.transaction,
      acceptanceLevel: "integration_harness",
    },
    blockers: [...new Set(blockers)],
    expiresAt,
  };
}
