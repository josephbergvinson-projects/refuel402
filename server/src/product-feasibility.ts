const BPS = 10_000n;

export type FeasibilityConstraint =
  | "CONFIGURED_MAX_HBAR"
  | "DESTINATION_AFFORDABILITY"
  | "PRICE_IMPACT_CAP"
  | "SPONSOR_EXPOSURE_CAP"
  | "ROUTE_UNAVAILABLE";

export type FeasibilityAssessment = {
  feasible: boolean;
  limitingConstraint: FeasibilityConstraint;
  destination: {
    minimumArrival: string;
    x402ProtocolFee: string;
    swapInputMaximum: string;
    minimumRetainedByPolicy: string;
    headroom: string;
  };
  priceImpact: {
    actualBps: number;
    maximumBps: number;
    headroomBps: number;
  };
  sponsor: {
    maximumExposureTinybar: string;
    exposureCapTinybar: string;
    reserveFloorTinybar: string;
    balanceTinybar: string | null;
    availableAboveReserveTinybar: string | null;
    reserveVerified: boolean;
    exposureHeadroomTinybar: string;
  };
};

export function assessProductFeasibility(input: {
  minimumArrival: bigint;
  x402ProtocolFee: bigint;
  swapInputMaximum: bigint;
  minimumRetainedBps: number;
  priceImpactBps: number;
  maximumPriceImpactBps: number;
  maximumSponsorExposureTinybar: bigint;
  sponsorExposureCapTinybar: bigint;
  sponsorReserveFloorTinybar: bigint;
  sponsorBalanceTinybar?: bigint | null;
}): FeasibilityAssessment {
  const minimumRetainedByPolicy = input.minimumArrival * BigInt(input.minimumRetainedBps) / BPS;
  const destinationDebit = input.x402ProtocolFee + input.swapInputMaximum + minimumRetainedByPolicy;
  const destinationHeadroom = input.minimumArrival - destinationDebit;
  const sponsorHeadroom = input.sponsorExposureCapTinybar - input.maximumSponsorExposureTinybar;
  const availableAboveReserve = input.sponsorBalanceTinybar === undefined || input.sponsorBalanceTinybar === null
    ? null
    : input.sponsorBalanceTinybar > input.sponsorReserveFloorTinybar
      ? input.sponsorBalanceTinybar - input.sponsorReserveFloorTinybar
      : 0n;
  const reserveVerified = availableAboveReserve !== null && availableAboveReserve >= input.maximumSponsorExposureTinybar;
  const constraints = {
    DESTINATION_AFFORDABILITY: destinationHeadroom >= 0n,
    PRICE_IMPACT_CAP: input.priceImpactBps <= input.maximumPriceImpactBps,
    SPONSOR_EXPOSURE_CAP: sponsorHeadroom >= 0n,
  } as const;
  const limitingConstraint: FeasibilityConstraint = !constraints.DESTINATION_AFFORDABILITY
    ? "DESTINATION_AFFORDABILITY"
    : !constraints.PRICE_IMPACT_CAP
      ? "PRICE_IMPACT_CAP"
      : !constraints.SPONSOR_EXPOSURE_CAP
        ? "SPONSOR_EXPOSURE_CAP"
        : "CONFIGURED_MAX_HBAR";
  return {
    feasible: Object.values(constraints).every(Boolean),
    limitingConstraint,
    destination: {
      minimumArrival: input.minimumArrival.toString(),
      x402ProtocolFee: input.x402ProtocolFee.toString(),
      swapInputMaximum: input.swapInputMaximum.toString(),
      minimumRetainedByPolicy: minimumRetainedByPolicy.toString(),
      headroom: destinationHeadroom.toString(),
    },
    priceImpact: {
      actualBps: input.priceImpactBps,
      maximumBps: input.maximumPriceImpactBps,
      headroomBps: input.maximumPriceImpactBps - input.priceImpactBps,
    },
    sponsor: {
      maximumExposureTinybar: input.maximumSponsorExposureTinybar.toString(),
      exposureCapTinybar: input.sponsorExposureCapTinybar.toString(),
      reserveFloorTinybar: input.sponsorReserveFloorTinybar.toString(),
      balanceTinybar: input.sponsorBalanceTinybar?.toString() ?? null,
      availableAboveReserveTinybar: availableAboveReserve?.toString() ?? null,
      reserveVerified,
      exposureHeadroomTinybar: sponsorHeadroom.toString(),
    },
  };
}

