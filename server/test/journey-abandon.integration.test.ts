import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ProductLifecycleStore,
  type StoredProductQuote,
} from "../src/product-lifecycle-store.js";
import { PostgresStore } from "../src/postgres-store.js";
import {
  acquireDestructiveSuiteLock,
  releaseDestructiveSuiteLock,
} from "./destructive-suite-lock.js";

/**
 * The abandon predicate has unit cover in journey-abandon.test.ts; this drives
 * the SQL. The transactional re-check, the state write, the append-only event
 * and the list exclusion are the parts a pure-function test cannot reach, and
 * they are the parts that decide whether a record is retired forever.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let lifecycleStore: PostgresStore;
let store: ProductLifecycleStore;
const account = privateKeyToAccount(`0x${"22".repeat(32)}`);

function quote(quoteId: string): StoredProductQuote {
  return {
    quoteId,
    mode: "testnet",
    account: account.address,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:testnet:fixture",
    originChainId: "11155111",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    executable: true,
    record: {
      routeMode: "bridge_plus_refuel",
      asset: { symbol: "USDC", destination: { decimals: 6 } },
      bridge: { normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } } },
      amountLedger: { destination: { remainingAtMinimum: "900000" }, hbar: { exactOutputTinybar: "100000000" } },
    },
  } as StoredProductQuote;
}

async function draft(tag: string) {
  const quoteId = tag.padEnd(64, "0");
  await store.saveQuote(quote(quoteId));
  // Provider, asset and origin chain are taken from the stored quote.
  return store.createJourney({
    quoteId,
    mode: "testnet",
    account: account.address,
    idempotencyKey: `abandon-${tag}-000000000000000`,
  });
}

suite("owner-driven journey abandon against PostgreSQL", () => {
  beforeAll(async () => {
    await acquireDestructiveSuiteLock(databaseUrl!);
    lifecycleStore = await PostgresStore.connect(databaseUrl!);
    store = new ProductLifecycleStore(lifecycleStore.pool);
  });

  beforeEach(async () => {
    await lifecycleStore.pool.query(
      `TRUNCATE
         refuel402_product_events,
         refuel402_product_submissions,
         refuel402_product_authorizations,
         refuel402_product_payments,
         refuel402_product_journeys,
         refuel402_product_quotes
       RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await lifecycleStore?.close();
    await releaseDestructiveSuiteLock();
  });

  it("retires a draft without deleting anything, and is idempotent", async () => {
    const journey = await draft("aa11");
    const abandoned = await store.abandonJourney(journey.id);

    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.events.some((event) => event.type === "journey_abandoned")).toBe(true);
    // The whole point of a terminal state rather than a DELETE.
    expect(abandoned.events.some((event) => event.type === "journey_created")).toBe(true);
    expect(await store.getJourney(journey.id)).not.toBeNull();

    const again = await store.abandonJourney(journey.id);
    expect(again.state).toBe("abandoned");
    expect(again.events.filter((event) => event.type === "journey_abandoned")).toHaveLength(1);
  });

  it("drops out of the default activity page and reads back on request", async () => {
    const kept = await draft("bb22");
    const retired = await draft("cc33");
    await store.abandonJourney(retired.id);

    const page = await store.listJourneysForAccount(account.address, { limit: 20 });
    expect(page.journeys.map((journey) => journey.id)).toEqual([kept.id]);

    const all = await store.listJourneysForAccount(account.address, { limit: 20, includeAbandoned: true });
    expect(all.journeys.map((journey) => journey.id).sort()).toEqual([kept.id, retired.id].sort());
  });

  it("refuses a wallet boundary transactionally and leaves the journey untouched", async () => {
    // The journey is still in state 'ready', so only the event check can catch
    // it — and this is the shape whose only remedy is POST /bridge/adopt.
    const journey = await draft("dd44");
    await store.recordWalletBoundary({ journeyId: journey.id, kind: "bridge" });

    await expect(store.abandonJourney(journey.id)).rejects.toThrow(/outside world/);
    const after = await store.getJourney(journey.id);
    expect(after?.state).toBe("ready");
    expect(after?.events.some((event) => event.type === "journey_abandoned")).toBe(false);
  });

  it("refuses a journey whose bridge was submitted, at the outermost guard", async () => {
    const journey = await draft("ee55");
    await store.recordBridgeSubmission({
      journeyId: journey.id,
      sourceTransactionHash: `0x${"ab".repeat(32)}`,
      destinationBalanceBefore: "0",
      hbarBalanceBefore: "0",
    });

    // A submitted bridge also moves the state to bridge_pending, so the state
    // allow-list refuses before the event check is even reached. Both guards
    // are load-bearing: the wallet-boundary case above proves the event check
    // catches what the state check cannot see.
    await expect(store.abandonJourney(journey.id)).rejects.toThrow(/abandon cannot run from bridge_pending/);
    expect((await store.getJourney(journey.id))?.state).toBe("bridge_pending");
  });

  it("reports a missing journey as a conflict rather than crashing", async () => {
    await expect(store.abandonJourney("00000000-0000-4000-8000-000000000000"))
      .rejects.toMatchObject({ code: "JOURNEY_NOT_FOUND" });
  });
});
