import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PostgresStore } from "../src/postgres-store.js";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";
import {
  ProductLifecycleStore,
  type ProductJourneyState,
  type StoredProductQuote,
} from "../src/product-lifecycle-store.js";
import { deriveProductRecovery } from "../src/product-recovery.js";
import {
  acquireDestructiveSuiteLock,
  releaseDestructiveSuiteLock,
} from "./destructive-suite-lock.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const account = privateKeyToAccount(`0x${"31".repeat(32)}`);
let postgres: PostgresStore;
let store: ProductLifecycleStore;
// Quote-liveness clock; advancing it expires destination quotes without sleeping.
let now = Date.now();

type Economics = {
  swapInputMaximum: string;
  minimumRetained: string;
  desiredHbarTinybar: string;
};
const consentedEconomics: Economics = {
  swapInputMaximum: "500000",
  minimumRetained: "1900000",
  desiredHbarTinybar: "1000000000",
};

function record(
  quoteId: string,
  economics: Economics = consentedEconomics,
  lifeSec = 60,
) {
  return {
    schema: "refuel402.combined-quote.v1",
    quoteId,
    routeMode: "bridge_plus_refuel",
    capabilities: { execute: true },
    expiresAt: Math.floor(now / 1000) + lifeSec,
    amountLedger: {
      destination: {
        swapInputMaximum: economics.swapInputMaximum,
        remainingAtMinimum: economics.minimumRetained,
      },
      hbar: { exactOutputTinybar: economics.desiredHbarTinybar },
    },
  } as Record<string, unknown>;
}

function storedQuote(quoteId: string): StoredProductQuote {
  return {
    quoteId,
    mode: "testnet",
    account: account.address,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:testnet:fixture",
    originChainId: "11155111",
    expiresAt: Math.floor(now / 1000) + 600,
    executable: true,
    record: record(quoteId),
  };
}

async function setState(journeyId: string, state: ProductJourneyState) {
  await postgres.pool.query(
    "UPDATE refuel402_product_journeys SET state = $2 WHERE journey_id = $1",
    [journeyId, state],
  );
}

async function refreshEvents(journeyId: string): Promise<number> {
  const result = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) FROM refuel402_product_events WHERE journey_id = $1 AND event_type = 'destination_quote_refreshed'",
    [journeyId],
  );
  return Number(result.rows[0]!.count);
}

/** Arrival-confirmed journey with one live destination quote already refreshed. */
async function arrivedJourney(seed: string) {
  const quoteId = seed.repeat(64).slice(0, 64);
  await store.saveQuote(storedQuote(quoteId));
  const journey = await store.createJourney({
    quoteId,
    mode: "testnet",
    account: account.address,
    idempotencyKey: `refresh-fixture-${seed.repeat(16)}`,
  });
  const sourceTransactionHash = keccak256(
    `0x${Buffer.from(`bridge:${journey.id}`).toString("hex")}` as Hex,
  );
  await store.recordBridgeSubmission({
    journeyId: journey.id,
    sourceTransactionHash,
    destinationBalanceBefore: "0",
    hbarBalanceBefore: "10000000",
  });
  await store.recordBridgeArrival({
    journeyId: journey.id,
    sourceTransactionHash,
    destinationTransactionHash: null,
    destinationBalanceAfter: "2500000",
    destinationAmountReceived: "2500000",
    providerStatus: "success",
  });
  return journey;
}

/** Settles the x402 fee against `consentedQuoteId`, which becomes the consent. */
async function settlePayment(journeyId: string, consentedQuoteId: string) {
  return store.recordPayment({
    journeyId,
    idempotencyKey: `payment-fixture-${journeyId}`,
    quoteId: consentedQuoteId,
    payment: {
      paymentIdentity: `payment-${journeyId}`,
      payer: account.address,
      network: "eip155:296",
      asset: "0x0000000000000000000000000000000000001001",
      amount: "20000",
      settlementReference: `settlement:${journeyId}`,
      proofHash: keccak256(
        `0x${Buffer.from(journeyId).toString("hex")}` as Hex,
      ),
    },
  });
}

async function listen(
  router: express.Router,
): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use("/v1/product", router);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