export type FeasibilityEvaluation<T> = {
  outputTinybar: bigint;
  assessment: FeasibilityAssessment;
  value: T;
};

export type MaximumFeasibleHbar<T> = {
  maximumTinybar: bigint;
  desiredTinybar: bigint;
  headroomTinybar: bigint;
  limitingConstraint: FeasibilityConstraint;
  resolutionTinybar: bigint;
  candidateBudget: number;
  candidatesEvaluated: number;
  selectedEvaluation: FeasibilityEvaluation<T> | null;
  desiredEvaluation: FeasibilityEvaluation<T>;
  solved: boolean;
  solveReason: "explicit_maximum" | "desired_infeasible" | "deferred_for_latency";
};

export function deferMaximumFeasibleHbar<T>(input: {
  desiredTinybar: bigint;
  configuredMaximumTinybar: bigint;
  candidateBudget: number;
  desiredEvaluation: FeasibilityEvaluation<T>;
}): MaximumFeasibleHbar<T> {
  if (!input.desiredEvaluation.assessment.feasible) {
    throw new Error("an infeasible desired output cannot defer maximum solving");
  }
  return {
    maximumTinybar: input.desiredTinybar,
    desiredTinybar: input.desiredTinybar,
    headroomTinybar: 0n,
    limitingConstraint: input.desiredEvaluation.assessment.limitingConstraint,
    resolutionTinybar: input.configuredMaximumTinybar - input.desiredTinybar,
    candidateBudget: input.candidateBudget,
    candidatesEvaluated: 1,
    selectedEvaluation: input.desiredEvaluation,
    desiredEvaluation: input.desiredEvaluation,
    solved: false,
    solveReason: "deferred_for_latency",
  };
}

/**
 * Finds a conservative, verified lower bound for the maximum exact HBAR output.
 * Every positive candidate is evaluated by the caller's authoritative quote path.
 * The returned maximum is always a candidate that passed; resolution records the
 * remaining interval rather than pretending untested tinybar precision.
 */
