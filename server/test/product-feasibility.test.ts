import { describe, expect, it } from "vitest";
import {
  assessProductFeasibility,
  deferMaximumFeasibleHbar,
  solveMaximumFeasibleHbar,
  type FeasibilityAssessment,
} from "../src/product-feasibility.js";

function assessment(feasible: boolean, constraint: FeasibilityAssessment["limitingConstraint"] = "CONFIGURED_MAX_HBAR"): FeasibilityAssessment {
  return {
    feasible,
    limitingConstraint: constraint,
    destination: {
      minimumArrival: "100",
      x402ProtocolFee: "10",
      swapInputMaximum: feasible ? "80" : "91",
      minimumRetainedByPolicy: "10",
      headroom: feasible ? "0" : "-11",
    },
    priceImpact: { actualBps: 10, maximumBps: 150, headroomBps: 140 },
    sponsor: {
      maximumExposureTinybar: "100",
      exposureCapTinybar: "200",
      reserveFloorTinybar: "50",
      balanceTinybar: "250",
      availableAboveReserveTinybar: "200",
      reserveVerified: true,
      exposureHeadroomTinybar: "100",
    },
  };
}

describe("maximum feasible HBAR and conservation model", () => {
  it("reconciles retained asset, destination deductions, impact, and sponsor constraints without cross-currency arithmetic", () => {
    const result = assessProductFeasibility({
      minimumArrival: 1_000n,
      x402ProtocolFee: 100n,
      swapInputMaximum: 800n,
      minimumRetainedBps: 1_000,
      priceImpactBps: 25,
      maximumPriceImpactBps: 150,
      maximumSponsorExposureTinybar: 500n,
      sponsorExposureCapTinybar: 800n,
      sponsorReserveFloorTinybar: 200n,
      sponsorBalanceTinybar: 1_000n,
    });
    expect(result.feasible).toBe(true);
    expect(result.destination).toEqual({
      minimumArrival: "1000",
      x402ProtocolFee: "100",
      swapInputMaximum: "800",
      minimumRetainedByPolicy: "100",
      headroom: "0",
    });
    expect(result.sponsor).toMatchObject({
      exposureHeadroomTinybar: "300",
      availableAboveReserveTinybar: "800",
      reserveVerified: true,
    });
  });

  it("reports each independent limiting class", () => {
    expect(assessProductFeasibility({
      minimumArrival: 100n, x402ProtocolFee: 10n, swapInputMaximum: 90n, minimumRetainedBps: 500,
      priceImpactBps: 0, maximumPriceImpactBps: 150, maximumSponsorExposureTinybar: 1n,
      sponsorExposureCapTinybar: 2n, sponsorReserveFloorTinybar: 1n,
    }).limitingConstraint).toBe("DESTINATION_AFFORDABILITY");
    expect(assessProductFeasibility({
      minimumArrival: 100n, x402ProtocolFee: 1n, swapInputMaximum: 1n, minimumRetainedBps: 0,
      priceImpactBps: 151, maximumPriceImpactBps: 150, maximumSponsorExposureTinybar: 1n,
      sponsorExposureCapTinybar: 2n, sponsorReserveFloorTinybar: 1n,
    }).limitingConstraint).toBe("PRICE_IMPACT_CAP");
    expect(assessProductFeasibility({
      minimumArrival: 100n, x402ProtocolFee: 1n, swapInputMaximum: 1n, minimumRetainedBps: 0,
      priceImpactBps: 0, maximumPriceImpactBps: 150, maximumSponsorExposureTinybar: 3n,
      sponsorExposureCapTinybar: 2n, sponsorReserveFloorTinybar: 1n,
    }).limitingConstraint).toBe("SPONSOR_EXPOSURE_CAP");
  });

  it("defers the expensive maximum solver for a feasible ordinary exact-output quote", () => {
    const desiredEvaluation = { outputTinybar: 100n, assessment: assessment(true), value: 100n };
    const deferred = deferMaximumFeasibleHbar({
      desiredTinybar: 100n,
      configuredMaximumTinybar: 5_000n,
      candidateBudget: 8,
      desiredEvaluation,
    });
    expect(deferred).toMatchObject({
      maximumTinybar: 100n,
      candidatesEvaluated: 1,
      solved: false,
      solveReason: "deferred_for_latency",
    });
    expect(deferred.resolutionTinybar).toBe(4_900n);
    expect(() => deferMaximumFeasibleHbar({
      desiredTinybar: 100n,
      configuredMaximumTinybar: 5_000n,
      candidateBudget: 8,
      desiredEvaluation: { ...desiredEvaluation, assessment: assessment(false) },
    })).toThrow("cannot defer");
  });

  it("returns a verified conservative bound under a fixed candidate budget", async () => {
    const threshold = 617n;
    const calls: bigint[] = [];
    const evaluate = async (outputTinybar: bigint) => {
      calls.push(outputTinybar);
      const feasible = outputTinybar <= threshold;
      return { outputTinybar, assessment: assessment(feasible, feasible ? "CONFIGURED_MAX_HBAR" : "DESTINATION_AFFORDABILITY"), value: outputTinybar };
    };
    const desiredEvaluation = await evaluate(500n);
    const solved = await solveMaximumFeasibleHbar({
      desiredTinybar: 500n,
      configuredMaximumTinybar: 1_000n,
      candidateBudget: 8,
      desiredEvaluation,
      evaluate,
    });
    expect(solved.maximumTinybar).toBeLessThanOrEqual(threshold);
    expect(solved.maximumTinybar + solved.resolutionTinybar).toBeGreaterThan(threshold);
    expect(solved.selectedEvaluation?.assessment.feasible).toBe(true);
    expect(solved.candidatesEvaluated).toBeLessThanOrEqual(8);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("finds a lower maximum when the requested output is unaffordable", async () => {
    const evaluate = async (outputTinybar: bigint) => ({
      outputTinybar,
      assessment: assessment(outputTinybar <= 100n, outputTinybar <= 100n ? "CONFIGURED_MAX_HBAR" : "DESTINATION_AFFORDABILITY"),
      value: outputTinybar,
    });
    const desiredEvaluation = await evaluate(150n);
    const solved = await solveMaximumFeasibleHbar({
      desiredTinybar: 150n,
      configuredMaximumTinybar: 200n,
      candidateBudget: 8,
      desiredEvaluation,
      evaluate,
    });
    expect(solved.desiredEvaluation.assessment.feasible).toBe(false);
    expect(solved.maximumTinybar).toBeLessThanOrEqual(100n);
    expect(solved.headroomTinybar).toBe(0n);
    expect(solved.limitingConstraint).toBe("DESTINATION_AFFORDABILITY");
  });

  it("searches below a price-impact-limited request instead of wasting the budget from the global cap", async () => {
    const threshold = 30n;
    const calls: bigint[] = [];
    const evaluate = async (outputTinybar: bigint) => {
      calls.push(outputTinybar);
      const feasible = outputTinybar <= threshold;
      return {
        outputTinybar,
        assessment: assessment(feasible, feasible ? "CONFIGURED_MAX_HBAR" : "PRICE_IMPACT_CAP"),
        value: outputTinybar,
      };
    };
    const desiredEvaluation = await evaluate(100n);
    const solved = await solveMaximumFeasibleHbar({
      desiredTinybar: 100n,
      configuredMaximumTinybar: 5_000n,
      candidateBudget: 6,
      desiredEvaluation,
      evaluate,
    });
    expect(calls).not.toContain(5_000n);
    expect(solved.maximumTinybar).toBeGreaterThan(0n);
    expect(solved.maximumTinybar).toBeLessThanOrEqual(threshold);
    expect(solved.maximumTinybar + solved.resolutionTinybar).toBeGreaterThan(threshold);
    expect(solved.selectedEvaluation?.assessment.feasible).toBe(true);
    expect(solved.candidatesEvaluated).toBe(6);
    expect(solved.limitingConstraint).toBe("PRICE_IMPACT_CAP");
  });

  it("searches below a sponsor-exposure-limited request using the same monotone bound", async () => {
    const calls: bigint[] = [];
    const evaluate = async (outputTinybar: bigint) => {
      calls.push(outputTinybar);
      const feasible = outputTinybar <= 40n;
      return {
        outputTinybar,
        assessment: assessment(feasible, feasible ? "CONFIGURED_MAX_HBAR" : "SPONSOR_EXPOSURE_CAP"),
        value: outputTinybar,
      };
    };
    const desiredEvaluation = await evaluate(100n);
    const solved = await solveMaximumFeasibleHbar({
      desiredTinybar: 100n,
      configuredMaximumTinybar: 5_000n,
      candidateBudget: 6,
      desiredEvaluation,
      evaluate,
    });
    expect(calls).not.toContain(5_000n);
    expect(solved.maximumTinybar).toBeGreaterThan(0n);
    expect(solved.maximumTinybar).toBeLessThanOrEqual(40n);
    expect(solved.limitingConstraint).toBe("SPONSOR_EXPOSURE_CAP");
  });

  it("finds a feasible middle band when dust-sized and cap-sized outputs both fail", async () => {
    const evaluate = async (outputTinybar: bigint) => ({
      outputTinybar,
      assessment: assessment(outputTinybar >= 20n && outputTinybar <= 60n, outputTinybar < 20n ? "DESTINATION_AFFORDABILITY" : "PRICE_IMPACT_CAP"),
      value: outputTinybar,
    });
    const desiredEvaluation = await evaluate(10n);
    const solved = await solveMaximumFeasibleHbar({
      desiredTinybar: 10n,
      configuredMaximumTinybar: 100n,
      candidateBudget: 10,
      desiredEvaluation,
      evaluate,
    });
    expect(solved.maximumTinybar).toBeGreaterThanOrEqual(50n);
    expect(solved.maximumTinybar).toBeLessThanOrEqual(60n);
    expect(solved.selectedEvaluation?.assessment.feasible).toBe(true);
  });

  it("is monotone across deterministic thresholds and never exceeds the configured cap", async () => {
    for (let threshold = 1n; threshold <= 97n; threshold += 8n) {
      const evaluate = async (outputTinybar: bigint) => ({
        outputTinybar,
        assessment: assessment(outputTinybar <= threshold, outputTinybar <= threshold ? "CONFIGURED_MAX_HBAR" : "PRICE_IMPACT_CAP"),
        value: outputTinybar,
      });
      const desiredEvaluation = await evaluate(1n);
      const solved = await solveMaximumFeasibleHbar({
        desiredTinybar: 1n,
        configuredMaximumTinybar: 100n,
        candidateBudget: 10,
        desiredEvaluation,
        evaluate,
      });
      expect(solved.maximumTinybar).toBeLessThanOrEqual(threshold);
      expect(solved.maximumTinybar).toBeLessThanOrEqual(100n);
      expect(solved.selectedEvaluation?.assessment.feasible).toBe(true);
    }
  });
});
