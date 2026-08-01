import { describe, expect, it, vi } from "vitest";
import { createProductBridgeSweeper } from "../src/product-bridge-sweeper.js";

function pending(journeyId: string) {
  return {
    arrival: { confirmed: false },
    journey: { id: journeyId, state: "bridge_pending" } as any,
  };
}

function ownedStore(ids: string[]) {
  return {
    listBridgeSweepCandidateIds: vi.fn(async () => ids),
    withBridgeSweepOwnership: vi.fn(async (_journeyId: string, work: () => Promise<unknown>) => ({
      acquired: true,
      value: await work(),
    })),
  };
}

describe("server-owned bridge sweeper", () => {
  it("bounds concurrent polls and reuses the existing idempotent status materializer", async () => {
    const ids = ["journey-a", "journey-b", "journey-c", "journey-d"];
    const store = ownedStore(ids);
    let active = 0;
    let maximum = 0;
    const status = vi.fn(async (journeyId: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return pending(journeyId);
    });
    const sweeper = createProductBridgeSweeper({
      store: store as any,
      bridgeTracker: { status },
      concurrency: 2,
      logger: { warn: vi.fn() },
    });
    await expect(sweeper.sweepOnce()).resolves.toMatchObject({
      scanned: 4,
      attempted: 4,
      acquired: 4,
      pending: 4,
      failed: 0,
    });
    expect(maximum).toBe(2);
    expect(status).toHaveBeenCalledTimes(4);
  });

  // Arrival is written by the owner's own bridge status read, not by this
  // sweeper, so a journey can become ready to convert while its backoff sits at
  // maximum. The ceiling is therefore the delay the owner experiences AFTER the
  // funds are already on Hedera — at 300s a pre-authorized refuel idled for
  // minutes with the surface still offering the manual path.
  it("bounds how long a journey can wait after its bridge lands", async () => {
    let now = 1_000;
    const status = vi.fn(async (journeyId: string) => pending(journeyId));
    const store = ownedStore(["journey-a"]);
    const sweeper = createProductBridgeSweeper({
      store: store as any,
      bridgeTracker: { status },
      now: () => now,
      logger: { warn: vi.fn() },
    });
    // Drive the backoff to its ceiling the way a slow bridge does.
    for (let i = 0; i < 12; i += 1) {
      await sweeper.sweepOnce();
      now += 400_000;
    }
    const before = now;
    await sweeper.sweepOnce();
    // Walk forward until it is willing to look again: that gap is the worst case
    // between funds landing and the refuel starting.
    let waited = 0;
    while ((await sweeper.sweepOnce()).attempted === 0 && waited < 600_000) {
      now += 1_000;
      waited += 1_000;
    }
    expect(before).toBeLessThanOrEqual(now);
    expect(waited).toBeLessThanOrEqual(20_000);
  });

  it("backs off pending work and does not poll without cross-instance ownership", async () => {
    let now = 1_000;
    const status = vi.fn(async (journeyId: string) => pending(journeyId));
    const store = ownedStore(["journey-a"]);
    const sweeper = createProductBridgeSweeper({
      store: store as any,
      bridgeTracker: { status },
      minimumBackoffMs: 5_000,
      now: () => now,
      logger: { warn: vi.fn() },
    });
    expect((await sweeper.sweepOnce()).attempted).toBe(1);
    expect((await sweeper.sweepOnce()).attempted).toBe(0);
    now += 5_000;
    expect((await sweeper.sweepOnce()).attempted).toBe(1);

    store.withBridgeSweepOwnership.mockImplementationOnce(async () => ({ acquired: false, value: null }));
    now += 10_000;
    await sweeper.sweepOnce();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("claims post-arrival refuel once, schedules exact 30s/60s retries, and never retries unknown dispatch", async () => {
    let now = 10_000;
    const authorization = {
      id: "auth-refuel",
      journeyId: "journey-a",
      state: "executing",
      attemptCount: 1,
      deadline: 10_000,
    } as any;
    const store = {
      listBridgeSweepCandidateIds: vi.fn(async () => ["journey-a"]),
      withBridgeSweepOwnership: vi.fn(async (_id: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })),
      getJourney: vi.fn(async () => ({ id: "journey-a", state: "arrival_confirmed" } as any)),
      beginRefuelAuthorizationAttempt: vi.fn(async () => ({ authorization, expired: false })),
      scheduleRefuelAuthorizationRetry: vi.fn(async () => undefined),
      finalizeRefuelAuthorization: vi.fn(async () => ({ id: "journey-a" } as any)),
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: "retry", errorCode: "REFUEL_CAP_PRICE_MISS", evidence: {} })
      .mockResolvedValueOnce({ kind: "retry", errorCode: "REFUEL_CAP_PRICE_MISS", evidence: {} })
      .mockResolvedValueOnce({ kind: "unknown", errorCode: "REFUEL_EXECUTION_DISPATCH_UNKNOWN", executionReference: null, evidence: {} });
    const sweeper = createProductBridgeSweeper({
      store: store as any,
      bridgeTracker: { status: vi.fn() },
      refuelExecutor: { execute },
      now: () => now,
      logger: { warn: vi.fn() },
    });
    await sweeper.sweepOnce();
    expect(store.scheduleRefuelAuthorizationRetry).toHaveBeenLastCalledWith(expect.objectContaining({ nextAttemptAt: now + 30_000 }));
    authorization.attemptCount = 2;
    now += 1;
    await sweeper.sweepOnce();
    expect(store.scheduleRefuelAuthorizationRetry).toHaveBeenLastCalledWith(expect.objectContaining({ nextAttemptAt: now + 60_000 }));
    authorization.attemptCount = 3;
    now += 1;
    await sweeper.sweepOnce();
    expect(store.finalizeRefuelAuthorization).toHaveBeenCalledWith(expect.objectContaining({ state: "unknown" }));
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("clears completed candidates and waits for an in-flight poll during shutdown", async () => {
    let release!: (value: ReturnType<typeof pending>) => void;
    const status = vi.fn((journeyId: string) => new Promise<ReturnType<typeof pending>>((resolve) => {
      release = resolve;
    }));
    const store = ownedStore(["journey-a"]);
    const sweeper = createProductBridgeSweeper({
      store: store as any,
      bridgeTracker: { status },
      logger: { warn: vi.fn() },
    });
    const sweep = sweeper.sweepOnce();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = sweeper.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release({ arrival: { confirmed: true }, journey: { id: "journey-a", state: "arrival_confirmed" } as any });
    await expect(sweep).resolves.toMatchObject({ completed: 1 });
    await stop;
    expect(stopped).toBe(true);
  });
});