suite("post-arrival destination quote refresh-and-retry", () => {
  beforeAll(async () => {
    await acquireDestructiveSuiteLock(databaseUrl!);
    postgres = await PostgresStore.connect(databaseUrl!);
    store = new ProductLifecycleStore(postgres.pool, () => now);
  });

  beforeEach(async () => {
    now = Date.now();
    await postgres.pool.query(
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
    await postgres?.close();
    await releaseDestructiveSuiteLock();
  });

  it("mints a destination quote from every pre- and post-consent execution state", async () => {
    const journey = await arrivedJourney("1");
    const states: ProductJourneyState[] = [
      "arrival_confirmed",
      "payment_pending",
      "payment_settled",
      "authorizing",
    ];
    for (const [index, state] of states.entries()) {
      const quoteId = String.fromCharCode(97 + index).repeat(64);
      await setState(journey.id, state);
      now += 120_000;
      const refreshed = await store.recordDestinationQuoteRefresh({
        journeyId: journey.id,
        quote: record(quoteId),
      });
      expect(refreshed.record.quoteId, state).toBe(quoteId);
      expect(await refreshEvents(journey.id)).toBe(index + 1);
    }
    for (const state of [
      "bridge_pending",
      "submitting",
      "completed",
    ] as ProductJourneyState[]) {
      await setState(journey.id, state);
      now += 120_000;
      await expect(
        store.recordDestinationQuoteRefresh({
          journeyId: journey.id,
          quote: record("f".repeat(64)),
        }),
      ).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
    }
    expect(await refreshEvents(journey.id)).toBe(states.length);
  });

  it("reuses the live quote only while it still clears the authorization runway gate", async () => {
    const journey = await arrivedJourney("2");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    // 20s of life left: past the reuse threshold but inside the 30s runway gate,
    // so reusing it would loop the client between 409 and an unchanged quote.
    now += 40_000;
    const reminted = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64)),
    });
    expect(reminted.record.quoteId).toBe("b".repeat(64));
    expect(reminted.expiresAt).toBeGreaterThan(Math.floor(now / 1000) + 30);
    // Still well clear of the gate: a duplicate POST stays a no-op.
    const reused = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("c".repeat(64)),
    });
    expect(reused.record.quoteId).toBe("b".repeat(64));
    expect(await refreshEvents(journey.id)).toBe(2);
  });

  it("accepts an equal or strictly better post-consent re-quote without new consent", async () => {
    const journey = await arrivedJourney("3");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));

    now += 120_000;
    const equal = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64)),
    });
    expect(equal.record.quoteId).toBe("b".repeat(64));

    now += 120_000;
    const better = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("c".repeat(64), {
        ...consentedEconomics,
        swapInputMaximum: "480000",
        minimumRetained: "1920000",
      }),
    });
    expect(better.record.quoteId).toBe("c".repeat(64));
    expect(await refreshEvents(journey.id)).toBe(3);
  });

  it("refuses a worse post-consent re-quote on every consented figure and writes nothing", async () => {
    const journey = await arrivedJourney("4");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));
    const worse: Array<[string, Economics]> = [
      [
        "debit",
        {
          ...consentedEconomics,
          swapInputMaximum: "500001",
          minimumRetained: "1900000",
        },
      ],
      ["retained", { ...consentedEconomics, minimumRetained: "1899999" }],
      ["output", { ...consentedEconomics, desiredHbarTinybar: "999999999" }],
    ];
    for (const [label, economics] of worse) {
      now += 120_000;
      await expect(
        store.recordDestinationQuoteRefresh({
          journeyId: journey.id,
          quote: record("d".repeat(64), economics),
        }),
        label,
      ).rejects.toMatchObject({
        code: "QUOTE_ECONOMICS_WORSENED",
        details: { consented: consentedEconomics, refreshed: economics },
      });
    }
    expect(await refreshEvents(journey.id)).toBe(1);
    const effective = await store.getEffectiveQuote(journey.id);
    expect(effective!.record.quoteId).toBe("a".repeat(64));
    expect((await store.getJourney(journey.id))!.state).toBe("payment_settled");
  });

  it("compares against the quote the settled payment was bound to, not the previous refresh", async () => {
    const journey = await arrivedJourney("5");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));
    now += 120_000;
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64), {
        ...consentedEconomics,
        swapInputMaximum: "480000",
        minimumRetained: "1920000",
      }),
    });
    // Worse than the immediately previous refresh, still better than consent.
    now += 120_000;
    const accepted = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("c".repeat(64), {
        ...consentedEconomics,
        swapInputMaximum: "490000",
        minimumRetained: "1910000",
      }),
    });
    expect(accepted.record.quoteId).toBe("c".repeat(64));
  });

  it("leaves pre-consent re-quotes uncompared", async () => {
    const journey = await arrivedJourney("6");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    now += 120_000;
    const worse = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64), {
        ...consentedEconomics,
        swapInputMaximum: "900000",
        minimumRetained: "1500000",
      }),
    });
    expect(worse.record.quoteId).toBe("b".repeat(64));
  });

  it("never implies a second payment after a post-settlement re-quote", async () => {
    const journey = await arrivedJourney("7");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));
    now += 120_000;
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64)),
    });
    let verifierCalls = 0;
    const { server, base } = await listen(
      createProductLifecycleRouter({
        store,
        paymentVerifier: {
          verify: async () => {
            verifierCalls += 1;
            throw new Error("the settled payment must never be re-verified");
          },
        },
      }),
    );
    try {
      const replay = await fetch(
        `${base}/v1/product/journeys/${journey.id}/payment`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `payment-fixture-${journey.id}`,
            "payment-signature": "must-not-be-read",
          },
          body: "{}",
        },
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        payment: { paymentIdentity: `payment-${journey.id}`, amount: "20000" },
      });
      const foreign = await fetch(
        `${base}/v1/product/journeys/${journey.id}/payment`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `payment-second-key-${journey.id}`,
          },
          body: "{}",
        },
      );
      expect(foreign.status).toBe(409);
      await expect(foreign.json()).resolves.toMatchObject({
        code: "PAYMENT_REPLAY",
      });
    } finally {
      await close(server);
    }
    expect(verifierCalls).toBe(0);
    const payments = await postgres.pool.query(
      "SELECT payment_identity FROM refuel402_product_payments WHERE journey_id = $1",
      [journey.id],
    );
    expect(payments.rowCount).toBe(1);
  });

  it("returns 409 QUOTE_ECONOMICS_WORSENED with the consented-vs-refreshed comparison over HTTP", async () => {
    const journey = await arrivedJourney("8");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));
    now += 120_000;
    const { server, base } = await listen(
      createProductLifecycleRouter({
        store,
        destinationQuoteRefresher: (journeyId) =>
          store.recordDestinationQuoteRefresh({
            journeyId,
            quote: record("d".repeat(64), {
              ...consentedEconomics,
              swapInputMaximum: "540000",
              minimumRetained: "1860000",
            }),
          }),
      }),
    );
    try {
      const response = await fetch(
        `${base}/v1/product/journeys/${journey.id}/destination-quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "QUOTE_ECONOMICS_WORSENED",
        retriable: false,
        details: {
          consented: consentedEconomics,
          refreshed: {
            swapInputMaximum: "540000",
            minimumRetained: "1860000",
            desiredHbarTinybar: "1000000000",
          },
        },
      });
    } finally {
      await close(server);
    }
    expect(await refreshEvents(journey.id)).toBe(1);
  });

  it("keeps the post-payment execution phase reachable instead of reporting it blocked", async () => {
    const journey = await arrivedJourney("9");
    await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("a".repeat(64)),
    });
    await settlePayment(journey.id, "a".repeat(64));
    for (const state of [
      "payment_settled",
      "authorizing",
    ] as ProductJourneyState[]) {
      await setState(journey.id, state);
      const current = (await store.getJourney(journey.id))!;
      expect(
        deriveProductRecovery(
          current,
          await store.getEffectiveQuote(journey.id),
        ),
        state,
      ).toMatchObject({
        disposition: "action_required",
        status: "action_required",
        nextAtomicStep: "destination_wallet_consent",
        walletActionRequired: true,
        autoSignAllowed: false,
        autoSubmitAllowed: false,
      });
    }
    // The quote the runway gate would reject is re-minted with real runway.
    now += 45_000;
    const refreshed = await store.recordDestinationQuoteRefresh({
      journeyId: journey.id,
      quote: record("b".repeat(64)),
    });
    expect(refreshed.expiresAt).toBeGreaterThan(Math.floor(now / 1000) + 30);
  });
});
