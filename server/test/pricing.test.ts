import { describe, expect, it } from "vitest";
import { priceSponsorship } from "../src/pricing.js";

const mirror = {
  gasPriceWei: async () => 10_000_000_000n,
  hbarUsd: async () => 0.1,
};

const cfg = {
  margin: 1.25,
  flatUsd: 0.005,
  allowanceHeadroom: 1.5,
  quoteTtlSec: 60,
  feeFloorTinybar: 20_000_000n,
};

describe("quote-time sponsor exposure", () => {
  it("allocates immutable per-leg allowances beneath the aggregate and fee cap", async () => {
    const quote = await priceSponsorship({
      mirror: mirror as never,
      cfg,
      totalGasLimit: 3_000_000n,
      expectedGasUnits: 1_500_000n,
      perLegExpectedGas: [500_000n, 1_000_000n],
      perTxAllowanceCapTinybar: 2_000_000n,
      hapiReservePerLegTinybar: 500_000n,
      amountIn: 1_000_000n,
      expectedOutTinybar: 10_000_000n,
      feeTokenId: "0.0.5449",
      feeTokenSymbol: "USDC",
    });
    expect(quote.perLegGasAllowanceTinybar).toEqual([750_000n, 1_500_000n]);
    expect(quote.maxGasAllowanceTinybar).toBe(2_250_000n);
    expect(quote.hapiReserveTinybar).toBe(1_000_000n);
    expect(quote.maxSponsorExposureTinybar).toBe(3_250_000n);
    // The token fee is converted from a tinybar amount that is always at least
    // the complete gas + HAPI exposure authorization.
    expect(quote.feeAmount).toBeGreaterThanOrEqual(2_000_000n);
    expect(quote.marketEvidence).toMatchObject({ gasPriceTinybarPerGas: "1", hbarUsd: 0.1 });
    expect(Date.parse(quote.marketEvidence.observedAt)).not.toBeNaN();
  });

  it("reuses one timestamped market snapshot across bounded maximum candidates", async () => {
    const unavailableMirror = {
      gasPriceWei: async () => { throw new Error("should not fetch"); },
      hbarUsd: async () => { throw new Error("should not fetch"); },
    };
    const quote = await priceSponsorship({
      mirror: unavailableMirror as never,
      cfg,
      totalGasLimit: 1_000_000n,
      expectedGasUnits: 500_000n,
      amountIn: 1_000_000n,
      expectedOutTinybar: 10_000_000n,
      feeTokenId: "0.0.5449",
      feeTokenSymbol: "USDC",
      market: { gasPriceTinybarPerGas: 2n, hbarUsd: 0.2, observedAt: "2026-07-23T00:00:00Z" },
    });
    expect(quote.marketEvidence).toEqual({ observedAt: "2026-07-23T00:00:00Z", gasPriceTinybarPerGas: "2", hbarUsd: 0.2 });
  });

  it("never lets a per-leg quote exceed the configured per-transaction cap", async () => {
    const quote = await priceSponsorship({
      mirror: mirror as never,
      cfg,
      totalGasLimit: 9_000_000n,
      expectedGasUnits: 9_000_000n,
      perLegExpectedGas: [3_000_000n, 3_000_000n, 3_000_000n],
      perTxAllowanceCapTinybar: 1_000_000n,
      hapiReservePerLegTinybar: 100_000n,
      amountIn: 1_000_000n,
      expectedOutTinybar: 10_000_000n,
      feeTokenId: "0.0.5449",
      feeTokenSymbol: "USDC",
    });
    expect(quote.perLegGasAllowanceTinybar).toEqual([1_000_000n, 1_000_000n, 1_000_000n]);
    expect(quote.perLegGasAllowanceTinybar.every((value) => value <= 1_000_000n)).toBe(true);
  });
});
