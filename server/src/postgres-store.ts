import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import type { Hex } from "viem";
import type { SponsorshipRecord, SponsorshipState } from "./store.js";
import { migrateProductLifecycleWithin, withMigrationLock } from "./product-lifecycle-store.js";

const LIVE_STATES: SponsorshipState[] = ["quoted", "paying", "settled", "submitting"];
const IMMUTABLE_FIELDS = [
  "rawHash",
  "network",
  "chainId",
  "quoteId",
  "routeId",
  "requirementsHash",
  "economicContract",
  "signer",
] as const;

export class LifecycleConflictError extends Error {
  constructor(
    readonly code: "NONCE_BUSY" | "PAYMENT_REPLAY" | "IMMUTABLE_LIFECYCLE_IDENTITY",
    message: string,
  ) {
    super(message);
  }
}

export interface LifecycleStore {
  get(hash: Hex): SponsorshipRecord | undefined | Promise<SponsorshipRecord | undefined>;
  stuckSubmitting(): SponsorshipRecord[] | Promise<SponsorshipRecord[]>;
  nonceBusy(
    signer: string,
    nonces: number[],
    exceptHash?: Hex,
  ): SponsorshipRecord | null | Promise<SponsorshipRecord | null>;
  upsert(rec: SponsorshipRecord): void | Promise<void>;
  claimForSubmission(hash: Hex): boolean | Promise<boolean>;
  exposureSince(sinceMs: number): bigint | Promise<bigint>;
  expireStaleQuotes(nowSec: number): void | Promise<void>;
  healthcheck?(): Promise<void>;
  close?(): Promise<void>;
}

export interface AsyncRateLimiter {
  allow(key: string): boolean | Promise<boolean>;
}

/**
 * Transactional production lifecycle store.
 *
 * The full immutable record is retained as JSONB so the public receipt remains
 * byte-compatible with the existing integration harness. Separate relational
 * rows enforce the invariants JSON files cannot enforce: one live nonce owner,
 * one payment identity, atomic state claims, and shared rate buckets.
 */
