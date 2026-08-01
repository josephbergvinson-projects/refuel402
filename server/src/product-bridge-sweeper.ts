import type { RefuelExecutionOutcome } from "./product-refuel-executor.js";
import type { ProductJourneyRecord, ProductLifecycleStore, RefuelAuthorizationRecord } from "./product-lifecycle-store.js";

type SweepStore = Pick<
  ProductLifecycleStore,
  | "listBridgeSweepCandidateIds"
  | "withBridgeSweepOwnership"
  | "getJourney"
  | "beginRefuelAuthorizationAttempt"
  | "scheduleRefuelAuthorizationRetry"
  | "finalizeRefuelAuthorization"
>;

type BridgeStatusReader = {
  status(journeyId: string): Promise<{
    arrival?: { confirmed?: boolean };
    journey?: ProductJourneyRecord;
    [key: string]: unknown;
  }>;
};

type RefuelExecutor = {
  execute(journeyId: string, authorization: RefuelAuthorizationRecord): Promise<RefuelExecutionOutcome>;
};

type BackoffState = { attempts: number; nextAt: number };

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const candidate = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(candidate)));
}

export type ProductBridgeSweepSummary = {
  scanned: number;
  attempted: number;
  acquired: number;
  completed: number;
  pending: number;
  failed: number;
  refuelCompleted: number;
  refuelRetries: number;
  refuelFallbacks: number;
  refuelUnknown: number;
};

/**
 * Server-owned polling for already-durable bridge submissions.
 *
 * The tracker remains the one arrival authority. After durable arrival, the same
 * cross-instance owner may claim one pre-authorized refuel attempt. Every dispatch
 * is persisted before execution; quote/cap misses follow the exact bounded retry
 * schedule and unknown dispatches are never retried blindly.
 */
