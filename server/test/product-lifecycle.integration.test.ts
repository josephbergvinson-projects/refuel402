import express from "express";
import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import {
  createPolicyRpcProcessor,
  type PolicyRpcAuthorization,
} from "../src/policy-rpc.js";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";
import { createProductDestinationActivator } from "../src/product-activation.js";
import {
  ProductLifecycleStore,
  type ProductActivityCursor,
  type StoredProductQuote,
} from "../src/product-lifecycle-store.js";
import { PostgresStore } from "../src/postgres-store.js";
import {
  acquireDestructiveSuiteLock,
  releaseDestructiveSuiteLock,
} from "./destructive-suite-lock.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let lifecycleStore: PostgresStore;
let productStore: ProductLifecycleStore;
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const target = getAddress("0x2222222222222222222222222222222222222222");

function quote(
  quoteId: string,
  overrides: Partial<StoredProductQuote> = {},
): StoredProductQuote {
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
      schema: "refuel402.combined-quote.v1",
      quoteId,
      mode: "testnet",
      account: account.address,
      capabilities: { execute: true },
    },
    ...overrides,
  };
}

async function createJourney(quoteId: string, idempotencyKey: string) {
  await productStore.saveQuote(quote(quoteId));
  return productStore.createJourney({
    quoteId,
    mode: "testnet",
    account: account.address,
    idempotencyKey,
  });
}

