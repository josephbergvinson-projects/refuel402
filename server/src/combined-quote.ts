import crypto from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { encodeExactOutputPath } from "../../client/src/txbuilder.js";
import type { BridgeQuote } from "./bridge.js";
import { AmountInvariantError, reconcileCanonicalAmounts } from "./amount-domain.js";
import { NETWORKS, pricingConfig, SPONSOR } from "./config.js";
import { MirrorQuoteError, type Mirror } from "./mirror.js";
import {
  assessProductFeasibility,
  deferMaximumFeasibleHbar,
  solveMaximumFeasibleHbar,
  type FeasibilityAssessment,
  type MaximumFeasibleHbar,
} from "./product-feasibility.js";
import { fetchMarketSnapshot, priceSponsorship, type Quote as SponsorshipQuote } from "./pricing.js";
import { buildRefuelCap, type RefuelPriceProtectionPreset } from "./refuel-cap.js";
import { refuelRouteHash } from "./refuel-authorization-witness.js";
import { buildRoutePresentation, productExecutionLegPlan } from "./product-route-model.js";
import { buildQuoteCostLedger } from "./quote-cost-ledger.js";
import { bindSaucerRoute, saucerExecutionRoute } from "./route-binding.js";
import {
  productContractAddresses,
  type ProductAssetOption,
  type ProductMode,
  type ProviderSelectionId,
  type SupportAsset,
} from "./support.js";
import {
  quoteBestSaucerRoute,
  saucerGraphProofRotationPending,
  type SaucerApiEvidence,
  type SaucerQuoteTiming,
} from "./saucer-api.js";

const BPS = 10_000n;

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function quantizationAwarePriceImpactBps(input: {
  amountIn: bigint;
  amountOut: bigint;
  referenceAmountIn: bigint;
  referenceAmountOut: bigint;
}): number {
  if (input.referenceAmountIn <= 0n || input.referenceAmountOut <= 0n || input.amountOut <= 0n) return 0;
  const linearInput = input.referenceAmountIn * input.amountOut / input.referenceAmountOut;
  if (linearInput <= 0n || input.amountIn <= linearInput) return 0;
  const observedExcess = input.amountIn - linearInput;
  // Exact-output quoters round each token amount to base units. Scaling a
  // one-base-unit reference uncertainty magnifies it by amountOut/referenceOut;
  // the desired quote contributes one additional base unit. Only excess above
  // that deterministic quantization envelope is proven economic impact.
  const referenceScaleCeiling = (input.amountOut + input.referenceAmountOut - 1n) / input.referenceAmountOut;
  const quantizationEnvelope = referenceScaleCeiling + 1n;
  if (observedExcess <= quantizationEnvelope) return 0;
  return Number((observedExcess - quantizationEnvelope) * BPS / linearInput);
}

function formatDecimalUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type QuoteFairValueAssessment =
  | {
      status: "verified";
      deviationBps: number;
      maximumDeviationBps: number;
      quoteImpliedHbarPerToken: number;
      marketImpliedHbarPerToken: number;
      tokenPriceUsd: number;
      hbarUsd: number;
    }
  | { status: "fair_value_unverified"; reason: string };

/**
 * Cross-checks the quote-implied HBAR price of the swap input token against
 * independent market evidence (SaucerSwap graph priceUsd + network HBAR/USD).
 * Same-pool price impact cannot see a stale pool whose mid drifted from spot;
 * this gate can. Missing price evidence is disclosed, never fabricated.
 */
export function assessQuoteFairValue(input: {
  amountIn: bigint;
  tokenDecimals: number | null;
  desiredHbarTinybar: bigint;
  tokenPriceUsd: number | null;
  hbarUsd: number | null | undefined;
}): QuoteFairValueAssessment {
  const maximumDeviationBps = boundedInteger("MAX_QUOTE_FAIR_VALUE_DEVIATION_BPS", 300, 1, 10_000);
  if (input.tokenPriceUsd === null || input.tokenPriceUsd <= 0 || !input.hbarUsd || input.hbarUsd <= 0) {
    return { status: "fair_value_unverified", reason: "token or HBAR market price is unavailable" };
  }
  if (input.tokenDecimals === null || input.amountIn <= 0n || input.desiredHbarTinybar <= 0n) {
    return { status: "fair_value_unverified", reason: "quote amounts or token decimals are unavailable" };
  }
  const quoteImpliedHbarPerToken =
    (Number(input.desiredHbarTinybar) / 1e8) / (Number(input.amountIn) / 10 ** input.tokenDecimals);
  const marketImpliedHbarPerToken = input.tokenPriceUsd / input.hbarUsd;
  if (!Number.isFinite(quoteImpliedHbarPerToken) || !Number.isFinite(marketImpliedHbarPerToken) || marketImpliedHbarPerToken <= 0) {
    return { status: "fair_value_unverified", reason: "implied price is not finite" };
  }
  const deviationBps = Math.round(
    Math.abs(quoteImpliedHbarPerToken - marketImpliedHbarPerToken) / marketImpliedHbarPerToken * 10_000,
  );
  return {
    status: "verified",
    deviationBps,
    maximumDeviationBps,
    quoteImpliedHbarPerToken,
    marketImpliedHbarPerToken,
    tokenPriceUsd: input.tokenPriceUsd,
    hbarUsd: input.hbarUsd,
  };
}

export function saucerQuoteSimulationCaller(env: NodeJS.ProcessEnv = process.env): Address | undefined {
  const configured = env.SAUCERSWAP_QUOTE_CALLER ?? env.SPONSOR_EVM_ADDRESS;
  return configured && /^0x[0-9a-fA-F]{40}$/.test(configured) ? getAddress(configured) : undefined;
}

function saucerRouteQuoteRequest(input: {
  mode: ProductMode;
  asset: SupportAsset;
  desiredHbarTinybar: bigint;
  mirror: Mirror;
  timing?: SaucerQuoteTiming;
}) {
  const simulationCaller = saucerQuoteSimulationCaller();
  return {
    mode: input.mode,
    asset: input.asset,
    desiredHbarTinybar: input.desiredHbarTinybar,
    simulationKey: input.mirror.quoteSimulationIdentity(),
    includeReferenceQuote: true,
    simulationSchedulerEnforcesSpacing: true,
    // Exact-output simulation is price discovery, not a user transaction. A
    // nonexistent/hollow destination EOA must still be able to get a quote, so
    // use a configured, deployed read-only caller instead of the user address.
    quoteExactOutput: (quoter: Address, path: `0x${string}`, amountOut: bigint) =>
      input.mirror.quoteExactOutput(quoter, path, amountOut, simulationCaller),
    quoteV1ExactOutput: (router: Address, path: Address[], amountOut: bigint) =>
      input.mirror.quoteV1ExactOutput(router, path, amountOut, simulationCaller),
    ...(input.timing ? { timing: input.timing } : {}),
  };
}

