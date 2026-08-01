import { describe, expect, it } from "vitest";
import { buildRefuelCap, flexibleRefuelBufferBps, refuelPresetBufferBps, RefuelCapError } from "../src/refuel-cap.js";

describe("refuel price-protection cap", () => {
  it("derives the flexible buffer from provider ETA and clamps to policy", () => {
    expect(flexibleRefuelBufferBps(10 * 60)).toMatchObject({ bufferBps: 1400, etaMinutes: 10, etaSource: "provider" });
    expect(flexibleRefuelBufferBps(null)).toMatchObject({ bufferBps: 3500, etaMinutes: null, etaSource: "conservative_unknown" });
    expect(flexibleRefuelBufferBps(10 * 60 * 60).bufferBps).toBe(3500);
  });

  it("publishes flexible, half-buffer balanced, strict, and exact custom caps", () => {
    expect(refuelPresetBufferBps({ preset: "balanced", providerEtaSeconds: 10 * 60 }).bufferBps).toBe(700);
    expect(refuelPresetBufferBps({ preset: "strict", providerEtaSeconds: 10 * 60 }).bufferBps).toBe(500);
    const flexible = buildRefuelCap({
      preset: "flexible",
      providerEtaSeconds: 10 * 60,
      serviceFeeAmount: 100n,
      swapInputExpected: 1_000n,
      tokenDecimals: 18,
    });
    expect(flexible).toMatchObject({ todayAmountIn: "1100", maxAmountIn: "1240", bufferBps: 1400 });
    expect(flexible.presetOptions.map((option) => option.preset)).toEqual(["flexible", "balanced", "strict"]);

    const custom = buildRefuelCap({
      preset: "custom",
      customMaxAmountIn: 1_150n,
      serviceFeeAmount: 100n,
      swapInputExpected: 1_000n,
      tokenDecimals: 18,
    });
    expect(custom).toMatchObject({ maxAmountIn: "1150", swapInputCap: "1050", bufferBps: 500 });
  });

  // Both refusals below reached the owner as a 503 "combined quote is
  // temporarily unavailable, retriable: true" — an outage that did not exist,
  // for a value only they could change. They must be typed, and they must say
  // which number to type.
  it("fails closed when a custom cap cannot even cover the fixed service fee", () => {
    expect(() => buildRefuelCap({
      preset: "custom",
      customMaxAmountIn: 100n,
      serviceFeeAmount: 100n,
      swapInputExpected: 1_000n,
      tokenDecimals: 18,
    })).toThrow(RefuelCapError);
    try {
      buildRefuelCap({
        preset: "custom",
        customMaxAmountIn: 100n,
        serviceFeeAmount: 100n,
        swapInputExpected: 1_000n,
        tokenDecimals: 3,
      });
      expect.unreachable("a cap at the service fee must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(RefuelCapError);
      expect((error as RefuelCapError).code).toBe("REFUEL_CAP_BELOW_SERVICE_FEE");
      expect((error as RefuelCapError).message).toContain("0.1");
      expect((error as RefuelCapError).message).toContain("1.1");
      expect((error as RefuelCapError).details).toMatchObject({ minimumMaxAmountIn: "1100" });
    }
  });

  // A cap above the fee but below today's total produced a NEGATIVE bufferBps
  // and a quote that could not execute at a price that already exists — it would
  // have sat for the full two hours and expired by construction.
  it("refuses a cap below today's price instead of guaranteeing a silent no-refuel", () => {
    try {
      buildRefuelCap({
        preset: "custom",
        customMaxAmountIn: 1_050n,
        serviceFeeAmount: 100n,
        swapInputExpected: 1_000n,
        tokenDecimals: 3,
      });
      expect.unreachable("a cap below today's price must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(RefuelCapError);
      expect((error as RefuelCapError).code).toBe("REFUEL_CAP_BELOW_TODAY_PRICE");
      expect((error as RefuelCapError).details).toMatchObject({ minimumMaxAmountIn: "1100" });
    }
  });

  it("accepts a custom cap exactly at today's price", () => {
    expect(buildRefuelCap({
      preset: "custom",
      customMaxAmountIn: 1_100n,
      serviceFeeAmount: 100n,
      swapInputExpected: 1_000n,
      tokenDecimals: 18,
    })).toMatchObject({ maxAmountIn: "1100", bufferBps: 0 });
  });
});
