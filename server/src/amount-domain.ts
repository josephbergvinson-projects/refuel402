const BPS = 10_000n;

export type CanonicalAmountLedgerInput = {
  sourceInput: bigint;
  providerFeeSource: bigint;
  providerGasRelayerSource: bigint;
  destinationArrivalInSourceUnits?: bigint | null;
  grossDestination: bigint;
  minimumDestination: bigint;
  x402ProtocolFee: bigint;
  destinationSwapInput: bigint;
  /**
   * The swap input at the QUOTED rate, before the max-slippage buffer.
   * `destinationSwapInput` is the ceiling the router may pull; this is what it is
   * expected to pull. Omitted it collapses to the ceiling, which keeps the
   * expected figure conservative rather than optimistic.
   */
  destinationSwapInputExpected?: bigint;
  exactHbarTinybar: bigint;
  minimumHbarTinybar: bigint;
  minimumRetainedBps: number;
};

export class AmountInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function nonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new AmountInvariantError("NEGATIVE_AMOUNT", `${name} cannot be negative`);
}

/**
 * Canonical server-side amount authority for the product quote.
 *
 * Source and destination units are deliberately not subtracted from one another:
 * provider fees are reconciled in source units, while protocol/swap/remaining are
 * reconciled in destination units. This prevents false arithmetic across assets
 * with different denominations or decimals.
 */