/**
 * Starts the serialized Saucer exact-output simulation before the provider
 * bridge quote resolves. Deduped through the saucer quote inflight map, so the
 * later buildCombinedQuote call coalesces onto the same simulation; a failure
 * here is swallowed and resurfaces through that authoritative call.
 */
export function prewarmCombinedQuoteSaucerRoute(input: {
  mode: ProductMode;
  asset: SupportAsset;
  desiredHbarTinybar: bigint;
  mirror: Mirror;
}): void {
  if (!process.env.SAUCERSWAP_API_KEY) return;
  // Entirely best-effort: a prewarm must never fail, delay, or double-charge the
  // request. A pending graph rotation re-keys the quote cache, so warming across
  // it would buy the authoritative call a second full candidate sweep instead of
  // a coalesce; skip rather than pay it twice.
  try {
    if (saucerGraphProofRotationPending(input.mode)) return;
    void quoteBestSaucerRoute(saucerRouteQuoteRequest(input)).catch(() => {});
  } catch {}
}

export type CombinedQuoteInput = {
  /** Live owner->Permit2 allowance for the destination token; gates one-signature eligibility. */
  permit2Allowance?: bigint;
  mode: ProductMode;
  requestedProvider: ProviderSelectionId;
  supportEvidenceAt: string;
  account: Address;
  asset: SupportAsset;
  runtimeAsset: ProductAssetOption;
  bridge: BridgeQuote;
  desiredHbarTinybar: bigint;
  slippageBps: number;
  refuelProtection?: {
    preset: RefuelPriceProtectionPreset;
    customMaxAmountIn?: bigint | null;
  };
  saucer: {
    amountIn: bigint;
    amountInMaximum: bigint;
    paymentAssetAmountInMaximum: bigint;
    gasEstimate: bigint;
    priceImpactBps: number;
    apiEvidence?: SaucerApiEvidence | null;
    simulatedAtMs: number;
    expiresAtMs: number;
  };
  x402: {
    feeAmount: bigint;
    feeUsd: number;
    maxSponsorExposureTinybar: bigint;
    maxFacilitatorExposureTinybar?: bigint;
    maxExecutionExposureTinybar?: bigint;
    componentsTinybar: Record<string, bigint>;
    perLegGasAllowanceTinybar?: bigint[];
    perLegHapiReserveTinybar?: bigint[];
    estimatedCostTinybar?: bigint;
    gasPriceTinybarPerGas?: bigint;
    hbarUsd?: number;
    marketEvidenceAt?: string;
    sponsorBalanceTinybar?: bigint | null;
    sponsorExposureCapTinybar?: bigint;
    expiresAt: number;
  };
  fairValue?: QuoteFairValueAssessment | null;
  maximumFeasible?: MaximumFeasibleHbar<FeasibilityCandidate>;
  minimumRetainedBps: number;
};

type FeasibilityCandidate = {
  amountIn: bigint;
  amountInMaximum: bigint;
  paymentAssetAmountInMaximum: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
  price: SponsorshipQuote;
  sponsorExposureTinybar: bigint;
  facilitatorExposureTinybar: bigint;
  assessment: FeasibilityAssessment;
};

export function sameAddressInvariant(account: string, fromAddress: string, toAddress: string): Address {
  const normalized = getAddress(account);
  if (getAddress(fromAddress) !== normalized || getAddress(toAddress) !== normalized) {
    throw new Error("bridge sender and Hedera destination must equal the connected MetaMask account");
  }
  return normalized;
}

export function rankProviderQuotes<T extends {
  bridge: { provider: string; estimatedSeconds: number | null };
  outcome: { retainedAtMinimumArrival: string };
  x402: { feeUsd: number };
}>(quotes: T[]): T[] {
  return [...quotes].sort((left, right) => {
    const retained = BigInt(right.outcome.retainedAtMinimumArrival) - BigInt(left.outcome.retainedAtMinimumArrival);
    if (retained !== 0n) return retained > 0n ? 1 : -1;
    if (left.x402.feeUsd !== right.x402.feeUsd) return left.x402.feeUsd - right.x402.feeUsd;
    const leftEta = left.bridge.estimatedSeconds ?? Number.MAX_SAFE_INTEGER;
    const rightEta = right.bridge.estimatedSeconds ?? Number.MAX_SAFE_INTEGER;
    if (leftEta !== rightEta) return leftEta - rightEta;
    return left.bridge.provider.localeCompare(right.bridge.provider);
  });
}

