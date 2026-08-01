import { AmountInvariantError } from "./amount-domain.js";
import type { BridgeQuote } from "./bridge.js";
import type { SupportAsset } from "./support.js";

export type QuoteFundingSource =
  | "user_origin"
  | "deducted_from_bridge"
  | "sponsor"
  | "included_in_swap";

export type QuoteCostExactness = "exact" | "quote_bound" | "estimated" | "maximum" | "included" | "unknown";

export type QuoteCostEntry = {
  id: string;
  label: string;
  stage:
    | "origin_approval"
    | "bridge"
    | "destination_activation"
    | "x402"
    | "wrapper"
    | "saucer"
    | "policy"
    | "outcome";
  payer: "user" | "sponsor" | "facilitator" | "provider";
  fundingSource: QuoteFundingSource;
  asset: {
    symbol: string;
    address: string | null;
    decimals: number | null;
    kind: "token" | "native" | "gas_units" | "rate";
  };
  quantity: {
    baseUnits: string | null;
    unit: "base_units" | "wei" | "tinybar" | "gas_units" | "basis_points" | "not_independently_quoted";
    exactness: QuoteCostExactness;
  };
  fiat: {
    currency: "USD";
    amount: number;
    evidenceAt: string;
  } | null;
  aggregation?: "included" | "excluded_overlap";
  note: string | null;
};

function sourceNativeSymbol(chainId: string): string {
  if (["1", "42161", "8453"].includes(chainId)) return "ETH";
  if (chainId === "43114") return "AVAX";
  if (chainId === "56") return "BNB";
  if (chainId === "137") return "POL";
  return "native gas";
}

function grouped(entries: QuoteCostEntry[], source: QuoteFundingSource, payer?: QuoteCostEntry["payer"]) {
  const totals = new Map<string, { symbol: string; address: string | null; decimals: number | null; baseUnits: bigint }>();
  for (const entry of entries) {
    if (entry.fundingSource !== source || (payer && entry.payer !== payer) || entry.quantity.baseUnits === null || entry.aggregation === "excluded_overlap") continue;
    if (!["base_units", "wei", "tinybar"].includes(entry.quantity.unit)) continue;
    const key = `${entry.asset.kind}:${entry.asset.address ?? entry.asset.symbol}:${entry.quantity.unit}`;
    const row = totals.get(key) ?? {
      symbol: entry.asset.symbol,
      address: entry.asset.address,
      decimals: entry.asset.decimals,
      baseUnits: 0n,
    };
    row.baseUnits += BigInt(entry.quantity.baseUnits);
    totals.set(key, row);
  }
  return [...totals.values()].map((row) => ({ ...row, baseUnits: row.baseUnits.toString() }));
}