export function createProductBridgeSweeper(options: {
  store: SweepStore;
  bridgeTracker: BridgeStatusReader;
  refuelExecutor?: RefuelExecutor;
  intervalMs?: number;
  minimumBackoffMs?: number;
  maximumBackoffMs?: number;
  concurrency?: number;
  scanLimit?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Pick<Console, "warn">;
}) {
  const intervalMs = boundedNumber(options.intervalMs, 15_000, 1_000);
  const minimumBackoffMs = boundedNumber(options.minimumBackoffMs, 5_000, 1_000);
  // This backoff exists to pace bridge POLLING, but the same tick is what runs
  // the refuel once the bridge lands — and arrival is written by the owner's own
  // status read, not by this sweeper, so a journey can become ready to convert
  // while its backoff is at maximum. At 300s that meant a pre-authorized refuel
  // sat idle for minutes after the funds were already there (journey 21d77abd:
  // arrived 22:34:42, converted 22:38:12) with the surface still offering the
  // manual path, which reads as "it silently failed".
  //
  // A bridge status read is cheap and only in-flight journeys are candidates, so
  // the ceiling is the delay the owner actually experiences after arrival. It is
  // bounded to that, not to what is comfortable for the upstream.
  const maximumBackoffMs = boundedNumber(options.maximumBackoffMs, 20_000, minimumBackoffMs);
  const concurrency = boundedNumber(options.concurrency, 2, 1, 8);
  const scanLimit = boundedNumber(options.scanLimit, concurrency * 8, concurrency, 50);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const logger = options.logger ?? console;
  const backoff = new Map<string, BackoffState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<ProductBridgeSweepSummary> | null = null;
  let stopped = true;

  function defer(journeyId: string): void {
    const attempts = (backoff.get(journeyId)?.attempts ?? 0) + 1;
    const delay = Math.min(maximumBackoffMs, minimumBackoffMs * (2 ** Math.min(attempts - 1, 16)));
    backoff.set(journeyId, { attempts, nextAt: now() + delay });
  }

  async function runRefuel(journeyId: string): Promise<"none" | "completed" | "retry" | "fallback" | "unknown"> {
    if (!options.refuelExecutor) return "none";
    const claim = await options.store.beginRefuelAuthorizationAttempt(journeyId, now());
    if (claim.expired) return "fallback";
    if (!claim.authorization) return "none";
    const outcome = await options.refuelExecutor.execute(journeyId, claim.authorization);
    if (outcome.kind === "retry") {
      const schedule = [30_000, 60_000, 120_000, 300_000];
      const delay = schedule[Math.min(claim.authorization.attemptCount - 1, schedule.length - 1)] ?? 300_000;
      await options.store.scheduleRefuelAuthorizationRetry({
        journeyId,
        errorCode: outcome.errorCode,
        nextAttemptAt: Math.min(claim.authorization.deadline * 1_000, now() + delay),
      });
      return "retry";
    }
    if (outcome.kind === "completed") {
      await options.store.finalizeRefuelAuthorization({
        journeyId,
        state: "completed",
        executionReference: outcome.executionReference,
        evidence: outcome.evidence,
      });
      return "completed";
    }
    if (outcome.kind === "unknown") {
      await options.store.finalizeRefuelAuthorization({
        journeyId,
        state: "unknown",
        executionReference: outcome.executionReference,
        errorCode: outcome.errorCode,
        evidence: outcome.evidence,
      });
      return "unknown";
    }
    await options.store.finalizeRefuelAuthorization({
      journeyId,
      state: "fallback",
      errorCode: outcome.errorCode,
      evidence: outcome.evidence,
    });
    return "fallback";
  }

  async function runSweep(): Promise<ProductBridgeSweepSummary> {
    const summary: ProductBridgeSweepSummary = {
      scanned: 0,
      attempted: 0,
      acquired: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      refuelCompleted: 0,
      refuelRetries: 0,
      refuelFallbacks: 0,
      refuelUnknown: 0,
    };
    const candidates = await options.store.listBridgeSweepCandidateIds(scanLimit);
    summary.scanned = candidates.length;
    const due = candidates.filter((journeyId) => (backoff.get(journeyId)?.nextAt ?? 0) <= now());
    let cursor = 0;
    const worker = async () => {
      while (cursor < due.length) {
        const journeyId = due[cursor++]!;
        summary.attempted += 1;
        try {
          const owned = await options.store.withBridgeSweepOwnership(journeyId, async () => {
            if (!options.refuelExecutor) {
              const bridge = await options.bridgeTracker.status(journeyId);
              const terminalized = bridge.arrival?.confirmed === true || bridge.journey?.state !== "bridge_pending";
              return { bridgePending: !terminalized, refuel: "none" as const };
            }
            let journey = await options.store.getJourney(journeyId);
            let arrivalConfirmed = journey?.state === "arrival_confirmed" || journey?.state === "completed";
            if (journey?.state === "bridge_pending") {
              const bridge = await options.bridgeTracker.status(journeyId);
              journey = bridge.journey ?? await options.store.getJourney(journeyId);
              arrivalConfirmed = bridge.arrival?.confirmed === true || journey?.state === "arrival_confirmed" || journey?.state === "completed";
              if (!arrivalConfirmed) return { bridgePending: true, refuel: "none" as const };
            }
            const refuel = arrivalConfirmed ? await runRefuel(journeyId) : "none";
            return { bridgePending: false, refuel };
          });
          if (!owned.acquired || !owned.value) {
            defer(journeyId);
            continue;
          }
          summary.acquired += 1;
          if (owned.value.bridgePending) {
            defer(journeyId);
            summary.pending += 1;
            continue;
          }
          backoff.delete(journeyId);
          summary.completed += 1;
          if (owned.value.refuel === "completed") summary.refuelCompleted += 1;
          if (owned.value.refuel === "retry") { summary.refuelRetries += 1; summary.pending += 1; }
          if (owned.value.refuel === "fallback") summary.refuelFallbacks += 1;
          if (owned.value.refuel === "unknown") summary.refuelUnknown += 1;
        } catch (error) {
          defer(journeyId);
          summary.failed += 1;
          logger.warn(`[product-bridge-sweeper] ${journeyId}: ${error instanceof Error ? error.message : "poll failed"}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, () => worker()));
    const live = new Set(candidates);
    for (const journeyId of backoff.keys()) {
      if (!live.has(journeyId)) backoff.delete(journeyId);
    }
    return summary;
  }

  function sweepOnce(): Promise<ProductBridgeSweepSummary> {
    if (running) return running;
    running = runSweep().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(delayMs: number): void {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      void sweepOnce()
        .catch((error) => logger.warn(`[product-bridge-sweeper] sweep failed: ${error instanceof Error ? error.message : "unknown error"}`))
        .finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref?.();
  }

  function start(): void {
    if (!stopped) return;
    stopped = false;
    schedule(0);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (running) await running;
  }

  return { start, stop, sweepOnce };
}