export function composeCombinedQuote(input: CombinedQuoteInput) {
  const account = sameAddressInvariant(input.account, input.bridge.fromAddress, input.bridge.toAddress);
  const expectedArrival = BigInt(input.bridge.expectedDestinationAmount);
  const minimumArrival = BigInt(input.bridge.minimumDestinationAmount);
  const sourceSymbol = input.bridge.normalized.sourceAmount.symbol;
  const providerFeeSource = input.bridge.fees
    .filter((fee) => fee.category === "provider" && fee.symbol === sourceSymbol)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  const providerGasRelayerSource = input.bridge.fees
    .filter((fee) => fee.category === "gas_relayer" && fee.symbol === sourceSymbol)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  // The wrapper rate converts Saucer swap units into payment-asset units; the
  // maximum already carries it, so the expected input must carry it too.
  const paymentAssetWrapperRate = input.asset.destination.wrapper ? BigInt(input.asset.destination.wrapper.rate) : 1n;
  const expectedPaymentAssetSwapInput = input.saucer.amountIn * paymentAssetWrapperRate;
  const refuelCap = buildRefuelCap({
    preset: input.refuelProtection?.preset ?? "flexible",
    providerEtaSeconds: input.bridge.estimatedSeconds,
    customMaxAmountIn: input.refuelProtection?.customMaxAmountIn,
    serviceFeeAmount: input.x402.feeAmount,
    swapInputExpected: expectedPaymentAssetSwapInput,
    tokenPriceUsd: input.saucer.apiEvidence?.priceUsd ?? null,
    tokenDecimals: input.asset.destination.decimals,
  });
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
    x402ProtocolFee: input.x402.feeAmount,
    destinationSwapInput: input.saucer.paymentAssetAmountInMaximum,
    destinationSwapInputExpected: expectedPaymentAssetSwapInput,
    exactHbarTinybar: input.desiredHbarTinybar,
    minimumHbarTinybar: input.desiredHbarTinybar,
    minimumRetainedBps: input.minimumRetainedBps,
  });
  const minimumRetainedByPolicy = BigInt(amountLedger.destination.minimumRetainedByPolicy);
  const maximumDebit = BigInt(amountLedger.destination.consumedMaximum);
  const retained = BigInt(amountLedger.destination.remainingAtMinimum);
  const desiredAssessment = input.maximumFeasible?.desiredEvaluation.assessment ?? assessProductFeasibility({
    minimumArrival,
    x402ProtocolFee: input.x402.feeAmount,
    swapInputMaximum: input.saucer.paymentAssetAmountInMaximum,
    minimumRetainedBps: input.minimumRetainedBps,
    priceImpactBps: input.saucer.priceImpactBps,
    maximumPriceImpactBps: Number(process.env.MAX_PRICE_IMPACT_BPS ?? 150),
    maximumSponsorExposureTinybar: input.x402.maxSponsorExposureTinybar,
    sponsorExposureCapTinybar: input.x402.sponsorExposureCapTinybar ?? SPONSOR.perRequestExposureCapTinybar,
    sponsorReserveFloorTinybar: SPONSOR.minReserveTinybar,
    sponsorBalanceTinybar: input.x402.sponsorBalanceTinybar,
  });
  const maximumFeasibleTinybar = input.maximumFeasible?.maximumTinybar ??
    (desiredAssessment.feasible ? input.desiredHbarTinybar : 0n);
  const effectiveLimitingConstraint = maximumFeasibleTinybar === 0n && !desiredAssessment.feasible
    ? desiredAssessment.limitingConstraint
    : input.maximumFeasible?.limitingConstraint ?? desiredAssessment.limitingConstraint;
  const blockers = [...input.runtimeAsset.runtime.blockers];
  if (BigInt(refuelCap.maxAmountIn) + minimumRetainedByPolicy > minimumArrival) {
    blockers.push("REFUEL_CAP_EXCEEDS_AVAILABLE_ARRIVAL");
  }
  if (
    input.bridge.expiresAt <= Math.floor(Date.now() / 1000) ||
    input.saucer.expiresAtMs <= Date.now()
  ) blockers.push("STALE_QUOTE");
  // The liquidity floor is a refuel execution gate: a below-floor (or
  // liquidity-unknown) selected route keeps the quote inspectable but blocked.
  const selectedLiquidityUsd = input.saucer.apiEvidence?.selectedRoute?.minimumLiquidityUsd ?? null;
  const liquidityFloorUsd = input.saucer.apiEvidence?.liquidityDisclosureThresholdUsd;
  if (
    input.saucer.apiEvidence?.selectedRoute &&
    typeof liquidityFloorUsd === "number" && liquidityFloorUsd > 0 &&
    !(selectedLiquidityUsd !== null && selectedLiquidityUsd >= liquidityFloorUsd)
  ) blockers.push("SAUCER_LIQUIDITY_POLICY");
  if (input.fairValue?.status === "verified" && input.fairValue.deviationBps > input.fairValue.maximumDeviationBps) {
    blockers.push("SAUCER_FAIR_VALUE_DEVIATION");
  }
  if (BigInt(desiredAssessment.destination.headroom) < 0n) blockers.push("EXPECTED_ARRIVAL_INSUFFICIENT");
  if (desiredAssessment.priceImpact.headroomBps < 0) blockers.push("PRICE_IMPACT_CAP_EXCEEDED");
  if (BigInt(desiredAssessment.sponsor.exposureHeadroomTinybar) < 0n) blockers.push("SPONSOR_EXPOSURE_CAP_EXCEEDED");
  if (!desiredAssessment.feasible || input.desiredHbarTinybar > maximumFeasibleTinybar) {
    blockers.push("DESIRED_HBAR_EXCEEDS_MAXIMUM");
  }

  const expiresAt = Math.min(
    input.bridge.expiresAt,
    input.x402.expiresAt,
    Math.floor(input.saucer.expiresAtMs / 1_000),
  );
  const saucerRouteBinding = bindSaucerRoute(input.saucer.apiEvidence);
  const saucerRoute = saucerExecutionRoute(input.saucer.apiEvidence);
  const quoteIdentity = {
    mode: input.mode,
    account,
    requestedProvider: input.requestedProvider,
    selectedProvider: input.bridge.provider,
    assetId: input.asset.id,
    originChainId: input.bridge.originChainId,
    providerQuoteId: input.bridge.quoteId,
    bridgeAmount: input.bridge.fromAmount,
    desiredHbarTinybar: input.desiredHbarTinybar.toString(),
    maximumDebit: maximumDebit.toString(),
    refuelCap: refuelCap.maxAmountIn,
    refuelProtectionPreset: refuelCap.preset,
    saucerRouteBinding,
    expiresAt,
  };
  const quoteId = crypto
    .createHash("sha256")
    .update(JSON.stringify(quoteIdentity))
    .digest("hex");
  const contracts = productContractAddresses(input.mode);
  const wrapper = input.asset.destination.wrapper;
  const network = NETWORKS[input.mode];
  const directHts = !wrapper && input.asset.destination.standard === "HTS";
  // Any hop count. The path is whatever SaucerSwap's router selection returned;
  // nothing here assumes a shape. The only requirements are that every hop is a
  // V3-style (v2 venue) pool — the contract calls exactOutput — and that the
  // route ends at WHBAR, which is what gets unwrapped into the owner's HBAR.
  const refuelRoutable = (wrapper || directHts) && saucerRoute.length >= 1 &&
    saucerRoute.every((hop) => hop.venue === "v2") &&
    getAddress(saucerRoute[saucerRoute.length - 1]!.toToken) === getAddress(network.whbarToken);
  const refuelSwapPath = refuelRoutable
    ? encodeExactOutputPath(
        [
          getAddress(wrapper?.htsAddress ?? input.asset.destination.address),
          ...saucerRoute.map((hop) => getAddress(hop.toToken)),
        ],
        saucerRoute.map((hop) => hop.fee),
      )
    : null;
  const refuelRoute = refuelRoutable && refuelSwapPath
    ? {
        wrapper: wrapper
          ? getAddress(wrapper.address)
          : getAddress("0x0000000000000000000000000000000000000000"),
        htsToken: getAddress(wrapper?.htsAddress ?? input.asset.destination.address),
        router: getAddress(network.router),
        whbar: getAddress(network.whbarToken),
        wrapperRate: BigInt(wrapper?.rate ?? 1),
        swapPath: refuelSwapPath,
      }
    : null;
  const refuelAuthorization = refuelRoute
    ? {
        schema: "refuel402.refuel-authorization-terms.v1",
        // `enabled` is about the ROUTE and the flag — is this a refuel the product
        // can pre-authorize at all. It deliberately does NOT fold in the allowance.
        //
        // Folding it in made the two client branches mutually exclusive: the
        // account that needed the one-time approval was exactly the account whose
        // quote said `enabled: false`, and nothing re-quotes in between, so the
        // journey that took the approval could never sign the witness and the fast
        // path could never fire for anyone new. The allowance is a PREREQUISITE the
        // client satisfies in the same visit, not a reason to withhold the terms.
        enabled: process.env.REFUEL_PREAUTHORIZATION_ENABLED === "1",
        // Setup the client must complete first, in order. Null once nothing is
        // outstanding, so the client can sign immediately.
        prerequisite: (input.permit2Allowance ?? 0n) >= BigInt(refuelCap.maxAmountIn)
          ? null
          : "permit2_allowance",
        unavailableReason: process.env.REFUEL_PREAUTHORIZATION_ENABLED !== "1"
          ? "preauthorization_disabled"
          : null,
        permit2Allowance: (input.permit2Allowance ?? 0n).toString(),
        permit2: contracts.permit2,
        spender: contracts.proxy,
        token: getAddress(input.asset.destination.address),
        owner: account,
        recipient: account,
        maxAmountIn: refuelCap.maxAmountIn,
        exactHbarTinybar: input.desiredHbarTinybar.toString(),
        serviceFeeAmount: input.x402.feeAmount.toString(),
        maxSponsorExposureTinybar: input.x402.maxSponsorExposureTinybar.toString(),
        authorizationTtlSeconds: refuelCap.authorizationTtlSeconds,
        route: {
          ...refuelRoute,
          wrapperRate: refuelRoute.wrapperRate.toString(),
        },
        routeHash: refuelRouteHash(refuelRoute),
      }
    : {
        schema: "refuel402.refuel-authorization-terms.v1",
        enabled: false,
        unavailableReason: "route_not_supported_by_atomic_refuel_proxy",
      };
  const paymentRecipient = process.env.X402_PAYMENT_RECIPIENT;
  if (!paymentRecipient || !/^0x[0-9a-fA-F]{40}$/.test(paymentRecipient)) {
    blockers.push("X402_PAYMENT_RECIPIENT_NOT_CONFIGURED");
  }
  const presentation = buildRoutePresentation(input.mode, input.asset, input.saucer.apiEvidence);
  const plannedLegs = productExecutionLegPlan(input.asset, input.saucer.gasEstimate);
  const executionLegs = input.x402.perLegGasAllowanceTinybar?.length === plannedLegs.length
    ? plannedLegs.map((leg, index) => {
        const gasAllowanceTinybar = input.x402.perLegGasAllowanceTinybar![index]!;
        const hapiReserveTinybar = input.x402.perLegHapiReserveTinybar?.[index] ?? 0n;
        return {
          id: leg.id,
          label: leg.label,
          stage: leg.stage,
          payer: leg.payer,
          gasAllowanceTinybar,
          hapiReserveTinybar,
          maximumTinybar: gasAllowanceTinybar + hapiReserveTinybar,
        };
      })
    : [{
        id: "policy_bundle",
        label: "Destination sponsored policy bundle",
        stage: "policy" as const,
        payer: "sponsor" as const,
        gasAllowanceTinybar: input.x402.maxSponsorExposureTinybar,
        hapiReserveTinybar: 0n,
        maximumTinybar: input.x402.maxSponsorExposureTinybar,
      }];
  const sponsoredLegs = executionLegs.map(({ id, label, stage, payer, maximumTinybar }) => ({
    id,
    label,
    stage,
    payer,
    maximumTinybar,
  }));
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
    x402FeeAmount: input.x402.feeAmount,
    x402FeeUsd: input.x402.feeUsd,
    marketEvidenceAt: input.x402.marketEvidenceAt ?? null,
    swapInputExact: input.saucer.amountIn,
    swapInputMaximum: input.saucer.amountInMaximum,
    paymentAssetSwapInputMaximum: input.saucer.paymentAssetAmountInMaximum,
    slippageBufferPaymentAsset: input.saucer.paymentAssetAmountInMaximum - expectedPaymentAssetSwapInput,
    priceImpactBps: input.saucer.priceImpactBps,
    saucerRoute: presentation,
    sponsoredLegs,
    maximumSponsorExposureTinybar: input.x402.maxExecutionExposureTinybar ?? input.x402.maxSponsorExposureTinybar,
    desiredHbarTinybar: input.desiredHbarTinybar,
  });

  return {
    schema: "refuel402.combined-quote.v1",
    routeMode: "bridge_plus_refuel" as const,
    quoteId,
    mode: input.mode,
    account,
    providerSelection: {
      requested: input.requestedProvider,
      selected: input.bridge.provider,
      strategy: input.requestedProvider === "auto" ? "best_eligible_quote" : "explicit",
      comparisonGroup: input.asset.comparisonGroup ?? input.asset.id,
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
      x402Payer: account,
      hbarRecipient: account,
      valid: true,
    },
    assetSelection: {
      requestedAssetId: input.asset.id,
      selectedAssetId: input.asset.id,
      assetPreserved: true,
    },
    asset: {
      id: input.asset.id,
      provider: input.asset.provider,
      symbol: input.asset.symbol,
      destination: input.asset.destination,
      riskDisclosures: input.asset.riskDisclosures ?? [],
    },
    bridge: input.bridge,
    refuelCap,
    refuelAuthorization,
    destination: {
      desiredHbarTinybar: input.desiredHbarTinybar.toString(),
      desiredHbar: formatDecimalUnits(input.desiredHbarTinybar, 8),
      hbarOutput: {
        kind: "exact_output",
        estimatedTinybar: input.desiredHbarTinybar.toString(),
        minimumTinybar: input.desiredHbarTinybar.toString(),
        status: "estimate",
      },
      route: saucerRoute,
      routeBinding: saucerRouteBinding,
      routePresentation: presentation,
      maximumFeasibleHbar: {
        tinybar: maximumFeasibleTinybar.toString(),
        hbar: formatDecimalUnits(maximumFeasibleTinybar, 8),
        desiredTinybar: input.desiredHbarTinybar.toString(),
        headroomTinybar: (input.maximumFeasible?.headroomTinybar ?? 0n).toString(),
        limitingConstraint: effectiveLimitingConstraint,
        solverResolutionTinybar: (input.maximumFeasible?.resolutionTinybar ?? 0n).toString(),
        candidateBudget: input.maximumFeasible?.candidateBudget ?? 1,
        candidatesEvaluated: input.maximumFeasible?.candidatesEvaluated ?? 1,
        routeScope: presentation?.scope ?? "selected_saucer_exact_output_route",
        boundKind: "verified_feasible_lower_bound",
        solved: input.maximumFeasible?.solved ?? false,
        solveReason: input.maximumFeasible?.solveReason ?? "deferred_for_latency",
      },
      affordability: desiredAssessment,
      amountIn: input.saucer.amountIn.toString(),
      amountInMaximum: input.saucer.amountInMaximum.toString(),
      paymentAssetAmountInMaximum: input.saucer.paymentAssetAmountInMaximum.toString(),
      gasEstimate: input.saucer.gasEstimate.toString(),
      slippageBps: input.slippageBps,
      priceImpactBps: input.saucer.priceImpactBps,
      fairValue: input.fairValue ?? null,
      simulatedAt: new Date(input.saucer.simulatedAtMs).toISOString(),
      expiresAt: new Date(input.saucer.expiresAtMs).toISOString(),
      saucerApiEvidence: input.saucer.apiEvidence ?? null,
    },
    x402: {
      network: `eip155:${input.mode === "mainnet" ? 295 : 296}`,
      scheme: "exact",
      transferMethod: "permit2",
      asset: input.asset.destination.address,
      feeAmount: input.x402.feeAmount.toString(),
      feeUsd: input.x402.feeUsd,
      maxSponsorExposureTinybar: input.x402.maxSponsorExposureTinybar.toString(),
      maxFacilitatorExposureTinybar: (input.x402.maxFacilitatorExposureTinybar ?? 0n).toString(),
      maxExecutionExposureTinybar: (input.x402.maxExecutionExposureTinybar ?? input.x402.maxSponsorExposureTinybar).toString(),
      sponsorPolicy: {
        effectiveQuoteCapTinybar: (input.x402.sponsorExposureCapTinybar ?? SPONSOR.perRequestExposureCapTinybar).toString(),
        configuredPerRequestCapTinybar: SPONSOR.perRequestExposureCapTinybar.toString(),
        dailyExposureCapTinybar: SPONSOR.dailyExposureCapTinybar.toString(),
        reserveFloorTinybar: SPONSOR.minReserveTinybar.toString(),
        balanceTinybar: input.x402.sponsorBalanceTinybar?.toString() ?? null,
        reserveVerified: desiredAssessment.sponsor.reserveVerified,
        dailyUsageVerification: "rechecked_atomically_before_sponsored_submission",
        concurrentReservationVerification: "active maximum exposure reservations are included atomically before sponsored submission",
      },
      componentsTinybar: Object.fromEntries(
        Object.entries(input.x402.componentsTinybar).map(([name, value]) => [name, value.toString()]),
      ),
      executionLegs: executionLegs.map((leg) => ({
        id: leg.id,
        payer: leg.payer,
        stage: leg.stage,
        gasAllowanceTinybar: leg.gasAllowanceTinybar.toString(),
        hapiReserveTinybar: leg.hapiReserveTinybar.toString(),
        maximumTinybar: leg.maximumTinybar.toString(),
      })),
      perLegGasAllowanceTinybar: (input.x402.perLegGasAllowanceTinybar ?? []).map((value) => value.toString()),
      perLegHapiReserveTinybar: (input.x402.perLegHapiReserveTinybar ?? []).map((value) => value.toString()),
      estimatedCostTinybar: input.x402.estimatedCostTinybar?.toString() ?? null,
      marketEvidence: input.x402.marketEvidenceAt
        ? {
            observedAt: input.x402.marketEvidenceAt,
            gasPriceTinybarPerGas: input.x402.gasPriceTinybarPerGas?.toString() ?? null,
            hbarUsd: input.x402.hbarUsd ?? null,
          }
        : null,
      payTo: paymentRecipient ?? null,
      contextHash: `0x${quoteId}`,
      maxTimeoutSeconds: 180,
      contract: {
        permit2: contracts.permit2,
        proxy: contracts.proxy,
      },
    },
    amountLedger,
    outcome: {
      grossDestinationArrival: expectedArrival.toString(),
      expectedArrival: expectedArrival.toString(),
      minimumArrival: minimumArrival.toString(),
      x402ProtocolFee: input.x402.feeAmount.toString(),
      destinationSwapInputMaximum: input.saucer.paymentAssetAmountInMaximum.toString(),
      maximumDebit: maximumDebit.toString(),
      minimumRetainedByPolicy: minimumRetainedByPolicy.toString(),
      destinationAssetRemaining: retained.toString(),
      retainedAtMinimumArrival: retained.toString(),
      totalEffectiveDifference: amountLedger.destination.effectiveDifference,
      hbarMinimumTinybar: input.desiredHbarTinybar.toString(),
      status: "estimate",
    },
    feasibility: {
      schema: "refuel402.maximum-feasible-hbar.v1",
      maximumTinybar: maximumFeasibleTinybar.toString(),
      desiredTinybar: input.desiredHbarTinybar.toString(),
      headroomTinybar: (input.maximumFeasible?.headroomTinybar ?? 0n).toString(),
      limitingConstraint: effectiveLimitingConstraint,
      resolutionTinybar: (input.maximumFeasible?.resolutionTinybar ?? 0n).toString(),
      candidateBudget: input.maximumFeasible?.candidateBudget ?? 1,
      candidatesEvaluated: input.maximumFeasible?.candidatesEvaluated ?? 1,
      boundKind: "verified_feasible_lower_bound",
      solved: input.maximumFeasible?.solved ?? false,
      solveReason: input.maximumFeasible?.solveReason ?? "deferred_for_latency",
      desiredAssessment,
      maximumAssessment: input.maximumFeasible?.solved ? input.maximumFeasible.selectedEvaluation?.assessment ?? null : null,
      maximumComponents: input.maximumFeasible?.solved && input.maximumFeasible.selectedEvaluation
        ? {
            swapInputMaximum: input.maximumFeasible.selectedEvaluation.value.paymentAssetAmountInMaximum.toString(),
            x402ProtocolFee: input.maximumFeasible.selectedEvaluation.value.price.feeAmount.toString(),
            priceImpactBps: input.maximumFeasible.selectedEvaluation.value.priceImpactBps,
            sponsorExposureTinybar: input.maximumFeasible.selectedEvaluation.value.sponsorExposureTinybar.toString(),
            facilitatorExposureTinybar: input.maximumFeasible.selectedEvaluation.value.facilitatorExposureTinybar.toString(),
            totalExecutionExposureTinybar: input.maximumFeasible.selectedEvaluation.value.price.maxSponsorExposureTinybar.toString(),
          }
        : null,
    },
    costLedger,
    consent: {
      bridgeTransactionRequired: true,
      refuelConsentRequired: true,
      maxSlippageBps: input.slippageBps,
      refuelProtectionPreset: refuelCap.preset,
      refuelMaxAmountIn: refuelCap.maxAmountIn,
      refuelAuthorizationTtlSeconds: refuelCap.authorizationTtlSeconds,
      hbarClaim: "exact_output_minimum",
    },
    capabilities: {
      quote: !blockers.some((code) =>
        code === "EXPECTED_ARRIVAL_INSUFFICIENT" ||
        code === "PRICE_IMPACT_CAP_EXCEEDED" ||
        code === "SPONSOR_EXPOSURE_CAP_EXCEEDED" ||
        code === "DESIRED_HBAR_EXCEEDS_MAXIMUM" ||
        code === "STALE_QUOTE",
      ),
      // A route with no executable provider transaction is not executable, however
      // clean its blockers are. Without this the client was cleared to start a
      // journey and pay for a Hedera activation, and only then discovered there was
      // nothing to send — burning both and raising no wallet prompt at all.
      execute: input.runtimeAsset.runtime.executable &&
        blockers.length === 0 &&
        Boolean(input.bridge.transaction),
      acceptanceLevel: "integration_harness",
    },
    blockers: [...new Set(blockers)],
    expiresAt,
  };
}