export function buildQuoteCostLedger(input: {
  bridge: BridgeQuote;
  asset: SupportAsset;
  sourceAmount: { symbol: string; decimals: number; address: string; native?: boolean };
  minimumArrival: bigint;
  retainedAtMinimum: bigint;
  x402FeeAmount: bigint;
  x402FeeUsd: number;
  marketEvidenceAt: string | null;
  swapInputExact: bigint;
  swapInputMaximum: bigint;
  paymentAssetSwapInputMaximum: bigint;
  slippageBufferPaymentAsset: bigint;
  priceImpactBps: number;
  saucerRoute: {
    hops?: {
      index: number;
      feeBps: number;
      pool: { id: string };
      liquidityUsd: number | null;
      input?: { symbol: string | null };
    }[];
    perHopAmountsAvailable?: boolean;
  } | null;
  sponsoredLegs: {
    id: string;
    label: string;
    stage: QuoteCostEntry["stage"];
    payer?: "sponsor" | "facilitator";
    maximumTinybar: bigint;
  }[];
  maximumSponsorExposureTinybar: bigint;
  desiredHbarTinybar: bigint;
}) {
  const entries: QuoteCostEntry[] = [];
  const sourceToken = {
    symbol: input.sourceAmount.symbol,
    address: input.sourceAmount.native ? null : input.sourceAmount.address,
    decimals: input.sourceAmount.decimals,
    kind: input.sourceAmount.native ? "native" as const : "token" as const,
  };
  const destinationToken = {
    symbol: input.asset.symbol,
    address: input.asset.destination.address,
    decimals: input.asset.destination.decimals,
    kind: "token" as const,
  };
  entries.push({
    id: "origin_principal",
    label: "Origin amount committed to bridge",
    stage: "bridge",
    payer: "user",
    fundingSource: "user_origin",
    asset: sourceToken,
    quantity: { baseUnits: input.bridge.fromAmount, unit: input.sourceAmount.native ? "wei" : "base_units", exactness: "exact" },
    fiat: null,
    note: "Principal, not a fee; destination arrival is reconciled separately.",
  });
  if (input.bridge.originApproval) {
    entries.push({
      id: "origin_approval_gas",
      label: "Origin token approval gas",
      stage: "origin_approval",
      payer: "user",
      fundingSource: "user_origin",
      asset: { symbol: sourceNativeSymbol(input.bridge.originChainId), address: null, decimals: 18, kind: "native" },
      quantity: { baseUnits: null, unit: "wei", exactness: "estimated" },
      fiat: null,
      note: "MetaMask estimates this native gas immediately before consent; it is not deducted from the bridged token.",
    });
  }
  const bridgeValue = BigInt(input.bridge.transaction?.value ?? 0);
  const bridgeFeeValue = input.sourceAmount.native
    ? bridgeValue - BigInt(input.bridge.fromAmount)
    : bridgeValue;
  if (bridgeFeeValue < 0n) throw new AmountInvariantError("BRIDGE_VALUE_BELOW_PRINCIPAL", "bridge transaction value is below the native source principal");
  if (bridgeFeeValue > 0n) {
    entries.push({
      id: "bridge_native_value",
      label: input.sourceAmount.native ? "Bridge messaging fee" : "Bridge native value / messaging fee",
      stage: "bridge",
      payer: "user",
      fundingSource: "user_origin",
      asset: { symbol: sourceNativeSymbol(input.bridge.originChainId), address: null, decimals: 18, kind: "native" },
      quantity: { baseUnits: bridgeFeeValue.toString(), unit: "wei", exactness: "quote_bound" },
      fiat: null,
      note: input.sourceAmount.native
        ? "The transaction value also carries the separately itemized native source principal; this row records only the messaging fee."
        : "Transaction value quoted by the bridge adapter; origin transaction gas remains separate.",
    });
  }
  entries.push({
    id: "bridge_transaction_gas",
    label: "Bridge transaction gas",
    stage: "bridge",
    payer: "user",
    fundingSource: "user_origin",
    asset: { symbol: sourceNativeSymbol(input.bridge.originChainId), address: null, decimals: 18, kind: "native" },
    quantity: {
      baseUnits: input.bridge.transaction?.gas ?? null,
      unit: input.bridge.transaction?.gas ? "gas_units" : "wei",
      exactness: input.bridge.transaction?.gas ? "maximum" : "estimated",
    },
    fiat: null,
    note: input.bridge.transaction?.gas
      ? "Gas-unit limit only; no native-currency total is added without a same-time gas price."
      : "MetaMask estimates native gas before consent; no fake native total is inferred.",
  });
  const sourceComparable = input.sourceAmount.decimals === input.asset.destination.decimals;
  const effectiveProviderDeduction = sourceComparable
    ? BigInt(input.bridge.fromAmount) - BigInt(input.bridge.expectedDestinationAmount)
    : null;
  const itemizedSourceFees = input.bridge.fees
    .filter((fee) => fee.symbol === input.sourceAmount.symbol)
    .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  const itemizedOverlap = effectiveProviderDeduction !== null && itemizedSourceFees > effectiveProviderDeduction;
  input.bridge.fees.forEach((fee, index) => {
    const sourceDenominated = !input.sourceAmount.native && fee.symbol === input.sourceAmount.symbol;
    const nativeDenominated = fee.symbol === sourceNativeSymbol(input.bridge.originChainId);
    const duplicatesBridgeValue = bridgeFeeValue > 0n &&
      nativeDenominated &&
      BigInt(fee.amount) === bridgeFeeValue;
    const overlap = (itemizedOverlap && sourceDenominated) || duplicatesBridgeValue;
    entries.push({
      id: `bridge_fee_${index}`,
      label: fee.name,
      stage: "bridge",
      payer: "user",
      fundingSource: sourceDenominated ? "deducted_from_bridge" : "user_origin",
      asset: {
        symbol: fee.symbol ?? "unknown",
        address: sourceDenominated ? input.sourceAmount.address : null,
        decimals: sourceDenominated ? input.sourceAmount.decimals : nativeDenominated ? 18 : null,
        kind: nativeDenominated ? "native" : "token",
      },
      quantity: { baseUnits: fee.amount || null, unit: nativeDenominated ? "wei" : "base_units", exactness: "estimated" },
      fiat: fee.usd === null ? null : { currency: "USD", amount: fee.usd, evidenceAt: input.bridge.normalized.evidence.observedAt },
      ...(overlap ? { aggregation: "excluded_overlap" as const } : {}),
      note: duplicatesBridgeValue
        ? "The same native amount is already represented by the bridge transaction value and is disclosed without adding it again."
        : itemizedOverlap && sourceDenominated
          ? "Provider-returned component overlaps the canonical source-input-to-arrival difference and is disclosed without adding it again."
          : fee.category === "gas_relayer"
          ? "Provider/relayer estimate; denomination is preserved."
          : "Provider-returned fee estimate.",
    });
  });
  const canonicalProviderRemainder = effectiveProviderDeduction === null
    ? 0n
    : effectiveProviderDeduction - (itemizedOverlap ? 0n : itemizedSourceFees);
  if (canonicalProviderRemainder > 0n) {
    entries.push({
      id: "bridge_effective_provider_difference",
      label: itemizedOverlap ? "Canonical bridge/provider deduction" : "Unitemized bridge/provider difference",
      stage: "bridge",
      payer: "user",
      fundingSource: "deducted_from_bridge",
      asset: sourceToken,
      quantity: { baseUnits: canonicalProviderRemainder.toString(), unit: "base_units", exactness: "estimated" },
      fiat: null,
      note: "Reconciles source input to gross destination arrival in equal-decimal bridge units; provider components are not double counted.",
    });
  }
  entries.push({
    id: "x402_protocol_fee",
    label: "x402 / Permit2 / proxy / policy fee",
    stage: "x402",
    payer: "user",
    fundingSource: "deducted_from_bridge",
    asset: destinationToken,
    quantity: { baseUnits: input.x402FeeAmount.toString(), unit: "base_units", exactness: "quote_bound" },
    fiat: input.marketEvidenceAt
      ? { currency: "USD", amount: input.x402FeeUsd, evidenceAt: input.marketEvidenceAt }
      : null,
    note: "Quote-bound destination-token fee; sponsor gas exposure is itemized separately.",
  });
  if (input.asset.destination.wrapper) {
    entries.push({
      id: "wrapper_conversion",
      label: "ERC20 → HTS wrapper conversion",
      stage: "wrapper",
      payer: "user",
      fundingSource: "included_in_swap",
      asset: destinationToken,
      quantity: { baseUnits: input.paymentAssetSwapInputMaximum.toString(), unit: "base_units", exactness: "included" },
      fiat: null,
      note: `Representation boundary only: rate ${input.asset.destination.wrapper.rate} raw ERC20 units per HTS base unit. The same amount is debited once by the Saucer-input row; approval and wrap gas are sponsor-covered.`,
    });
  }
  const tradeToken = input.asset.destination.wrapper
    ? {
        symbol: input.saucerRoute?.hops?.[0]?.input?.symbol ?? `HTS-${input.asset.symbol}`,
        address: input.asset.destination.wrapper.htsAddress,
        decimals: 8,
        kind: "token" as const,
      }
    : destinationToken;
  entries.push({
    id: "saucer_swap_input_estimate",
    label: "Saucer exact-output input estimate",
    stage: "saucer",
    payer: "user",
    fundingSource: "included_in_swap",
    asset: tradeToken,
    quantity: { baseUnits: input.swapInputExact.toString(), unit: "base_units", exactness: "estimated" },
    fiat: null,
    note: "Expected Router input from the exact-output quote; already bounded by the separate maximum and not added as a second debit.",
  });
  entries.push({
    id: "saucer_swap_input",
    label: "Saucer exact-output input maximum",
    stage: "saucer",
    payer: "user",
    fundingSource: "deducted_from_bridge",
    asset: destinationToken,
    quantity: { baseUnits: input.paymentAssetSwapInputMaximum.toString(), unit: "base_units", exactness: "maximum" },
    fiat: null,
    note: input.asset.destination.wrapper
      ? `Raw-token equivalent of ${input.swapInputMaximum} HTS base units; wrapper conversion is a boundary, not a second debit.`
      : `Router may pull up to ${input.swapInputMaximum} destination-token base units.`,
  });
  entries.push({
    id: "slippage_buffer",
    label: "Slippage buffer (unused amount retained)",
    stage: "saucer",
    payer: "user",
    fundingSource: "included_in_swap",
    asset: destinationToken,
    quantity: { baseUnits: input.slippageBufferPaymentAsset.toString(), unit: "base_units", exactness: "maximum" },
    fiat: null,
    note: "This is approval/swap headroom, not an automatic charge; unused input remains with the user.",
  });
  entries.push({
    id: "price_impact",
    label: "Quoted price impact",
    stage: "saucer",
    payer: "user",
    fundingSource: "included_in_swap",
    asset: { symbol: "bps", address: null, decimals: null, kind: "rate" },
    quantity: { baseUnits: String(input.priceImpactBps), unit: "basis_points", exactness: "estimated" },
    fiat: null,
    note: "Rate effect already reflected in exact-output input; never added again as a token fee.",
  });
  for (const hop of input.saucerRoute?.hops ?? []) {
    entries.push({
      id: `saucer_lp_fee_${hop.index}`,
      label: `Saucer V2 pool fee · ${hop.pool.id}`,
      stage: "saucer",
      payer: "user",
      fundingSource: "included_in_swap",
      asset: { symbol: "bps", address: null, decimals: null, kind: "rate" },
      quantity: { baseUnits: String(hop.feeBps), unit: "basis_points", exactness: "included" },
      fiat: null,
      note: hop.liquidityUsd === null
        ? "Fee tier is included in the quoted route; per-hop token amounts are not independently quoted."
        : `Fee tier is included in the quoted route; pool liquidity evidence $${hop.liquidityUsd.toFixed(2)}.`,
    });
  }
  for (const leg of input.sponsoredLegs) {
    entries.push({
      id: `sponsor_${leg.id}`,
      label: leg.label,
      stage: leg.stage,
      payer: leg.payer ?? "sponsor",
      fundingSource: "sponsor",
      asset: { symbol: "HBAR", address: null, decimals: 8, kind: "native" },
      quantity: { baseUnits: leg.maximumTinybar.toString(), unit: "tinybar", exactness: "maximum" },
      fiat: null,
      note: "Maximum externally funded gas/HAPI authorization; payer is explicit and the amount is never deducted from bridged principal or added to user-paid totals.",
    });
  }
  const sponsoredGasTotal = input.sponsoredLegs.reduce((sum, leg) => sum + leg.maximumTinybar, 0n);
  const sponsoredReserve = input.maximumSponsorExposureTinybar > sponsoredGasTotal
    ? input.maximumSponsorExposureTinybar - sponsoredGasTotal
    : 0n;
  if (sponsoredReserve > 0n) {
    entries.push({
      id: "sponsor_policy_reserve",
      label: "Sponsor HAPI / failure reserve",
      stage: "policy",
      payer: "sponsor",
      fundingSource: "sponsor",
      asset: { symbol: "HBAR", address: null, decimals: 8, kind: "native" },
      quantity: { baseUnits: sponsoredReserve.toString(), unit: "tinybar", exactness: "maximum" },
      fiat: null,
      note: "Fixed policy reserve completing the quote-bound sponsor exposure maximum; never charged to bridged principal.",
    });
  }
  return {
    schema: "refuel402.quote-cost-ledger.v1" as const,
    entries,
    summary: {
      userPaid: grouped(entries, "user_origin"),
      deductedFromBridge: grouped(entries, "deducted_from_bridge"),
      sponsorCovered: grouped(entries, "sponsor", "sponsor"),
      facilitatorCovered: grouped(entries, "sponsor", "facilitator"),
      includedInSwap: grouped(entries, "included_in_swap"),
      retainedBridgedAsset: {
        symbol: input.asset.symbol,
        address: input.asset.destination.address,
        decimals: input.asset.destination.decimals,
        baseUnits: input.retainedAtMinimum.toString(),
        exactness: "minimum" as const,
      },
      hbarReceived: {
        symbol: "HBAR",
        decimals: 8,
        baseUnits: input.desiredHbarTinybar.toString(),
        exactness: "exact" as const,
      },
      externalExecutionExposureMaximumTinybar: input.maximumSponsorExposureTinybar.toString(),
      fiatTotal: null,
      fiatTotalReason: "No aggregate fiat total: token, native-gas, and sponsor evidence do not share one complete timestamped price set.",
    },
  };
}