export class PostgresStore implements LifecycleStore {
  private constructor(readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "refuel402",
    });
    const store = new PostgresStore(pool);
    await store.migrate();
    await store.healthcheck();
    return store;
  }

  private async migrate(): Promise<void> {
    await withMigrationLock(this.pool, async (client) => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS refuel402_sponsorships (
        bundle_hash text PRIMARY KEY,
        raw_hash text NOT NULL,
        network text NOT NULL,
        signer text NOT NULL,
        nonces integer[] NOT NULL,
        state text NOT NULL,
        updated_at bigint NOT NULL,
        record jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS refuel402_sponsorships_state_updated
        ON refuel402_sponsorships (state, updated_at);

      CREATE TABLE IF NOT EXISTS refuel402_nonce_reservations (
        network text NOT NULL,
        signer text NOT NULL,
        nonce integer NOT NULL,
        bundle_hash text NOT NULL REFERENCES refuel402_sponsorships(bundle_hash) ON DELETE CASCADE,
        PRIMARY KEY (network, signer, nonce)
      );

      CREATE TABLE IF NOT EXISTS refuel402_payment_identities (
        payment_identity text PRIMARY KEY,
        bundle_hash text NOT NULL REFERENCES refuel402_sponsorships(bundle_hash) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS refuel402_payment_one_per_bundle
        ON refuel402_payment_identities (bundle_hash);

      CREATE TABLE IF NOT EXISTS refuel402_rate_limit_buckets (
        key_hash text NOT NULL,
        bucket_start bigint NOT NULL,
        hit_count integer NOT NULL,
        expires_at bigint NOT NULL,
        PRIMARY KEY (key_hash, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS refuel402_rate_limit_expiry
        ON refuel402_rate_limit_buckets (expires_at);
    `);
      await migrateProductLifecycleWithin(client);
    });
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async get(hash: Hex): Promise<SponsorshipRecord | undefined> {
    const result = await this.pool.query<{ record: SponsorshipRecord }>(
      "SELECT record FROM refuel402_sponsorships WHERE bundle_hash = $1",
      [hash],
    );
    return result.rows[0]?.record;
  }

  async stuckSubmitting(): Promise<SponsorshipRecord[]> {
    const result = await this.pool.query<{ record: SponsorshipRecord }>(
      `SELECT record FROM refuel402_sponsorships
       WHERE state IN ('paying', 'settled', 'submitting')
       ORDER BY updated_at ASC`,
    );
    return result.rows.map((row) => row.record);
  }

  async nonceBusy(
    signer: string,
    nonces: number[],
    exceptHash?: Hex,
  ): Promise<SponsorshipRecord | null> {
    if (nonces.length === 0) return null;
    const result = await this.pool.query<{ record: SponsorshipRecord }>(
      `SELECT s.record
       FROM refuel402_nonce_reservations n
       JOIN refuel402_sponsorships s ON s.bundle_hash = n.bundle_hash
       WHERE n.network = $1
         AND n.signer = $2
         AND n.nonce = ANY($3::integer[])
         AND ($4::text IS NULL OR n.bundle_hash <> $4)
       LIMIT 1`,
      [process.env.HEDERA_NETWORK ?? "testnet", signer.toLowerCase(), nonces, exceptHash ?? null],
    );
    return result.rows[0]?.record ?? null;
  }

  private verifyImmutable(prior: SponsorshipRecord, next: SponsorshipRecord): void {
    for (const field of IMMUTABLE_FIELDS) {
      if (prior[field] !== next[field]) {
        throw new LifecycleConflictError(
          "IMMUTABLE_LIFECYCLE_IDENTITY",
          `${field} changed for ${next.bundleHash}`,
        );
      }
    }
    if (
      !isDeepStrictEqual(prior.rawTxs, next.rawTxs) ||
      !isDeepStrictEqual(prior.requirements, next.requirements) ||
      (prior.quote && next.quote && !isDeepStrictEqual(prior.quote, next.quote))
    ) {
      throw new LifecycleConflictError(
        "IMMUTABLE_LIFECYCLE_IDENTITY",
        `rawTxs/requirements/quote changed for ${next.bundleHash}`,
      );
    }
  }

  private async reserveLiveIdentity(client: PoolClient, rec: SponsorshipRecord): Promise<void> {
    const live = LIVE_STATES.includes(rec.state);
    if (!live) {
      await client.query(
        "DELETE FROM refuel402_nonce_reservations WHERE bundle_hash = $1",
        [rec.bundleHash],
      );
      return;
    }

    for (const nonce of rec.nonces) {
      const result = await client.query(
        `INSERT INTO refuel402_nonce_reservations (network, signer, nonce, bundle_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (network, signer, nonce) DO UPDATE
           SET bundle_hash = EXCLUDED.bundle_hash
           WHERE refuel402_nonce_reservations.bundle_hash = EXCLUDED.bundle_hash
         RETURNING bundle_hash`,
        [rec.network, rec.signer.toLowerCase(), nonce, rec.bundleHash],
      );
      if (result.rowCount !== 1) {
        throw new LifecycleConflictError(
          "NONCE_BUSY",
          `a live quote already owns ${rec.network}:${rec.signer}:${nonce}`,
        );
      }
    }
  }

  private async reservePaymentIdentity(client: PoolClient, rec: SponsorshipRecord): Promise<void> {
    const identity = rec.payment?.paymentIdentity;
    if (!identity) return;
    const existing = await client.query<{ payment_identity: string }>(
      "SELECT payment_identity FROM refuel402_payment_identities WHERE bundle_hash = $1",
      [rec.bundleHash],
    );
    if (existing.rows[0] && existing.rows[0].payment_identity !== identity) {
      throw new LifecycleConflictError(
        "PAYMENT_REPLAY",
        "bundle is already bound to a different payment identity",
      );
    }
    const result = await client.query(
      `INSERT INTO refuel402_payment_identities (payment_identity, bundle_hash)
       VALUES ($1, $2)
       ON CONFLICT (payment_identity) DO UPDATE
         SET bundle_hash = EXCLUDED.bundle_hash
         WHERE refuel402_payment_identities.bundle_hash = EXCLUDED.bundle_hash
       RETURNING bundle_hash`,
      [identity, rec.bundleHash],
    );
    if (result.rowCount !== 1) {
      throw new LifecycleConflictError(
        "PAYMENT_REPLAY",
        `payment identity is already bound to another bundle`,
      );
    }
  }

  async upsert(rec: SponsorshipRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const priorResult = await client.query<{ record: SponsorshipRecord }>(
        "SELECT record FROM refuel402_sponsorships WHERE bundle_hash = $1 FOR UPDATE",
        [rec.bundleHash],
      );
      const prior = priorResult.rows[0]?.record;
      if (prior) this.verifyImmutable(prior, rec);

      rec.updatedAt = Date.now();
      await client.query(
        `INSERT INTO refuel402_sponsorships
           (bundle_hash, raw_hash, network, signer, nonces, state, updated_at, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (bundle_hash) DO UPDATE SET
           state = EXCLUDED.state,
           updated_at = EXCLUDED.updated_at,
           record = EXCLUDED.record`,
        [
          rec.bundleHash,
          rec.rawHash,
          rec.network,
          rec.signer.toLowerCase(),
          rec.nonces,
          rec.state,
          rec.updatedAt,
          JSON.stringify(rec),
        ],
      );
      await this.reserveLiveIdentity(client, rec);
      await this.reservePaymentIdentity(client, rec);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimForSubmission(hash: Hex): Promise<boolean> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE refuel402_sponsorships
       SET state = 'submitting',
           updated_at = $2,
           record = jsonb_set(
             jsonb_set(record, '{state}', '"submitting"'::jsonb),
             '{updatedAt}', to_jsonb($2::bigint)
           )
       WHERE bundle_hash = $1 AND state = 'settled'
       RETURNING bundle_hash`,
      [hash, now],
    );
    return result.rowCount === 1;
  }

  async exposureSince(sinceMs: number): Promise<bigint> {
    const result = await this.pool.query<{ record: SponsorshipRecord }>(
      "SELECT record FROM refuel402_sponsorships WHERE updated_at >= $1",
      [sinceMs],
    );
    let total = 0n;
    for (const { record } of result.rows) {
      if (record.execution?.sponsorFeeTinybar) {
        total += BigInt(record.execution.sponsorFeeTinybar);
      } else if (["paying", "settled", "submitting"].includes(record.state) && record.quote) {
        total += BigInt(record.quote.maxSponsorExposureTinybar);
      }
    }
    return total;
  }

  async expireStaleQuotes(nowSec: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updatedAt = Date.now();
      const expired = await client.query<{ bundle_hash: string }>(
        `UPDATE refuel402_sponsorships
         SET state = 'failed',
             updated_at = $2,
             record = jsonb_set(
               jsonb_set(
                 jsonb_set(record, '{state}', '"failed"'::jsonb),
                 '{error}', to_jsonb('quote expired unused'::text)
               ),
               '{updatedAt}', to_jsonb($2::bigint)
             )
         WHERE state = 'quoted'
           AND (record #>> '{quote,expiresAt}')::bigint + 60 < $1
         RETURNING bundle_hash`,
        [nowSec, updatedAt],
      );
      if (expired.rows.length > 0) {
        await client.query(
          "DELETE FROM refuel402_nonce_reservations WHERE bundle_hash = ANY($1::text[])",
          [expired.rows.map((row) => row.bundle_hash)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  rateLimiter(cfg: { windowSec: number; max: number; namespace: string }): PostgresRateLimiter {
    return new PostgresRateLimiter(this.pool, cfg);
  }
}

export class PostgresRateLimiter implements AsyncRateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly cfg: { windowSec: number; max: number; namespace: string },
  ) {}

  async allow(key: string): Promise<boolean> {
    const now = Date.now();
    const windowMs = this.cfg.windowSec * 1000;
    const bucketStart = Math.floor(now / windowMs) * windowMs;
    const salt = process.env.RATE_LIMIT_SALT ?? "refuel402-public-rate-limit";
    const keyHash = createHash("sha256")
      .update(`${salt}:${this.cfg.namespace}:${key}`)
      .digest("hex");
    const result = await this.pool.query<{ hit_count: number }>(
      `INSERT INTO refuel402_rate_limit_buckets
         (key_hash, bucket_start, hit_count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key_hash, bucket_start) DO UPDATE
         SET hit_count = refuel402_rate_limit_buckets.hit_count + 1
       RETURNING hit_count`,
      [keyHash, bucketStart, bucketStart + windowMs * 2],
    );
    if (Math.random() < 0.01) {
      void this.pool.query(
        "DELETE FROM refuel402_rate_limit_buckets WHERE expires_at < $1",
        [now],
      ).catch(() => undefined);
    }
    return (result.rows[0]?.hit_count ?? this.cfg.max + 1) <= this.cfg.max;
  }
}

export async function createLifecycleStore(
  dataDir: string,
  jsonFactory: () => LifecycleStore,
): Promise<LifecycleStore> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) return PostgresStore.connect(databaseUrl);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production; JSON lifecycle state is test/local only");
  }
  return jsonFactory();
}
