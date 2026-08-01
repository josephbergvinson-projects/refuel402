import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  LifecycleConflictError,
  PostgresStore,
} from "../src/postgres-store.js";
import type { SponsorshipRecord } from "../src/store.js";
import {
  acquireDestructiveSuiteLock,
  releaseDestructiveSuiteLock,
} from "./destructive-suite-lock.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let store: PostgresStore;

function record(
  hash: Hex,
  nonce: number,
  paymentIdentity?: string,
): SponsorshipRecord {
  return {
    bundleHash: hash,
    rawHash: `0x${hash.slice(2).padEnd(64, "1").slice(0, 64)}` as Hex,
    rawTxs: ["0x01"],
    network: "testnet",
    chainId: 296,
    quoteId: `0x${hash.slice(2).padEnd(64, "2").slice(0, 64)}` as Hex,
    routeId: `0x${hash.slice(2).padEnd(64, "3").slice(0, 64)}` as Hex,
    requirementsHash: `0x${hash.slice(2).padEnd(64, "4").slice(0, 64)}` as Hex,
    requirements: [{ scheme: "exact" }],
    economicContract: "prepaid_bounded_attempt_v1",
    signer: "0x1111111111111111111111111111111111111111",
    nonces: [nonce],
    state: paymentIdentity ? "paying" : "quoted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    quote: {
      feeToken: "USDC",
      feeTokenId: "0.0.5449",
      feeAmount: "1000",
      expiresAt: Math.floor(Date.now() / 1000) + 120,
      estimatedGasTinybar: "100",
      maxGasAllowanceTinybar: "100",
      perLegGasAllowanceTinybar: ["100"],
      hapiReserveTinybar: "20",
      maxSponsorExposureTinybar: "120",
      feeComponentsTinybar: {
        gasAllowance: "100",
        hapiReserve: "20",
        failedAttemptReserve: "0",
        operatingMargin: "0",
      },
    },
    payment: paymentIdentity
      ? {
          settlementId: null,
          payer: "0.0.7001",
          network: "hedera:testnet",
          paidTokenId: "0.0.5449",
          paidAmount: "1000",
          paymentIdentity,
          raw: { intent: true },
        }
      : null,
    execution: null,
    refund: null,
    error: null,
  };
}

suite("Postgres production lifecycle store", () => {
  beforeAll(async () => {
    await acquireDestructiveSuiteLock(databaseUrl!);
    store = await PostgresStore.connect(databaseUrl!);
    await store.pool.query(
      "TRUNCATE refuel402_payment_identities, refuel402_nonce_reservations, refuel402_sponsorships, refuel402_rate_limit_buckets CASCADE",
    );
  });

  afterAll(async () => {
    await store?.close();
    await releaseDestructiveSuiteLock();
  });

  it("serializes concurrent replica migrations instead of deadlocking on catalog rows", async () => {
    const replicas = await Promise.all(
      Array.from({ length: 4 }, () => PostgresStore.connect(databaseUrl!)),
    );
    try {
      await Promise.all(replicas.map((replica) => replica.healthcheck()));
    } finally {
      await Promise.all(replicas.map((replica) => replica.close()));
    }
  });

  it("atomically owns a live signer nonce and releases it at terminal state", async () => {
    const first = record("0xaaa" as Hex, 7);
    await store.upsert(first);
    await expect(store.nonceBusy(first.signer, [7])).resolves.toMatchObject({
      bundleHash: first.bundleHash,
    });

    const competing = record("0xbbb" as Hex, 7);
    await expect(store.upsert(competing)).rejects.toMatchObject({
      code: "NONCE_BUSY",
    });

    first.state = "failed";
    first.error = "fixture terminal";
    await store.upsert(first);
    await expect(store.nonceBusy(first.signer, [7])).resolves.toBeNull();
  });

  it("binds one payment identity to one bundle and claims submission once", async () => {
    const identity = "payment-a";
    const first = record("0xccc" as Hex, 8, identity);
    await store.upsert(first);

    const replay = record("0xddd" as Hex, 9, identity);
    await expect(store.upsert(replay)).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );

    const secondPaymentForSameBundle = structuredClone(first);
    secondPaymentForSameBundle.payment!.paymentIdentity = "payment-b";
    await expect(
      store.upsert(secondPaymentForSameBundle),
    ).rejects.toMatchObject({ code: "PAYMENT_REPLAY" });

    first.state = "settled";
    first.payment!.settlementId = "0.0.9002@1753020000.000000001";
    await store.upsert(first);
    await expect(store.claimForSubmission(first.bundleHash)).resolves.toBe(
      true,
    );
    await expect(store.claimForSubmission(first.bundleHash)).resolves.toBe(
      false,
    );
  });

  it("expires quotes atomically and releases their nonce reservation", async () => {
    const expired = record("0xeee" as Hex, 10);
    expired.quote!.expiresAt = Math.floor(Date.now() / 1000) - 120;
    await store.upsert(expired);
    await store.expireStaleQuotes(Math.floor(Date.now() / 1000));
    await expect(store.get(expired.bundleHash)).resolves.toMatchObject({
      state: "failed",
      error: "quote expired unused",
    });
    await expect(store.nonceBusy(expired.signer, [10])).resolves.toBeNull();
  });

  it("shares rate buckets and exposure across callers", async () => {
    const limiterA = store.rateLimiter({
      windowSec: 60,
      max: 2,
      namespace: "fixture",
    });
    const limiterB = store.rateLimiter({
      windowSec: 60,
      max: 2,
      namespace: "fixture",
    });
    await expect(limiterA.allow("same-user")).resolves.toBe(true);
    await expect(limiterB.allow("same-user")).resolves.toBe(true);
    await expect(limiterA.allow("same-user")).resolves.toBe(false);
    await expect(
      store.exposureSince(Date.now() - 60_000),
    ).resolves.toBeGreaterThan(0n);
  });
});
