// Durable store for quotes and sponsorship lifecycle.
// Security-review-driven properties:
//   - keyed by SEMANTIC bundle hash (immune to signature/RLP re-encoding)
//   - at most one live record per (signer, nonce) — kills concurrent-nonce griefs
//   - atomic writes (tmp + rename), single-process mutex per record
//   - raw txs persisted so a crashed "submitting" record can be reconciled
//     against the chain (EVM tx hash is deterministic from the bytes)
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";

export type SponsorshipState =
  | "quoted"
  | "paying" // payment intent persisted; on-chain fee transfer in flight
  | "settled"
  | "submitting"
  | "completed"
  | "partial"
  | "refunded"
  | "review"
  | "failed";

export type SponsorshipRecord = {
  /** Semantic bundle hash — the primary key */
  bundleHash: Hex;
  /** Byte-exact hash of the raw txs the quote was issued for */
  rawHash: Hex;
  rawTxs: Hex[];
  /** Immutable lifecycle identity, pinned before payment collection. */
  network: "testnet" | "mainnet";
  chainId: number;
  quoteId: Hex;
  routeId: Hex;
  requirementsHash: Hex;
  requirements: unknown[];
  economicContract: "prepaid_bounded_attempt_v1";
  signer: string;
  nonces: number[];
  state: SponsorshipState;
  createdAt: number;
  updatedAt: number;
  quote: {
    feeToken: string;
    feeTokenId: string;
    feeAmount: string;
    expiresAt: number;
    estimatedGasTinybar: string;
    maxGasAllowanceTinybar: string;
    perLegGasAllowanceTinybar: string[];
    hapiReserveTinybar: string;
    maxSponsorExposureTinybar: string;
    feeComponentsTinybar: {
      gasAllowance: string;
      hapiReserve: string;
      failedAttemptReserve: string;
      operatingMargin: string;
    };
  } | null;
  payment: {
    settlementId: string | null;
    payer: string | null;
    network: string | null;
    /** What the payer ACTUALLY paid — the source of truth for refunds */
    paidTokenId: string | null;
    paidAmount: string | null;
    paymentIdentity: string | null;
    raw: unknown;
  } | null;
  execution: {
    transactionIds: string[];
    evmHashes: string[];
    hashscanLinks: string[];
    sponsorFeeTinybar: string | null;
    attemptedLegs: number;
    successfulLegs: number;
    perLeg: {
      index: number;
      kind: string;
      allowanceTinybar: string;
      transactionId: string | null;
      ethereumHash: string | null;
      status: string;
      sponsorPaidTinybar: string;
      sender: string;
    }[];
    disposition: "delivered" | "attempt_failed" | "partially_delivered" | "not_started";
    reconciliation: "complete" | "manual_review";
    status: string | null;
  } | null;
  refund: {
    transactionId: string;
    amount: string;
    tokenId: string;
    reason: string;
    status: string;
  } | null;
  error: string | null;
};

const LIVE_STATES: SponsorshipState[] = ["quoted", "paying", "settled", "submitting"];

export class Store {
  private file: string;
  private data: Record<string, SponsorshipRecord>;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "sponsorships.json");
    this.data = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, SponsorshipRecord>)
      : {};
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(hash: Hex): SponsorshipRecord | undefined {
    return this.data[hash];
  }

  /**
   * Records left mid-flight by a previous process run (crash recovery):
   *   - "submitting": execution may have partially happened
   *   - "settled": payment captured but submission never claimed
   *   - "paying": on-chain fee transfer was in flight when we died (status unknown)
   * All three are the dangerous window where a user may have paid and would
   * otherwise get neither execution nor refund.
   */
  stuckSubmitting(): SponsorshipRecord[] {
    return Object.values(this.data).filter(
      (r) =>
        r.state === "submitting" ||
        r.state === "paying" ||
        (r.state === "settled" && r.payment != null),
    );
  }

  /**
   * Another LIVE record holding any of these (signer, nonce) pairs?
   * Enforces "one live quote per nonce" — the anti-grief serialization.
   */
  nonceBusy(signer: string, nonces: number[], exceptHash?: Hex): SponsorshipRecord | null {
    for (const rec of Object.values(this.data)) {
      if (rec.bundleHash === exceptHash) continue;
      if (!LIVE_STATES.includes(rec.state)) continue;
      if (rec.signer.toLowerCase() !== signer.toLowerCase()) continue;
      if (rec.nonces.some((n) => nonces.includes(n))) return rec;
    }
    return null;
  }

  upsert(rec: SponsorshipRecord): void {
    const prior = this.data[rec.bundleHash];
    if (prior) {
      const immutable = [
        "rawHash", "network", "chainId", "quoteId", "routeId", "requirementsHash",
        "economicContract", "signer",
      ] as const;
      for (const field of immutable) {
        if (prior[field] !== rec[field]) {
          throw new Error(`IMMUTABLE_LIFECYCLE_IDENTITY: ${field} changed`);
        }
      }
      if (JSON.stringify(prior.rawTxs) !== JSON.stringify(rec.rawTxs) ||
          JSON.stringify(prior.requirements) !== JSON.stringify(rec.requirements)) {
        throw new Error("IMMUTABLE_LIFECYCLE_IDENTITY: rawTxs/requirements changed");
      }
      if (prior.quote && rec.quote && JSON.stringify(prior.quote) !== JSON.stringify(rec.quote)) {
        throw new Error("IMMUTABLE_LIFECYCLE_IDENTITY: quote changed");
      }
    }
    rec.updatedAt = Date.now();
    this.data[rec.bundleHash] = rec;
    this.persist();
  }

  /**
   * Atomically claim a settled record for submission. Returns false if another
   * request already moved it past "settled" (double-submit guard). Node's
   * single-threaded event loop makes check-and-set atomic within the process;
   * the persisted state guards across restarts.
   */
  claimForSubmission(hash: Hex): boolean {
    const rec = this.data[hash];
    if (!rec || rec.state !== "settled") return false;
    rec.state = "submitting";
    this.upsert(rec);
    return true;
  }

  /**
   * Rolling exposure accounting for the daily sponsor cap. Completed attempts
   * count actual sponsor cost; live paid/submit states reserve their immutable
   * maximum so concurrent requests cannot overbook the relayer.
   */
  exposureSince(sinceMs: number): bigint {
    let total = 0n;
    for (const rec of Object.values(this.data)) {
      if (rec.updatedAt < sinceMs) continue;
      if (rec.execution?.sponsorFeeTinybar) {
        total += BigInt(rec.execution.sponsorFeeTinybar);
      } else if (["paying", "settled", "submitting"].includes(rec.state) && rec.quote) {
        total += BigInt(rec.quote.maxSponsorExposureTinybar);
      }
    }
    return total;
  }

  /** Expire stale quotes so their nonces free up. */
  expireStaleQuotes(nowSec: number): void {
    let dirty = false;
    for (const rec of Object.values(this.data)) {
      if (rec.state === "quoted" && rec.quote && rec.quote.expiresAt + 60 < nowSec) {
        rec.state = "failed";
        rec.error = "quote expired unused";
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }
}