const ERC20_ALLOWANCE_SELECTOR = "0xdd62ed3e";

/**
 * Live owner->Permit2 allowance for the destination token. Never throws: a read
 * failure must degrade to "not eligible for the one-signature path", never break
 * quoting, because the manual flow does not need this at all.
 */
async function readPermit2Allowance(input: {
  mirror: Mirror;
  token: Address;
  owner: Address;
  permit2: Address;
}): Promise<bigint> {
  const data = `${ERC20_ALLOWANCE_SELECTOR}${input.owner.slice(2).toLowerCase().padStart(64, "0")}${input.permit2.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  try {
    const result = await input.mirror.ethCall(input.token, data);
    return result && result !== "0x" ? BigInt(result) : 0n;
  } catch {
    return 0n;
  }
}

export async function buildCombinedQuote(input: {
  mode: ProductMode;
  requestedProvider: ProviderSelectionId;
  supportEvidenceAt: string;
  account: Address;
  asset: SupportAsset;
  runtimeAsset: ProductAssetOption;
  bridge: BridgeQuote;
  desiredHbarTinybar: bigint;
  slippageBps: number;
  refuelProtection?: {
    preset: RefuelPriceProtectionPreset;
    customMaxAmountIn?: bigint | null;
  };
  mirror: Mirror;
  solveMaximumHbar?: boolean;
}) {
  const startedAt = Date.now();
  if (!process.env.SAUCERSWAP_API_KEY) {
    throw new Error("complete-graph SaucerSwap API credential is required for an execution quote");
  }
  const simulationCaller = saucerQuoteSimulationCaller();
  const saucerTiming: SaucerQuoteTiming = {};
  let sponsorSnapshotPolicyMs = 0;
  let concurrentSponsorMarketMs = 0;
  // The sponsor snapshot and the one gas/HBAR market read have no Saucer
  // dependency; they overlap the serialized exact-output simulations. Their span
  // is reported on its own because it is concurrent, not additive, wall time.
  const sponsorMarketBranch = (async () => {
    const branchStartedAt = Date.now();
    try {
      return await Promise.all([
        SPONSOR.operatorId ? input.mirror.account(SPONSOR.operatorId) : null,
        fetchMarketSnapshot(input.mirror),
      ]);
    } finally {
      concurrentSponsorMarketMs = Date.now() - branchStartedAt;
    }
  })();
  const [best, [sponsorAccount, market]] = await Promise.all([
    quoteBestSaucerRoute(saucerRouteQuoteRequest({
      mode: input.mode,
      asset: input.asset,
      desiredHbarTinybar: input.desiredHbarTinybar,
      mirror: input.mirror,
      timing: saucerTiming,
    })),
    sponsorMarketBranch,
  ]);
  const bridge = input.bridge;
  const route = best.route;
  const exact = best.exact;
  const apiEvidence: SaucerApiEvidence = best.evidence;
  const routedAsset: SupportAsset = {
    ...input.asset,
    saucer: {
      ...input.asset.saucer,
      status: "verified",
      route,
      evidence: apiEvidence
        ? `Complete SaucerSwap API graph ${apiEvidence.graphHash}; exact-output best path selected from ${apiEvidence.quotedCandidatePathCount ?? apiEvidence.quotedV2CandidatePathCount ?? apiEvidence.v2ExecutableCandidatePathCount} bounded venue-aware candidates. ${apiEvidence.belowDisclosureLiquidityPathCount ?? 0} V2 candidates were below the liquidity execution floor; a below-floor selection stays disclosed but refuel execution is gated by SAUCER_LIQUIDITY_POLICY.`
        : input.asset.saucer.evidence,
    },
  };
  const routedRuntimeAsset: ProductAssetOption = {
    ...input.runtimeAsset,
    saucer: routedAsset.saucer,
    runtime: {
      ...input.runtimeAsset.runtime,
      // A live simulation disproves route/probe blockers; SAUCER_LIQUIDITY_POLICY
      // is a policy verdict, not a probe artifact, and must survive to the quote.
      blockers: apiEvidence
        ? input.runtimeAsset.runtime.blockers.filter((code) => !["SAUCER_ROUTE_UNAVAILABLE", "SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED", "SAUCER_QUOTER_CURRENT_PROBE_FAILED"].includes(code))
        : input.runtimeAsset.runtime.blockers,
    },
  };
  const reference = best.reference;
  if (!reference) throw new Error("SaucerSwap reference quote is absent from the serialized simulation set");
  const priceImpactBps = quantizationAwarePriceImpactBps({
    amountIn: exact.amountIn,
    amountOut: input.desiredHbarTinybar,
    referenceAmountIn: reference.amountIn,
    referenceAmountOut: reference.amountOut,
  });
  const amountInMaximum =
    (exact.amountIn * BigInt(10_000 + input.slippageBps) + 9_999n) / BPS;
  const wrapperRate = input.asset.destination.wrapper
    ? BigInt(input.asset.destination.wrapper.rate)
    : 1n;
  const paymentAssetAmountInMaximum = amountInMaximum * wrapperRate;
  const minimumRetainedBps = Number(process.env.MIN_RETAINED_TOKEN_BPS ?? 500);
  const maximumPriceImpactBps = Number(process.env.MAX_PRICE_IMPACT_BPS ?? 150);
  const configuredMaximumTinybar = BigInt(process.env.MAX_REFUEL_TINYBAR ?? 5_000_000_000n);
  const candidateBudget = Number(process.env.MAX_HBAR_SOLVER_CANDIDATES ?? 8);
  const minimumArrival = BigInt(bridge.minimumDestinationAmount);
  let sponsorBalanceTinybar: bigint | null | undefined;
  if (SPONSOR.operatorId) {
    if (!sponsorAccount) throw new Error("sponsor reserve account is unavailable for quote-time verification");
    sponsorBalanceTinybar = BigInt(sponsorAccount.balance.balance);
  }
  const sponsorPolicyCapTinybar = SPONSOR.perRequestExposureCapTinybar < SPONSOR.dailyExposureCapTinybar
    ? SPONSOR.perRequestExposureCapTinybar
    : SPONSOR.dailyExposureCapTinybar;
  const sponsorAvailableAboveReserve = sponsorBalanceTinybar === undefined || sponsorBalanceTinybar === null
    ? sponsorPolicyCapTinybar
    : sponsorBalanceTinybar > SPONSOR.minReserveTinybar
      ? sponsorBalanceTinybar - SPONSOR.minReserveTinybar
      : 0n;
  const sponsorExposureCapTinybar = sponsorAvailableAboveReserve < sponsorPolicyCapTinybar
    ? sponsorAvailableAboveReserve
    : sponsorPolicyCapTinybar;
  const selectedVenue = apiEvidence.selectedRoute?.venue ?? "v2";
  const selectedPath = selectedVenue === "v2"
    ? encodeExactOutputPath(best.tokens, route.map((hop) => hop.fee))
    : null;
  const quoteSelectedExactOutput = (outputTinybar: bigint) => selectedVenue === "v1"
    ? input.mirror.quoteV1ExactOutput(NETWORKS[input.mode].v1Router!, best.tokens, outputTinybar, simulationCaller)
    : input.mirror.quoteExactOutput(NETWORKS[input.mode].quoter, selectedPath!, outputTinybar, simulationCaller);

  const candidateFor = async (
    outputTinybar: bigint,
    quoted: { amountIn: bigint; gasEstimate: bigint },
    fixedMarket?: { gasPriceTinybarPerGas: bigint; hbarUsd: number; observedAt: string },
  ) => {
    const impactBps = quantizationAwarePriceImpactBps({
      amountIn: quoted.amountIn,
      amountOut: outputTinybar,
      referenceAmountIn: reference.amountIn,
      referenceAmountOut: reference.amountOut,
    });
    const maximumInput = (quoted.amountIn * BigInt(10_000 + input.slippageBps) + 9_999n) / BPS;
    const paymentMaximum = maximumInput * wrapperRate;
    const legs = productExecutionLegPlan(input.asset, quoted.gasEstimate);
    const expectedGas = legs.map((leg) => leg.expectedGas);
    const sponsorStartedAt = Date.now();
    const priced = await priceSponsorship({
      mirror: input.mirror,
      cfg: pricingConfig(),
      totalGasLimit: expectedGas.reduce((sum, value) => sum + value, 0n) * 2n,
      expectedGasUnits: expectedGas.reduce((sum, value) => sum + value, 0n),
      perLegExpectedGas: expectedGas,
      perTxAllowanceCapTinybar: SPONSOR.perTxAllowanceCapTinybar,
      perLegHapiReserveTinybar: legs.map((leg) =>
        leg.payer === "sponsor" ? SPONSOR.hapiReservePerLegTinybar : 0n),
      amountIn: paymentMaximum,
      expectedOutTinybar: outputTinybar,
      feeTokenId: input.asset.destination.tokenId ?? input.asset.destination.address,
      feeTokenSymbol: input.asset.symbol,
      ...(fixedMarket ? { market: fixedMarket } : {}),
    });
    sponsorSnapshotPolicyMs += Date.now() - sponsorStartedAt;
    const sponsorExposureTinybar = legs.reduce((sum, leg, index) =>
      leg.payer === "sponsor"
        ? sum + priced.perLegGasAllowanceTinybar[index]! + priced.perLegHapiReserveTinybar[index]!
        : sum, 0n);
    const facilitatorExposureTinybar = legs.reduce((sum, leg, index) =>
      leg.payer === "facilitator"
        ? sum + priced.perLegGasAllowanceTinybar[index]! + priced.perLegHapiReserveTinybar[index]!
        : sum, 0n);
    if (sponsorExposureTinybar + facilitatorExposureTinybar !== priced.maxSponsorExposureTinybar) {
      throw new AmountInvariantError("EXPOSURE_DECOMPOSITION_MISMATCH", "execution exposure decomposition does not reconcile");
    }
    const assessment = assessProductFeasibility({
      minimumArrival,
      x402ProtocolFee: priced.feeAmount,
      swapInputMaximum: paymentMaximum,
      minimumRetainedBps,
      priceImpactBps: impactBps,
      maximumPriceImpactBps,
      maximumSponsorExposureTinybar: sponsorExposureTinybar,
      sponsorExposureCapTinybar,
      sponsorReserveFloorTinybar: SPONSOR.minReserveTinybar,
      sponsorBalanceTinybar,
    });
    const value: FeasibilityCandidate = {
      amountIn: quoted.amountIn,
      amountInMaximum: maximumInput,
      paymentAssetAmountInMaximum: paymentMaximum,
      priceImpactBps: impactBps,
      gasEstimate: quoted.gasEstimate,
      price: priced,
      sponsorExposureTinybar,
      facilitatorExposureTinybar,
      assessment,
    };
    return { outputTinybar, assessment, value };
  };

  const desiredEvaluation = await candidateFor(input.desiredHbarTinybar, exact, market);
  const fairValue = assessQuoteFairValue({
    amountIn: exact.amountIn,
    tokenDecimals: apiEvidence.decimals,
    desiredHbarTinybar: input.desiredHbarTinybar,
    tokenPriceUsd: apiEvidence.priceUsd ?? null,
    hbarUsd: market.hbarUsd,
  });
  const maximumStartedAt = Date.now();
  const maximumFeasible = input.solveMaximumHbar || !desiredEvaluation.assessment.feasible
    ? await solveMaximumFeasibleHbar<FeasibilityCandidate>({
        desiredTinybar: input.desiredHbarTinybar,
        configuredMaximumTinybar,
        candidateBudget,
        desiredEvaluation,
        evaluate: async (outputTinybar) => {
          try {
            const quoted = await quoteSelectedExactOutput(outputTinybar);
            return candidateFor(outputTinybar, quoted, market);
          } catch (error) {
            if (error instanceof MirrorQuoteError && error.code === "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP") throw error;
            // A broken amount/exposure invariant is a data inconsistency at any
            // probe amount, not an unavailable route; it must reach the 502 map.
            if (error instanceof AmountInvariantError) throw error;
            const assessment: FeasibilityAssessment = {
              ...desiredEvaluation.assessment,
              feasible: false,
              limitingConstraint: "ROUTE_UNAVAILABLE",
            };
            return {
              outputTinybar,
              assessment,
              value: { ...desiredEvaluation.value, assessment },
            };
          }
        },
      })
    : deferMaximumFeasibleHbar({
        desiredTinybar: input.desiredHbarTinybar,
        configuredMaximumTinybar,
        candidateBudget,
        desiredEvaluation,
      });
  const maximumSolverMs = Date.now() - maximumStartedAt;
  const price = desiredEvaluation.value.price;

  // Permit2 SignatureTransfer moves the token through the token's own
  // transferFrom, so the owner must already have approved Permit2 for at least
  // the cap. The only approval this product builds is fee-sized, so without this
  // read every pre-authorized execution would revert on chain. Reading it here
  // lets the quote publish the one-signature path ONLY to accounts that can
  // actually use it, and everyone else silently keeps today's manual flow.
  const permit2Allowance = await readPermit2Allowance({
    mirror: input.mirror,
    token: getAddress(routedAsset.destination.address),
    owner: input.account,
    permit2: productContractAddresses(input.mode).permit2,
  });

  const quote = composeCombinedQuote({
    permit2Allowance,
    mode: input.mode,
    requestedProvider: input.requestedProvider,
    supportEvidenceAt: input.supportEvidenceAt,
    account: input.account,
    asset: routedAsset,
    runtimeAsset: routedRuntimeAsset,
    bridge,
    desiredHbarTinybar: input.desiredHbarTinybar,
    slippageBps: input.slippageBps,
    refuelProtection: input.refuelProtection,
    saucer: {
      amountIn: exact.amountIn,
      amountInMaximum,
      paymentAssetAmountInMaximum,
      gasEstimate: exact.gasEstimate,
      priceImpactBps,
      apiEvidence,
      simulatedAtMs: best.simulatedAt,
      expiresAtMs: best.expiresAt,
    },
    x402: {
      feeAmount: price.feeAmount,
      feeUsd: price.feeUsd,
      maxSponsorExposureTinybar: desiredEvaluation.value.sponsorExposureTinybar,
      maxFacilitatorExposureTinybar: desiredEvaluation.value.facilitatorExposureTinybar,
      maxExecutionExposureTinybar: price.maxSponsorExposureTinybar,
      componentsTinybar: price.feeComponentsTinybar,
      perLegGasAllowanceTinybar: price.perLegGasAllowanceTinybar,
      perLegHapiReserveTinybar: price.perLegHapiReserveTinybar,
      estimatedCostTinybar: price.estimatedCostTinybar,
      gasPriceTinybarPerGas: price.gasPriceTinybarPerGas,
      hbarUsd: price.hbarUsd,
      marketEvidenceAt: price.marketEvidence.observedAt,
      sponsorBalanceTinybar,
      sponsorExposureCapTinybar,
      expiresAt: price.expiresAt,
    },
    fairValue,
    maximumFeasible,
    minimumRetainedBps,
  });
  return {
    ...quote,
    timing: {
      schema: "refuel402.quote-timing.v1",
      saucerGraphMs: saucerTiming.graphMs ?? 0,
      saucerGraphCache: saucerTiming.graphCache ?? "unknown",
      exactOutputSimulationMs: saucerTiming.exactOutputSimulationMs ?? 0,
      saucerQuoteCache: saucerTiming.quoteCache ?? "unknown",
      // Own serial durations. Solver-candidate pricing is counted here and again
      // inside maximumSolverMs, which is the span that contains it.
      sponsorSnapshotPolicyMs,
      concurrentSponsorMarketMs,
      maximumSolverMs,
      maximumSolverMode: maximumFeasible.solved ? maximumFeasible.solveReason : "deferred_for_latency",
      totalCombinedQuoteMs: Date.now() - startedAt,
    },
  };
}
