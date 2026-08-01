import { describe, expect, it } from "vitest";
import { AmountInvariantError, reconcileCanonicalAmounts } from "../src/amount-domain.js";

function ledger(overrides: Partial<Parameters<typeof reconcileCanonicalAmounts>[0]> = {}) {
  return reconcileCanonicalAmounts({
    sourceInput: 10_000_000n,
    providerFeeSource: 50_000n,
    providerGasRelayerSource: 25_000n,
    destinationArrivalInSourceUnits: 9_925_000n,
    grossDestination: 9_925_000n,
    minimumDestination: 9_800_000n,
    x402ProtocolFee: 20_000n,
    destinationSwapInput: 330_000n,
    destinationSwapInputExpected: 320_000n,
    exactHbarTinybar: 500_000_000n,
    minimumHbarTinybar: 500_000_000n,
    minimumRetainedBps: 500,
    ...overrides,
  });
}

describe("canonical amount ledger", () => {
  it("reconciles source, destination, and exact HBAR equations without cross-asset arithmetic", () => {
    const result = ledger();
    expect(result.source).toMatchObject({
      input: "10000000",
      providerFee: "50000",
      gasRelayerFee: "25000",
      afterProviderCosts: "9925000",
      arrivalEquivalent: "9925000",
      itemizedProviderDeductions: "75000",
      effectiveProviderDeductions: "75000",
      unitemizedProviderDifference: "0",
      reconciled: true,
    });
    expect(result.destination).toMatchObject({
      grossArrival: "9925000",
      minimumArrival: "9800000",
      x402ProtocolFee: "20000",
      swapInputMaximum: "330000",
      swapInputExpected: "320000",
      consumedMaximum: "350000",
      consumedExpected: "340000",
      remainingAtMinimum: "9450000",
      remainingExpected: "9585000",
      providerSlippageBuffer: "125000",
      reconciled: true,
      expectedReconciled: true,
      sufficient: true,
    });
    expect(result.hbar).toMatchObject({ exactOutputTinybar: "500000000", minimumOutputTinybar: "500000000", reconciled: true });
    expect(result.allInvariantsHold).toBe(true);
  });

  it("is decimal-safe across representative base-unit ranges", () => {
    for (let exponent = 0; exponent <= 36; exponent += 3) {
      const input = 10n ** BigInt(exponent) + 999n;
      const provider = input / 100n;
      const gas = input / 200n;
      const destination = input - provider - gas;
      const protocol = destination / 1000n;
      const swap = destination / 4n;
      const result = ledger({
        sourceInput: input,
        providerFeeSource: provider,
        providerGasRelayerSource: gas,
        destinationArrivalInSourceUnits: destination,
        grossDestination: destination,
        minimumDestination: destination,
        x402ProtocolFee: protocol,
        destinationSwapInput: swap,
        destinationSwapInputExpected: swap,
        exactHbarTinybar: 1n,
        minimumHbarTinybar: 1n,
        minimumRetainedBps: 0,
      });
      expect(result.allInvariantsHold).toBe(true);
      expect(BigInt(result.destination.remainingAtMinimum) + protocol + swap).toBe(destination);
    }
  });

  it("exposes effective unitemized provider differences without violating conservation", () => {
    const result = ledger({
      providerFeeSource: 25_000n,
      providerGasRelayerSource: 0n,
      destinationArrivalInSourceUnits: 9_925_000n,
    });
    expect(result.source).toMatchObject({
      itemizedProviderDeductions: "25000",
      effectiveProviderDeductions: "75000",
      unitemizedProviderDifference: "50000",
      reconciled: true,
    });
  });

  it("rejects invalid fee, minimum, and HBAR relationships", () => {
    expect(() => ledger({ providerFeeSource: 10_000_001n })).toThrow(AmountInvariantError);
    expect(() => ledger({ minimumDestination: 9_925_001n })).toThrow("minimum destination amount exceeds");
    expect(() => ledger({ exactHbarTinybar: 1n, minimumHbarTinybar: 2n })).toThrow("minimum HBAR output exceeds");
    expect(() => ledger({ destinationSwapInputExpected: 330_001n })).toThrow("expected destination swap input exceeds");
  });

  it("keeps the expected figure at or above the slippage floor, and collapses to it when unstated", () => {
    const result = ledger();
    expect(BigInt(result.destination.remainingExpected)).toBeGreaterThan(BigInt(result.destination.remainingAtMinimum));

    // Both slippage buffers at their worst: the expected figure is the floor.
    const worst = ledger({ destinationSwapInputExpected: undefined, minimumDestination: 9_925_000n });
    expect(worst.destination.remainingExpected).toBe(worst.destination.remainingAtMinimum);
    expect(worst.allInvariantsHold).toBe(true);
  });
});