export async function solveMaximumFeasibleHbar<T>(input: {
  desiredTinybar: bigint;
  configuredMaximumTinybar: bigint;
  candidateBudget: number;
  desiredEvaluation: FeasibilityEvaluation<T>;
  evaluate: (outputTinybar: bigint) => Promise<FeasibilityEvaluation<T>>;
}): Promise<MaximumFeasibleHbar<T>> {
  if (input.desiredTinybar <= 0n || input.configuredMaximumTinybar <= 0n) {
    throw new Error("desired and configured maximum HBAR must be positive");
  }
  if (input.desiredTinybar > input.configuredMaximumTinybar) {
    throw new Error("desired HBAR exceeds the configured maximum");
  }
  if (!Number.isInteger(input.candidateBudget) || input.candidateBudget < 2 || input.candidateBudget > 16) {
    throw new Error("maximum solver candidate budget must be between 2 and 16");
  }
  const cache = new Map<string, FeasibilityEvaluation<T>>([
    [input.desiredTinybar.toString(), input.desiredEvaluation],
  ]);
  let evaluated = 1;
  const evaluate = async (candidate: bigint) => {
    const key = candidate.toString();
    const cached = cache.get(key);
    if (cached) return cached;
    if (evaluated >= input.candidateBudget) throw new Error("maximum solver candidate budget exhausted");
    const result = await input.evaluate(candidate);
    if (result.outputTinybar !== candidate) throw new Error("maximum solver evaluation output mismatch");
    cache.set(key, result);
    evaluated += 1;
    return result;
  };

  const cap = input.configuredMaximumTinybar;
  const desiredConstraint = input.desiredEvaluation.assessment.limitingConstraint;
  const desiredFailureBoundsMaximum = !input.desiredEvaluation.assessment.feasible &&
    ["PRICE_IMPACT_CAP", "SPONSOR_EXPOSURE_CAP"].includes(desiredConstraint);
  let high: bigint;
  let lastFailed: FeasibilityEvaluation<T>;

  if (desiredFailureBoundsMaximum) {
    // Price impact and sponsor exposure are monotone with exact output for one
    // fixed route/market snapshot. Once the requested output fails either cap,
    // a feasible maximum must be below that request. Starting from the unrelated
    // global cap would waste the bounded candidate budget before reaching the
    // user's actual output range (for example, 1 HBAR on a thin WETH route).
    high = input.desiredTinybar;
    lastFailed = input.desiredEvaluation;
  } else {
    const capEvaluation = await evaluate(cap);
    if (capEvaluation.assessment.feasible) {
      return {
        maximumTinybar: cap,
        desiredTinybar: input.desiredTinybar,
        headroomTinybar: cap > input.desiredTinybar ? cap - input.desiredTinybar : 0n,
        limitingConstraint: "CONFIGURED_MAX_HBAR",
        resolutionTinybar: 0n,
        candidateBudget: input.candidateBudget,
        candidatesEvaluated: evaluated,
        selectedEvaluation: capEvaluation,
        desiredEvaluation: input.desiredEvaluation,
        solved: true,
        solveReason: input.desiredEvaluation.assessment.feasible ? "explicit_maximum" : "desired_infeasible",
      };
    }
    high = cap;
    lastFailed = capEvaluation;
  }

  let low = input.desiredEvaluation.assessment.feasible ? input.desiredTinybar : 0n;
  let lowEvaluation: FeasibilityEvaluation<T> | null = input.desiredEvaluation.assessment.feasible
    ? input.desiredEvaluation
    : null;

  // Exact-output affordability can be false at dust-sized outputs because a
  // fixed sponsor fee converted into token base units is dominated by integer
  // rounding. When that non-monotone class fails, retain the global-cap search.
  // Monotone price-impact/exposure failures instead descend from the failed
  // requested output so a bounded search can find the useful local band.
  if (low === 0n) {
    let anchor = high / 2n;
    while (evaluated < input.candidateBudget && anchor > 0n) {
      const candidate = await evaluate(anchor);
      if (candidate.assessment.feasible) {
        low = anchor;
        lowEvaluation = candidate;
        break;
      }
      high = anchor;
      lastFailed = candidate;
      anchor /= 2n;
    }
  }

  while (lowEvaluation && evaluated < input.candidateBudget && high - low > 1n) {
    const midpoint = low + (high - low) / 2n;
    const candidate = await evaluate(midpoint);
    if (candidate.assessment.feasible) {
      low = midpoint;
      lowEvaluation = candidate;
    } else {
      high = midpoint;
      lastFailed = candidate;
    }
  }

  return {
    maximumTinybar: low,
    desiredTinybar: input.desiredTinybar,
    headroomTinybar: low > input.desiredTinybar ? low - input.desiredTinybar : 0n,
    limitingConstraint: lastFailed.assessment.limitingConstraint,
    resolutionTinybar: high - low,
    candidateBudget: input.candidateBudget,
    candidatesEvaluated: evaluated,
    selectedEvaluation: lowEvaluation,
    desiredEvaluation: input.desiredEvaluation,
    solved: true,
    solveReason: input.desiredEvaluation.assessment.feasible ? "explicit_maximum" : "desired_infeasible",
  };
}