// created_at is stamped by the store at write time, so window-boundary cases are
// seeded directly to pin an event on a chosen side of the cutoff.
async function seedActivationEvent(
  journeyId: string,
  eventType: "destination_activation_started" | "destination_activation_funded",
  record: Record<string, unknown>,
  createdAt: number,
) {
  await lifecycleStore.pool.query(
    `INSERT INTO refuel402_product_events (journey_id, event_type, record, created_at)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [journeyId, eventType, JSON.stringify(record), createdAt],
  );
}

async function recordArrival(journeyId: string) {
  const sourceTransactionHash = keccak256(
    `0x${Buffer.from(`bridge:${journeyId}`).toString("hex")}` as Hex,
  );
  await productStore.recordBridgeSubmission({
    journeyId,
    sourceTransactionHash,
    destinationBalanceBefore: "0",
    hbarBalanceBefore: "10000000",
  });
  await productStore.recordBridgeArrival({
    journeyId,
    sourceTransactionHash,
    destinationTransactionHash: null,
    destinationBalanceAfter: "1000",
    destinationAmountReceived: "1000",
    providerStatus: "success",
  });
}

function payment(paymentIdentity = "payment-fixture") {
  return {
    paymentIdentity,
    payer: account.address,
    network: "eip155:296",
    asset: "0x0000000000000000000000000000000000001001",
    amount: "1000",
    settlementReference: `settlement:${paymentIdentity}`,
    proofHash: keccak256(
      `0x${Buffer.from(paymentIdentity).toString("hex")}` as Hex,
    ),
  };
}

function authorization(
  id: string,
  rawTransactionHash: Hex,
  nonce = 0,
  expiresAt = Math.floor(Date.now() / 1000) + 300,
): PolicyRpcAuthorization {
  return {
    id,
    mode: "testnet",
    account: account.address,
    chainId: 296,
    nonce,
    to: target,
    dataHash: keccak256("0x1234"),
    value: 0n,
    gasLimitMaximum: 100_000n,
    maxGasAllowanceTinybar: 10_000_000n,
    expiresAt,
  };
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

suite("PostgreSQL product lifecycle integration", () => {
  beforeAll(async () => {
    await acquireDestructiveSuiteLock(databaseUrl!);
    lifecycleStore = await PostgresStore.connect(databaseUrl!);
    productStore = new ProductLifecycleStore(lifecycleStore.pool);
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

  it("serves bounded account-isolated Activity pages without lifecycle mutation", async () => {
    const first = await createJourney("a".repeat(64), "activity-first-0001");
    const second = await createJourney("b".repeat(64), "activity-second-0001");
    const otherAccount = privateKeyToAccount(`0x${"33".repeat(32)}`);
    await productStore.saveQuote(quote("c".repeat(64), { account: otherAccount.address }));
    await productStore.createJourney({
      quoteId: "c".repeat(64),
      mode: "testnet",
      account: otherAccount.address,
      idempotencyKey: "activity-other-0001",
    });
    await lifecycleStore.pool.query(
      `UPDATE refuel402_product_journeys
       SET updated_at = CASE journey_id WHEN $1 THEN 1000 WHEN $2 THEN 2000 ELSE 3000 END`,
      [first.id, second.id],
    );
    const beforeEvents = await lifecycleStore.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM refuel402_product_events",
    );
    const { server, base } = await listen(createProductLifecycleRouter({ store: productStore }));
    try {
      const pageOneResponse = await fetch(
        `${base}/v1/product/journeys?account=${account.address}&limit=1`,
      );
      expect(pageOneResponse.status).toBe(200);
      const pageOne = await pageOneResponse.json() as any;
      expect(pageOne).toMatchObject({
        schema: "refuel402.product-activity.v2",
        account: getAddress(account.address),
        nextBefore: { active: false, updatedAt: 2000, journeyId: second.id },
        items: [{ journeyId: second.id, action: "resume", state: "ready" }],
      });
      expect(pageOne.items[0]).not.toHaveProperty("events");
      expect(pageOne.items[0]).not.toHaveProperty("authorizations");

      const pageTwo = await fetch(
        `${base}/v1/product/journeys?account=${account.address}&limit=1&before=${pageOne.nextBefore.updatedAt}` +
          `&beforeJourneyId=${pageOne.nextBefore.journeyId}&beforeActive=${pageOne.nextBefore.active}`,
      ).then((response) => response.json()) as any;
      expect(pageTwo.items.map((item: any) => item.journeyId)).toEqual([first.id]);
      expect(pageTwo.items.some((item: any) => item.journeyId === second.id)).toBe(false);

      const isolated = await fetch(
        `${base}/v1/product/journeys?account=${otherAccount.address}&limit=8`,
      ).then((response) => response.json()) as any;
      expect(isolated.items).toHaveLength(1);
      expect(isolated.items[0].journeyId).not.toBe(first.id);
      expect(isolated.items[0].journeyId).not.toBe(second.id);

      const invalid = await fetch(`${base}/v1/product/journeys?account=bad&limit=99`);
      expect(invalid.status).toBe(400);
      const afterEvents = await lifecycleStore.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM refuel402_product_events",
      );
      expect(afterEvents.rows[0]!.count).toBe(beforeEvents.rows[0]!.count);
    } finally {
      await close(server);
    }
  });

  it("keeps older active work ahead of newer drafts and pages timestamp ties without loss", async () => {
    const active = await createJourney("d".repeat(60) + "1001", "activity-priority-0001");
    const draftA = await createJourney("d".repeat(60) + "1002", "activity-priority-0002");
    const draftB = await createJourney("d".repeat(60) + "1003", "activity-priority-0003");
    await lifecycleStore.pool.query(
      `UPDATE refuel402_product_journeys
       SET state = CASE WHEN journey_id = $1 THEN 'bridge_pending' ELSE 'ready' END,
           updated_at = CASE WHEN journey_id = $1 THEN 500 ELSE 1000 END
       WHERE journey_id = ANY($2::text[])`,
      [active.id, [active.id, draftA.id, draftB.id]],
    );
    const seen: string[] = [];
    let cursor: ProductActivityCursor | null = null;
    do {
      const page = await productStore.listJourneysForAccount(account.address, { limit: 1, cursor });
      seen.push(...page.journeys.map((journey) => journey.id));
      cursor = page.nextCursor;
    } while (cursor && seen.length < 4);
    expect(seen).toEqual([
      active.id,
      ...[draftA.id, draftB.id].sort((left, right) => right.localeCompare(left)),
    ]);
    expect(new Set(seen).size).toBe(3);
  });

  it("rebinds one live source quote to the same pre-boundary journey and refuses after a wallet boundary", async () => {
    const sourceRecord = (quoteId: string) => ({
      schema: "refuel402.combined-quote.v1",
      quoteId,
      mode: "testnet",
      account: account.address,
      routeMode: "bridge_plus_refuel",
      capabilities: { execute: true },
      asset: { id: "axelar:testnet:fixture" },
      bridge: {
        originChainId: "11155111",
        originToken: target,
        transaction: { from: account.address, to: target, data: "0x", value: "0" },
        normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
      },
      amountLedger: { hbar: { exactOutputTinybar: "100000000" } },
      destination: { slippageBps: 100 },
    });
    const oldQuoteId = "d".repeat(60) + "2001";
    const newQuoteId = "d".repeat(60) + "2002";
    const blockedQuoteId = "d".repeat(60) + "2003";
    await productStore.saveQuote(quote(oldQuoteId, { record: sourceRecord(oldQuoteId) }));
    await productStore.saveQuote(quote(newQuoteId, { record: sourceRecord(newQuoteId) }));
    await productStore.saveQuote(quote(blockedQuoteId, { record: sourceRecord(blockedQuoteId) }));
    const journey = await productStore.createJourney({
      quoteId: oldQuoteId,
      mode: "testnet",
      account: account.address,
      idempotencyKey: "source-resend-0001",
    });
    const rebound = await productStore.refreshSourceQuote({ journeyId: journey.id, quoteId: newQuoteId });
    expect(rebound.id).toBe(journey.id);
    expect(rebound.quoteId).toBe(newQuoteId);
    expect(rebound.events.filter((event) => event.type === "source_quote_refreshed")).toHaveLength(1);
    const replay = await productStore.refreshSourceQuote({ journeyId: journey.id, quoteId: newQuoteId });
    expect(replay.events.filter((event) => event.type === "source_quote_refreshed")).toHaveLength(1);
    await productStore.recordWalletBoundary({ journeyId: journey.id, kind: "bridge" });
    await expect(productStore.refreshSourceQuote({ journeyId: journey.id, quoteId: blockedQuoteId }))
      .rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
  });

  /**
   * A resend re-prices; it must never re-negotiate. The fingerprint is the only
   * thing standing between "send the transfer you already consented to at a live
   * price" and "send a different transfer", so every field it pins gets a test.
   * These run against real SQL because the comparison happens inside the
   * FOR UPDATE transaction, not in the route.
   */
  it("refuses a replacement source quote that changes what the owner consented to", async () => {
    const sourceRecord = (quoteId: string, overrides: Record<string, unknown> = {}) => ({
      schema: "refuel402.combined-quote.v1",
      quoteId,
      mode: "testnet",
      account: account.address,
      routeMode: "bridge_plus_refuel",
      capabilities: { execute: true },
      asset: { id: "axelar:testnet:fixture" },
      bridge: {
        originChainId: "11155111",
        originToken: target,
        transaction: { from: account.address, to: target, data: "0x", value: "0" },
        normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
      },
      amountLedger: { hbar: { exactOutputTinybar: "100000000" } },
      destination: { slippageBps: 100 },
      ...overrides,
    });
    const baseQuoteId = "d".repeat(60) + "3000";
    await productStore.saveQuote(quote(baseQuoteId, { record: sourceRecord(baseQuoteId) }));
    const journey = await productStore.createJourney({
      quoteId: baseQuoteId,
      mode: "testnet",
      account: account.address,
      idempotencyKey: "source-resend-guard-0001",
    });

    // Each case is a distinct way a resend could quietly become a different deal,
    // or could hand the wallet something it cannot broadcast.
    const cases: Array<{ id: string; code: string; quote: Partial<StoredProductQuote> }> = [
      {
        id: "d".repeat(60) + "3001",
        code: "IDEMPOTENCY_CONFLICT",
        quote: { record: sourceRecord("x", { bridge: { originChainId: "11155111", originToken: target, transaction: { from: account.address, to: target, data: "0x", value: "0" }, normalized: { sourceAmount: { amount: "2000000", decimals: 6, symbol: "USDC" } } } }) },
      },
      {
        id: "d".repeat(60) + "3002",
        code: "IDEMPOTENCY_CONFLICT",
        quote: { record: sourceRecord("x", { amountLedger: { hbar: { exactOutputTinybar: "900000000" } } }) },
      },
      {
        id: "d".repeat(60) + "3003",
        code: "IDEMPOTENCY_CONFLICT",
        quote: { record: sourceRecord("x", { destination: { slippageBps: 500 } }) },
      },
      {
        id: "d".repeat(60) + "3004",
        code: "QUOTE_EXPIRED",
        quote: { expiresAt: Math.floor(Date.now() / 1000) - 1 },
      },
      {
        id: "d".repeat(60) + "3005",
        code: "QUOTE_NOT_EXECUTABLE",
        quote: { executable: false },
      },
      {
        id: "d".repeat(60) + "3006",
        code: "QUOTE_NOT_EXECUTABLE",
        quote: { record: sourceRecord("x", { bridge: { originChainId: "11155111", originToken: target, normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } } } }) },
      },
      {
        id: "d".repeat(60) + "3007",
        code: "IDEMPOTENCY_CONFLICT",
        quote: { originChainId: "1" },
      },
    ];

    for (const example of cases) {
      await productStore.saveQuote(quote(example.id, {
        record: sourceRecord(example.id),
        ...example.quote,
      }));
      await expect(
        productStore.refreshSourceQuote({ journeyId: journey.id, quoteId: example.id }),
        example.code,
      ).rejects.toMatchObject({ code: example.code });
    }

    // Every refusal left the journey on its original quote.
    const unchanged = await productStore.getJourney(journey.id);
    expect(unchanged?.quoteId).toBe(baseQuoteId);
    expect(unchanged?.events.filter((event) => event.type === "source_quote_refreshed")).toHaveLength(0);
  });

  /**
   * The route verifies consent against a journey it read BEFORE taking the row
   * lock, so the store re-asserts the recovered signer against the row it actually
   * locks. Without this the check trusts a snapshot another transaction could have
   * moved underneath it.
   */
  it("refuses a source resend whose consent does not recover to the locked journey owner", async () => {
    const sourceRecord = (id: string) => ({
      schema: "refuel402.combined-quote.v1",
      quoteId: id,
      mode: "testnet",
      account: account.address,
      routeMode: "bridge_plus_refuel",
      capabilities: { execute: true },
      asset: { id: "axelar:testnet:fixture" },
      bridge: {
        originChainId: "11155111",
        originToken: target,
        transaction: { from: account.address, to: target, data: "0x", value: "0" },
        normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
      },
      amountLedger: { hbar: { exactOutputTinybar: "100000000" } },
      destination: { slippageBps: 100 },
    });
    const firstQuoteId = "f".repeat(60) + "6001";
    const secondQuoteId = "f".repeat(60) + "6002";
    await productStore.saveQuote(quote(firstQuoteId, { record: sourceRecord(firstQuoteId) }));
    await productStore.saveQuote(quote(secondQuoteId, { record: sourceRecord(secondQuoteId) }));
    const journey = await productStore.createJourney({
      quoteId: firstQuoteId,
      mode: "testnet",
      account: account.address,
      idempotencyKey: "source-resend-consent-0001",
    });

    await expect(productStore.refreshSourceQuote({
      journeyId: journey.id,
      quoteId: secondQuoteId,
      consentedAccount: getAddress("0x3333333333333333333333333333333333333333"),
    })).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });

    // Refused before any write: still on the original quote, no rebind event.
    const unchanged = await productStore.getJourney(journey.id);
    expect(unchanged?.quoteId).toBe(firstQuoteId);
    expect(unchanged?.events.filter((event) => event.type === "source_quote_refreshed")).toHaveLength(0);

    // The owner's own consent still works.
    const rebound = await productStore.refreshSourceQuote({
      journeyId: journey.id,
      quoteId: secondQuoteId,
      consentedAccount: getAddress(account.address),
    });
    expect(rebound.quoteId).toBe(secondQuoteId);
  });

  /**
   * A live pre-authorized refuel and the manual destination path must never be
   * able to spend the same arrival. The executor locks only the refuel row and
   * createAuthorization locks only the journey row, so without taking both the two
   * transactions do not exclude each other — a background execution could land
   * while the owner is walking the manual legs, and both would spend.
   */
  it("refuses a manual destination leg while a pre-authorized refuel is live", async () => {
    const quoteId = "e".repeat(60) + "7001";
    const journey = await createJourney(quoteId, "refuel-exclusion-0001");
    await productStore.recordRefuelAuthorization({
      id: `refuel-${journey.id}`,
      journeyId: journey.id,
      owner: getAddress(account.address),
      token: target,
      maxAmountIn: "1000000",
      exactHbarTinybar: "1000000000",
      serviceFeeAmount: "100000",
      maxSponsorExposureTinybar: "100000000",
      recipient: getAddress(account.address),
      journeyNonce: "1",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      routeHash: `0x${"11".repeat(32)}`,
      signature: `0x${"22".repeat(65)}`,
      permit2: target,
      spender: target,
      route: {
        wrapper: target,
        htsToken: target,
        router: target,
        whbar: target,
        wrapperRate: "1",
        swapPath: "0x22222222222222222222222222222222222222220005dc2222222222222222222222222222222222222222" as Hex,
      },
    } as any);

    const authorization = {
      mode: "testnet" as const,
      account: getAddress(account.address),
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: `0x${"33".repeat(32)}`,
      value: 0n,
      gasLimitMaximum: 100_000n,
      maxGasAllowanceTinybar: 1_000_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };

    // arrival_confirmed is where the manual destination path legitimately starts,
    // so the allowed-states gate passes here and ONLY the refuel fence can refuse.
    // Without this the test would pass for the wrong reason.
    await lifecycleStore.pool.query(
      "UPDATE refuel402_product_journeys SET state = 'arrival_confirmed' WHERE journey_id = $1",
      [journey.id],
    );

    await expect(productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "manual-permit2-0001",
      authorization: authorization as any,
    })).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });

    // Positive control: release the pre-authorization and the same call proceeds
    // past the fence, proving the refusal above came from the fence and not from
    // the state gate.
    await lifecycleStore.pool.query(
      "UPDATE refuel402_product_refuel_authorizations SET state = 'expired' WHERE journey_id = $1",
      [journey.id],
    );
    const released = await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "manual-permit2-0002",
      authorization: authorization as any,
    });
    expect(released.intentKind).toBe("permit2_approval");
  });

  /**
   * The Permit2 allowance is one-time-per-token setup, so it is taken pre-bridge
   * while the wallet is already on Hedera. Where a confirmed approval LEAVES the
   * journey must therefore depend on durable bridge evidence, not on the intent
   * kind: mapping it to `payment_pending` unconditionally drove a pre-bridge
   * journey into a state where the wallet boundary and the bridge submission were
   * both refused, bricking it before anything was sent.
   */
  it("leaves a pre-bridge Permit2 approval still bridgeable, and still bridges after it", async () => {
    const journey = await createJourney("e".repeat(60) + "9001", "permit2-prebridge-0001");
    const rawHash = keccak256("0x9911");
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "authorization-prebridge-permit2",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-prebridge-permit2", rawHash),
    });
    await productStore.consume(rawHash, {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    });
    await productStore.markSubmitted("auth-prebridge-permit2", rawHash);

    // Not payment_pending — there is no bridge evidence yet.
    await expect(productStore.confirmIntent({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      ethereumHash: rawHash,
      receipt: { status: "success" },
    })).resolves.toMatchObject({ state: "bridge_ready" });

    // And the whole point: the journey can still be bridged afterwards.
    await expect(productStore.recordWalletBoundary({
      journeyId: journey.id,
      kind: "bridge",
    })).resolves.toMatchObject({ id: journey.id });
  });

  /**
   * The refuel completed ON CHAIN. If the journey has meanwhile left
   * arrival_confirmed the conflict must still be surfaced — but throwing from
   * inside the transaction rolled the whole thing back, discarding the execution
   * reference and leaving money moved with no record of it. Evidence first, then
   * the conflict.
   */
  it("keeps the on-chain execution record when the journey has already moved on", async () => {
    const journey = await createJourney("e".repeat(60) + "a001", "finalize-conflict-0001");
    await productStore.recordRefuelAuthorization({
      id: `refuel-${journey.id}`,
      journeyId: journey.id,
      owner: getAddress(account.address),
      token: target,
      maxAmountIn: "1000000",
      exactHbarTinybar: "1000000000",
      serviceFeeAmount: "100000",
      maxSponsorExposureTinybar: "100000000",
      recipient: getAddress(account.address),
      journeyNonce: "7",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      routeHash: `0x${"77".repeat(32)}`,
      signature: `0x${"88".repeat(65)}`,
      permit2: target,
      spender: target,
      route: {
        wrapper: target, htsToken: target, router: target, whbar: target, wrapperRate: "1",
        swapPath: `0x${target.slice(2).toLowerCase()}0005dc${target.slice(2).toLowerCase()}`,
      },
    } as any);
    await lifecycleStore.pool.query(
      "UPDATE refuel402_product_refuel_authorizations SET state = 'executing' WHERE journey_id = $1",
      [journey.id],
    );
    // The owner's own manual leg moved the journey out from under the executor.
    await lifecycleStore.pool.query(
      "UPDATE refuel402_product_journeys SET state = 'payment_pending' WHERE journey_id = $1",
      [journey.id],
    );

    await expect(productStore.finalizeRefuelAuthorization({
      journeyId: journey.id,
      state: "completed",
      executionReference: "0xdeadbeefcafe",
      evidence: { note: "executed" },
    })).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });

    // The conflict was raised, and the evidence survived it.
    const after = await productStore.getJourney(journey.id);
    const types = (after?.events ?? []).map((event) => event.type);
    expect(types).toContain("refuel_authorization_executed");
    expect(types).toContain("refuel_authorization_state_conflict");
    const row = await lifecycleStore.pool.query<{ state: string; execution_reference: string | null }>(
      "SELECT state, execution_reference FROM refuel402_product_refuel_authorizations WHERE journey_id = $1",
      [journey.id],
    );
    expect(row.rows[0]).toMatchObject({ state: "completed", execution_reference: "0xdeadbeefcafe" });
  });

  /**
   * The background sweep must stop chasing journeys it can no longer confirm.  /**
   * The background sweep must stop chasing journeys it can no longer confirm.  /**
   * The background sweep must stop chasing journeys it can no longer confirm.
   * Arrival matching only accepts a credit inside the 72h adoption window, so an
   * older `bridge_pending` journey is unreachable by polling — and because the
   * sweep is oldest-first, leaving those rows in the candidate set would spend the
   * provider and mirror rate budget on doomed work ahead of journeys that can
   * still land.
   */
  it("drops bridge sweep candidates older than the arrival window", async () => {
    const freshQuoteId = "e".repeat(60) + "5001";
    const staleQuoteId = "e".repeat(60) + "5002";
    const fresh = await createJourney(freshQuoteId, "sweep-age-fresh-0001");
    const stale = await createJourney(staleQuoteId, "sweep-age-stale-0001");
    const now = Date.now();
    const withinWindow = now - 60 * 60 * 1000;
    const pastWindow = now - 80 * 3_600 * 1_000;
    await lifecycleStore.pool.query(
      `UPDATE refuel402_product_journeys
       SET state = 'bridge_pending',
           updated_at = CASE WHEN journey_id = $1 THEN $3::bigint ELSE $4::bigint END
       WHERE journey_id = ANY($2::text[])`,
      [fresh.id, [fresh.id, stale.id], withinWindow, pastWindow],
    );

    const candidates = await productStore.listBridgeSweepCandidateIds(50, now);
    expect(candidates).toContain(fresh.id);
    expect(candidates).not.toContain(stale.id);
  });

  /**
   * The entire economic justification for staying on the same journey: a Hedera
   * activation that was already paid for must survive the resend. If it did not,
   * "Send this journey again" would be a more expensive "Start a fresh transfer".
   */
  it("preserves a confirmed destination activation across a source resend", async () => {
    const sourceRecord = (quoteId: string) => ({
      schema: "refuel402.combined-quote.v1",
      quoteId,
      mode: "testnet",
      account: account.address,
      routeMode: "bridge_plus_refuel",
      capabilities: { execute: true },
      asset: { id: "axelar:testnet:fixture" },
      bridge: {
        originChainId: "11155111",
        originToken: target,
        transaction: { from: account.address, to: target, data: "0x", value: "0" },
        normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
      },
      amountLedger: { hbar: { exactOutputTinybar: "100000000" } },
      destination: { slippageBps: 100 },
    });
    const firstQuoteId = "d".repeat(60) + "4001";
    const secondQuoteId = "d".repeat(60) + "4002";
    await productStore.saveQuote(quote(firstQuoteId, { record: sourceRecord(firstQuoteId) }));
    await productStore.saveQuote(quote(secondQuoteId, { record: sourceRecord(secondQuoteId) }));
    const journey = await productStore.createJourney({
      quoteId: firstQuoteId,
      mode: "testnet",
      account: account.address,
      idempotencyKey: "source-resend-activation-0001",
    });
    await productStore.recordDestinationActivation({
      journeyId: journey.id,
      transactionId: "0.0.1-2-3",
      amountTinybar: "50000000",
      status: "funded",
    });

    const rebound = await productStore.refreshSourceQuote({ journeyId: journey.id, quoteId: secondQuoteId });
    expect(rebound.quoteId).toBe(secondQuoteId);
    // The activation evidence is append-only and must still be there.
    expect(rebound.events.some((event) => event.type === "destination_activation_funded")).toBe(true);
    // And the journey must not have been rewound behind the work already paid for.
    expect(rebound.state).not.toBe("abandoned");
    expect(["ready", "bridge_ready"]).toContain(rebound.state);
  });

  it("runs the exact HTTP journey create/read shape with immutable idempotency", async () => {
    const quoteId = "1".repeat(64);
    await productStore.saveQuote(quote(quoteId));
    const { server, base } = await listen(
      createProductLifecycleRouter({ store: productStore }),
    );
    try {
      const body = { mode: "testnet", quoteId, account: account.address };
      const first = await fetch(`${base}/v1/product/journeys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "journey-fixture-0001",
        },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as {
        journey: { id: string; state: string };
      };
      expect(firstBody.journey.state).toBe("ready");

      const replay = await fetch(`${base}/v1/product/journeys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "journey-fixture-0001",
        },
        body: JSON.stringify(body),
      });
      const replayBody = (await replay.json()) as { journey: { id: string } };
      expect(replay.status).toBe(201);
      expect(replayBody.journey.id).toBe(firstBody.journey.id);

      const readback = await fetch(
        `${base}/v1/product/journeys/${firstBody.journey.id}`,
      );
      expect(readback.status).toBe(200);
      await expect(readback.json()).resolves.toMatchObject({
        journey: {
          id: firstBody.journey.id,
          quoteId,
          account: account.address,
          requestedProvider: "auto",
          selectedProvider: "axelar",
          assetId: "axelar:testnet:fixture",
          originChainId: "11155111",
          events: [{ type: "journey_created" }],
        },
      });
      const quoteReadback = await fetch(`${base}/v1/product/quotes/${quoteId}`);
      expect(quoteReadback.status).toBe(200);
      await expect(quoteReadback.json()).resolves.toMatchObject({
        quote: {
          quoteId,
          requestedProvider: "auto",
          selectedProvider: "axelar",
        },
      });
      await expect(
        productStore.saveQuote(
          quote(quoteId, {
            record: {
              schema: "refuel402.combined-quote.v1",
              quoteId,
              altered: true,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(
        lifecycleStore.pool.query(
          "UPDATE refuel402_product_events SET event_type = 'tampered' WHERE journey_id = $1",
          [firstBody.journey.id],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await close(server);
    }
  });

  it("persists one payment and one immutable intent authorization through the HTTP wrapper", async () => {
    const journey = await createJourney("2".repeat(64), "journey-fixture-0002");
    await recordArrival(journey.id);
    const raw = await account.signTransaction({
      chainId: 296,
      type: "eip1559",
      nonce: 0,
      to: target,
      data: "0x1234",
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    const rawHash = keccak256(raw);
    const router = createProductLifecycleRouter({
      store: productStore,
      paymentVerifier: { verify: vi.fn(async () => payment()) },
      intentBuilder: {
        build: vi.fn(async () => ({
          rawTransactionHash: rawHash,
          authorization: authorization("auth-http-1", rawHash),
          transaction: {
            chainId: 296,
            from: account.address,
            to: target,
            data: "0x1234" as Hex,
            value: "0",
            gas: "100000",
            nonce: 0,
            maxFeePerGas: "0" as const,
            maxPriorityFeePerGas: "0" as const,
          },
        })),
      },
    });
    const { server, base } = await listen(router);
    try {
      const paid = await fetch(
        `${base}/v1/product/journeys/${journey.id}/payment`,
        {
          method: "POST",
          headers: {
            "payment-signature": "fixture-redacted",
            "idempotency-key": "payment-fixture-0001",
          },
        },
      );
      expect(paid.status).toBe(200);
      await expect(paid.json()).resolves.toMatchObject({
        payment: { paymentIdentity: "payment-fixture", journeyId: journey.id },
      });

      const replay = await fetch(
        `${base}/v1/product/journeys/${journey.id}/payment`,
        {
          method: "POST",
          headers: {
            "payment-signature": "fixture-redacted",
            "idempotency-key": "payment-fixture-0002",
          },
        },
      );
      expect(replay.status).toBe(409);

      const authorized = await fetch(
        `${base}/v1/product/journeys/${journey.id}/intents/router_execution/authorize`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "authorization-0001",
          },
          body: "{}",
        },
      );
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toMatchObject({
        authorization: {
          id: "auth-http-1",
          rawTransactionHash: null,
          matching:
            "exact_unsigned_fields_then_one_time_raw_transaction_consumption",
          state: "pending",
        },
      });

      const readback = await productStore.getJourney(journey.id);
      expect(readback).toMatchObject({
        state: "authorizing",
        payment: { paymentIdentity: "payment-fixture" },
        authorizations: [{ id: "auth-http-1", state: "pending" }],
        submissions: [],
        events: [
          { type: "journey_created" },
          { type: "bridge_submitted" },
          { type: "bridge_arrived" },
          { type: "payment_settled" },
          { type: "authorization_created" },
        ],
      });
      const events = await fetch(
        `${base}/v1/product/journeys/${journey.id}/events`,
      );
      expect(events.status).toBe(200);
      await expect(events.json()).resolves.toMatchObject({
        events: [
          { type: "journey_created" },
          { type: "bridge_submitted" },
          { type: "bridge_arrived" },
          { type: "payment_settled" },
          { type: "authorization_created" },
        ],
      });
      const submissions = await fetch(
        `${base}/v1/product/journeys/${journey.id}/submissions`,
      );
      expect(submissions.status).toBe(200);
      await expect(submissions.json()).resolves.toMatchObject({
        submissions: [],
      });
    } finally {
      await close(server);
    }
  });

  it("consumes a policy-RPC authorization once and persists the submission result", async () => {
    const journey = await createJourney("3".repeat(64), "journey-fixture-0003");
    await recordArrival(journey.id);
    await productStore.recordPayment({
      journeyId: journey.id,
      idempotencyKey: "payment-fixture-0003",
      payment: payment("payment-policy-rpc"),
    });
    const raw = await account.signTransaction({
      chainId: 296,
      type: "eip1559",
      nonce: 0,
      to: target,
      data: "0x1234",
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    const rawHash = keccak256(raw);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "router_execution",
      idempotencyKey: "authorization-0002",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-policy-rpc-1", rawHash),
    });
    const submit = vi.fn(async () => ({ ethereumHash: rawHash }));
    const process = createPolicyRpcProcessor({
      upstreams: {
        testnet: "https://testnet.hashio.io/api",
        mainnet: "https://mainnet.hashio.io/api",
      },
      authorizer: productStore,
      submitter: { testnet: { submit } },
    });

    const first = await process("testnet", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [raw],
    });
    expect(first).toMatchObject({ result: rawHash });
    const replay = await process("testnet", {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_sendRawTransaction",
      params: [raw],
    });
    expect(replay).toMatchObject({ error: { code: -32003 } });
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "execution_pending",
      authorizations: [
        { id: "auth-policy-rpc-1", state: "submitted", ethereumHash: rawHash },
      ],
      submissions: [
        {
          authorizationId: "auth-policy-rpc-1",
          state: "submitted",
          ethereumHash: rawHash,
        },
      ],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "authorization_consumed" }),
        expect.objectContaining({ type: "authorization_submitted" }),
      ]),
    });
  });

  it("persists one authoritative final receipt and completes the journey idempotently", async () => {
    const journey = await createJourney("5".repeat(64), "journey-fixture-0005");
    await recordArrival(journey.id);
    await productStore.recordPayment({
      journeyId: journey.id,
      idempotencyKey: "payment-idempotency-0005",
      payment: payment("payment-fixture-0005"),
    });
    const raw = await account.signTransaction({
      chainId: 296,
      type: "eip1559",
      nonce: 5,
      to: target,
      data: "0x1234",
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    const rawHash = keccak256(raw);
    const candidate = {
      mode: "testnet" as const,
      account: account.address,
      chainId: 296,
      nonce: 5,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    };
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "router_execution",
      idempotencyKey: "authorization-0005",
      authorization: authorization("auth-reconcile-1", rawHash, 5),
    });
    await expect(
      productStore.consume(rawHash, candidate),
    ).resolves.toMatchObject({ id: "auth-reconcile-1" });
    await productStore.markSubmitted("auth-reconcile-1", rawHash);
    const receipt = {
      transactionHash: rawHash,
      status: "success",
      destinationAssetRemaining: "9477000",
      hbarReceivedTinybar: "500000000",
      reconciliation: "complete_with_balance_readback",
    };
    await expect(
      productStore.recordReconciliation({
        journeyId: journey.id,
        ethereumHash: rawHash,
        receipt,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    await expect(
      productStore.recordReconciliation({
        journeyId: journey.id,
        ethereumHash: rawHash,
        receipt,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    await expect(
      productStore.recordReconciliation({
        journeyId: journey.id,
        ethereumHash: rawHash,
        receipt: { ...receipt, hbarReceivedTinybar: "499999999" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "completed",
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "journey_reconciled",
          record: expect.objectContaining({
            reconciliation: "complete",
            receipt,
          }),
        }),
      ]),
    });
  });

  it("fails closed across restart when a consumed submission result is unknown, without poisoning in-flight consumption", async () => {
    const journey = await createJourney("4".repeat(64), "journey-fixture-0004");
    const rawHash = keccak256("0x1234");
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorization-0003",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-restart-1", rawHash),
    });
    const candidate = {
      mode: "testnet" as const,
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    };
    await expect(
      productStore.consume(rawHash, candidate),
    ).resolves.toMatchObject({ id: "auth-restart-1" });

    const restarted = new ProductLifecycleStore(lifecycleStore.pool);
    // A replica booting mid-submission must not flip a millisecond-scale
    // consumed transient to unknown; only expiry-aged consumption is unknown.
    await expect(restarted.recoverInterrupted()).resolves.toMatchObject({
      unknownAuthorizations: 0,
      reviewJourneys: 0,
    });
    await expect(restarted.getJourney(journey.id)).resolves.toMatchObject({
      state: "submitting",
      authorizations: [{ id: "auth-restart-1", state: "consumed" }],
    });
    const agedNowSec = Math.floor(Date.now() / 1000) + 601;
    await expect(
      restarted.recoverInterrupted(agedNowSec),
    ).resolves.toMatchObject({
      unknownAuthorizations: 1,
      reviewJourneys: 1,
    });
    await expect(
      restarted.recoverInterrupted(agedNowSec),
    ).resolves.toMatchObject({
      unknownAuthorizations: 0,
      reviewJourneys: 0,
    });
    await expect(restarted.getJourney(journey.id)).resolves.toMatchObject({
      state: "review",
      authorizations: [{ id: "auth-restart-1", state: "unknown" }],
      submissions: [{ authorizationId: "auth-restart-1", state: "unknown" }],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "restart_unknown_submission" }),
      ]),
    });
    await expect(restarted.consume(rawHash, candidate)).resolves.toBeNull();
  });

  it("reverts to the furthest durable checkpoint instead of behind confirmed activation work", async () => {
    const journey = await createJourney("c".repeat(64), "journey-fixture-000c");
    const rawHash = keccak256("0x4321");
    const nowSec = Math.floor(Date.now() / 1000);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorization-000c-activation",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-000c-activation", rawHash),
    });
    await productStore.consume(rawHash, {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    });
    await productStore.markSubmitted("auth-000c-activation", rawHash);
    await expect(
      productStore.confirmIntent({
        journeyId: journey.id,
        intentKind: "activation",
        ethereumHash: rawHash,
        receipt: { status: "success" },
      }),
    ).resolves.toMatchObject({ state: "bridge_ready" });
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorization-000c-retry",
      authorization: authorization(
        "auth-000c-retry",
        keccak256("0x9876"),
        1,
        nowSec + 60,
      ),
    });
    await expect(
      productStore.recoverInterrupted(nowSec + 120),
    ).resolves.toMatchObject({
      expiredAuthorizations: 1,
      revertedJourneys: 1,
    });
    // The HTS association is already on chain: reverting to 'ready' would ask
    // for it again.
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "bridge_ready",
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "journey_reverted",
          record: expect.objectContaining({ to: "bridge_ready" }),
        }),
      ]),
    });
  });

  it("leaves a journey with a still-consumable pending authorization alone until it expires", async () => {
    const journey = await createJourney("d".repeat(64), "journey-fixture-000d");
    await recordArrival(journey.id);
    const nowSec = Math.floor(Date.now() / 1000);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "authorization-000d-short",
      authorization: authorization(
        "auth-000d-short",
        keccak256("0x5678"),
        3,
        nowSec + 60,
      ),
    });
    // A second live reservation for the SAME intent kind would now supersede the
    // short one, so the two coexisting rows this sweep is about must be
    // different kinds.
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "wrapper_approval",
      idempotencyKey: "authorization-000d-live",
      authorization: authorization(
        "auth-000d-live",
        keccak256("0x6789"),
        4,
        nowSec + 3600,
      ),
    });
    await expect(
      productStore.recoverInterrupted(nowSec + 120),
    ).resolves.toMatchObject({
      expiredAuthorizations: 1,
      revertedJourneys: 0,
    });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "authorizing",
    });
    await expect(
      productStore.recoverInterrupted(nowSec + 4000),
    ).resolves.toMatchObject({
      expiredAuthorizations: 1,
      revertedJourneys: 1,
    });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "arrival_confirmed",
    });
  });

  it("reverts expired-pending journeys to their durable-event state instead of review", async () => {
    const journey = await createJourney("6".repeat(64), "journey-fixture-0006");
    await recordArrival(journey.id);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "authorization-0006",
      authorization: authorization(
        "auth-expired-1",
        keccak256("0x5678"),
        3,
        Math.floor(Date.now() / 1000) + 60,
      ),
    });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "authorizing",
    });
    const summary = await productStore.recoverInterrupted(
      Math.floor(Date.now() / 1000) + 120,
    );
    expect(summary).toMatchObject({
      expiredAuthorizations: 1,
      unknownAuthorizations: 0,
      reviewJourneys: 0,
      revertedJourneys: 1,
    });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "arrival_confirmed",
      authorizations: [{ id: "auth-expired-1", state: "expired" }],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "authorization_expired" }),
        expect.objectContaining({
          type: "journey_reverted",
          record: expect.objectContaining({ to: "arrival_confirmed" }),
        }),
      ]),
    });
  });

  async function reviewJourneyWithUnknown(quoteId: string, suffix: string) {
    const journey = await createJourney(quoteId, `journey-fixture-${suffix}`);
    const rawHash = keccak256(`0x12340000${suffix}` as Hex);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: `authorization-${suffix}`,
      rawTransactionHash: rawHash,
      authorization: authorization(`auth-${suffix}`, rawHash),
    });
    await productStore.consume(rawHash, {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    });
    await productStore.recoverInterrupted(Math.floor(Date.now() / 1000) + 601);
    return { journey, rawHash, authorizationId: `auth-${suffix}` };
  }

  it("refuses to bind one mined transaction to two authorizations of the same intent", async () => {
    const journey = await createJourney("e".repeat(64), "journey-fixture-000e");
    const firstRaw = keccak256("0xaa01");
    const secondRaw = keccak256("0xaa02");
    for (const [index, rawHash] of [firstRaw, secondRaw].entries()) {
      await productStore.createAuthorization({
        journeyId: journey.id,
        intentKind: "activation",
        idempotencyKey: `authorization-000e-${index}`,
        rawTransactionHash: rawHash,
        authorization: authorization(`auth-000e-${index}`, rawHash, index),
      });
    }
    // createAuthorization now supersedes the older live reservation, so two
    // consumable rows of one intent kind are only reachable on a database that
    // predates that rule. The hash guard below stays as defense in depth.
    await lifecycleStore.pool.query(
      "UPDATE refuel402_product_authorizations SET state = 'pending' WHERE authorization_id = $1",
      ["auth-000e-0"],
    );
    for (const [index, rawHash] of [firstRaw, secondRaw].entries()) {
      await expect(
        productStore.consume(rawHash, {
          mode: "testnet",
          account: account.address,
          chainId: 296,
          nonce: index,
          to: target,
          dataHash: keccak256("0x1234"),
          value: 0n,
          gasLimit: 100_000n,
        }),
      ).resolves.toMatchObject({ id: `auth-000e-${index}` });
    }
    await productStore.recoverInterrupted(Math.floor(Date.now() / 1000) + 601);
    const ethereumHash = keccak256("0xbb01");
    await expect(
      productStore.resolveSubmissionAsSubmitted({
        authorizationId: "auth-000e-0",
        ethereumHash,
        evidence: {},
      }),
    ).resolves.toMatchObject({ state: "review" });
    await expect(
      productStore.resolveSubmissionAsSubmitted({
        authorizationId: "auth-000e-1",
        ethereumHash,
        evidence: {},
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    const readback = await productStore.getJourney(journey.id);
    expect(
      readback!.authorizations.filter((entry) => entry.state === "submitted"),
    ).toHaveLength(1);
  });

  it("blocks review release while a pending authorization is still consumable", async () => {
    const journey = await createJourney("f".repeat(64), "journey-fixture-000f");
    const nowSec = Math.floor(Date.now() / 1000);
    const rawHash = keccak256("0xcc01");
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorization-000f-consumed",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-000f-consumed", rawHash),
    });
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "permit2_approval",
      idempotencyKey: "authorization-000f-live",
      authorization: authorization(
        "auth-000f-live",
        keccak256("0xcc02"),
        9,
        nowSec + 3600,
      ),
    });
    await productStore.consume(rawHash, {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    });
    await productStore.recoverInterrupted(nowSec + 601);
    await productStore.resolveSubmissionAsRejected({
      authorizationId: "auth-000f-consumed",
      reason: "expired_never_broadcast",
      evidence: {},
    });
    await expect(
      productStore.releaseReviewJourney(journey.id, nowSec + 601),
    ).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
    // Once the live authorization can no longer be consumed it must not wedge
    // review, even though no sweep has flipped it to 'expired' yet.
    await expect(
      productStore.releaseReviewJourney(journey.id, nowSec + 7200),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("resolves an unknown submission as submitted from mirror evidence and exits review", async () => {
    const { journey, rawHash, authorizationId } =
      await reviewJourneyWithUnknown("7".repeat(64), "0007");
    const resolved = await productStore.resolveSubmissionAsSubmitted({
      authorizationId,
      ethereumHash: rawHash,
      evidence: { source: "mirror-contract-result", status: "0x1" },
    });
    expect(resolved).toMatchObject({
      state: "activation_pending",
      authorizations: [
        { id: authorizationId, state: "submitted", ethereumHash: rawHash },
      ],
      submissions: [
        { authorizationId, state: "submitted", ethereumHash: rawHash },
      ],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "submission_reconciled_submitted" }),
      ]),
    });
    await expect(
      productStore.resolveSubmissionAsSubmitted({
        authorizationId,
        ethereumHash: rawHash,
        evidence: {},
      }),
    ).resolves.toMatchObject({ state: "activation_pending" });
    await expect(
      productStore.resolveSubmissionAsSubmitted({
        authorizationId,
        ethereumHash: keccak256("0x9999"),
        evidence: {},
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REPLAY" });
  });

  it("resolves an unknown submission as rejected and releases the review journey from durable events", async () => {
    const { journey, authorizationId } = await reviewJourneyWithUnknown(
      "9".repeat(64),
      "0009",
    );
    await expect(
      productStore.releaseReviewJourney(journey.id),
    ).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
    const rejected = await productStore.resolveSubmissionAsRejected({
      authorizationId,
      reason: "expired_never_broadcast",
      evidence: { source: "mirror-account", ethereumNonce: 0 },
    });
    expect(rejected).toMatchObject({
      state: "review",
      authorizations: [{ id: authorizationId, state: "rejected" }],
      submissions: [
        {
          authorizationId,
          state: "rejected",
          reason: "expired_never_broadcast",
        },
      ],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "submission_reconciled_rejected" }),
      ]),
    });
    const released = await productStore.releaseReviewJourney(journey.id);
    expect(released).toMatchObject({
      state: "ready",
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "review_released",
          record: expect.objectContaining({ targetState: "ready" }),
        }),
      ]),
    });
    await expect(
      productStore.releaseReviewJourney(journey.id),
    ).rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
  });

  it("adopts a lost bridge submission and binds the matched credit as the arrival", async () => {
    const journey = await createJourney("a".repeat(64), "journey-fixture-000a");
    await productStore.recordWalletBoundary({
      journeyId: journey.id,
      kind: "bridge",
    });
    const sourceTransactionHash = keccak256("0xadfadf");
    const credit = {
      transactionId: "0.0.8008-1111111111-000000001",
      transactionHash: `0x${"cd".repeat(24)}`,
      consensusTimestamp: "1785022901.893723365",
      tokenId: "0.0.10285486",
      accountId: "0.0.7007",
      amount: "3000000",
    };
    const adopted = await productStore.adoptBridgeSubmission({
      journeyId: journey.id,
      sourceTransactionHash,
      destinationBalanceBefore: "1000",
      hbarBalanceBefore: "10000000",
      credit,
      amountCriterion: "exact",
      provider: "axelar",
      providerState: "pending",
      providerStatus: "ongoing",
      evidence: { candidateCount: 1 },
    });
    expect(adopted).toMatchObject({
      state: "arrival_confirmed",
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "bridge_submission_adopted",
          record: expect.objectContaining({ userConfirmed: true }),
        }),
        expect.objectContaining({
          type: "bridge_submitted",
          record: expect.objectContaining({ destinationBalanceBefore: "1000" }),
        }),
        expect.objectContaining({
          type: "bridge_arrived",
          record: expect.objectContaining({
            destinationBalanceAfter: "3001000",
            adopted: true,
          }),
        }),
      ]),
    });
    await expect(
      productStore.boundArrivalTransactionIds(account.address),
    ).resolves.toContain(credit.transactionId);
    await expect(
      productStore.adoptBridgeSubmission({
        journeyId: journey.id,
        sourceTransactionHash,
        destinationBalanceBefore: "1000",
        hbarBalanceBefore: "10000000",
        credit,
        amountCriterion: "exact",
        provider: "axelar",
        providerState: "pending",
        providerStatus: "ongoing",
        evidence: { candidateCount: 1 },
      }),
    ).resolves.toMatchObject({ state: "arrival_confirmed" });
    await expect(
      productStore.adoptBridgeSubmission({
        journeyId: journey.id,
        sourceTransactionHash: keccak256("0xdfdfdf"),
        destinationBalanceBefore: "1000",
        hbarBalanceBefore: "10000000",
        credit,
        amountCriterion: "exact",
        provider: "axelar",
        providerState: "pending",
        providerStatus: "ongoing",
        evidence: { candidateCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const arrivalEvents = (await productStore.getJourney(
      journey.id,
    ))!.events.filter((event) => event.type === "bridge_arrived");
    expect(arrivalEvents).toHaveLength(1);
  });

  it("never binds one destination credit to two journeys of the same account", async () => {
    const credit = {
      transactionId: "0.0.8008-2222222222-000000002",
      transactionHash: `0x${"ef".repeat(24)}`,
      consensusTimestamp: "1785022902.893723365",
      tokenId: "0.0.10285486",
      accountId: "0.0.7007",
      amount: "3000000",
    };
    const adoption = (journeyId: string, sourceTransactionHash: Hex) =>
      productStore.adoptBridgeSubmission({
        journeyId,
        sourceTransactionHash,
        destinationBalanceBefore: "1000",
        hbarBalanceBefore: "10000000",
        credit,
        amountCriterion: "exact",
        provider: "axelar" as const,
        providerState: "pending" as const,
        providerStatus: "ongoing",
        evidence: { candidateCount: 1 },
      });
    const first = await createJourney(
      "7".repeat(64),
      "journey-fixture-double-bind-1",
    );
    const second = await createJourney(
      "8".repeat(64),
      "journey-fixture-double-bind-2",
    );
    await productStore.recordWalletBoundary({
      journeyId: first.id,
      kind: "bridge",
    });
    await productStore.recordWalletBoundary({
      journeyId: second.id,
      kind: "bridge",
    });
    await expect(
      adoption(first.id, keccak256("0xdd01")),
    ).resolves.toMatchObject({ state: "arrival_confirmed" });
    await expect(
      adoption(second.id, keccak256("0xdd02")),
    ).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    await expect(productStore.getJourney(second.id)).resolves.toMatchObject({
      state: "ready",
      events: [{ type: "journey_created" }, { type: "bridge_wallet_boundary" }],
    });
    // The same exclusion guards the polling arrival recorder.
    const third = await createJourney(
      "6".repeat(64),
      "journey-fixture-double-bind-3",
    );
    const thirdSource = keccak256("0xdd03");
    await productStore.recordBridgeSubmission({
      journeyId: third.id,
      sourceTransactionHash: thirdSource,
      destinationBalanceBefore: "0",
      hbarBalanceBefore: "10000000",
    });
    await expect(
      productStore.recordBridgeArrival({
        journeyId: third.id,
        sourceTransactionHash: thirdSource,
        destinationTransactionId: credit.transactionId,
        destinationTransactionHash: credit.transactionHash,
        destinationBalanceAfter: "3000000",
        destinationAmountReceived: "3000000",
        providerStatus: "success",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
  });

  it("releases a journey stranded in submitting without waiting for a process restart", async () => {
    const journey = await createJourney(
      "5".repeat(64),
      "journey-fixture-stranded",
    );
    const rawHash = keccak256("0xee01");
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorization-stranded",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-stranded", rawHash),
    });
    // Crash between consume() and markSubmitted: the row stays 'consumed'.
    await expect(
      productStore.consume(rawHash, {
        mode: "testnet",
        account: account.address,
        chainId: 296,
        nonce: 0,
        to: target,
        dataHash: keccak256("0x1234"),
        value: 0n,
        gasLimit: 100_000n,
      }),
    ).resolves.toMatchObject({ id: "auth-stranded" });
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "submitting",
    });
    const reader = {
      contractResult: async (hash: Hex) =>
        hash.toLowerCase() === rawHash.toLowerCase()
          ? {
              hash: rawHash,
              from: account.address,
              to: target,
              nonce: 0,
              function_parameters: "0x1234",
              amount: 0,
              status: "0x1",
            }
          : null,
      account: async () => ({ ethereum_nonce: 1 }),
      contractResultByNonce: async () => null,
    };
    const { server, base } = await listen(
      createProductLifecycleRouter({
        store: productStore,
        submissionEvidence: { testnet: reader },
      }),
    );
    try {
      const inGrace = await fetch(
        `${base}/v1/product/journeys/${journey.id}/reconcile-submissions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(inGrace.status).toBe(200);
      const inGraceBody = (await inGrace.json()) as {
        journey: { state: string };
        resolutions: unknown[];
        recovery: { revalidateAfterMs?: number };
      };
      expect(inGraceBody.resolutions).toEqual([]);
      expect(inGraceBody.journey.state).toBe("submitting");
      expect(inGraceBody.recovery.revalidateAfterMs).toBeGreaterThan(0);

      // The submitting replica stayed down past expiry plus the 300s grace.
      await lifecycleStore.pool.query(
        "UPDATE refuel402_product_authorizations SET expires_at = $2 WHERE authorization_id = $1",
        ["auth-stranded", Math.floor(Date.now() / 1000) - 400],
      );
      const released = await fetch(
        `${base}/v1/product/journeys/${journey.id}/reconcile-submissions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(released.status).toBe(200);
      await expect(released.json()).resolves.toMatchObject({
        journey: { state: "activation_pending" },
        resolutions: [
          {
            authorizationId: "auth-stranded",
            resolution: "submitted",
            ethereumHash: rawHash,
          },
        ],
      });
      await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
        authorizations: [{ id: "auth-stranded", state: "submitted" }],
        submissions: [{ authorizationId: "auth-stranded", state: "submitted" }],
        events: expect.arrayContaining([
          expect.objectContaining({ type: "restart_unknown_submission" }),
          expect.objectContaining({ type: "submission_reconciled_submitted" }),
        ]),
      });
    } finally {
      await close(server);
    }
  });

  it("serves the reconcile-submissions endpoint with a read-only journey GET", async () => {
    const { journey, rawHash, authorizationId } =
      await reviewJourneyWithUnknown("b".repeat(64), "000b");
    const reader = {
      contractResult: async (hash: Hex) =>
        hash.toLowerCase() === rawHash.toLowerCase()
          ? {
              hash: rawHash,
              from: account.address,
              to: target,
              nonce: 0,
              function_parameters: "0x1234",
              status: "0x1",
            }
          : null,
      account: async () => ({ ethereum_nonce: 1 }),
      contractResultByNonce: async () => null,
    };
    const { server, base } = await listen(
      createProductLifecycleRouter({
        store: productStore,
        submissionEvidence: { testnet: reader },
      }),
    );
    try {
      const before = await fetch(`${base}/v1/product/journeys/${journey.id}`);
      const beforeBody = (await before.json()) as {
        schema: string;
        journey: { events: unknown[] };
        recovery: Record<string, unknown>;
        continuation: Record<string, unknown>;
      };
      expect(beforeBody.schema).toBe("refuel402.product-journey.v4");
      expect(beforeBody.continuation).toMatchObject({
        schema: "refuel402.arrival-continuation.v2",
        ready: false,
        nextAction: null,
        error: null,
      });
      expect(beforeBody.recovery).toMatchObject({
        disposition: "blocked_unknown_submit_result",
        nextAtomicStep: "reconcile_submissions",
      });
      const again = await fetch(`${base}/v1/product/journeys/${journey.id}`);
      const againBody = (await again.json()) as typeof beforeBody;
      expect(againBody.journey.events.length).toBe(
        beforeBody.journey.events.length,
      );

      const reconciled = await fetch(
        `${base}/v1/product/journeys/${journey.id}/reconcile-submissions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "reconcile-http-fixture-0001",
          },
          body: "{}",
        },
      );
      expect(reconciled.status).toBe(200);
      await expect(reconciled.json()).resolves.toMatchObject({
        schema: "refuel402.product-reconcile-submissions.v1",
        journey: { state: "activation_pending" },
        resolutions: [
          {
            authorizationId,
            intentKind: "activation",
            resolution: "submitted",
            ethereumHash: rawHash,
          },
        ],
        recovery: {
          nextAtomicStep: "source_wallet_consent",
          revalidateAfterMs: 15000,
        },
      });
      const replay = await fetch(
        `${base}/v1/product/journeys/${journey.id}/reconcile-submissions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "reconcile-http-fixture-0002",
          },
          body: "{}",
        },
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({ resolutions: [] });
    } finally {
      await close(server);
    }
  });

  it("counts sponsored intent allowances the in-memory submitter never recorded", async () => {
    const cutoff = Date.now();
    const nowSec = Math.floor(cutoff / 1000);
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(0n);

    const journey = await createJourney("f".repeat(64), "exposure-0001");
    const rawHash = keccak256(`0x${Buffer.from(`exposure:${journey.id}`).toString("hex")}` as Hex);
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "exposure-auth-live",
      rawTransactionHash: rawHash,
      authorization: authorization("auth-exposure-live", rawHash),
    });

    // A live pending reservation already counts, so concurrent journeys cannot
    // each be told the whole daily cap is free.
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(10_000_000n);
    // ...but a lapsed pending reservation never cost the sponsor anything.
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec: nowSec + 3_600 })).resolves.toBe(0n);
    // ...and spend outside the daily window is not double-counted tomorrow.
    await expect(productStore.sponsoredIntentExposureSince(cutoff + 86_400_000, { nowSec })).resolves.toBe(0n);

    await productStore.consume(rawHash, {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    });
    // Consumed spend counts regardless of expiry: the sponsor already paid.
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec: nowSec + 3_600 })).resolves.toBe(10_000_000n);
    // ...but the submitter deciding on that very row must not be charged its own
    // allowance twice, which would make the effective cap dailyCap - allowance.
    await expect(
      productStore.sponsoredIntentExposureSince(cutoff, { nowSec, excludeRawTransactionHash: rawHash }),
    ).resolves.toBe(0n);
    await expect(
      productStore.sponsoredIntentExposureSince(cutoff, { nowSec, excludeRawTransactionHash: keccak256("0xdead") }),
    ).resolves.toBe(10_000_000n);
  });

  it("keeps one live reservation per intent when a refresh-retry mints a new key", async () => {
    const cutoff = Date.now();
    const nowSec = Math.floor(cutoff / 1000);
    const journey = await createJourney("3".repeat(64), "exposure-supersede-0001");
    const first = await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorize-activation-0001",
      authorization: authorization("auth-supersede-1", keccak256("0xab01")),
    });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(10_000_000n);

    // The web client mints authorize-<kind>-r<n> on a refresh-retry, so the
    // unique replay guard cannot collapse it onto the first reservation.
    const retry = await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorize-activation-0001-r1",
      authorization: authorization("auth-supersede-2", keccak256("0xab02"), 1),
    });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(10_000_000n);
    await expect(productStore.getJourney(journey.id)).resolves.toMatchObject({
      state: "authorizing",
      authorizations: [
        { id: first.id, state: "expired" },
        { id: retry.id, state: "pending" },
      ],
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "authorization_expired",
          record: expect.objectContaining({ authorizationId: first.id }),
        }),
      ]),
    });
    // The superseded row was never broadcast, so it stays consumable-by-nobody
    // rather than becoming evidence that needs review.
    await expect(productStore.consume(keccak256("0xab03"), {
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: target,
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimit: 100_000n,
    })).resolves.toBeNull();

    // Replaying the SAME key returns the stored reservation untouched.
    await expect(productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "activation",
      idempotencyKey: "authorize-activation-0001-r1",
      authorization: authorization("auth-supersede-2", keccak256("0xab02"), 1),
    })).resolves.toMatchObject({ id: retry.id, state: "pending" });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(10_000_000n);

    // A different intent kind is a genuinely separate reservation.
    await productStore.createAuthorization({
      journeyId: journey.id,
      intentKind: "wrapper_approval",
      idempotencyKey: "authorize-wrapper-approval-0001",
      authorization: authorization("auth-supersede-3", keccak256("0xab04"), 2),
    });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(20_000_000n);
  });

  it("keeps mined-reverted spend counted and every other rejection free", async () => {
    const cutoff = Date.now();
    const nowSec = Math.floor(cutoff / 1000);
    const reverted = await reviewJourneyWithUnknown("4".repeat(64), "0011");
    const free = await reviewJourneyWithUnknown("5".repeat(64), "0012");
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(20_000_000n);

    // A reverted Hedera call still burned sponsor-paid gas, so reconciling it
    // must not lower measured exposure below already-realized spend.
    await productStore.resolveSubmissionAsRejected({
      authorizationId: reverted.authorizationId,
      reason: "mined_reverted",
      evidence: { source: "mirror-contract-result", status: "0x0" },
    });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(20_000_000n);

    // Nothing was broadcast for this one, so it costs nothing.
    await productStore.resolveSubmissionAsRejected({
      authorizationId: free.authorizationId,
      reason: "expired_never_broadcast",
      evidence: { source: "mirror-account", ethereumNonce: 0 },
    });
    await expect(productStore.sponsoredIntentExposureSince(cutoff, { nowSec })).resolves.toBe(10_000_000n);

    // The ledger flag stays out of the authorization contract the API serves.
    const readback = await productStore.getJourney(reverted.journey.id);
    expect(readback!.authorizations[0]).toMatchObject({ state: "rejected" });
    expect(readback!.authorizations[0]).not.toHaveProperty("sponsorSpent");
  });

  it("can serve the daily-cap read from the sponsor-exposure index", async () => {
    // Without this index every cap decision on four hot paths sequentially scans
    // a table that is never pruned. Seq scans are disabled so the assertion is
    // that the partial predicate is provable from the query, not that an empty
    // fixture table is large enough to make the planner care.
    const client = await lifecycleStore.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT COALESCE(SUM((record->>'maxGasAllowanceTinybar')::numeric), 0)::text AS total
         FROM refuel402_product_authorizations
         WHERE updated_at >= $1
           AND ($3::text IS NULL OR raw_transaction_hash IS DISTINCT FROM $3)
           AND (state IN ('consumed', 'submitted', 'unknown')
                OR (state = 'pending' AND expires_at > $2)
                OR (state = 'rejected' AND record->>'sponsorSpent' = 'true'))`,
        [Date.now(), Math.floor(Date.now() / 1000), null],
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "refuel402_product_authorizations_sponsor_exposure",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("counts activation HBAR that left the sponsor before the funded event landed", async () => {
    const cutoff = Date.now();
    const journey = await createJourney("a".repeat(64), "activation-exposure-0001");
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(0n);

    // The transfer lands and then the status check or the mirror readback throws:
    // recordDestinationActivation never runs, so the write-ahead marker is the
    // only durable evidence the sponsor paid.
    await expect(productStore.beginDestinationActivation(journey.id, "10000000")).resolves.toBe("proceed");
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);

    // The journey stays fail-closed pending reconciliation, so a blind retry
    // cannot spend a second activation against the same marker.
    await expect(productStore.beginDestinationActivation(journey.id, "10000000")).rejects.toMatchObject({
      code: "JOURNEY_STATE_CONFLICT",
    });
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);
    await expect(productStore.activationExposureSince(cutoff + 86_400_000)).resolves.toBe(0n);
  });

  it("counts one activation per journey when both the marker and the funded event exist", async () => {
    const cutoff = Date.now();
    const journey = await createJourney("b".repeat(64), "activation-exposure-0002");
    // Both rows carry the same bound amount on every production path, so the pair
    // is one spend: the assertion is that it is counted once, never summed.
    await productStore.beginDestinationActivation(journey.id, "10000000");
    await productStore.recordDestinationActivation({
      journeyId: journey.id,
      transactionId: "0.0.5@1.1",
      amountTinybar: "10000000",
      status: "SUCCESS",
    });
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);

    // ...while a second journey is still its own spend.
    const second = await createJourney("c".repeat(64), "activation-exposure-0003");
    await productStore.beginDestinationActivation(second.id, "3000000");
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(13_000_000n);
  });

  it("charges the larger row if a marker and its funded event ever disagree", async () => {
    // Unreachable through the activator - one binding produces both amounts - so
    // this is seeded. It pins the direction: over-charge, never under-charge.
    const cutoff = Date.now();
    const journey = await createJourney("8".repeat(64), "activation-exposure-0008");
    await seedActivationEvent(journey.id, "destination_activation_started", { state: "started", amountTinybar: "10000000" }, cutoff + 1);
    await seedActivationEvent(journey.id, "destination_activation_funded", { amountTinybar: "9000000" }, cutoff + 2);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);
  });

  it("counts a funded event written with a lower event_id than its marker exactly once", async () => {
    // Nothing in the schema forces the funded row to outrank its marker by
    // event_id, so selection must not read event_id at all.
    const cutoff = Date.now();
    const journey = await createJourney("9".repeat(64), "activation-exposure-0009");
    await seedActivationEvent(journey.id, "destination_activation_funded", { amountTinybar: "5000000" }, cutoff + 1);
    await seedActivationEvent(journey.id, "destination_activation_started", { state: "started", amountTinybar: "5000000" }, cutoff + 2);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(5_000_000n);

    // ...and when the older funded row is the larger one it is still the charge,
    // so "newest event_id wins" cannot pass either.
    const inverted = await createJourney("0".repeat(64), "activation-exposure-0010");
    await seedActivationEvent(inverted.id, "destination_activation_funded", { amountTinybar: "6000000" }, cutoff + 1);
    await seedActivationEvent(inverted.id, "destination_activation_started", { state: "started", amountTinybar: "4000000" }, cutoff + 2);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(11_000_000n);
  });

  it("can serve the activation daily-cap read from the activation-exposure index", async () => {
    // Same reasoning as the authorizations index: seq scans are off so the
    // assertion is that the partial predicate is provable from the query.
    const client = await lifecycleStore.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM (
           SELECT MAX((record->>'amountTinybar')::numeric) AS amount
           FROM refuel402_product_events
           WHERE event_type IN ('destination_activation_started', 'destination_activation_funded')
             AND created_at >= $1
           GROUP BY journey_id
         ) AS activation`,
        [Date.now()],
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "refuel402_product_events_activation_exposure",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("charges nothing for an activation that only associated an account that already existed", async () => {
    const cutoff = Date.now();
    const journey = await createJourney("d".repeat(64), "activation-exposure-0004");
    // No marker is written on this path and the funded event carries "0".
    await productStore.recordDestinationActivation({
      journeyId: journey.id,
      transactionId: "account-already-exists",
      amountTinybar: "0",
      status: "SUCCESS",
    });
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(0n);

    // A marker written before it carried an amount contributes 0, never throws.
    const legacy = await createJourney("e".repeat(64), "activation-exposure-0005");
    await seedActivationEvent(legacy.id, "destination_activation_started", { state: "started" }, Date.now());
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(0n);
  });

  it("counts whichever activation event is inside the window, from either direction", async () => {
    const cutoff = Date.now();
    const late = await createJourney("6".repeat(64), "activation-exposure-0006");
    await seedActivationEvent(late.id, "destination_activation_started", { state: "started", amountTinybar: "10000000" }, cutoff - 1);
    await seedActivationEvent(late.id, "destination_activation_funded", { amountTinybar: "10000000" }, cutoff + 1);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);

    const early = await createJourney("7".repeat(64), "activation-exposure-0007");
    await seedActivationEvent(early.id, "destination_activation_started", { state: "started", amountTinybar: "4000000" }, cutoff + 1);
    await seedActivationEvent(early.id, "destination_activation_funded", { amountTinybar: "4000000" }, cutoff - 1);
    // The marker is the only row in range here; dropping it would hide the spend.
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(14_000_000n);

    // Both rows of both journeys in range is still one activation each.
    await expect(productStore.activationExposureSince(cutoff - 1)).resolves.toBe(14_000_000n);
  });

  it("aggregates only the rows inside the window, not every row of a journey that has one", async () => {
    // Equal amounts cannot tell a correct filter from one applied after grouping,
    // so these pairs disagree: whichever row is in range must be the one charged.
    const cutoff = Date.now();
    const rising = await createJourney("8".repeat(64), "activation-exposure-0008");
    await seedActivationEvent(rising.id, "destination_activation_funded", { amountTinybar: "4000000" }, cutoff - 1);
    await seedActivationEvent(rising.id, "destination_activation_started", { state: "started", amountTinybar: "10000000" }, cutoff + 1);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(10_000_000n);

    const falling = await createJourney("9".repeat(64), "activation-exposure-0009");
    await seedActivationEvent(falling.id, "destination_activation_started", { state: "started", amountTinybar: "10000000" }, cutoff - 1);
    await seedActivationEvent(falling.id, "destination_activation_funded", { amountTinybar: "4000000" }, cutoff + 1);
    // Grouping before filtering would charge the out-of-window 10000000 here.
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(14_000_000n);
  });

  it("includes an activation stamped exactly at the cutoff", async () => {
    const cutoff = Date.now();
    const journey = await createJourney("a".repeat(63) + "0", "activation-exposure-0010");
    await seedActivationEvent(journey.id, "destination_activation_started", { state: "started", amountTinybar: "5000000" }, cutoff);
    await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(5_000_000n);
    await expect(productStore.activationExposureSince(cutoff + 1)).resolves.toBe(0n);
  });

  it("keeps a retry that finds the funded account from erasing the spend it recovers", async () => {
    // The whole loop against the real activator and the real store: attempt 1
    // transfers and dies on the readback, mirror lag clears, and the retry - which
    // POST /v1/product/journeys/:id/activate exposes to any client - sees an
    // account that exists. Nothing it writes may lower measured exposure.
    const original = process.env.DESTINATION_ACTIVATION_TINYBAR;
    process.env.DESTINATION_ACTIVATION_TINYBAR = "7000000";
    try {
      const cutoff = Date.now();
      const quoteId = "f".repeat(64);
      await productStore.saveQuote(
        quote(quoteId, {
          record: {
            schema: "refuel402.combined-quote.v1",
            quoteId,
            mode: "testnet",
            account: account.address,
            capabilities: { execute: true },
            asset: { destination: { arrival: "activation_required", tokenId: "0.0.7777" } },
          },
        }),
      );
      const journey = await productStore.createJourney({
        quoteId,
        mode: "testnet",
        account: account.address,
        idempotencyKey: "activation-retry-0001",
      });

      let destinationVisible = false;
      const activateAlias = vi.fn(async () => ({ transactionId: "0.0.9@1.1", status: "SUCCESS" }));
      const activate = createProductDestinationActivator({
        store: productStore,
        mirrors: {
          testnet: {
            account: async (id: string) =>
              id === account.address
                ? destinationVisible
                  ? { balance: { balance: 0, tokens: [] } }
                  : null
                : { balance: { balance: 100_000_000_000, tokens: [] } },
            isAssociated: async () => true,
          } as any,
          mainnet: {} as any,
        },
        sponsors: { testnet: { operatorId: "0.0.1", activateAlias } as any },
        exposureSince: (cutoffMs) => productStore.activationExposureSince(cutoffMs),
        sleep: async () => undefined,
      });

      await expect(activate(journey.id)).rejects.toThrow(/readback did not converge/);
      expect(activateAlias).toHaveBeenCalledTimes(1);
      await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(7_000_000n);

      destinationVisible = true;
      const recovered = await activate(journey.id);
      // The retry commits a funded event, which the exposure ledger prefers over
      // the marker. If it carries "0" the spend is masked to 0 permanently.
      await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(7_000_000n);
      // The sponsor must not pay twice, and the response must not claim nothing moved.
      expect(activateAlias).toHaveBeenCalledTimes(1);
      expect(recovered).toMatchObject({
        required: true,
        funded: true,
        transactionId: "recovered-from-activation-marker",
        amountTinybar: "7000000",
      });

      // A third call is idempotent on the funded event and still cannot mask it.
      await activate(journey.id);
      await expect(productStore.activationExposureSince(cutoff)).resolves.toBe(7_000_000n);
    } finally {
      if (original === undefined) delete process.env.DESTINATION_ACTIVATION_TINYBAR;
      else process.env.DESTINATION_ACTIVATION_TINYBAR = original;
    }
  });
});
