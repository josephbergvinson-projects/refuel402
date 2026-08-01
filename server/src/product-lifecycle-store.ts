import { randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import type { Pool, PoolClient } from "pg";
import type {
  PolicyRpcAuthorization,
  PolicyRpcAuthorizer,
  PolicyRpcTransactionCandidate,
} from "./policy-rpc.js";
import type { SponsorExposureOptions } from "./sponsor-exposure.js";
import type {
  ProductMode,
  ProviderId,
  ProviderSelectionId,
} from "./support.js";

export type ProductJourneyState =
  | "ready"
  | "bridge_ready"
  | "activation_pending"
  | "bridge_pending"
  | "arrival_confirmed"
  | "payment_pending"
  | "payment_settled"
  | "authorizing"
  | "submitting"
  | "execution_pending"
  | "completed"
  | "review"
  | "failed"
  // Owner retired a journey that never produced durable external evidence. The
  // record, its events and its quote are all preserved; this state only removes
  // it from the account's default activity list.
  | "abandoned";

export type StoredProductQuote = {
  quoteId: string;
  mode: ProductMode;
  account: Address;
  requestedProvider: ProviderSelectionId;
  selectedProvider: ProviderId;
  assetId: string;
  originChainId: string;
  expiresAt: number;
  executable: boolean;
  record: Record<string, unknown>;
};

export type ProductPaymentRecord = {
  paymentIdentity: string;
  journeyId: string;
  payer: string;
  network: string;
  asset: string;
  amount: string;
  settlementReference: string;
  proofHash: Hex;
  createdAt: number;
};

export type RefuelAuthorizationState =
  | "recorded"
  | "executing"
  | "retry_scheduled"
  | "completed"
  | "expired"
  | "fallback"
  | "unknown";

export type RefuelAuthorizationRecord = {
  id: string;
  journeyId: string;
  state: RefuelAuthorizationState;
  owner: Address;
  token: Address;
  maxAmountIn: string;
  exactHbarTinybar: string;
  serviceFeeAmount: string;
  maxSponsorExposureTinybar: string;
  recipient: Address;
  journeyNonce: string;
  deadline: number;
  routeHash: Hex;
  signature: Hex;
  permit2: Address;
  spender: Address;
  route: {
    wrapper: Address;
    htsToken: Address;
    router: Address;
    whbar: Address;
    wrapperRate: string;
    swapPath: Hex;
  };
  attemptCount: number;
  nextAttemptAt: number;
  executionReference: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProductAuthorizationRecord = PolicyRpcAuthorization & {
  journeyId: string;
  intentKind: ProductIntentKind;
  rawTransactionHash: Hex | null;
  state: "pending" | "consumed" | "submitted" | "unknown" | "rejected" | "expired";
  ethereumHash: Hex | null;
  createdAt: number;
  updatedAt: number;
};

export type ProductIntentKind =
  | "activation"
  | "permit2_approval"
  | "wrapper_approval"
  | "wrapper_execution"
  | "router_approval"
  | "router_execution";

export type ProductSubmissionRecord = {
  id: string;
  authorizationId: string;
  journeyId: string;
  rawTransactionHash: Hex;
  state: "consumed" | "submitted" | "unknown" | "rejected";
  ethereumHash: Hex | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProductEventRecord = {
  id: number;
  type: string;
  record: Record<string, unknown>;
  createdAt: number;
};

export type ProductJourneyRecord = {
  id: string;
  quoteId: string;
  mode: ProductMode;
  account: Address;
  requestedProvider: ProviderSelectionId;
  selectedProvider: ProviderId;
  assetId: string;
  originChainId: string;
  state: ProductJourneyState;
  createdAt: number;
  updatedAt: number;
  payment: ProductPaymentRecord | null;
  refuelAuthorization?: RefuelAuthorizationRecord | null;
  authorizations: ProductAuthorizationRecord[];
  submissions: ProductSubmissionRecord[];
  events: ProductEventRecord[];
};

export class ProductLifecycleConflictError extends Error {
  constructor(
    readonly code:
      | "QUOTE_NOT_FOUND"
      | "QUOTE_EXPIRED"
      | "QUOTE_NOT_EXECUTABLE"
      | "IDEMPOTENCY_CONFLICT"
      | "PAYMENT_REPLAY"
      | "JOURNEY_NOT_FOUND"
      | "JOURNEY_STATE_CONFLICT"
      | "AUTHORIZATION_REPLAY"
      | "EVIDENCE_CONFLICT"
      | "NO_MATCHING_CREDIT"
      | "AMBIGUOUS_CREDIT"
      | "QUOTE_EXPIRES_TOO_SOON"
      | "QUOTE_ECONOMICS_WORSENED"
      | "STORED_QUOTE_INVALID",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * A sponsored intent authorization needs at least this much life left; below it
 * the intent builder returns QUOTE_EXPIRES_TOO_SOON so the client refreshes the
 * destination quote and retries the same leg.
 */
export const PRODUCT_AUTHORIZATION_MIN_RUNWAY_SEC = 30;

/**
 * A refresh reuses the live destination quote only while it still clears the
 * runway gate with round-trip slack. At or below it the reuse short-circuit and
 * the runway gate would disagree and refresh-and-retry would loop on one quote.
 */
const DESTINATION_QUOTE_REUSE_RUNWAY_SEC = PRODUCT_AUTHORIZATION_MIN_RUNWAY_SEC + 15;

/** States that may mint a destination quote. The last two are post-consent. */
const DESTINATION_QUOTE_REFRESH_STATES: ProductJourneyState[] = [
  "arrival_confirmed",
  "payment_pending",
  "payment_settled",
  "authorizing",
];

/**
 * The only state an owner may retire from. `ready` is where a journey sits when
 * nothing has happened yet, and where the revert path lands one whose
 * authorization expired unused. Everything else is refused — a false refusal
 * costs one stale row in a list, a false accept can cost the owner their
 * bridged principal, and there is no un-abandon path.
 */
export const ABANDONABLE_STATES: ProductJourneyState[] = ["ready"];

/**
 * Evidence that a journey reached the outside world, or might have.
 *
 * The wallet boundaries are in here for the case that matters most: a boundary
 * with no `bridge_submitted` is exactly the shape the recovery engine routes to
 * POST /bridge/adopt, because the owner may have broadcast a bridge whose hash
 * was never persisted. Retiring one would destroy the only remedy for funds
 * already moving on the origin chain.
 *
 * `destination_activation_funded` is deliberately NOT here: it is sponsor HBAR
 * that already landed in the owner's own Hedera account, it activates the
 * ACCOUNT rather than the journey, every later journey reuses it, and the
 * daily-cap ledger is event-sourced so abandoning cannot un-charge it.
 */
const ABANDON_BLOCKING_EVENTS = [
  "payment_settled",
  "bridge_submitted",
  "bridge_submission_adopted",
  "bridge_arrived",
  "bridge_only_completed",
  "journey_reconciled",
  "bridge_wallet_boundary",
  "origin_approval_wallet_boundary",
] as const;

const INTENT_CONFIRMED_EVENT = /^intent_.+_confirmed$/;

/**
 * How long a `bridge_pending` journey stays worth polling in the background.
 * Matches the 72h adoption window that bounds arrival matching in
 * product-bridge.ts: past it, no credit can be attributed to this submission, so
 * the only remaining routes are owner-signed adoption or operator review.
 */
const BRIDGE_SWEEP_MAX_AGE_MS = 72 * 3_600 * 1_000;

/**
 * A write-ahead activation marker with no funded result is an HBAR transfer
 * whose outcome was never learned. beginDestinationActivation already refuses
 * to move past it; so does this.
 */
function unresolvedActivation(types: Set<string>): boolean {
  return types.has("destination_activation_started") && !types.has("destination_activation_funded");
}

/**
 * Pure, record-only eligibility. The transactional re-check in abandonJourney
 * is the authority; this exists so the activity list can label a row without a
 * second round trip, and so the route can refuse early with a clear reason.
 */
export function journeyAbandonable(journey: ProductJourneyRecord, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!ABANDONABLE_STATES.includes(journey.state)) return false;
  if (journey.payment) return false;
  // Submissions only ever exist because consume() ran, which means an
  // authorization was spent against the policy RPC. Any of them is a refusal.
  if (journey.submissions.length > 0) return false;
  const types = new Set(journey.events.map((event) => event.type));
  if ((ABANDON_BLOCKING_EVENTS as readonly string[]).some((type) => types.has(type))) return false;
  if ([...types].some((type) => INTENT_CONFIRMED_EVENT.test(type))) return false;
  if (unresolvedActivation(types)) return false;
  return !journey.authorizations.some((authorization) =>
    ["unknown", "consumed", "submitted"].includes(authorization.state) ||
    (authorization.state === "pending" && authorization.expiresAt > nowSec));
}

export type ProductActivityCursor = {
  active: boolean;
  updatedAt: number;
  journeyId: string;
};

/**
 * A source resend is safe only while durable evidence proves that no origin
 * wallet boundary or bridge hash exists. Completed activation is allowed: it is
 * account setup already owned by this journey, and reusing it avoids another
 * sponsored activation. Unbroadcast activation reservations may be expired by
 * the transactional re-quote bind.
 */
export function sourceJourneyResendable(journey: ProductJourneyRecord): boolean {
  if (!["ready", "bridge_ready", "activation_pending", "authorizing", "failed"].includes(journey.state)) return false;
  if (journey.payment) return false;
  const types = new Set(journey.events.map((event) => event.type));
  const forbiddenEvents = [
    "origin_approval_wallet_boundary",
    "bridge_wallet_boundary",
    "bridge_submitted",
    "bridge_submission_adopted",
    "bridge_arrived",
    "bridge_only_completed",
    "payment_settled",
    "journey_reconciled",
  ];
  if (forbiddenEvents.some((type) => types.has(type))) return false;
  if ([...types].some((type) => INTENT_CONFIRMED_EVENT.test(type) && type !== "intent_activation_confirmed")) return false;
  const authorizations = new Map(journey.authorizations.map((authorization) => [authorization.id, authorization]));
  if (journey.authorizations.some((authorization) =>
    authorization.intentKind !== "activation" ||
    ["unknown", "consumed"].includes(authorization.state) ||
    (authorization.state === "pending" && Boolean(authorization.rawTransactionHash)))) return false;
  return journey.submissions.every((submission) => {
    const authorization = authorizations.get(submission.authorizationId);
    return authorization?.intentKind === "activation" && ["submitted", "rejected"].includes(submission.state);
  });
}

function sourceIntentFingerprint(value: Record<string, unknown>): string {
  const record = value as Record<string, any>;
  return JSON.stringify({
    routeMode: record.routeMode ?? null,
    account: record.account ?? null,
    originChainId: record.bridge?.originChainId ?? null,
    originToken: record.bridge?.originToken ?? null,
    sourceAmount: record.bridge?.normalized?.sourceAmount ?? null,
    desiredHbarTinybar: record.amountLedger?.hbar?.exactOutputTinybar ?? null,
    slippageBps: record.destination?.slippageBps ?? null,
  });
}

export type DestinationQuoteEconomics = {
  swapInputMaximum: string;
  minimumRetained: string;
  desiredHbarTinybar: string;
};

function decimalAmount(value: unknown): string | null {
  const text = typeof value === "bigint" || typeof value === "number" ? String(value) : String(value ?? "");
  return /^\d+$/.test(text) ? text : null;
}

/**
 * The three consented figures the user actually agreed to: the exact HBAR they
 * asked for, the maximum destination asset the swap may debit, and the minimum
 * destination asset left afterwards.
 */
function destinationQuoteEconomics(record: unknown): DestinationQuoteEconomics {
  const quote = (record ?? {}) as Record<string, any>;
  const ledger = (quote.amountLedger ?? {}) as Record<string, any>;
  const swapInputMaximum = decimalAmount(ledger.destination?.swapInputMaximum);
  const minimumRetained = decimalAmount(ledger.destination?.remainingAtMinimum);
  const desiredHbarTinybar = decimalAmount(ledger.hbar?.exactOutputTinybar);
  if (!swapInputMaximum || !minimumRetained || !desiredHbarTinybar) {
    throw new ProductLifecycleConflictError(
      "QUOTE_NOT_EXECUTABLE",
      "quote does not expose comparable destination economics",
    );
  }
  return { swapInputMaximum, minimumRetained, desiredHbarTinybar };
}

type QuoteRow = {
  quote_id: string;
  mode: ProductMode;
  account: string;
  requested_provider: ProviderSelectionId | null;
  selected_provider: ProviderId | null;
  asset_id: string | null;
  origin_chain_id: string | null;
  expires_at: string | number;
  executable: boolean;
  record: Record<string, unknown>;
};

type JourneyRow = {
  journey_id: string;
  quote_id: string;
  mode: ProductMode;
  account: string;
  requested_provider: ProviderSelectionId;
  selected_provider: ProviderId;
  asset_id: string;
  origin_chain_id: string;
  state: ProductJourneyState;
  created_at: string | number;
  updated_at: string | number;
};

type PaymentRow = {
  payment_identity: string;
  journey_id: string;
  record: ProductPaymentRecord;
};

type RefuelAuthorizationRow = {
  authorization_id: string;
  journey_id: string;
  state: RefuelAuthorizationState;
  owner: string;
  token: string;
  max_amount_in: string;
  exact_hbar_tinybar: string;
  service_fee_amount: string;
  max_sponsor_exposure_tinybar: string;
  recipient: string;
  journey_nonce: string;
  deadline: string | number;
  route_hash: Hex;
  signature: Hex;
  permit2: string;
  spender: string;
  record: RefuelAuthorizationRecord["route"];
  attempt_count: string | number;
  next_attempt_at: string | number;
  execution_reference: string | null;
  last_error_code: string | null;
  created_at: string | number;
  updated_at: string | number;
};

type SubmissionRow = {
  submission_id: string;
  authorization_id: string;
  journey_id: string;
  raw_transaction_hash: Hex;
  state: ProductSubmissionRecord["state"];
  ethereum_hash: Hex | null;
  reason: string | null;
  created_at: string | number;
  updated_at: string | number;
};

type EventRow = {
  event_id: string | number;
  event_type: string;
  record: Record<string, unknown>;
  created_at: string | number;
};

type AuthorizationRow = {
  authorization_id: string;
  journey_id: string;
  intent_kind: ProductIntentKind;
  raw_transaction_hash: Hex | null;
  state: ProductAuthorizationRecord["state"];
  ethereum_hash: Hex | null;
  record: SerializedAuthorization;
  created_at: string | number;
  updated_at: string | number;
};

type SerializedAuthorization = Omit<
  PolicyRpcAuthorization,
  "account" | "to" | "dataHash" | "value" | "gasLimitMaximum" | "maxGasAllowanceTinybar"
> & {
  account: string;
  to: string;
  dataHash: string;
  value: string;
  gasLimitMaximum: string;
  maxGasAllowanceTinybar: string;
  // Stamped only by a mined-and-reverted reconciliation: the sponsor was charged
  // for the burned gas, so the row stays counted against the daily cap even
  // though the authorization ends in 'rejected'. Ledger-only; never exposed.
  sponsorSpent?: boolean;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

function serializeAuthorization(input: PolicyRpcAuthorization): SerializedAuthorization {
  return {
    ...input,
    account: getAddress(input.account),
    to: getAddress(input.to),
    dataHash: input.dataHash,
    value: input.value.toString(),
    gasLimitMaximum: input.gasLimitMaximum.toString(),
    maxGasAllowanceTinybar: input.maxGasAllowanceTinybar.toString(),
  };
}

function deserializeAuthorization(record: SerializedAuthorization): PolicyRpcAuthorization {
  const { sponsorSpent: _sponsorSpent, ...rest } = record;
  return {
    ...rest,
    account: getAddress(record.account),
    to: getAddress(record.to),
    dataHash: record.dataHash as Hex,
    value: BigInt(record.value),
    gasLimitMaximum: BigInt(record.gasLimitMaximum),
    maxGasAllowanceTinybar: BigInt(record.maxGasAllowanceTinybar),
  };
}

function authorizationFromRow(row: AuthorizationRow): ProductAuthorizationRecord {
  return {
    ...deserializeAuthorization(row.record),
    journeyId: row.journey_id,
    intentKind: row.intent_kind,
    rawTransactionHash: row.raw_transaction_hash,
    state: row.state,
    ethereumHash: row.ethereum_hash,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function refuelAuthorizationFromRow(row: RefuelAuthorizationRow): RefuelAuthorizationRecord {
  return {
    id: row.authorization_id,
    journeyId: row.journey_id,
    state: row.state,
    owner: getAddress(row.owner),
    token: getAddress(row.token),
    maxAmountIn: String(row.max_amount_in),
    exactHbarTinybar: String(row.exact_hbar_tinybar),
    serviceFeeAmount: String(row.service_fee_amount),
    maxSponsorExposureTinybar: String(row.max_sponsor_exposure_tinybar),
    recipient: getAddress(row.recipient),
    journeyNonce: String(row.journey_nonce),
    deadline: Number(row.deadline),
    routeHash: row.route_hash,
    signature: row.signature,
    permit2: getAddress(row.permit2),
    spender: getAddress(row.spender),
    route: {
      ...row.record,
      wrapper: getAddress(row.record.wrapper),
      htsToken: getAddress(row.record.htsToken),
      router: getAddress(row.record.router),
      whbar: getAddress(row.record.whbar),
      wrapperRate: String(row.record.wrapperRate),
      swapPath: String(row.record.swapPath) as Hex,
    },
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: Number(row.next_attempt_at),
    executionReference: row.execution_reference,
    lastErrorCode: row.last_error_code,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// Concurrent boots run byte-identical CREATE ... IF NOT EXISTS DDL. Without one
// writer at a time PostgreSQL deadlocks on the shared catalog rows and a replica
// dies during startup migration, so every migration path takes this lock first.
const MIGRATION_ADVISORY_LOCK_KEY = 402_402_402;

export async function withMigrationLock<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    return await run(client);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

export async function migrateProductLifecycle(pool: Pool): Promise<void> {
  await withMigrationLock(pool, (client) => migrateProductLifecycleWithin(client));
}

export async function migrateProductLifecycleWithin(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS refuel402_product_quotes (
      quote_id text PRIMARY KEY,
      mode text NOT NULL CHECK (mode IN ('testnet', 'mainnet')),
      account text NOT NULL,
      requested_provider text NOT NULL CHECK (requested_provider IN ('auto', 'axelar', 'layerzero')),
      selected_provider text NOT NULL CHECK (selected_provider IN ('axelar', 'layerzero')),
      asset_id text NOT NULL,
      origin_chain_id text NOT NULL,
      expires_at bigint NOT NULL,
      executable boolean NOT NULL,
      record jsonb NOT NULL,
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refuel402_product_quotes_expiry
      ON refuel402_product_quotes (expires_at);

    CREATE TABLE IF NOT EXISTS refuel402_product_journeys (
      journey_id text PRIMARY KEY,
      quote_id text NOT NULL UNIQUE REFERENCES refuel402_product_quotes(quote_id),
      idempotency_key text NOT NULL UNIQUE,
      mode text NOT NULL CHECK (mode IN ('testnet', 'mainnet')),
      account text NOT NULL,
      requested_provider text NOT NULL CHECK (requested_provider IN ('auto', 'axelar', 'layerzero')),
      selected_provider text NOT NULL CHECK (selected_provider IN ('axelar', 'layerzero')),
      asset_id text NOT NULL,
      origin_chain_id text NOT NULL,
      state text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refuel402_product_journeys_state_updated
      ON refuel402_product_journeys (state, updated_at);

    CREATE TABLE IF NOT EXISTS refuel402_product_payments (
      payment_identity text PRIMARY KEY,
      journey_id text NOT NULL UNIQUE REFERENCES refuel402_product_journeys(journey_id),
      idempotency_key text NOT NULL UNIQUE,
      proof_hash text NOT NULL UNIQUE,
      record jsonb NOT NULL,
      created_at bigint NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refuel402_product_refuel_authorizations (
      authorization_id text PRIMARY KEY,
      journey_id text NOT NULL UNIQUE REFERENCES refuel402_product_journeys(journey_id),
      state text NOT NULL CHECK (state IN ('recorded', 'executing', 'retry_scheduled', 'completed', 'expired', 'fallback', 'unknown')),
      owner text NOT NULL,
      token text NOT NULL,
      max_amount_in numeric(78,0) NOT NULL CHECK (max_amount_in > 0),
      exact_hbar_tinybar numeric(78,0) NOT NULL CHECK (exact_hbar_tinybar > 0),
      service_fee_amount numeric(78,0) NOT NULL CHECK (service_fee_amount >= 0),
      max_sponsor_exposure_tinybar numeric(78,0) NOT NULL CHECK (max_sponsor_exposure_tinybar > 0),
      recipient text NOT NULL,
      journey_nonce numeric(78,0) NOT NULL,
      deadline bigint NOT NULL,
      route_hash text NOT NULL,
      signature text NOT NULL,
      permit2 text NOT NULL,
      spender text NOT NULL,
      record jsonb NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at bigint NOT NULL,
      execution_reference text,
      last_error_code text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );
    ALTER TABLE refuel402_product_refuel_authorizations
      ADD COLUMN IF NOT EXISTS max_sponsor_exposure_tinybar numeric(78,0) NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS refuel402_product_refuel_authorizations_due
      ON refuel402_product_refuel_authorizations (state, next_attempt_at)
      WHERE state IN ('recorded', 'retry_scheduled');

    CREATE TABLE IF NOT EXISTS refuel402_product_authorizations (
      authorization_id text PRIMARY KEY,
      journey_id text NOT NULL REFERENCES refuel402_product_journeys(journey_id),
      intent_kind text NOT NULL,
      idempotency_key text NOT NULL,
      raw_transaction_hash text UNIQUE,
      mode text NOT NULL CHECK (mode IN ('testnet', 'mainnet')),
      expires_at bigint NOT NULL,
      state text NOT NULL,
      ethereum_hash text,
      record jsonb NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (journey_id, intent_kind, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS refuel402_product_authorizations_state_expiry
      ON refuel402_product_authorizations (state, expires_at);
    -- Every daily-cap decision on four hot paths scans this never-pruned table by
    -- updated_at. The predicate must stay a superset of the states
    -- sponsoredIntentExposureSince counts, or the planner cannot use it.
    CREATE INDEX IF NOT EXISTS refuel402_product_authorizations_sponsor_exposure
      ON refuel402_product_authorizations (updated_at)
      WHERE state IN ('pending', 'consumed', 'submitted', 'unknown', 'rejected');

    CREATE TABLE IF NOT EXISTS refuel402_product_submissions (
      submission_id text PRIMARY KEY,
      authorization_id text NOT NULL UNIQUE REFERENCES refuel402_product_authorizations(authorization_id),
      journey_id text NOT NULL REFERENCES refuel402_product_journeys(journey_id),
      raw_transaction_hash text NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN ('consumed', 'submitted', 'unknown', 'rejected')),
      ethereum_hash text,
      reason text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refuel402_product_submissions_journey
      ON refuel402_product_submissions (journey_id, created_at);
    CREATE INDEX IF NOT EXISTS refuel402_product_submissions_state
      ON refuel402_product_submissions (state, updated_at);

    CREATE TABLE IF NOT EXISTS refuel402_product_events (
      event_id bigserial PRIMARY KEY,
      journey_id text NOT NULL REFERENCES refuel402_product_journeys(journey_id),
      event_type text NOT NULL,
      record jsonb NOT NULL,
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refuel402_product_events_journey
      ON refuel402_product_events (journey_id, event_id);
    -- activationExposureSince backs three hot paths (activation, the policy-RPC
    -- bounded submitter, POST /v1/fuel) over a table that takes an event for every
    -- lifecycle transition of every journey and whose rows can never be deleted.
    -- The predicate must stay a superset of the event types it counts, or the
    -- planner cannot use it.
    CREATE INDEX IF NOT EXISTS refuel402_product_events_activation_exposure
      ON refuel402_product_events (created_at)
      WHERE event_type IN ('destination_activation_started', 'destination_activation_funded');
    CREATE OR REPLACE FUNCTION refuel402_reject_product_event_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'refuel402 product events are append-only' USING ERRCODE = '55000';
    END;
    $$;
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'refuel402_product_events_immutable'
      ) THEN
        CREATE TRIGGER refuel402_product_events_immutable
        BEFORE UPDATE OR DELETE ON refuel402_product_events
        FOR EACH ROW EXECUTE FUNCTION refuel402_reject_product_event_mutation();
      END IF;
    END;
    $migration$;

    ALTER TABLE refuel402_product_quotes
      ADD COLUMN IF NOT EXISTS requested_provider text,
      ADD COLUMN IF NOT EXISTS selected_provider text,
      ADD COLUMN IF NOT EXISTS asset_id text,
      ADD COLUMN IF NOT EXISTS origin_chain_id text;
    ALTER TABLE refuel402_product_journeys
      ADD COLUMN IF NOT EXISTS requested_provider text,
      ADD COLUMN IF NOT EXISTS selected_provider text,
      ADD COLUMN IF NOT EXISTS asset_id text,
      ADD COLUMN IF NOT EXISTS origin_chain_id text;
    ALTER TABLE refuel402_product_authorizations
      ALTER COLUMN raw_transaction_hash DROP NOT NULL;
  `);
}


/**
 * Where a confirmed `permit2_approval` leaves the journey.
 *
 * The allowance is a one-time-per-token setup, so it can legitimately be taken
 * BEFORE the bridge (while the wallet is already on Hedera for activation) or
 * after arrival as part of the manual destination leg. It used to map to
 * `payment_pending` unconditionally, which pre-bridge drove the journey into a
 * state where the wallet boundary and the bridge submission are both refused —
 * bricking it before anything was sent. The position is decided by durable bridge
 * evidence, never by the intent kind alone.
 */
async function permit2ApprovalNextState(
  client: PoolClient,
  journeyId: string,
): Promise<ProductJourneyState> {
  const bridged = await client.query<{ event_type: string }>(
    `SELECT event_type FROM refuel402_product_events
     WHERE journey_id = $1
       AND event_type IN ('bridge_submitted', 'bridge_submission_adopted', 'bridge_arrived')
     LIMIT 1`,
    [journeyId],
  );
  return bridged.rows[0] ? "payment_pending" : "bridge_ready";
}

export class ProductLifecycleStore implements PolicyRpcAuthorizer {
  /**
   * nowMs is the quote-liveness clock only. It is injectable so a harness can
   * advance past a real ~60s Saucer simulation window without sleeping; every
   * other timestamp stays wall-clock.
   */
  constructor(readonly pool: Pool, private readonly nowMs: () => number = () => Date.now()) {}

  async saveQuote(quote: StoredProductQuote): Promise<void> {
    const now = Date.now();
    const account = getAddress(quote.account);
    const result = await this.pool.query(
      `INSERT INTO refuel402_product_quotes
         (quote_id, mode, account, requested_provider, selected_provider, asset_id,
          origin_chain_id, expires_at, executable, record, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (quote_id) DO UPDATE SET
         quote_id = EXCLUDED.quote_id
       WHERE refuel402_product_quotes.mode = EXCLUDED.mode
         AND refuel402_product_quotes.account = EXCLUDED.account
         AND refuel402_product_quotes.requested_provider = EXCLUDED.requested_provider
         AND refuel402_product_quotes.selected_provider = EXCLUDED.selected_provider
         AND refuel402_product_quotes.asset_id = EXCLUDED.asset_id
         AND refuel402_product_quotes.origin_chain_id = EXCLUDED.origin_chain_id
         AND refuel402_product_quotes.expires_at = EXCLUDED.expires_at
         AND refuel402_product_quotes.executable = EXCLUDED.executable
         AND refuel402_product_quotes.record = EXCLUDED.record
       RETURNING quote_id`,
      [
        quote.quoteId,
        quote.mode,
        account.toLowerCase(),
        quote.requestedProvider,
        quote.selectedProvider,
        quote.assetId,
        quote.originChainId,
        quote.expiresAt,
        quote.executable,
        JSON.stringify(quote.record),
        now,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ProductLifecycleConflictError(
        "IDEMPOTENCY_CONFLICT",
        "quote identity was reused with different immutable fields",
      );
    }
  }

  async getQuote(id: string): Promise<StoredProductQuote | null> {
    const result = await this.pool.query<QuoteRow>(
      "SELECT * FROM refuel402_product_quotes WHERE quote_id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!row.requested_provider || !row.selected_provider || !row.asset_id || !row.origin_chain_id) {
      throw new ProductLifecycleConflictError(
        "IDEMPOTENCY_CONFLICT",
        "stored quote predates the provider-bound lifecycle contract",
      );
    }
    return {
      quoteId: row.quote_id,
      mode: row.mode,
      account: getAddress(row.account),
      requestedProvider: row.requested_provider,
      selectedProvider: row.selected_provider,
      assetId: row.asset_id,
      originChainId: row.origin_chain_id,
      expiresAt: Number(row.expires_at),
      executable: row.executable,
      record: row.record,
    };
  }

  private async event(
    client: PoolClient,
    journeyId: string,
    eventType: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO refuel402_product_events (journey_id, event_type, record, created_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [journeyId, eventType, JSON.stringify(record), Date.now()],
    );
  }

  private assertJourneyIdentity(
    row: JourneyRow,
    input: { quoteId: string; mode: ProductMode; account: Address },
  ): void {
    if (
      row.quote_id !== input.quoteId ||
      row.mode !== input.mode ||
      getAddress(row.account) !== getAddress(input.account)
    ) {
      throw new ProductLifecycleConflictError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key is already bound to a different journey request",
      );
    }
  }

  async createJourney(input: {
    quoteId: string;
    mode: ProductMode;
    account: Address;
    idempotencyKey: string;
    nowSec?: number;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE idempotency_key = $1 FOR UPDATE",
        [input.idempotencyKey],
      );
      if (replay.rows[0]) {
        this.assertJourneyIdentity(replay.rows[0], input);
        await client.query("COMMIT");
        return this.getJourney(replay.rows[0].journey_id) as Promise<ProductJourneyRecord>;
      }

      const quoteResult = await client.query<QuoteRow>(
        "SELECT * FROM refuel402_product_quotes WHERE quote_id = $1 FOR UPDATE",
        [input.quoteId],
      );
      const quote = quoteResult.rows[0];
      if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "quote does not exist");
      if (!quote.requested_provider || !quote.selected_provider || !quote.asset_id || !quote.origin_chain_id) {
        throw new ProductLifecycleConflictError(
          "IDEMPOTENCY_CONFLICT",
          "quote is missing immutable provider/support identity",
        );
      }
      if (quote.mode !== input.mode || getAddress(quote.account) !== getAddress(input.account)) {
        throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "quote mode/account mismatch");
      }
      if (Number(quote.expires_at) <= (input.nowSec ?? Math.floor(Date.now() / 1000))) {
        throw new ProductLifecycleConflictError("QUOTE_EXPIRED", "quote is expired");
      }
      if (!quote.executable) {
        throw new ProductLifecycleConflictError(
          "QUOTE_NOT_EXECUTABLE",
          "quote is not executable under current provider, contract, facilitator, and policy gates",
        );
      }

      const existing = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE quote_id = $1 FOR UPDATE",
        [input.quoteId],
      );
      if (existing.rows[0]) {
        this.assertJourneyIdentity(existing.rows[0], input);
        await client.query("COMMIT");
        return this.getJourney(existing.rows[0].journey_id) as Promise<ProductJourneyRecord>;
      }

      const now = Date.now();
      const journeyId = randomUUID();
      await client.query(
        `INSERT INTO refuel402_product_journeys
           (journey_id, quote_id, idempotency_key, mode, account, requested_provider,
            selected_provider, asset_id, origin_chain_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ready', $10, $10)`,
        [
          journeyId,
          input.quoteId,
          input.idempotencyKey,
          input.mode,
          getAddress(input.account).toLowerCase(),
          quote.requested_provider,
          quote.selected_provider,
          quote.asset_id,
          quote.origin_chain_id,
          now,
        ],
      );
      await this.event(client, journeyId, "journey_created", {
        quoteId: input.quoteId,
        state: "ready",
        requestedProvider: quote.requested_provider,
        selectedProvider: quote.selected_provider,
        assetId: quote.asset_id,
        originChainId: quote.origin_chain_id,
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJourney(id: string): Promise<ProductJourneyRecord | null> {
    return this.loadJourney(this.pool, id);
  }

  async recordRefuelAuthorization(input: Omit<
    RefuelAuthorizationRecord,
    "state" | "attemptCount" | "nextAttemptAt" | "executionReference" | "lastErrorCode" | "createdAt" | "updatedAt"
  >): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (!["ready", "bridge_ready", "activation_pending", "authorizing"].includes(journey.state)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "refuel authorization must be recorded before the origin bridge is submitted",
        );
      }
      if (getAddress(journey.account) !== getAddress(input.owner) || getAddress(input.recipient) !== getAddress(input.owner)) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "refuel authorization owner does not match the journey");
      }
      const existing = await client.query<RefuelAuthorizationRow>(
        "SELECT * FROM refuel402_product_refuel_authorizations WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      if (existing.rows[0]) {
        const replay = refuelAuthorizationFromRow(existing.rows[0]);
        const comparableReplay = {
          id: replay.id,
          journeyId: replay.journeyId,
          owner: replay.owner,
          token: replay.token,
          maxAmountIn: replay.maxAmountIn,
          exactHbarTinybar: replay.exactHbarTinybar,
          serviceFeeAmount: replay.serviceFeeAmount,
          maxSponsorExposureTinybar: replay.maxSponsorExposureTinybar,
          recipient: replay.recipient,
          journeyNonce: replay.journeyNonce,
          deadline: replay.deadline,
          routeHash: replay.routeHash,
          signature: replay.signature,
          permit2: replay.permit2,
          spender: replay.spender,
          route: replay.route,
        };
        if (canonicalJson(comparableReplay) !== canonicalJson(input)) {
          throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "journey already has a different refuel authorization");
        }
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      const now = Date.now();
      await client.query(
        `INSERT INTO refuel402_product_refuel_authorizations
           (authorization_id, journey_id, state, owner, token, max_amount_in, exact_hbar_tinybar,
            service_fee_amount, max_sponsor_exposure_tinybar, recipient, journey_nonce, deadline,
            route_hash, signature, permit2, spender, record, attempt_count, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, 'recorded', $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9,
                 $10::numeric, $11, $12, $13, $14, $15, $16::jsonb, 0, $17, $17, $17)`,
        [
          input.id,
          input.journeyId,
          getAddress(input.owner).toLowerCase(),
          getAddress(input.token).toLowerCase(),
          input.maxAmountIn,
          input.exactHbarTinybar,
          input.serviceFeeAmount,
          input.maxSponsorExposureTinybar,
          getAddress(input.recipient).toLowerCase(),
          input.journeyNonce,
          input.deadline,
          input.routeHash,
          input.signature,
          getAddress(input.permit2).toLowerCase(),
          getAddress(input.spender).toLowerCase(),
          JSON.stringify(input.route),
          now,
        ],
      );
      await this.event(client, input.journeyId, "refuel_authorization_recorded", {
        authorizationId: input.id,
        maxAmountIn: input.maxAmountIn,
        exactHbarTinybar: input.exactHbarTinybar,
        serviceFeeAmount: input.serviceFeeAmount,
        maxSponsorExposureTinybar: input.maxSponsorExposureTinybar,
        journeyNonce: input.journeyNonce,
        deadline: input.deadline,
        routeHash: input.routeHash,
        permit2: input.permit2,
        spender: input.spender,
      });
      await client.query(
        "UPDATE refuel402_product_journeys SET updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "refuel authorization identity already exists");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The same read, against either the pool or an open transaction client.
   *
   * A caller that already holds a client must pass it. Reaching back into the
   * pool from inside a transaction takes a SECOND connection while the first sits
   * idle on BEGIN, so N concurrent callers can hold N connections and all wait for
   * one more — a circular wait that deadlocks a small pool. It also reads outside
   * the row lock the caller just took, which makes a "locked re-check" only look
   * like one.
   */
  private async loadJourney(
    queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    id: string,
  ): Promise<ProductJourneyRecord | null> {
    const journeyResult = await queryable.query<JourneyRow>(
      "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1",
      [id],
    );
    const row = journeyResult.rows[0];
    if (!row) return null;
    if (!row.requested_provider || !row.selected_provider || !row.asset_id || !row.origin_chain_id) {
      throw new ProductLifecycleConflictError(
        "IDEMPOTENCY_CONFLICT",
        "journey is missing immutable provider/support identity",
      );
    }
    // Sequential, not Promise.all: one client cannot pipeline, and a pool and a
    // client must behave identically here.
    const paymentResult = await queryable.query<PaymentRow>(
      "SELECT payment_identity, journey_id, record FROM refuel402_product_payments WHERE journey_id = $1",
      [id],
    );
    const refuelAuthorizationResult = await queryable.query<RefuelAuthorizationRow>(
      `SELECT * FROM refuel402_product_refuel_authorizations WHERE journey_id = $1`,
      [id],
    );
    const authorizationResult = await queryable.query<AuthorizationRow>(
      `SELECT * FROM refuel402_product_authorizations
       WHERE journey_id = $1 ORDER BY created_at, authorization_id`,
      [id],
    );
    const submissionResult = await queryable.query<SubmissionRow>(
      `SELECT * FROM refuel402_product_submissions
       WHERE journey_id = $1 ORDER BY created_at, submission_id`,
      [id],
    );
    const eventResult = await queryable.query<EventRow>(
      `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
       WHERE journey_id = $1 ORDER BY event_id`,
      [id],
    );
    return {
      id: row.journey_id,
      quoteId: row.quote_id,
      mode: row.mode,
      account: getAddress(row.account),
      requestedProvider: row.requested_provider,
      selectedProvider: row.selected_provider,
      assetId: row.asset_id,
      originChainId: row.origin_chain_id,
      state: row.state,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      payment: paymentResult.rows[0]?.record ?? null,
      refuelAuthorization: refuelAuthorizationResult.rows[0]
        ? refuelAuthorizationFromRow(refuelAuthorizationResult.rows[0])
        : null,
      authorizations: authorizationResult.rows.map(authorizationFromRow),
      submissions: submissionResult.rows.map((submission) => ({
        id: submission.submission_id,
        authorizationId: submission.authorization_id,
        journeyId: submission.journey_id,
        rawTransactionHash: submission.raw_transaction_hash,
        state: submission.state,
        ethereumHash: submission.ethereum_hash,
        reason: submission.reason,
        createdAt: Number(submission.created_at),
        updatedAt: Number(submission.updated_at),
      })),
      events: eventResult.rows.map((event) => ({
        id: Number(event.event_id),
        type: event.event_type,
        record: event.record,
        createdAt: Number(event.created_at),
      })),
    };
  }

  /**
   * Bounded account Activity read. The exclusive cursor contains every ORDER BY
   * component, including the active-work category, so timestamp ties and the
   * active/draft boundary cannot skip rows.
   */
  async listJourneysForAccount(
    account: Address,
    options: { limit: number; cursor?: ProductActivityCursor | null; includeAbandoned?: boolean },
  ): Promise<{ journeys: ProductJourneyRecord[]; nextCursor: ProductActivityCursor | null }> {
    const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
    const cursor = options.cursor ?? null;
    const cursorRank = cursor ? (cursor.active ? 0 : 1) : null;
    // Exclusion and ordering belong in SQL, not after the fetch: page-local
    // filtering or sorting silently breaks the cursor.
    const result = await this.pool.query<{ journey_id: string; updated_at: string; activity_rank: number | string }>(
      `SELECT journey_id, updated_at,
              CASE WHEN state NOT IN ('ready', 'completed', 'abandoned') THEN 0 ELSE 1 END AS activity_rank
       FROM refuel402_product_journeys
       WHERE lower(account) = lower($1)
         AND ($6::boolean OR state <> 'abandoned')
         AND (
           $2::integer IS NULL
           OR CASE WHEN state NOT IN ('ready', 'completed', 'abandoned') THEN 0 ELSE 1 END > $2
           OR (
             CASE WHEN state NOT IN ('ready', 'completed', 'abandoned') THEN 0 ELSE 1 END = $2
             AND (updated_at < $3 OR (updated_at = $3 AND journey_id < $4))
           )
         )
       ORDER BY activity_rank ASC, updated_at DESC, journey_id DESC
       LIMIT $5`,
      [
        getAddress(account),
        cursorRank,
        cursor?.updatedAt ?? null,
        cursor?.journeyId ?? null,
        limit,
        options.includeAbandoned === true,
      ],
    );
    const journeys = (await Promise.all(result.rows.map((row) => this.getJourney(row.journey_id))))
      .filter((journey): journey is ProductJourneyRecord => journey !== null);
    const last = result.rows.length === limit ? result.rows[result.rows.length - 1]! : null;
    return {
      journeys,
      nextCursor: last ? {
        active: Number(last.activity_rank) === 0,
        updatedAt: Number(last.updated_at),
        journeyId: last.journey_id,
      } : null,
    };
  }

  /**
   * Bind a live replacement source quote to the same journey. The row lock and
   * evidence re-check are the authority; the client cannot turn a journey id into
   * permission to replay a source transaction.
   */
  async refreshSourceQuote(input: {
    journeyId: string;
    quoteId: string;
    /**
     * The account the route recovered from the owner's EIP-712 consent. Re-checked
     * here against the locked row: the route read the journey before taking the
     * lock, so verifying only there would trust a snapshot that another
     * transaction could have moved underneath it.
     */
    consentedAccount?: Address;
    nowSec?: number;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journeyRow = journeyResult.rows[0];
      if (!journeyRow) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (input.consentedAccount && getAddress(journeyRow.account) !== getAddress(input.consentedAccount)) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "source quote consent does not recover to the owner of the locked journey",
        );
      }
      // Through the transaction client, so the evidence is read inside the row
      // lock taken above and this does not take a second pooled connection while
      // holding the first.
      const journey = await this.loadJourney(client, input.journeyId);
      if (!journey || !sourceJourneyResendable(journey)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "same-journey source resend requires no source wallet boundary, bridge hash, payment, or unresolved submission",
        );
      }
      const quoteResult = await client.query<QuoteRow>(
        "SELECT * FROM refuel402_product_quotes WHERE quote_id = $1 FOR UPDATE",
        [input.quoteId],
      );
      const quote = quoteResult.rows[0];
      if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "replacement quote does not exist");
      if (Number(quote.expires_at) <= (input.nowSec ?? Math.floor(this.nowMs() / 1000))) {
        throw new ProductLifecycleConflictError("QUOTE_EXPIRED", "replacement quote is expired");
      }
      if (!quote.executable || !(quote.record as Record<string, any>).bridge?.transaction) {
        throw new ProductLifecycleConflictError("QUOTE_NOT_EXECUTABLE", "replacement quote has no executable bridge transaction");
      }
      if (
        quote.mode !== journeyRow.mode ||
        getAddress(quote.account) !== getAddress(journeyRow.account) ||
        quote.requested_provider !== journeyRow.requested_provider ||
        quote.asset_id !== journeyRow.asset_id ||
        quote.origin_chain_id !== journeyRow.origin_chain_id
      ) {
        throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "replacement quote changes the journey source identity");
      }
      const currentQuote = await client.query<QuoteRow>(
        "SELECT * FROM refuel402_product_quotes WHERE quote_id = $1 FOR UPDATE",
        [journeyRow.quote_id],
      );
      if (!currentQuote.rows[0] || sourceIntentFingerprint(currentQuote.rows[0].record) !== sourceIntentFingerprint(quote.record)) {
        throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "replacement quote changes the consented source amount or destination objective");
      }
      if (journeyRow.quote_id === quote.quote_id) {
        await client.query("COMMIT");
        return journey;
      }
      const now = Date.now();
      const expired = await client.query<{ authorization_id: string }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'expired', updated_at = $2
         WHERE journey_id = $1 AND intent_kind = 'activation'
           AND state = 'pending' AND raw_transaction_hash IS NULL
         RETURNING authorization_id`,
        [input.journeyId, now],
      );
      for (const row of expired.rows) {
        await this.event(client, input.journeyId, "authorization_expired", {
          authorizationId: row.authorization_id,
          reason: "unbroadcast activation authorization retired by a live same-journey source re-quote",
        });
      }
      const activationComplete = journey.events.some((event) => event.type === "intent_activation_confirmed");
      await client.query(
        `UPDATE refuel402_product_journeys
         SET quote_id = $2, selected_provider = $3, state = $4, updated_at = $5
         WHERE journey_id = $1`,
        [input.journeyId, quote.quote_id, quote.selected_provider, activationComplete ? "bridge_ready" : "ready", now],
      );
      await this.event(client, input.journeyId, "source_quote_refreshed", {
        previousQuoteId: journeyRow.quote_id,
        quoteId: quote.quote_id,
        expiresAt: Number(quote.expires_at),
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "replacement quote is already bound to another journey");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseUnbroadcastBridgeBoundary(input: {
    journeyId: string;
    evidence: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const events = await client.query<EventRow>(
        "SELECT event_id, event_type, record, created_at FROM refuel402_product_events WHERE journey_id = $1 ORDER BY event_id",
        [input.journeyId],
      );
      const hasBoundary = events.rows.some((event) => event.event_type === "bridge_wallet_boundary");
      const hasBroadcast = events.rows.some((event) => event.event_type === "bridge_submitted") ||
        events.rows.some((event) => typeof event.record.sourceTransactionHash === "string");
      if (!hasBoundary || hasBroadcast || journey.state === "bridge_pending" || journey.state === "arrival_confirmed") {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "bridge wallet boundary cannot be released because durable broadcast evidence exists or the boundary is absent",
        );
      }
      const now = Date.now();
      const activationComplete = events.rows.some((event) => event.event_type === "intent_activation_confirmed");
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [input.journeyId, activationComplete ? "bridge_ready" : "ready", now],
      );
      await this.event(client, input.journeyId, "bridge_wallet_boundary_cleared", {
        disposition: "authoritative_no_broadcast",
        evidence: input.evidence,
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Journeys still worth a background arrival poll.
   *
   * Bounded by age as well as by count. Arrival matching only accepts a credit
   * inside the adoption window after submission, so a journey older than that can
   * never be confirmed by this path — polling it forever would spend the bridge
   * provider's and the mirror's rate budget on work that cannot succeed, and
   * because the sweep is oldest-first those doomed rows would crowd out the recent
   * journeys that can still land. `updated_at` is written when the journey enters
   * `bridge_pending` and nothing else moves it while pending, so it is exactly the
   * submission age. Anything past the window needs `/bridge/adopt` or operator
   * review, not another poll.
   */
  async listBridgeSweepCandidateIds(limit: number, nowMs = this.nowMs()): Promise<string[]> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    const oldestUpdatedAt = nowMs - BRIDGE_SWEEP_MAX_AGE_MS;
    const result = await this.pool.query<{ journey_id: string }>(
      `SELECT journey.journey_id
       FROM refuel402_product_journeys journey
       LEFT JOIN refuel402_product_refuel_authorizations refuel
         ON refuel.journey_id = journey.journey_id
       WHERE (journey.state = 'bridge_pending' AND journey.updated_at > $2)
          OR (journey.state = 'arrival_confirmed'
              AND refuel.state IN ('recorded', 'retry_scheduled')
              AND refuel.next_attempt_at <= $3)
       ORDER BY journey.updated_at ASC, journey.journey_id ASC
       LIMIT $1`,
      [bounded, oldestUpdatedAt, nowMs],
    );
    return result.rows.map((row) => row.journey_id);
  }

  /** Hold cross-instance ownership for one network poll on one pool session. */
  async withBridgeSweepOwnership<T>(
    journeyId: string,
    work: () => Promise<T>,
  ): Promise<{ acquired: boolean; value: T | null }> {
    const client = await this.pool.connect();
    const lockName = `refuel402:bridge-sweep:${journeyId}`;
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockName],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false, value: null };
      return { acquired: true, value: await work() };
    } finally {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]).catch(() => undefined);
      }
      client.release();
    }
  }

  async beginRefuelAuthorizationAttempt(
    journeyId: string,
    nowMs = this.nowMs(),
  ): Promise<{ authorization: RefuelAuthorizationRecord | null; expired: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<RefuelAuthorizationRow>(
        "SELECT * FROM refuel402_product_refuel_authorizations WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      if (!row.rows[0] || !["recorded", "retry_scheduled"].includes(row.rows[0].state) || Number(row.rows[0].next_attempt_at) > nowMs) {
        await client.query("COMMIT");
        return { authorization: null, expired: false };
      }
      if (Number(row.rows[0].deadline) <= Math.floor(nowMs / 1000)) {
        await client.query(
          "UPDATE refuel402_product_refuel_authorizations SET state = 'expired', last_error_code = 'REFUEL_AUTHORIZATION_EXPIRED', updated_at = $2 WHERE journey_id = $1",
          [journeyId, nowMs],
        );
        await this.event(client, journeyId, "refuel_authorization_expired", {
          authorizationId: row.rows[0].authorization_id,
          deadline: Number(row.rows[0].deadline),
          fallback: "destination_wallet_consent",
        });
        await client.query("COMMIT");
        return { authorization: null, expired: true };
      }
      const updated = await client.query<RefuelAuthorizationRow>(
        `UPDATE refuel402_product_refuel_authorizations
         SET state = 'executing', attempt_count = attempt_count + 1, updated_at = $2
         WHERE journey_id = $1 RETURNING *`,
        [journeyId, nowMs],
      );
      await this.event(client, journeyId, "refuel_authorization_execution_started", {
        authorizationId: row.rows[0].authorization_id,
        attempt: Number(updated.rows[0]!.attempt_count),
      });
      await client.query("COMMIT");
      return { authorization: refuelAuthorizationFromRow(updated.rows[0]!), expired: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async scheduleRefuelAuthorizationRetry(input: {
    journeyId: string;
    errorCode: string;
    nextAttemptAt: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<RefuelAuthorizationRow>(
        `UPDATE refuel402_product_refuel_authorizations
         SET state = 'retry_scheduled', next_attempt_at = $2, last_error_code = $3, updated_at = $4
         WHERE journey_id = $1 AND state = 'executing' RETURNING *`,
        [input.journeyId, input.nextAttemptAt, input.errorCode, Date.now()],
      );
      if (!updated.rows[0]) throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "refuel authorization attempt is not active");
      await this.event(client, input.journeyId, "refuel_authorization_retry_scheduled", {
        authorizationId: updated.rows[0].authorization_id,
        attempt: Number(updated.rows[0].attempt_count),
        errorCode: input.errorCode,
        nextAttemptAt: input.nextAttemptAt,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeRefuelAuthorization(input: {
    journeyId: string;
    state: "completed" | "fallback" | "unknown";
    executionReference?: string | null;
    errorCode?: string | null;
    evidence: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    // Set once the on-chain evidence is durable, so the catch below cannot undo a
    // transaction that has already been committed.
    let committed = false;
    try {
      await client.query("BEGIN");
      const updated = await client.query<RefuelAuthorizationRow>(
        `UPDATE refuel402_product_refuel_authorizations
         SET state = $2, execution_reference = $3, last_error_code = $4, updated_at = $5
         WHERE journey_id = $1 AND state = 'executing' RETURNING *`,
        [input.journeyId, input.state, input.executionReference ?? null, input.errorCode ?? null, Date.now()],
      );
      if (!updated.rows[0]) throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "refuel authorization attempt is not active");
      if (input.state === "completed") {
        // rowCount is checked: this used to update WHERE state='arrival_confirmed'
        // and ignore the result, so a journey the owner had already moved on to a
        // manual leg left the refuel completed ON CHAIN while the journey record
        // stayed behind — money moved, state stranded.
        const advanced = await client.query(
          "UPDATE refuel402_product_journeys SET state = 'completed', updated_at = $2 WHERE journey_id = $1 AND state = 'arrival_confirmed'",
          [input.journeyId, Date.now()],
        );
        if (advanced.rowCount !== 1) {
          // The refuel DID execute on chain. Throwing here would roll back the row
          // update above and lose the execution reference entirely — money moved,
          // and no record of it. Commit the evidence first, flag the conflict as a
          // durable event, and only then surface it: an operator can reconcile
          // from a record that exists, never from one that was discarded.
          await this.event(client, input.journeyId, "refuel_authorization_executed", {
            authorizationId: updated.rows[0].authorization_id,
            executionReference: input.executionReference,
            evidence: input.evidence,
          });
          await this.event(client, input.journeyId, "refuel_authorization_state_conflict", {
            authorizationId: updated.rows[0].authorization_id,
            executionReference: input.executionReference,
            reason: "journey had already left arrival_confirmed when the refuel completed",
          });
          await client.query("COMMIT");
          committed = true;
          throw new ProductLifecycleConflictError(
            "JOURNEY_STATE_CONFLICT",
            "refuel executed on chain but the journey had already left arrival_confirmed; the execution is recorded and must be reconciled before any further destination action",
          );
        }
        await this.event(client, input.journeyId, "refuel_authorization_executed", {
          authorizationId: updated.rows[0].authorization_id,
          executionReference: input.executionReference,
          evidence: input.evidence,
        });
        await this.event(client, input.journeyId, "journey_reconciled", {
          submissionId: updated.rows[0].authorization_id,
          ethereumHash: input.executionReference,
          receipt: input.evidence,
          reconciliation: "complete",
        });
      } else {
        await this.event(client, input.journeyId, input.state === "unknown"
          ? "refuel_authorization_unknown"
          : "refuel_authorization_fallback", {
          authorizationId: updated.rows[0].authorization_id,
          errorCode: input.errorCode,
          executionReference: input.executionReference ?? null,
          fallback: "destination_wallet_consent",
          evidence: input.evidence,
        });
      }
      await client.query("COMMIT");
      committed = true;
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEffectiveQuote(journeyId: string): Promise<StoredProductQuote | null> {
    const journey = await this.getJourney(journeyId);
    if (!journey) return null;
    const original = await this.getQuote(journey.quoteId);
    if (!original) return null;
    const refreshed = [...journey.events].reverse().find((event) => event.type === "destination_quote_refreshed");
    const record = refreshed?.record.quote;
    if (!record || typeof record !== "object") return original;
    const quote = record as Record<string, any>;
    const expiresAt = Number(quote.expiresAt);
    return {
      ...original,
      expiresAt,
      executable: quote.capabilities?.execute === true,
      record: quote,
    };
  }

  /**
   * The quote the user actually consented to: the destination quote in force
   * when the payment settled. Post-2026-07 payments name it directly on the
   * payment_settled event; older ones are resolved positionally from the
   * append-only log, since events only ever grow.
   */
  private async consentedQuoteRecord(
    client: PoolClient,
    journey: JourneyRow,
  ): Promise<Record<string, unknown> | null> {
    const events = await client.query<EventRow>(
      `SELECT event_id, event_type, record, created_at
       FROM refuel402_product_events
       WHERE journey_id = $1 AND event_type IN ('payment_settled', 'destination_quote_refreshed')
       ORDER BY event_id ASC`,
      [journey.journey_id],
    );
    const settled = [...events.rows].reverse().find((event) => event.event_type === "payment_settled");
    if (!settled) return null;
    const refreshes = events.rows.filter((event) =>
      event.event_type === "destination_quote_refreshed" && Number(event.event_id) < Number(settled.event_id));
    const boundQuoteId = String(settled.record.quoteId ?? "");
    const bound = boundQuoteId
      ? [...refreshes].reverse().find((event) => String(event.record.quoteId ?? "") === boundQuoteId)
      : undefined;
    const consented = bound ?? refreshes.at(-1);
    if (consented) return consented.record.quote as Record<string, unknown>;
    const original = await client.query<QuoteRow>(
      "SELECT * FROM refuel402_product_quotes WHERE quote_id = $1",
      [journey.quote_id],
    );
    return original.rows[0]?.record ?? null;
  }

  async recordDestinationQuoteRefresh(input: {
    journeyId: string;
    quote: Record<string, unknown>;
  }): Promise<StoredProductQuote> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (!DESTINATION_QUOTE_REFRESH_STATES.includes(journey.state)) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `destination quote cannot refresh from ${journey.state}`);
      }
      const nowSec = Math.floor(this.nowMs() / 1000);
      const priorRefresh = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at
         FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'destination_quote_refreshed'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      const priorExpiresAt = Number(priorRefresh.rows[0]?.record.expiresAt ?? 0);
      if (priorExpiresAt > nowSec + DESTINATION_QUOTE_REUSE_RUNWAY_SEC) {
        await client.query("COMMIT");
        return (await this.getEffectiveQuote(input.journeyId))!;
      }
      const expiresAt = Number(input.quote.expiresAt);
      if (!Number.isInteger(expiresAt) || expiresAt <= nowSec) {
        throw new ProductLifecycleConflictError("QUOTE_EXPIRED", "refreshed destination quote is not live");
      }
      // Clicking the primary action consented to one exact quote. Re-quoting to
      // regain runway may only keep or improve those terms; anything worse needs
      // fresh explicit consent, so it is reported and nothing is written.
      const consentedRecord = await this.consentedQuoteRecord(client, journey);
      if (consentedRecord) {
        const consented = destinationQuoteEconomics(consentedRecord);
        const refreshed = destinationQuoteEconomics(input.quote);
        if (
          refreshed.desiredHbarTinybar !== consented.desiredHbarTinybar ||
          BigInt(refreshed.swapInputMaximum) > BigInt(consented.swapInputMaximum) ||
          BigInt(refreshed.minimumRetained) < BigInt(consented.minimumRetained)
        ) {
          throw new ProductLifecycleConflictError(
            "QUOTE_ECONOMICS_WORSENED",
            "refreshed destination quote is worse than the consented quote",
            { consented, refreshed },
          );
        }
      }
      await this.event(client, input.journeyId, "destination_quote_refreshed", {
        quote: input.quote,
        quoteId: String(input.quote.quoteId ?? ""),
        expiresAt,
      });
      await client.query("COMMIT");
      return (await this.getEffectiveQuote(input.journeyId))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // amountTinybar is the intended transfer, written BEFORE the sponsor moves any
  // HBAR. If the caller dies between the transfer and recordDestinationActivation
  // this marker is the only durable evidence of the spend, so activationExposureSince
  // charges it against the daily cap.
  async beginDestinationActivation(journeyId: string, amountTinybar: string): Promise<"proceed" | "complete"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const events = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type IN ('destination_activation_started', 'destination_activation_funded')
         ORDER BY event_id`,
        [journeyId],
      );
      if (events.rows.some((event) => event.event_type === "destination_activation_funded")) {
        await client.query("COMMIT");
        return "complete";
      }
      if (events.rows.some((event) => event.event_type === "destination_activation_started")) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "destination activation result is unknown; reconcile the original attempt before retry",
        );
      }
      if (journey.state !== "ready") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `destination activation cannot begin from ${journey.state}`);
      }
      await this.event(client, journeyId, "destination_activation_started", { state: "started", amountTinybar });
      await client.query("COMMIT");
      return "proceed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Counting only funded events loses every activation that transferred but died
  // before recordDestinationActivation, and that spend stays invisible to the daily
  // cap forever. So each journey contributes exactly one in-window activation: the
  // MAX of its marker and funded amounts, which in production are the same bound
  // amount. MAX rather than a preferred row because it cannot under-count whatever
  // the two rows say and does not depend on their relative event_id. Over-counting
  // is the safe direction - a started marker whose transfer actually failed keeps
  // being charged until it ages out of the window (nothing clears a marker: the
  // begin guard scans all events with no time bound and the immutability trigger
  // blocks DELETE), which costs at most one activation of headroom; under-counting
  // costs the cap itself. The window filter stays inside the per-journey grouping
  // so a marker below the cutoff with its funded event above still counts once.
  // A row with no amountTinybar (a marker written before this carried one)
  // contributes 0 rather than throwing.
  async activationExposureSince(cutoffMs: number): Promise<bigint> {
    const result = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM (
         SELECT MAX((record->>'amountTinybar')::numeric) AS amount
         FROM refuel402_product_events
         WHERE event_type IN ('destination_activation_started', 'destination_activation_funded')
           AND created_at >= $1
         GROUP BY journey_id
       ) AS activation`,
      [cutoffMs],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  }

  // Sponsored intent gas is the product's largest sponsor cost, and the bounded
  // submitter only keeps an in-memory replay map, so the authorization rows are
  // the durable record. Live reservations count alongside spent allowances -
  // concurrent journeys must not each be told the whole daily cap is free - while
  // expired-unconsumed and lapsed pending rows never cost anything. A rejection
  // is free EXCEPT when the transaction was mined and reverted: Hedera still
  // charged the sponsor for the gas it burned, so those rows carry sponsorSpent.
  async sponsoredIntentExposureSince(
    cutoffMs: number,
    options: SponsorExposureOptions & { nowSec?: number } = {},
  ): Promise<bigint> {
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
    const result = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM((record->>'maxGasAllowanceTinybar')::numeric), 0)::text AS total
       FROM refuel402_product_authorizations
       WHERE updated_at >= $1
         AND ($3::text IS NULL OR raw_transaction_hash IS DISTINCT FROM $3)
         AND (state IN ('consumed', 'submitted', 'unknown')
              OR (state = 'pending' AND expires_at > $2)
              OR (state = 'rejected' AND record->>'sponsorSpent' = 'true'))`,
      [cutoffMs, nowSec, options.excludeRawTransactionHash ?? null],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  }

  async refuelAuthorizationExposureSince(cutoffMs: number): Promise<bigint> {
    const result = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(max_sponsor_exposure_tinybar), 0)::text AS total
       FROM refuel402_product_refuel_authorizations
       WHERE updated_at >= $1 AND attempt_count > 0`,
      [cutoffMs],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  }

  async recordDestinationActivation(input: {
    journeyId: string;
    transactionId: string;
    amountTinybar: string;
    status: string;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'destination_activation_funded'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      if (journey.state !== "ready") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `destination activation cannot fund from ${journey.state}`);
      }
      await this.event(client, input.journeyId, "destination_activation_funded", input);
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordWalletBoundary(input: {
    journeyId: string;
    kind: "origin_approval" | "bridge";
    /**
     * The account the route recovered from the owner's SourceLegConsent.
     * Re-checked against the locked row: the route verifies against a pre-lock
     * read, so trusting only that would trust a snapshot another transaction
     * could have moved underneath it.
     */
    consentedAccount?: Address;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (input.consentedAccount && getAddress(journey.account) !== getAddress(input.consentedAccount)) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "source leg consent does not recover to the owner of the locked journey",
        );
      }
      const eventType = `${input.kind}_wallet_boundary`;
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = $2 ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId, eventType],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      if (!["ready", "bridge_ready"].includes(journey.state)) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `wallet boundary cannot be recorded from ${journey.state}`);
      }
      await this.event(client, input.journeyId, eventType, {
        kind: input.kind,
        state: "consent_requested",
        automaticReplay: "forbidden_without_authoritative_transaction_hash",
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordBridgeSubmission(input: {
    journeyId: string;
    sourceTransactionHash: Hex;
    destinationBalanceBefore: string;
    hbarBalanceBefore: string;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'bridge_submitted'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      if (prior.rows[0]) {
        const record = prior.rows[0].record;
        if (
          String(record.sourceTransactionHash).toLowerCase() !== input.sourceTransactionHash.toLowerCase() ||
          String(record.destinationBalanceBefore) !== input.destinationBalanceBefore ||
          String(record.hbarBalanceBefore) !== input.hbarBalanceBefore
        ) throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "bridge submission differs from the stored journey submission");
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      if (!["ready", "bridge_ready"].includes(journey.state)) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `bridge cannot be submitted from ${journey.state}`);
      }
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'bridge_pending', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await this.event(client, input.journeyId, "bridge_submitted", {
        sourceTransactionHash: input.sourceTransactionHash,
        destinationBalanceBefore: input.destinationBalanceBefore,
        hbarBalanceBefore: input.hbarBalanceBefore,
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordBridgeArrival(input: {
    journeyId: string;
    sourceTransactionHash: Hex;
    destinationTransactionId?: string | null;
    destinationTransactionHash: string | null;
    providerDestinationTransactionHash?: Hex | null;
    destinationBalanceBefore?: string;
    destinationBalanceAfter: string;
    destinationAmountReceived: string;
    expectedRecipient?: Address;
    expectedTokenId?: string | null;
    expectedDestinationAmount?: string;
    minimumDestinationAmount?: string;
    amountCriterion?: "exact" | "minimum" | null;
    consensusTimestamp?: string | null;
    bridgeSubmittedAt?: string;
    provider?: ProviderId;
    providerState?: "pending" | "arrived" | "failed" | "unknown";
    providerStatus: string;
    providerLagging?: boolean;
    routeIdentity?: {
      quoteId: string;
      originChainId: string;
      evidenceSource: string | null;
      routeId: string | null;
      responseHash: string | null;
    };
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockAccountForJourney(client, input.journeyId);
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'bridge_arrived'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      if (prior.rows[0]) {
        if (String(prior.rows[0].record.sourceTransactionHash).toLowerCase() !== input.sourceTransactionHash.toLowerCase()) {
          throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "bridge arrival differs from the stored journey arrival");
        }
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      if (journey.state !== "bridge_pending") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `bridge arrival cannot be recorded from ${journey.state}`);
      }
      await this.assertUnboundDestinationCredit(client, input.journeyId, input.destinationTransactionId);
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'arrival_confirmed', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await this.event(client, input.journeyId, "bridge_arrived", input);
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBridgeOnly(journeyId: string): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      const journey = result.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'bridge_only_completed'
         ORDER BY event_id DESC LIMIT 1`,
        [journeyId],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
      }
      if (journey.state !== "arrival_confirmed") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `bridge-only completion cannot run from ${journey.state}`);
      }
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'completed', updated_at = $2 WHERE journey_id = $1",
        [journeyId, now],
      );
      await this.event(client, journeyId, "bridge_only_completed", {
        state: "completed",
        outcome: "destination_asset_arrived_no_hbar_claim",
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async confirmIntent(input: {
    journeyId: string;
    intentKind: Exclude<ProductIntentKind, "router_execution">;
    ethereumHash: Hex;
    receipt: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const authorization = await client.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM refuel402_product_authorizations
         WHERE journey_id = $1 AND intent_kind = $2 AND state = 'submitted' AND ethereum_hash = $3
         FOR UPDATE`,
        [input.journeyId, input.intentKind, input.ethereumHash],
      );
      if (authorization.rows.length !== 1) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "submitted intent authorization is missing");
      }
      const confirmedAuthorization = authorization.rows[0]!;
      const eventType = `intent_${input.intentKind}_confirmed`;
      const prior = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = $2 ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId, eventType],
      );
      if (prior.rows[0]) {
        if (String(prior.rows[0].record.ethereumHash).toLowerCase() !== input.ethereumHash.toLowerCase()) {
          throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "intent confirmation differs from the stored receipt");
        }
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      const nextState: ProductJourneyState = input.intentKind === "activation"
        ? "bridge_ready"
        : input.intentKind === "permit2_approval"
          ? await permit2ApprovalNextState(client, input.journeyId)
          : "authorizing";
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [input.journeyId, nextState, now],
      );
      await this.event(client, input.journeyId, eventType, {
        authorizationId: confirmedAuthorization.authorization_id,
        ethereumHash: input.ethereumHash,
        receipt: input.receipt,
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPayment(input: {
    journeyId: string;
    idempotencyKey: string;
    /** Effective quote the payment was verified against; names the consented quote. */
    quoteId?: string;
    payment: Omit<ProductPaymentRecord, "journeyId" | "createdAt">;
  }): Promise<ProductPaymentRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const replay = await client.query<PaymentRow & { idempotency_key: string }>(
        `SELECT payment_identity, journey_id, idempotency_key, record
         FROM refuel402_product_payments
         WHERE idempotency_key = $1 OR journey_id = $2 OR payment_identity = $3
         FOR UPDATE`,
        [input.idempotencyKey, input.journeyId, input.payment.paymentIdentity],
      );
      if (replay.rows[0]) {
        const prior = replay.rows[0];
        if (
          prior.journey_id !== input.journeyId ||
          prior.payment_identity !== input.payment.paymentIdentity ||
          prior.idempotency_key !== input.idempotencyKey
        ) {
          throw new ProductLifecycleConflictError("PAYMENT_REPLAY", "payment or idempotency identity is already consumed");
        }
        await client.query("COMMIT");
        return prior.record;
      }
      if (!["arrival_confirmed", "payment_pending"].includes(journey.state)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          `payment cannot be recorded from ${journey.state}`,
        );
      }
      const record: ProductPaymentRecord = {
        ...input.payment,
        journeyId: input.journeyId,
        createdAt: Date.now(),
      };
      await client.query(
        `INSERT INTO refuel402_product_payments
           (payment_identity, journey_id, idempotency_key, proof_hash, record, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          record.paymentIdentity,
          record.journeyId,
          input.idempotencyKey,
          record.proofHash,
          JSON.stringify(record),
          record.createdAt,
        ],
      );
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'payment_settled', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, Date.now()],
      );
      await this.event(client, input.journeyId, "payment_settled", {
        paymentIdentity: record.paymentIdentity,
        settlementReference: record.settlementReference,
        proofHash: record.proofHash,
        // Absent only for direct store callers; consent then resolves positionally.
        ...(input.quoteId ? { quoteId: input.quoteId } : {}),
      });
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ProductLifecycleConflictError("PAYMENT_REPLAY", "payment identity was already consumed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthorization(input: {
    journeyId: string;
    intentKind: ProductIntentKind;
    idempotencyKey: string;
    rawTransactionHash?: Hex | null;
    authorization: PolicyRpcAuthorization;
  }): Promise<ProductAuthorizationRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journeyResult = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const journey = journeyResult.rows[0];
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (journey.mode !== input.authorization.mode || getAddress(journey.account) !== getAddress(input.authorization.account)) {
        throw new ProductLifecycleConflictError("AUTHORIZATION_REPLAY", "authorization journey identity mismatch");
      }
      // A live pre-authorization and the manual destination path must never be
      // able to spend the same arrival. The executor locks only the refuel row and
      // this locks only the journey row, so without taking BOTH here the two
      // transactions do not exclude each other and a background execution can land
      // while the owner is walking the manual legs. Only the destination legs are
      // fenced: `activation` is the pre-bridge source leg and is unaffected.
      if (input.intentKind !== "activation") {
        const liveRefuel = await client.query<{ state: string }>(
          "SELECT state FROM refuel402_product_refuel_authorizations WHERE journey_id = $1 FOR UPDATE",
          [input.journeyId],
        );
        const contended = liveRefuel.rows[0]?.state;
        if (contended && ["recorded", "executing", "retry_scheduled", "unknown"].includes(contended)) {
          throw new ProductLifecycleConflictError(
            "JOURNEY_STATE_CONFLICT",
            "this journey has a live pre-authorized refuel; it must finish, expire, or be released before a manual destination leg can be authorized",
          );
        }
      }
      const prePayment = input.intentKind === "activation" || input.intentKind === "permit2_approval";
      const allowedStates: ProductJourneyState[] = input.intentKind === "activation"
        ? ["ready", "bridge_ready", "authorizing"]
        : input.intentKind === "permit2_approval"
          // Both positions are legitimate: pre-bridge as one-time setup while the
          // wallet is already on Hedera, or post-arrival as the manual leg. Where
          // it LEAVES the journey is decided by durable bridge evidence — see
          // permit2ApprovalNextState — not by the intent kind.
          ? ["ready", "bridge_ready", "arrival_confirmed", "payment_pending", "authorizing"]
          : prePayment
            ? ["payment_pending", "payment_settled", "authorizing"]
            : ["payment_settled", "authorizing"];
      if (!allowedStates.includes(journey.state)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          `${input.intentKind} cannot be authorized from ${journey.state}`,
        );
      }
      const replay = await client.query<AuthorizationRow & { idempotency_key: string }>(
        `SELECT * FROM refuel402_product_authorizations
         WHERE (journey_id = $1 AND intent_kind = $2 AND idempotency_key = $3)
            OR ($4::text IS NOT NULL AND raw_transaction_hash = $4)
         FOR UPDATE`,
        [input.journeyId, input.intentKind, input.idempotencyKey, input.rawTransactionHash ?? null],
      );
      if (replay.rows[0]) {
        const prior = replay.rows[0];
        if (
          prior.journey_id !== input.journeyId ||
          prior.intent_kind !== input.intentKind ||
          prior.idempotency_key !== input.idempotencyKey ||
          (!!input.rawTransactionHash && prior.raw_transaction_hash !== input.rawTransactionHash)
        ) {
          throw new ProductLifecycleConflictError(
            "AUTHORIZATION_REPLAY",
            "authorization hash or idempotency identity is already consumed",
          );
        }
        await client.query("COMMIT");
        return authorizationFromRow(prior);
      }
      const now = Date.now();
      // A refresh-retry mints a new idempotency key (authorize-<kind>-r<n>), so
      // the unique replay guard does not collapse it onto the prior attempt and
      // every superseded reservation would keep holding its full allowance
      // against the daily cap. Nothing was ever broadcast from a pending row, so
      // retire it exactly as the expiry sweep does.
      const superseded = await client.query<{ authorization_id: string }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'expired', updated_at = $3
         WHERE journey_id = $1 AND intent_kind = $2
           AND state = 'pending' AND expires_at > $4
         RETURNING authorization_id`,
        [input.journeyId, input.intentKind, now, Math.floor(now / 1000)],
      );
      for (const row of superseded.rows) {
        await this.event(client, input.journeyId, "authorization_expired", {
          authorizationId: row.authorization_id,
          reason: "authorization superseded by a newer authorization for the same intent; nothing was broadcast",
        });
      }
      const authorization = {
        ...input.authorization,
        id: input.authorization.id || randomUUID(),
      };
      await client.query(
        `INSERT INTO refuel402_product_authorizations
           (authorization_id, journey_id, intent_kind, idempotency_key, raw_transaction_hash,
            mode, expires_at, state, ethereum_hash, record, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, $8::jsonb, $9, $9)`,
        [
          authorization.id,
          input.journeyId,
          input.intentKind,
          input.idempotencyKey,
          input.rawTransactionHash ?? null,
          authorization.mode,
          authorization.expiresAt,
          JSON.stringify(serializeAuthorization(authorization)),
          now,
        ],
      );
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'authorizing', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await this.event(client, input.journeyId, "authorization_created", {
        authorizationId: authorization.id,
        intentKind: input.intentKind,
        rawTransactionHash: input.rawTransactionHash ?? null,
      });
      await client.query("COMMIT");
      return {
        ...authorization,
        journeyId: input.journeyId,
        intentKind: input.intentKind,
        rawTransactionHash: input.rawTransactionHash ?? null,
        state: "pending",
        ethereumHash: null,
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ProductLifecycleConflictError("AUTHORIZATION_REPLAY", "authorization identity was already consumed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async consume(
    rawTransactionHash: Hex,
    candidate: PolicyRpcTransactionCandidate,
  ): Promise<PolicyRpcAuthorization | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const nowSec = Math.floor(Date.now() / 1000);
      const now = Date.now();
      const matches = await client.query<AuthorizationRow>(
        `SELECT * FROM refuel402_product_authorizations
         WHERE state = 'pending'
           AND expires_at > $1
           AND mode = $2
           AND lower(record->>'account') = lower($3)
           AND (record->>'chainId')::bigint = $4
           AND (record->>'nonce')::bigint = $5
           AND lower(record->>'to') = lower($6)
           AND lower(record->>'dataHash') = lower($7)
           AND (record->>'value')::numeric = $8::numeric
           AND (record->>'gasLimitMaximum')::numeric >= $9::numeric
           AND (raw_transaction_hash IS NULL OR raw_transaction_hash = $10)
         FOR UPDATE`,
        [
          nowSec,
          candidate.mode,
          candidate.account,
          candidate.chainId,
          candidate.nonce,
          candidate.to,
          candidate.dataHash,
          candidate.value.toString(),
          candidate.gasLimit.toString(),
          rawTransactionHash,
        ],
      );
      if (matches.rows.length !== 1) {
        await client.query("COMMIT");
        return null;
      }
      const selected = matches.rows[0]!;
      const consumed = await client.query<AuthorizationRow>(
        `UPDATE refuel402_product_authorizations
         SET state = 'consumed', raw_transaction_hash = $2, updated_at = $3
         WHERE authorization_id = $1 AND state = 'pending'
         RETURNING *`,
        [selected.authorization_id, rawTransactionHash, now],
      );
      const row = consumed.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const submissionId = randomUUID();
      await client.query(
        `INSERT INTO refuel402_product_submissions
           (submission_id, authorization_id, journey_id, raw_transaction_hash, state,
            ethereum_hash, reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'consumed', NULL, NULL, $5, $5)`,
        [submissionId, row.authorization_id, row.journey_id, rawTransactionHash, now],
      );
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'submitting', updated_at = $2 WHERE journey_id = $1",
        [row.journey_id, now],
      );
      await this.event(client, row.journey_id, "authorization_consumed", {
        authorizationId: row.authorization_id,
        submissionId,
        rawTransactionHash,
      });
      await client.query("COMMIT");
      return deserializeAuthorization(row.record);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") return null;
      throw error;
    } finally {
      client.release();
    }
  }

  async markSubmitted(authorizationId: string, ethereumHash: Hex): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const result = await client.query<{ journey_id: string; intent_kind: ProductIntentKind }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'submitted', ethereum_hash = $2, updated_at = $3
         WHERE authorization_id = $1 AND state = 'consumed'
         RETURNING journey_id, intent_kind`,
        [authorizationId, ethereumHash, now],
      );
      if (!result.rows[0]) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "authorization is not in the consumed submission state",
        );
      }
      const submission = await client.query<{ submission_id: string }>(
        `UPDATE refuel402_product_submissions
         SET state = 'submitted', ethereum_hash = $2, reason = NULL, updated_at = $3
         WHERE authorization_id = $1 AND state = 'consumed'
         RETURNING submission_id`,
        [authorizationId, ethereumHash, now],
      );
      if (!submission.rows[0]) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "durable submission attempt is missing or already terminal",
        );
      }
      const nextJourneyState: ProductJourneyState = result.rows[0].intent_kind === "activation"
        ? "activation_pending"
        : result.rows[0].intent_kind === "permit2_approval"
          ? await permit2ApprovalNextState(client, result.rows[0].journey_id)
          : result.rows[0].intent_kind === "router_execution"
            ? "execution_pending"
            : "authorizing";
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [result.rows[0].journey_id, nextJourneyState, now],
      );
      await this.event(client, result.rows[0].journey_id, "authorization_submitted", {
        authorizationId,
        submissionId: submission.rows[0].submission_id,
        ethereumHash,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRejected(authorizationId: string, reason: string): Promise<void> {
    await this.markTerminalAuthorization(authorizationId, "rejected", "authorizing", reason);
  }

  async markUnknown(authorizationId: string, reason: string): Promise<void> {
    await this.markTerminalAuthorization(authorizationId, "unknown", "review", reason);
  }

  private async markTerminalAuthorization(
    authorizationId: string,
    state: "rejected" | "unknown",
    journeyState: ProductJourneyState,
    reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const result = await client.query<{ journey_id: string }>(
        `UPDATE refuel402_product_authorizations
         SET state = $2, updated_at = $3
         WHERE authorization_id = $1 AND state = 'consumed'
         RETURNING journey_id`,
        [authorizationId, state, now],
      );
      if (!result.rows[0]) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "authorization is not in the consumed submission state",
        );
      }
      const submission = await client.query<{ submission_id: string }>(
        `UPDATE refuel402_product_submissions
         SET state = $2, reason = $3, updated_at = $4
         WHERE authorization_id = $1 AND state = 'consumed'
         RETURNING submission_id`,
        [authorizationId, state, reason, now],
      );
      if (!submission.rows[0]) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "durable submission attempt is missing or already terminal",
        );
      }
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [result.rows[0].journey_id, journeyState, now],
      );
      await this.event(client, result.rows[0].journey_id, `authorization_${state}`, {
        authorizationId,
        submissionId: submission.rows[0].submission_id,
        reason,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordReconciliation(input: {
    journeyId: string;
    ethereumHash: Hex;
    receipt: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      const row = journey.rows[0];
      if (!row) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (row.state === "completed") {
        const prior = await client.query<{ record: { ethereumHash?: string; receipt?: Record<string, unknown> } }>(
          `SELECT record FROM refuel402_product_events
           WHERE journey_id = $1 AND event_type = 'journey_reconciled'
           ORDER BY event_id DESC LIMIT 1`,
          [input.journeyId],
        );
        const record = prior.rows[0]?.record;
        if (
          !record ||
          record.ethereumHash?.toLowerCase() !== input.ethereumHash.toLowerCase() ||
          canonicalJson(record.receipt) !== canonicalJson(input.receipt)
        ) {
          throw new ProductLifecycleConflictError(
            "IDEMPOTENCY_CONFLICT",
            "completed journey reconciliation identity differs from the stored receipt",
          );
        }
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      if (row.state !== "execution_pending") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `reconciliation cannot complete from ${row.state}`);
      }
      const submission = await client.query<{ submission_id: string }>(
        `SELECT submission.submission_id
         FROM refuel402_product_submissions submission
         JOIN refuel402_product_authorizations auth
           ON auth.authorization_id = submission.authorization_id
         WHERE submission.journey_id = $1
           AND submission.state = 'submitted'
           AND submission.ethereum_hash = $2
           AND auth.intent_kind = 'router_execution'
         FOR UPDATE OF submission`,
        [input.journeyId, input.ethereumHash],
      );
      if (submission.rows.length !== 1) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "authoritative submitted transaction is missing");
      }
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'completed', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await this.event(client, input.journeyId, "journey_reconciled", {
        submissionId: submission.rows[0]!.submission_id,
        ethereumHash: input.ethereumHash,
        receipt: input.receipt,
        reconciliation: "complete",
      });
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * consume() requires expires_at > now, so a consumed row is only truly unknown
   * once expiry plus Hedera's 180s transaction validity has passed; a fresher
   * consumed row may be an in-flight submission on another replica.
   * journeyId scopes the promotion to one journey; null sweeps every journey.
   */
  private async promoteGraceExpiredConsumed(
    client: PoolClient,
    nowSec: number,
    now: number,
    journeyId: string | null,
  ): Promise<Array<{ authorization_id: string; journey_id: string }>> {
    const unknown = await client.query<{ authorization_id: string; journey_id: string }>(
      `UPDATE refuel402_product_authorizations
       SET state = 'unknown', updated_at = $2
       WHERE state = 'consumed' AND expires_at + 300 <= $1
         AND ($3::text IS NULL OR journey_id = $3)
       RETURNING authorization_id, journey_id`,
      [nowSec, now, journeyId],
    );
    if (unknown.rows.length > 0) {
      await client.query(
        `UPDATE refuel402_product_submissions
         SET state = 'unknown',
             reason = 'restart found a consumed authorization without a terminal submission result',
             updated_at = $2
         WHERE authorization_id = ANY($1::text[]) AND state = 'consumed'`,
        [unknown.rows.map((row) => row.authorization_id), now],
      );
    }
    for (const row of unknown.rows) {
      await this.event(client, row.journey_id, "restart_unknown_submission", {
        authorizationId: row.authorization_id,
        reason: "authorization was consumed before restart without a submitted result; do not retry blindly",
      });
    }
    return unknown.rows;
  }

  /**
   * Furthest durable checkpoint a journey may be reverted or released to.
   * Confirmed activation/approval intents are on-chain work that must not be
   * re-requested, so they rank above the bridge/arrival events that precede them.
   */
  private async durableCheckpoint(
    client: PoolClient,
    journeyId: string,
  ): Promise<{ target: ProductJourneyState; basis: string[] }> {
    const durable = await client.query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM refuel402_product_events
       WHERE journey_id = $1 AND event_type IN (
         'payment_settled', 'intent_permit2_approval_confirmed', 'bridge_arrived',
         'bridge_submitted', 'intent_activation_confirmed', 'destination_activation_funded')`,
      [journeyId],
    );
    const kinds = new Set(durable.rows.map((row) => row.event_type));
    // A confirmed approval only means `payment_pending` once the bridge has
    // actually happened; pre-bridge it just means the allowance is set.
    const bridgedAlready = kinds.has("bridge_arrived") || kinds.has("bridge_submitted");
    const target: ProductJourneyState = kinds.has("payment_settled")
      ? "payment_settled"
      : (kinds.has("intent_permit2_approval_confirmed") && bridgedAlready)
        ? "payment_pending"
        : kinds.has("bridge_arrived")
          ? "arrival_confirmed"
          : kinds.has("bridge_submitted")
            ? "bridge_pending"
            : kinds.has("intent_activation_confirmed")
              ? "bridge_ready"
              // destination_activation_funded is sponsor-side funding only; it
              // leaves the journey at 'ready' and is recorded as basis evidence.
              : "ready";
    return { target, basis: [...kinds].sort() };
  }

  /**
   * Runtime counterpart to recoverInterrupted's global sweep, scoped to one
   * journey so a crash between consume() and markSubmitted is releasable without
   * waiting for the next process start. Rows still inside the grace window are
   * left alone: they may be in flight on another replica.
   */
  async promoteExpiredConsumedSubmissions(
    journeyId: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): Promise<{ promoted: string[]; nextGraceAtSec: number | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      if (!journey.rows[0]) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const promoted = await this.promoteGraceExpiredConsumed(client, nowSec, now, journeyId);
      if (promoted.length > 0) {
        await client.query(
          "UPDATE refuel402_product_journeys SET state = 'review', updated_at = $2 WHERE journey_id = $1",
          [journeyId, now],
        );
      }
      const remaining = await client.query<{ next_grace: string | null }>(
        `SELECT MIN(expires_at + 300)::text AS next_grace
         FROM refuel402_product_authorizations
         WHERE journey_id = $1 AND state = 'consumed'`,
        [journeyId],
      );
      await client.query("COMMIT");
      const nextGrace = remaining.rows[0]?.next_grace;
      return {
        promoted: promoted.map((row) => row.authorization_id),
        nextGraceAtSec: nextGrace === null || nextGrace === undefined ? null : Number(nextGrace),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverInterrupted(nowSec = Math.floor(Date.now() / 1000)): Promise<{
    expiredAuthorizations: number;
    unknownAuthorizations: number;
    reviewJourneys: number;
    revertedJourneys: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const expired = await client.query<{ authorization_id: string; journey_id: string }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'expired', updated_at = $2
         WHERE state = 'pending' AND expires_at <= $1
         RETURNING authorization_id, journey_id`,
        [nowSec, now],
      );
      for (const row of expired.rows) {
        await this.event(client, row.journey_id, "authorization_expired", {
          authorizationId: row.authorization_id,
          reason: "authorization expired before one-time consumption",
        });
      }
      const unknown = await this.promoteGraceExpiredConsumed(client, nowSec, now, null);
      // Only unknown-consumed evidence produces review; expired-pending
      // authorizations were never broadcast and are replay-safe by construction.
      const reviewJourneyIds = [...new Set(unknown.map((row) => row.journey_id))];
      if (reviewJourneyIds.length > 0) {
        await client.query(
          `UPDATE refuel402_product_journeys
           SET state = 'review', updated_at = $2
           WHERE journey_id = ANY($1::text[])`,
          [reviewJourneyIds, now],
        );
      }
      const revertCandidates = [...new Set(expired.rows.map((row) => row.journey_id))]
        .filter((journeyId) => !reviewJourneyIds.includes(journeyId));
      let revertedJourneys = 0;
      for (const journeyId of revertCandidates) {
        const journey = await client.query<{ state: ProductJourneyState }>(
          "SELECT state FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
          [journeyId],
        );
        if (journey.rows[0]?.state !== "authorizing") continue;
        // A surviving 'pending' row is genuinely consumable: the same transaction
        // already expired every stale one, so reverting behind it would reopen
        // the state-machine bypass. The journey reverts on a later sweep instead.
        const live = await client.query(
          `SELECT 1 FROM refuel402_product_authorizations
           WHERE journey_id = $1 AND state IN ('unknown', 'consumed', 'pending') LIMIT 1`,
          [journeyId],
        );
        if (live.rows[0]) continue;
        const { target } = await this.durableCheckpoint(client, journeyId);
        await client.query(
          "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
          [journeyId, target, now],
        );
        await this.event(client, journeyId, "journey_reverted", {
          from: "authorizing",
          to: target,
          reason: "authorization expired while still pending; nothing was broadcast, so the durable-event state is authoritative",
        });
        revertedJourneys += 1;
      }
      await client.query("COMMIT");
      return {
        expiredAuthorizations: expired.rowCount ?? 0,
        unknownAuthorizations: unknown.length,
        reviewJourneys: reviewJourneyIds.length,
        revertedJourneys,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveSubmissionAsSubmitted(input: {
    authorizationId: string;
    ethereumHash: Hex;
    evidence: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const existing = await client.query<AuthorizationRow>(
        "SELECT * FROM refuel402_product_authorizations WHERE authorization_id = $1",
        [input.authorizationId],
      );
      const journeyId = existing.rows[0]?.journey_id;
      if (!journeyId) throw new ProductLifecycleConflictError("AUTHORIZATION_REPLAY", "authorization does not exist");
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      // One mined transaction can back exactly one authorization: a second claim
      // on the same hash would make confirmIntent/recordReconciliation
      // permanently ambiguous, so refuse it here instead.
      const duplicate = await client.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM refuel402_product_authorizations
         WHERE journey_id = $1 AND intent_kind = $2 AND state = 'submitted'
           AND lower(ethereum_hash) = lower($3) AND authorization_id <> $4
         LIMIT 1`,
        [journeyId, existing.rows[0]!.intent_kind, input.ethereumHash, input.authorizationId],
      );
      if (duplicate.rows[0]) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "another authorization on this journey already holds that submitted transaction hash",
        );
      }
      const updated = await client.query<{ intent_kind: ProductIntentKind }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'submitted', ethereum_hash = $2, updated_at = $3
         WHERE authorization_id = $1 AND state = 'unknown' AND raw_transaction_hash IS NOT NULL
         RETURNING intent_kind`,
        [input.authorizationId, input.ethereumHash, now],
      );
      if (!updated.rows[0]) {
        const current = await client.query<AuthorizationRow>(
          "SELECT * FROM refuel402_product_authorizations WHERE authorization_id = $1",
          [input.authorizationId],
        );
        const row = current.rows[0];
        if (row?.state === "submitted" && row.ethereum_hash?.toLowerCase() === input.ethereumHash.toLowerCase()) {
          await client.query("COMMIT");
          return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
        }
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "authorization is not reconcilable as submitted",
        );
      }
      const submission = await client.query<{ submission_id: string }>(
        `UPDATE refuel402_product_submissions
         SET state = 'submitted', ethereum_hash = $2, reason = NULL, updated_at = $3
         WHERE authorization_id = $1 AND state = 'unknown'
         RETURNING submission_id`,
        [input.authorizationId, input.ethereumHash, now],
      );
      if (!submission.rows[0]) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "durable submission attempt is missing or already terminal",
        );
      }
      if (journey.rows[0]?.state === "review") {
        const unresolved = await client.query(
          `SELECT 1 FROM refuel402_product_authorizations
           WHERE journey_id = $1 AND state IN ('unknown', 'consumed')
           UNION ALL
           SELECT 1 FROM refuel402_product_submissions
           WHERE journey_id = $1 AND state IN ('unknown', 'consumed')
           LIMIT 1`,
          [journeyId],
        );
        if (!unresolved.rows[0]) {
          const nextState: ProductJourneyState = updated.rows[0].intent_kind === "activation"
            ? "activation_pending"
            : updated.rows[0].intent_kind === "permit2_approval"
              ? await permit2ApprovalNextState(client, journeyId)
              : updated.rows[0].intent_kind === "router_execution"
                ? "execution_pending"
                : "authorizing";
          await client.query(
            "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
            [journeyId, nextState, now],
          );
        }
      }
      await this.event(client, journeyId, "submission_reconciled_submitted", {
        authorizationId: input.authorizationId,
        submissionId: submission.rows[0].submission_id,
        ethereumHash: input.ethereumHash,
        evidence: input.evidence,
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveSubmissionAsRejected(input: {
    authorizationId: string;
    reason: string;
    evidence: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const existing = await client.query<AuthorizationRow>(
        "SELECT * FROM refuel402_product_authorizations WHERE authorization_id = $1",
        [input.authorizationId],
      );
      const journeyId = existing.rows[0]?.journey_id;
      if (!journeyId) throw new ProductLifecycleConflictError("AUTHORIZATION_REPLAY", "authorization does not exist");
      await client.query(
        "SELECT 1 FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      // A mined-and-reverted call still burned sponsor-paid gas (router_execution
      // reverting on slippage is the likeliest product failure), so the row must
      // keep counting against the daily cap. Every other rejection reason -
      // pre-broadcast refusal, mode/raw mismatch, expired_never_broadcast,
      // nonce_occupied_by_different_transaction - spent nothing.
      const sponsorSpent = input.reason === "mined_reverted";
      const updated = await client.query<{ authorization_id: string }>(
        `UPDATE refuel402_product_authorizations
         SET state = 'rejected',
             updated_at = $2,
             record = CASE WHEN $3 THEN jsonb_set(record, '{sponsorSpent}', 'true'::jsonb) ELSE record END
         WHERE authorization_id = $1 AND state IN ('unknown', 'expired')
         RETURNING authorization_id`,
        [input.authorizationId, now, sponsorSpent],
      );
      if (!updated.rows[0]) {
        if (existing.rows[0]?.state === "rejected") {
          await client.query("COMMIT");
          return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
        }
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "authorization is not reconcilable as rejected",
        );
      }
      await client.query(
        `UPDATE refuel402_product_submissions
         SET state = 'rejected', reason = $2, updated_at = $3
         WHERE authorization_id = $1 AND state IN ('unknown', 'consumed')`,
        [input.authorizationId, input.reason, now],
      );
      await this.event(client, journeyId, "submission_reconciled_rejected", {
        authorizationId: input.authorizationId,
        reason: input.reason,
        evidence: input.evidence,
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseReviewJourney(
    journeyId: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      if (!journey.rows[0]) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (journey.rows[0].state !== "review") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `review release cannot run from ${journey.rows[0].state}`);
      }
      // No expiry sweep precedes this call, so 'pending' only blocks release
      // while it is still consumable; a stale unswept row must not wedge review.
      const unresolved = await client.query(
        `SELECT 1 FROM refuel402_product_authorizations
         WHERE journey_id = $1
           AND (state IN ('unknown', 'consumed') OR (state = 'pending' AND expires_at > $2))
         UNION ALL
         SELECT 1 FROM refuel402_product_submissions
         WHERE journey_id = $1 AND state IN ('unknown', 'consumed')
         LIMIT 1`,
        [journeyId, nowSec],
      );
      if (unresolved.rows[0]) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "unresolved unknown, consumed, or still-live authorization evidence exists; reconcile it first",
        );
      }
      const { target, basis } = await this.durableCheckpoint(client, journeyId);
      const now = Date.now();
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [journeyId, target, now],
      );
      await this.event(client, journeyId, "review_released", {
        targetState: target,
        basis,
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retire a journey that never produced durable external evidence.
   *
   * Every eligibility check is re-run inside the transaction against the locked
   * row, because the caller's read is a TOCTOU: a bridge submission landing
   * between the pre-check and this call must win. Nothing is deleted — the
   * journey, its quote and its whole event log stay readable by id forever.
   */
  async abandonJourney(
    journeyId: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [journeyId],
      );
      const row = journey.rows[0];
      if (!row) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      if (row.state === "abandoned") {
        await client.query("COMMIT");
        return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
      }
      if (!ABANDONABLE_STATES.includes(row.state as ProductJourneyState)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          `abandon cannot run from ${row.state}`,
        );
      }
      // Every check re-runs here against the locked row rather than trusting the
      // caller's read: a bridge submission landing between the two must win.
      const events = await client.query<{ event_type: string }>(
        "SELECT DISTINCT event_type FROM refuel402_product_events WHERE journey_id = $1",
        [journeyId],
      );
      const types = new Set(events.rows.map((row) => row.event_type));
      const blocking = [
        ...(ABANDON_BLOCKING_EVENTS as readonly string[]).filter((type) => types.has(type)),
        ...[...types].filter((type) => INTENT_CONFIRMED_EVENT.test(type)),
      ];
      if (blocking.length > 0) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          `journey reached the outside world (${blocking.sort().join(", ")}); it cannot be abandoned`,
        );
      }
      if (unresolvedActivation(types)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "a destination activation was started and its result was never recorded; reconcile it before abandoning",
        );
      }
      const unresolved = await client.query(
        `SELECT 1 FROM refuel402_product_authorizations
         WHERE journey_id = $1
           AND (state IN ('unknown', 'consumed', 'submitted') OR (state = 'pending' AND expires_at > $2))
         UNION ALL
         SELECT 1 FROM refuel402_product_submissions WHERE journey_id = $1
         LIMIT 1`,
        [journeyId, nowSec],
      );
      if (unresolved.rows[0]) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "authorization or submission evidence is unresolved or still live; reconcile it first",
        );
      }
      const payment = await client.query(
        "SELECT 1 FROM refuel402_product_payments WHERE journey_id = $1 LIMIT 1",
        [journeyId],
      );
      if (payment.rows[0]) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "a payment record exists for this journey; it cannot be abandoned",
        );
      }
      await client.query(
        "UPDATE refuel402_product_journeys SET state = $2, updated_at = $3 WHERE journey_id = $1",
        [journeyId, "abandoned", Date.now()],
      );
      await this.event(client, journeyId, "journey_abandoned", {
        from: row.state,
        // Sponsor-side activation funding is recorded rather than treated as a
        // blocker: it activates the ACCOUNT, not the journey, so it is already
        // spent and already reusable by any later journey. Stamping it keeps the
        // sunk cost auditable against an abandoned record.
        sponsorActivationFunded: types.has("destination_activation_funded"),
        events: [...types].sort(),
      });
      await client.query("COMMIT");
      return this.getJourney(journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Per-account serialization point for arrival binding. Any pre-transaction
   * bound-credit read is a TOCTOU: two concurrent adoptions, or an adoption
   * racing the GET /bridge arrival recorder, would otherwise bind one
   * destination credit to two journeys of the same account.
   */
  private async lockAccountForJourney(client: PoolClient, journeyId: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(account))
       FROM refuel402_product_journeys WHERE journey_id = $1`,
      [journeyId],
    );
  }

  private async assertUnboundDestinationCredit(
    client: PoolClient,
    journeyId: string,
    destinationTransactionId: string | null | undefined,
  ): Promise<void> {
    if (!destinationTransactionId) return;
    const bound = await client.query(
      `SELECT 1 FROM refuel402_product_events event
       JOIN refuel402_product_journeys journey ON journey.journey_id = event.journey_id
       WHERE event.event_type = 'bridge_arrived'
         AND journey.account = (SELECT account FROM refuel402_product_journeys WHERE journey_id = $1)
         AND event.record->>'destinationTransactionId' = $2
         AND event.journey_id <> $1
       LIMIT 1`,
      [journeyId, destinationTransactionId],
    );
    if (bound.rows[0]) {
      throw new ProductLifecycleConflictError(
        "EVIDENCE_CONFLICT",
        "destination credit is already bound to another journey for this account",
      );
    }
  }

  /** destinationTransactionIds already bound by any bridge_arrived event for this account. */
  async boundArrivalTransactionIds(account: Address): Promise<Set<string>> {
    const result = await this.pool.query<{ tid: string }>(
      `SELECT event.record->>'destinationTransactionId' AS tid
       FROM refuel402_product_events event
       JOIN refuel402_product_journeys journey ON journey.journey_id = event.journey_id
       WHERE event.event_type = 'bridge_arrived'
         AND journey.account = $1
         AND event.record->>'destinationTransactionId' IS NOT NULL`,
      [getAddress(account).toLowerCase()],
    );
    return new Set(result.rows.map((row) => row.tid));
  }

  async adoptBridgeSubmission(input: {
    journeyId: string;
    sourceTransactionHash: Hex;
    destinationBalanceBefore: string;
    hbarBalanceBefore: string;
    credit: {
      transactionId: string;
      transactionHash: string;
      consensusTimestamp: string;
      tokenId: string;
      accountId: string;
      amount: string;
    };
    amountCriterion: "exact" | "minimum" | null;
    provider: ProviderId;
    providerState: "pending" | "arrived" | "failed" | "unknown";
    providerStatus: string;
    evidence: Record<string, unknown>;
  }): Promise<ProductJourneyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockAccountForJourney(client, input.journeyId);
      const journey = await client.query<JourneyRow>(
        "SELECT * FROM refuel402_product_journeys WHERE journey_id = $1 FOR UPDATE",
        [input.journeyId],
      );
      if (!journey.rows[0]) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const adopted = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'bridge_submission_adopted'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      if (adopted.rows[0]) {
        if (String(adopted.rows[0].record.sourceTransactionHash).toLowerCase() !== input.sourceTransactionHash.toLowerCase()) {
          throw new ProductLifecycleConflictError("IDEMPOTENCY_CONFLICT", "a different source transaction hash was already adopted");
        }
        await client.query("COMMIT");
        return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
      }
      const submitted = await client.query<EventRow>(
        `SELECT event_id, event_type, record, created_at FROM refuel402_product_events
         WHERE journey_id = $1 AND event_type = 'bridge_submitted'
         ORDER BY event_id DESC LIMIT 1`,
        [input.journeyId],
      );
      if (submitted.rows[0]) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          "a bridge submission hash is already durable; poll GET /v1/product/journeys/:id/bridge instead",
        );
      }
      if (!["ready", "bridge_ready"].includes(journey.rows[0].state)) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `bridge adoption cannot run from ${journey.rows[0].state}`);
      }
      await this.assertUnboundDestinationCredit(client, input.journeyId, input.credit.transactionId);
      const now = Date.now();
      await this.event(client, input.journeyId, "bridge_submission_adopted", {
        sourceTransactionHash: input.sourceTransactionHash,
        creditTransactionId: input.credit.transactionId,
        creditConsensusTimestamp: input.credit.consensusTimestamp,
        providerStatus: input.providerStatus,
        userConfirmed: true,
        evidence: input.evidence,
      });
      await this.event(client, input.journeyId, "bridge_submitted", {
        sourceTransactionHash: input.sourceTransactionHash,
        destinationBalanceBefore: input.destinationBalanceBefore,
        hbarBalanceBefore: input.hbarBalanceBefore,
        adopted: true,
      });
      // The adopted credit IS the arrival evidence: the balance-diff heuristic is
      // unsound once unrelated deposits accumulate on the account.
      const balanceAfter = BigInt(input.destinationBalanceBefore) + BigInt(input.credit.amount);
      await this.event(client, input.journeyId, "bridge_arrived", {
        sourceTransactionHash: input.sourceTransactionHash,
        destinationTransactionId: input.credit.transactionId,
        destinationTransactionHash: input.credit.transactionHash,
        destinationBalanceBefore: input.destinationBalanceBefore,
        destinationBalanceAfter: balanceAfter.toString(),
        destinationAmountReceived: input.credit.amount,
        expectedTokenId: input.credit.tokenId,
        amountCriterion: input.amountCriterion,
        consensusTimestamp: input.credit.consensusTimestamp,
        provider: input.provider,
        providerState: input.providerState,
        providerStatus: input.providerStatus,
        adopted: true,
      });
      await client.query(
        "UPDATE refuel402_product_journeys SET state = 'arrival_confirmed', updated_at = $2 WHERE journey_id = $1",
        [input.journeyId, now],
      );
      await client.query("COMMIT");
      return this.getJourney(input.journeyId) as Promise<ProductJourneyRecord>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