export function reconcileCanonicalAmounts(input: CanonicalAmountLedgerInput) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "bigint") nonNegative(name, value);
  }
  if (!Number.isInteger(input.minimumRetainedBps) || input.minimumRetainedBps < 0 || input.minimumRetainedBps > 10_000) {
    throw new AmountInvariantError("RETAINED_BPS_INVALID", "minimum retained basis points must be 0-10000");
  }
  if (input.providerFeeSource + input.providerGasRelayerSource > input.sourceInput) {
    throw new AmountInvariantError("SOURCE_FEES_EXCEED_INPUT", "provider and relayer fees exceed the source input");
  }
  if (input.minimumDestination > input.grossDestination) {
    throw new AmountInvariantError("MINIMUM_EXCEEDS_GROSS", "minimum destination amount exceeds the expected gross arrival");
  }
  if (input.minimumHbarTinybar > input.exactHbarTinybar) {
    throw new AmountInvariantError("MINIMUM_HBAR_EXCEEDS_EXACT", "minimum HBAR output exceeds the exact/expected output");
  }
  const swapInputExpected = input.destinationSwapInputExpected ?? input.destinationSwapInput;
  if (swapInputExpected > input.destinationSwapInput) {
    throw new AmountInvariantError(
      "EXPECTED_SWAP_INPUT_EXCEEDS_MAXIMUM",
      "expected destination swap input exceeds the slippage-bounded maximum",
    );
  }

  const sourceAfterProviderCosts = input.sourceInput - input.providerFeeSource - input.providerGasRelayerSource;
  const itemizedProviderDeductions = input.providerFeeSource + input.providerGasRelayerSource;
  const sourceArrivalEquivalent = input.destinationArrivalInSourceUnits ?? null;
  if (sourceArrivalEquivalent !== null && sourceArrivalEquivalent > input.sourceInput) {
    throw new AmountInvariantError("ARRIVAL_EQUIVALENT_EXCEEDS_INPUT", "source-equivalent destination arrival exceeds source input");
  }
  const effectiveProviderDeductions = sourceArrivalEquivalent === null
    ? itemizedProviderDeductions
    : input.sourceInput - sourceArrivalEquivalent;
  const unitemizedProviderDifference = effectiveProviderDeductions > itemizedProviderDeductions
    ? effectiveProviderDeductions - itemizedProviderDeductions
    : 0n;
  const itemizedFeeOverlap = itemizedProviderDeductions > effectiveProviderDeductions
    ? itemizedProviderDeductions - effectiveProviderDeductions
    : 0n;
  const sourceConserved = sourceArrivalEquivalent === null
    ? input.sourceInput === itemizedProviderDeductions + sourceAfterProviderCosts
    : input.sourceInput === effectiveProviderDeductions + sourceArrivalEquivalent;
  const destinationConsumed = input.x402ProtocolFee + input.destinationSwapInput;
  const remainingAtMinimum = input.minimumDestination > destinationConsumed
    ? input.minimumDestination - destinationConsumed
    : 0n;
  // What the owner actually expects to keep: the quoted arrival less the protocol
  // fee and the swap input at the quoted rate. Both slippage buffers (the
  // provider's on arrival, the router's on the swap) are absent here by
  // construction — they are what separates this from remainingAtMinimum.
  const destinationConsumedExpected = input.x402ProtocolFee + swapInputExpected;
  const remainingExpected = input.grossDestination > destinationConsumedExpected
    ? input.grossDestination - destinationConsumedExpected
    : 0n;
  const minimumRetainedByPolicy = input.minimumDestination * BigInt(input.minimumRetainedBps) / BPS;
  const providerSlippageBuffer = input.grossDestination - input.minimumDestination;
  const destinationConserved = input.grossDestination === providerSlippageBuffer + destinationConsumed + remainingAtMinimum;
  const expectedConserved = input.grossDestination === destinationConsumedExpected + remainingExpected;
  const sufficient = destinationConsumed + minimumRetainedByPolicy <= input.minimumDestination;

  return {
    schema: "refuel402.amount-ledger.v1" as const,
    source: {
      input: input.sourceInput.toString(),
      providerFee: input.providerFeeSource.toString(),
      gasRelayerFee: input.providerGasRelayerSource.toString(),
      afterProviderCosts: sourceAfterProviderCosts.toString(),
      arrivalEquivalent: sourceArrivalEquivalent?.toString() ?? null,
      itemizedProviderDeductions: itemizedProviderDeductions.toString(),
      effectiveProviderDeductions: effectiveProviderDeductions.toString(),
      unitemizedProviderDifference: unitemizedProviderDifference.toString(),
      itemizedFeeOverlap: itemizedFeeOverlap.toString(),
      effectiveCost: effectiveProviderDeductions.toString(),
      equation: sourceArrivalEquivalent === null
        ? "input = itemizedProviderDeductions + afterProviderCosts (cross-unit arrival not comparable)"
        : "input = effectiveProviderDeductions + sourceEquivalentDestinationArrival",
      reconciled: sourceConserved,
    },
    destination: {
      grossArrival: input.grossDestination.toString(),
      minimumArrival: input.minimumDestination.toString(),
      x402ProtocolFee: input.x402ProtocolFee.toString(),
      swapInputMaximum: input.destinationSwapInput.toString(),
      swapInputExpected: swapInputExpected.toString(),
      consumedMaximum: destinationConsumed.toString(),
      consumedExpected: destinationConsumedExpected.toString(),
      remainingAtMinimum: remainingAtMinimum.toString(),
      remainingExpected: remainingExpected.toString(),
      minimumRetainedByPolicy: minimumRetainedByPolicy.toString(),
      providerSlippageBuffer: providerSlippageBuffer.toString(),
      effectiveDifference: (input.grossDestination - remainingAtMinimum).toString(),
      equation: "grossArrival = providerSlippageBuffer + x402ProtocolFee + swapInputMaximum + remainingAtMinimum",
      expectedEquation: "grossArrival = x402ProtocolFee + swapInputExpected + remainingExpected",
      reconciled: destinationConserved,
      expectedReconciled: expectedConserved,
      sufficient,
    },
    hbar: {
      exactOutputTinybar: input.exactHbarTinybar.toString(),
      minimumOutputTinybar: input.minimumHbarTinybar.toString(),
      equation: "exactOutputTinybar >= minimumOutputTinybar",
      reconciled: input.exactHbarTinybar >= input.minimumHbarTinybar,
    },
    allInvariantsHold:
      sourceConserved &&
      destinationConserved &&
      expectedConserved &&
      remainingExpected >= remainingAtMinimum &&
      input.exactHbarTinybar >= input.minimumHbarTinybar,
  };
}
