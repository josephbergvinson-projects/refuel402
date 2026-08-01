import express from "express";
import { z } from "zod";
import { getAddress, keccak256, verifyTypedData, type Address, type Hex } from "viem";
import type { Mirror } from "./mirror.js";
import type { PolicyRpcAuthorization } from "./policy-rpc.js";
import { createProductPaymentRequired } from "./product-payment-challenge.js";
import { deriveProductRecovery } from "./product-recovery.js";
import {
  journeyNonce,
  refuelAuthorizationId,
  refuelAuthorizationTypedData,
  refuelRouteHash,
} from "./refuel-authorization-witness.js";
import {
  ProductLifecycleConflictError,
  journeyAbandonable,
  type ProductAuthorizationRecord,
  type ProductIntentKind,
  type ProductJourneyRecord,
  type ProductLifecycleStore,
  type StoredProductQuote,
  type ProductPaymentRecord,
} from "./product-lifecycle-store.js";
import { journeyAbandonTypedData } from "./journey-abandon-witness.js";
import { journeySourceLegTypedData } from "./journey-source-leg-witness.js";
import type { ProductMode } from "./support.js";

const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const intentKinds = [
  "activation",
  "permit2_approval",
  "wrapper_approval",
  "wrapper_execution",
  "router_approval",
  "router_execution",
] as const satisfies readonly ProductIntentKind[];

export type ProductBridgeTracker = {
  submit(journeyId: string, sourceTransactionHash: Hex): Promise<ProductJourneyRecord>;
  status(journeyId: string): Promise<Record<string, unknown>>;
  /** confirmation is the owner's EIP-712 BridgeAdoption signature over the hash. */
  adopt?(journeyId: string, sourceTransactionHash: Hex, confirmation: Hex): Promise<ProductJourneyRecord>;
};

export type SourceBoundaryAbsenceReader = {
  proveNoBroadcast(input: {
    journey: ProductJourneyRecord;
    quote: StoredProductQuote;
  }): Promise<
    | { status: "proven_absent"; evidence: Record<string, unknown> }
    | { status: "unknown"; reason: string; evidence?: Record<string, unknown> }
  >;
};

export type SubmissionEvidenceReader = {
  contractResult(hash: Hex): Promise<Record<string, unknown> | null>;
  account(idOrAlias: string): Promise<{ ethereum_nonce: number } | null>;
  contractResultByNonce(from: Address, nonce: number): Promise<Record<string, unknown> | null>;
};

/** Mirror-backed evidence reader for reconcile-submissions. */
export function mirrorSubmissionEvidence(mirror: Mirror): SubmissionEvidenceReader {
  return {
    contractResult: (hash) => mirror.contractResult(hash) as Promise<Record<string, unknown> | null>,
    account: (idOrAlias) => mirror.account(idOrAlias),
    async contractResultByNonce(from, nonce) {
      // Bounded scan of the account's recent EVM results; null = occupier not
      // observable, which the resolver treats as ambiguous (no writes).
      let url = `${mirror.mirrorBase}/api/v1/contracts/results?from=${from.toLowerCase()}&limit=100&order=desc`;
      for (let page = 0; page < 5 && url; page += 1) {
        const body = await fetch(url)
          .then((response) => response.ok
            ? response.json() as Promise<{ results?: Array<Record<string, unknown>>; links?: { next?: string | null } }>
            : null)
          .catch(() => null);
        if (!body) return null;
        for (const row of body.results ?? []) {
          if (Number(row.nonce) === nonce) return row;
        }
        url = body.links?.next ? `${mirror.mirrorBase}${body.links.next}` : "";
      }
      return null;
    },
  };
}

export type SubmissionResolution =
  | { resolution: "submitted"; reason: string; ethereumHash: Hex; evidence: Record<string, unknown> }
  | { resolution: "rejected"; reason: string; evidence: Record<string, unknown> }
  | { resolution: "ambiguous"; reason: string; evidence: Record<string, unknown> }
  | { resolution: "conflict"; reason: string; evidence: Record<string, unknown> };

function sameEvmAddress(left: unknown, right: Address): boolean {
  try {
    return getAddress(String(left)) === getAddress(right);
  } catch {
    return false;
  }
}

/** keccak of mirror calldata; a missing or unprefixed value hashes as empty. */
function minedCalldataHash(value: unknown): Hex {
  return keccak256(typeof value === "string" && value.startsWith("0x") ? value as Hex : "0x");
}

/** Mirror reports the mined value in tinybar; authorizations carry EVM weibar. */
function minedValueWeibar(result: Record<string, unknown>): bigint | null {
  const raw = result.amount ?? 0;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const text = typeof raw === "number" ? String(Math.trunc(raw)) : raw.trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text) * 10_000_000_000n;
}

function assessMinedResult(
  result: Record<string, unknown>,
  journey: ProductJourneyRecord,
  authorization: ProductAuthorizationRecord,
  fallbackHash: Hex,
): SubmissionResolution {
  const evidence = {
    source: "mirror-contract-result",
    hash: String(result.hash ?? fallbackHash),
    status: String(result.status ?? ""),
    from: String(result.from ?? ""),
    to: String(result.to ?? ""),
    nonce: Number(result.nonce ?? NaN),
    amount: String(result.amount ?? ""),
  };
  if (!sameEvmAddress(result.from, journey.account)) {
    return { resolution: "conflict", reason: "mined sender does not match the journey account", evidence };
  }
  if (!sameEvmAddress(result.to, authorization.to)) {
    return { resolution: "conflict", reason: "mined target does not match the authorization", evidence };
  }
  if (Number(result.nonce) !== authorization.nonce) {
    return { resolution: "conflict", reason: "mined nonce does not match the authorization", evidence };
  }
  if (minedCalldataHash(result.function_parameters) !== authorization.dataHash.toLowerCase()) {
    return { resolution: "conflict", reason: "mined calldata does not match the authorization dataHash", evidence };
  }
  // consume() matched value exactly, so a same-calldata different-value
  // transaction is a different transaction, not this authorization.
  if (minedValueWeibar(result) !== authorization.value) {
    return { resolution: "conflict", reason: "mined value does not match the authorization", evidence };
  }
  const ethereumHash = typeof result.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(result.hash)
    ? result.hash as Hex
    : fallbackHash;
  if (String(result.status) === "0x1") {
    return { resolution: "submitted", reason: "mined_success", ethereumHash, evidence };
  }
  return { resolution: "rejected", reason: "mined_reverted", evidence };
}

/**
 * Resolves one unknown authorization from mirror evidence only: a mined result
 * decides directly; absence is definitive only after the expiry grace window
 * when the account nonce proves the outcome. Never trusts request-body input.
 */
export async function resolveUnknownSubmission(input: {
  journey: ProductJourneyRecord;
  authorization: ProductAuthorizationRecord;
  reader: SubmissionEvidenceReader;
  nowSec?: number;
}): Promise<SubmissionResolution> {
  const { journey, authorization, reader } = input;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (!authorization.rawTransactionHash) {
    return { resolution: "ambiguous", reason: "authorization has no raw transaction hash", evidence: {} };
  }
  const mined = await reader.contractResult(authorization.rawTransactionHash);
  if (mined) return assessMinedResult(mined, journey, authorization, authorization.rawTransactionHash);
  if (nowSec <= authorization.expiresAt + 600) {
    return {
      resolution: "ambiguous",
      reason: "mirror has no result and the post-expiry grace window has not elapsed",
      evidence: { source: "mirror-contract-result", found: false },
    };
  }
  const account = await reader.account(journey.account);
  if (!account) {
    return { resolution: "ambiguous", reason: "mirror account state is unavailable", evidence: { source: "mirror-account", found: false } };
  }
  if (account.ethereum_nonce <= authorization.nonce) {
    return {
      resolution: "rejected",
      reason: "expired_never_broadcast",
      evidence: { source: "mirror-account", ethereumNonce: account.ethereum_nonce, authorizedNonce: authorization.nonce },
    };
  }
  const occupier = await reader.contractResultByNonce(journey.account, authorization.nonce);
  if (!occupier) {
    return {
      resolution: "ambiguous",
      reason: "the consumed account nonce has an unobservable occupying transaction",
      evidence: { source: "mirror-contract-results", ethereumNonce: account.ethereum_nonce },
    };
  }
  // The by-nonce scan may only rescue the case the by-hash endpoint transiently
  // missed: the SAME raw transaction. Another authorization's transaction can
  // carry an identical nonce/target/calldata, and adopting its hash here would
  // mark two authorizations submitted with one hash.
  const occupierMatch = String(occupier.hash ?? "").toLowerCase() === authorization.rawTransactionHash.toLowerCase() &&
    sameEvmAddress(occupier.to, authorization.to) &&
    minedCalldataHash(occupier.function_parameters) === authorization.dataHash.toLowerCase();
  if (occupierMatch) return assessMinedResult(occupier, journey, authorization, authorization.rawTransactionHash);
  return {
    resolution: "rejected",
    reason: "nonce_occupied_by_different_transaction",
    evidence: {
      source: "mirror-contract-results",
      occupierHash: String(occupier.hash ?? ""),
      occupierTo: String(occupier.to ?? ""),
      ethereumNonce: account.ethereum_nonce,
    },
  };
}

export type ProductPaymentVerifier = {
  verify(input: {
    journey: ProductJourneyRecord;
    paymentSignature: string;
  }): Promise<Omit<ProductPaymentRecord, "journeyId" | "createdAt">>;
};

export type ProductReceiptReconciler = {
  reconcile(input: {
    journey: ProductJourneyRecord;
    ethereumHash: Hex;
  }): Promise<Record<string, unknown>>;
};

export type ProductIntentBuilder = {
  build(input: {
    journey: ProductJourneyRecord;
    intentKind: ProductIntentKind;
    request: unknown;
  }): Promise<{
    authorization: PolicyRpcAuthorization;
    transaction: {
      chainId: number;
      from: string;
      to: string;
      data: Hex;
      value: string;
      gas: string;
      nonce: number;
      maxFeePerGas: "0";
      maxPriorityFeePerGas: "0";
    };
  }>;
};

function idempotencyKey(req: express.Request): string | null {
  const value = req.header("idempotency-key");
  return value && idempotencyPattern.test(value) ? value : null;
}

/** getEffectiveQuote keeps the original quote identity; the record carries the live one. */
function effectiveQuoteId(quote: StoredProductQuote): string {
  return typeof quote.record.quoteId === "string" ? quote.record.quoteId : quote.quoteId;
}

function publicJourney(journey: ProductJourneyRecord) {
  return {
    ...journey,
    refuelAuthorization: journey.refuelAuthorization
      ? { ...journey.refuelAuthorization, signature: undefined }
      : null,
    authorizations: journey.authorizations.map((authorization) => ({
      ...authorization,
      value: authorization.value.toString(),
      gasLimitMaximum: authorization.gasLimitMaximum.toString(),
      maxGasAllowanceTinybar: authorization.maxGasAllowanceTinybar.toString(),
    })),
  };
}

function activitySummary(journey: ProductJourneyRecord, quote: StoredProductQuote) {
  const record = quote.record as Record<string, any>;
  const source = record.bridge?.normalized?.sourceAmount ?? null;
  const recovery = deriveProductRecovery(journey, quote);
  const action = recovery.disposition === "terminal"
    ? "view"
    : recovery.disposition === "blocked_unknown_submit_result" ||
        recovery.disposition === "operator_review" ||
        journey.state === "review"
      ? "inspect"
      : "resume";
  return {
    journeyId: journey.id,
    state: journey.state,
    mode: journey.mode,
    routeMode: record.routeMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel",
    assetId: journey.assetId,
    assetSymbol: record.asset?.symbol ?? source?.symbol ?? "Asset",
    sourceAmount: source ? {
      amount: String(source.amount),
      decimals: Number(source.decimals),
      symbol: String(source.symbol),
    } : null,
    minimumRetained: record.amountLedger?.destination?.remainingAtMinimum === undefined
      ? null
      : String(record.amountLedger.destination.remainingAtMinimum),
    destinationDecimals: Number(record.asset?.destination?.decimals ?? 0),
    exactHbarTinybar: record.amountLedger?.hbar?.exactOutputTinybar === undefined
      ? null
      : String(record.amountLedger.hbar.exactOutputTinybar),
    createdAt: journey.createdAt,
    updatedAt: journey.updatedAt,
    action,
    // Server-computed so the drawer never re-derives an eligibility rule that
    // decides whether a record can be retired.
    abandonable: journeyAbandonable(journey),
    recovery: {
      disposition: recovery.disposition,
      status: recovery.status,
      nextAtomicStep: recovery.nextAtomicStep,
      walletActionRequired: recovery.walletActionRequired,
      reason: recovery.reason,
    },
  };
}

/**
 * The most an Activity row can say when its quote or recovery decision cannot be
 * read. Deliberately inert: `inspect` never offers to resume, and `abandonable`
 * false keeps the retire control off a record whose eligibility is unknown.
 */
function degradedActivitySummary(journey: ProductJourneyRecord) {
  return {
    journeyId: journey.id,
    state: journey.state,
    mode: journey.mode,
    routeMode: "bridge_plus_refuel" as const,
    assetSymbol: null,
    sourceAmount: null,
    minimumRetained: null,
    destinationDecimals: 0,
    exactHbarTinybar: null,
    createdAt: journey.createdAt,
    updatedAt: journey.updatedAt,
    action: "inspect" as const,
    abandonable: false,
    degraded: true,
    recovery: null,
  };
}

/** The confirmation every source-leg mutation carries. */
const sourceLegConfirmation = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

/**
 * One gate for every source-leg mutation.
 *
 * Recovers the owner's SourceLegConsent against the journey account and throws
 * before the caller touches anything. `quoteId` defaults to the journey's current
 * quote, so a consent is spent on the quote the journey is actually on; the
 * re-bind passes the replacement quote explicitly because that is the quote the
 * owner was shown and is about to move to.
 *
 * Returns the recovered account so the caller can re-assert it inside its own
 * transaction against the row it locks — this check necessarily runs against a
 * pre-lock read, and trusting that alone would trust a row another transaction
 * could move underneath it.
 */
async function requireSourceLegConsent(
  journey: ProductJourneyRecord,
  confirmation: string,
  quoteId: string = journey.quoteId,
): Promise<Address> {
  const consent = journeySourceLegTypedData({
    journeyId: journey.id,
    quoteId,
    account: journey.account,
    mode: journey.mode,
    originChainId: journey.originChainId,
  });
  const consented = await verifyTypedData({
    ...consent,
    address: journey.account,
    signature: confirmation as Hex,
  }).catch(() => false);
  if (!consented) {
    throw new ProductLifecycleConflictError(
      "EVIDENCE_CONFLICT",
      "source leg consent does not recover to the journey account for this journey, quote, and origin chain",
    );
  }
  return journey.account;
}

function conflictStatus(error: ProductLifecycleConflictError): number {
  switch (error.code) {
    case "QUOTE_NOT_FOUND":
    case "JOURNEY_NOT_FOUND":
      return 404;
    case "STORED_QUOTE_INVALID":
      return 500;
    case "QUOTE_EXPIRED":
    case "QUOTE_NOT_EXECUTABLE":
    case "JOURNEY_STATE_CONFLICT":
    case "QUOTE_ECONOMICS_WORSENED":
      return 409;
    default:
      return 409;
  }
}

type LifecycleErrorContext = {
  journeyId?: string | null;
  quoteId?: string | null;
  intentKind?: string | null;
};

function errorLogContext(res: express.Response, context: LifecycleErrorContext) {
  return {
    requestId: res.locals.requestId ?? null,
    journeyId: context.journeyId ?? null,
    quoteId: context.quoteId ?? null,
    intentKind: context.intentKind ?? null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
  };
}

function sendError(res: express.Response, error: unknown, context: LifecycleErrorContext = {}): void {
  if (error instanceof ProductLifecycleConflictError) {
    if (error.code === "STORED_QUOTE_INVALID") {
      console.error("[product-lifecycle] stored quote rejected", {
        ...errorLogContext(res, context),
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    }
    res.status(conflictStatus(error)).json({
      error: error.code,
      code: error.code,
      message: error.message,
      retriable: false,
      // Structured lifecycle conflicts carry only bounded decision evidence; no
      // stored quote body or credentials cross the HTTP boundary.
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  const detail = error instanceof Error ? error.message : "unknown failure";
  console.error("[product-lifecycle] request failed", {
    ...errorLogContext(res, context),
    name: error instanceof Error ? error.name : "UnknownError",
    message: detail,
  });
  // A Hedera read that failed is not the owner's fault and is not permanent, so
  // it says so. This used to answer every unexpected failure with the same
  // "product lifecycle request failed", which reached the owner verbatim: a step
  // that stopped for a reason the server knew, described in words nobody can act
  // on. Nothing here is written before these calls, so "nothing was sent or
  // spent" is a statement about the code path, not a hope.
  // A revert, not a failed read: the relay answered perfectly well and the HTS
  // token refused because the association has not landed for this account yet.
  // Association is part of the flow, so this is a sequencing state rather than
  // anything the owner has to go and do — and reporting it as an upstream outage
  // sent them to wait out a network problem that did not exist. Only reachable
  // once the bounded propagation retry above has already been exhausted.
  if (/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/i.test(detail)) {
    res.status(409).json({
      error: "DESTINATION_TOKEN_NOT_ASSOCIATED",
      code: "DESTINATION_TOKEN_NOT_ASSOCIATED",
      message: "Nothing was sent or spent: your Hedera account is still being prepared for this token. It finishes on its own — continue in a moment.",
      retriable: true,
    });
    return;
  }
  if (upstreamReadFailure(detail)) {
    res.status(503).json({
      error: "UPSTREAM_READ_UNAVAILABLE",
      code: "UPSTREAM_READ_UNAVAILABLE",
      message: "Nothing was sent or spent: a Hedera network read failed while preparing this step. Try again in a moment.",
      retriable: true,
    });
    return;
  }
  res.status(500).json({
    error: "PRODUCT_LIFECYCLE_ERROR",
    code: "PRODUCT_LIFECYCLE_ERROR",
    message: "Nothing was sent or spent: this step could not be prepared. Try again; if it keeps happening the server log names the cause.",
    retriable: true,
  });
}

/**
 * A failed read of Hedera — the JSON-RPC relay or the mirror — rather than a
 * decision this product made. `Mirror.rpc` prefixes these `rpc <method>:` and the
 * mirror's own failures are named; both are transient and both used to be
 * indistinguishable from a logic error at the surface.
 */
function upstreamReadFailure(message: string): boolean {
  return /^rpc [a-z_]+:/i.test(message) ||
    /mirror|estimateGas|eth_getTransactionCount|429|rate limit|timeout|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}

export function createProductLifecycleRouter(options: {
  store: ProductLifecycleStore;
  destinationActivator?: (journeyId: string) => Promise<unknown>;
  bridgeTracker?: ProductBridgeTracker;
  destinationQuoteRefresher?: (journeyId: string) => Promise<StoredProductQuote>;
  paymentVerifier?: ProductPaymentVerifier;
  intentBuilder?: ProductIntentBuilder;
  receiptReconciler?: ProductReceiptReconciler;
  submissionEvidence?: Partial<Record<ProductMode, SubmissionEvidenceReader>>;
  sourceBoundaryAbsence?: Partial<Record<ProductMode, SourceBoundaryAbsenceReader>>;
}) {
  const router = express.Router();

  // Pure read: GET never mints destination quotes; POST /destination-quote is
  // the only refresh path.
  function arrivalContinuation(journey: ProductJourneyRecord, quote: StoredProductQuote): {
    schema: "refuel402.arrival-continuation.v2";
    ready: boolean;
    nextAction: "destination_wallet_consent" | "refresh_destination_quote" | null;
    error: null;
  } {
    const routeMode = quote.record.routeMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel";
    // A live pre-authorized refuel owns this arrival, exactly as in
    // deriveProductRecovery. This is a SECOND, independent answer to "what
    // happens next" and it did not ask that question — so while the executor was
    // converting, recovery correctly said `poll_refuel` and this still advertised
    // `destination_wallet_consent`, which is what put a manual "Approve
    // conversion" panel in front of an owner whose refuel was already running.
    const refuelInFlight = ["recorded", "executing", "retry_scheduled"]
      .includes(String(journey.refuelAuthorization?.state ?? ""));
    // Only the pre-consent states may advertise consent: past payment_settled a
    // fresh quote is not an invitation to sign the destination leg again.
    const awaitingConsent = !refuelInFlight &&
      ["arrival_confirmed", "payment_pending"].includes(journey.state) &&
      routeMode === "bridge_plus_refuel";
    const latestRefresh = [...journey.events].reverse().find((event) => event.type === "destination_quote_refreshed");
    const ready = awaitingConsent && Boolean(latestRefresh) && quote.expiresAt > Math.floor(Date.now() / 1_000) + 15;
    return {
      schema: "refuel402.arrival-continuation.v2",
      ready,
      nextAction: ready
        ? "destination_wallet_consent"
        : awaitingConsent
          ? "refresh_destination_quote"
          : null,
      error: null,
    };
  }

  router.get("/quotes/:id", async (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.id)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        code: "BAD_REQUEST",
        message: "invalid quote id",
        retriable: false,
      });
    }
    try {
      const quote = await options.store.getQuote(req.params.id);
      if (!quote) {
        return res.status(404).json({
          error: "QUOTE_NOT_FOUND",
          code: "QUOTE_NOT_FOUND",
          message: "quote does not exist",
          retriable: false,
        });
      }
      return res.json({ schema: "refuel402.stored-product-quote.v1", quote });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/journeys", async (req, res) => {
    const query = z.object({
      account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      limit: z.coerce.number().int().min(1).max(20).default(8),
      before: z.coerce.number().int().positive().optional(),
      beforeJourneyId: z.string().uuid().optional(),
      beforeActive: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
      // Abandoned journeys are hidden by default and never deleted; this is the
      // documented way to read them back.
      includeAbandoned: z.coerce.boolean().default(false),
    }).safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        code: "BAD_REQUEST",
        message: "invalid activity query",
        retriable: false,
        details: query.error.issues,
      });
    }
    const cursorParts = [query.data.before, query.data.beforeJourneyId, query.data.beforeActive];
    if (cursorParts.some((value) => value !== undefined) && cursorParts.some((value) => value === undefined)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        code: "BAD_REQUEST",
        message: "activity cursor requires before, beforeJourneyId, and beforeActive together",
        retriable: false,
      });
    }
    try {
      const page = await options.store.listJourneysForAccount(getAddress(query.data.account), {
        limit: query.data.limit,
        cursor: query.data.before === undefined ? null : {
          active: query.data.beforeActive!,
          updatedAt: query.data.before,
          journeyId: query.data.beforeJourneyId!,
        },
        includeAbandoned: query.data.includeAbandoned,
      });
      // One unsummarizable journey must cost one row, not the list. This was a
      // Promise.all, so a single missing quote or an uninterpretable record threw
      // and 404ed the whole drawer — leaving an account with a transfer in flight
      // looking as though it had no journeys at all.
      const items = await Promise.all(page.journeys.map(async (journey) => {
        try {
          const quote = await options.store.getEffectiveQuote(journey.id);
          if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "journey quote does not exist");
          return activitySummary(journey, quote);
        } catch {
          return degradedActivitySummary(journey);
        }
      }));
      return res.json({
        schema: "refuel402.product-activity.v2",
        account: getAddress(query.data.account),
        items,
        nextBefore: page.nextCursor,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys", async (req, res) => {
    const key = idempotencyKey(req);
    if (!key) {
      return res.status(400).json({
        error: "IDEMPOTENCY_KEY_REQUIRED",
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key must be 16-128 safe characters",
        retriable: false,
      });
    }
    const body = z.object({
      mode: z.enum(["testnet", "mainnet"]),
      quoteId: z.string().regex(/^[0-9a-f]{64}$/),
      account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        code: "BAD_REQUEST",
        message: "invalid journey request",
        retriable: false,
        details: body.error.issues,
      });
    }
    try {
      const journey = await options.store.createJourney({
        ...body.data,
        account: getAddress(body.data.account),
        idempotencyKey: key,
      });
      return res.status(201).json({
        schema: "refuel402.product-journey.v1",
        journey: publicJourney(journey),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/journeys/:id", async (req, res) => {
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) {
        return res.status(404).json({
          error: "JOURNEY_NOT_FOUND",
          code: "JOURNEY_NOT_FOUND",
          message: "journey does not exist",
          retriable: false,
        });
      }
      const quote = await options.store.getEffectiveQuote(journey.id);
      if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "journey quote does not exist");
      return res.json({
        schema: "refuel402.product-journey.v4",
        journey: publicJourney(journey),
        quote: quote.record,
        recovery: deriveProductRecovery(journey, quote),
        continuation: arrivalContinuation(journey, quote),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/journeys/:id/events", async (req, res) => {
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) {
        return res.status(404).json({
          error: "JOURNEY_NOT_FOUND",
          code: "JOURNEY_NOT_FOUND",
          message: "journey does not exist",
          retriable: false,
        });
      }
      return res.json({
        schema: "refuel402.product-events.v1",
        journeyId: journey.id,
        events: journey.events,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/journeys/:id/submissions", async (req, res) => {
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) {
        return res.status(404).json({
          error: "JOURNEY_NOT_FOUND",
          code: "JOURNEY_NOT_FOUND",
          message: "journey does not exist",
          retriable: false,
        });
      }
      return res.json({
        schema: "refuel402.product-submissions.v1",
        journeyId: journey.id,
        submissions: journey.submissions,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/activate", async (req, res) => {
    if (!options.destinationActivator) {
      return res.status(503).json({
        error: "DESTINATION_ACTIVATION_NOT_READY",
        code: "DESTINATION_ACTIVATION_NOT_READY",
        message: "destination activation sponsor is not enabled",
        retriable: false,
      });
    }
    const body = z.object({ confirmation: sourceLegConfirmation }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid activation request", retriable: false });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      // This spends real sponsor HBAR, and a failed readback leaves a wedge that
      // blocks abandon forever. Unsigned, both were reachable on a stranger's
      // journey by anyone who could enumerate an id.
      await requireSourceLegConsent(journey, body.data.confirmation);
      return res.json(await options.destinationActivator(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/wallet-boundary", async (req, res) => {
    const body = z.object({
      kind: z.enum(["origin_approval", "bridge"]),
      confirmation: sourceLegConfirmation,
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid wallet boundary", retriable: false });
    }
    try {
      const existing = await options.store.getJourney(req.params.id);
      if (!existing) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      // The worst of the unsigned mutations. The event it appends is append-only,
      // no route removes it, and three predicates read it as blocked: the journey
      // becomes unresumable, un-requotable AND unretirable, with no escape hatch.
      const consentedAccount = await requireSourceLegConsent(existing, body.data.confirmation);
      const journey = await options.store.recordWalletBoundary({
        journeyId: req.params.id,
        kind: body.data.kind,
        consentedAccount,
      });
      return res.json({ schema: "refuel402.wallet-boundary.v1", journey: publicJourney(journey) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/bridge", async (req, res) => {
    if (!options.bridgeTracker) {
      return res.status(503).json({
        error: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        code: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        message: "live provider submission tracking is not enabled",
        retriable: false,
      });
    }
    const body = z.object({
      sourceTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      confirmation: sourceLegConfirmation,
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid bridge submission", retriable: false });
    }
    try {
      const existing = await options.store.getJourney(req.params.id);
      if (!existing) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      // Binding an arbitrary hash forecloses both abandon and adoption, and makes
      // the owner's own later real submission conflict — losing the recovery route
      // for live principal, not merely denying service.
      await requireSourceLegConsent(existing, body.data.confirmation);
      const journey = await options.bridgeTracker.submit(req.params.id, body.data.sourceTransactionHash as Hex);
      return res.json({ schema: "refuel402.product-bridge-submission.v1", journey: publicJourney(journey) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/journeys/:id/bridge", async (req, res) => {
    if (!options.bridgeTracker) {
      return res.status(503).json({
        error: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        code: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        message: "live provider submission tracking is not enabled",
        retriable: false,
      });
    }
    try {
      const status = await options.bridgeTracker.status(req.params.id) as Record<string, unknown> & { journey?: ProductJourneyRecord };
      return res.json({
        ...status,
        ...(status.journey ? { journey: publicJourney(status.journey) } : {}),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Adoption and submission reconciliation are idempotent by durable state, not
  // by request key: adoption keys off the stored source hash and reconciliation
  // off authorization state, and the browser polls reconciliation with one
  // stable key, so keyed response replay would be wrong. No Idempotency-Key.
  router.post("/journeys/:id/bridge/adopt", async (req, res) => {
    if (!options.bridgeTracker?.adopt) {
      return res.status(503).json({
        error: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        code: "PRODUCT_BRIDGE_TRACKER_NOT_READY",
        message: "chain-evidence bridge adoption is not enabled",
        retriable: false,
      });
    }
    const body = z.object({
      sourceTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      // Owner consent is a signature over the adoption, not a boolean flag.
      confirmation: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid bridge adoption", retriable: false });
    }
    try {
      const journey = await options.bridgeTracker.adopt(
        req.params.id,
        body.data.sourceTransactionHash as Hex,
        body.data.confirmation as Hex,
      );
      return res.json({ schema: "refuel402.product-bridge-adoption.v1", journey: publicJourney(journey) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/source-quote", async (req, res) => {
    const body = z.object({
      quoteId: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid source quote refresh", retriable: false });
    }
    try {
      const existing = await options.store.getJourney(req.params.id);
      if (!existing) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      // Consent names the REPLACEMENT quote, not the journey's current one: that
      // is the quote the owner was shown and is about to move to, and it means a
      // captured signature cannot authorize the next re-bind.
      const consentedAccount = await requireSourceLegConsent(existing, body.data.confirmation, body.data.quoteId);
      const journey = await options.store.refreshSourceQuote({
        journeyId: req.params.id,
        quoteId: body.data.quoteId,
        consentedAccount,
      });
      const quote = await options.store.getQuote(journey.quoteId);
      if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "replacement quote does not exist");
      return res.json({
        schema: "refuel402.source-quote-refresh.v1",
        journey: publicJourney(journey),
        quote: quote.record,
        recovery: deriveProductRecovery(journey, quote),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/refuel-authorization", async (req, res) => {
    const body = z.object({
      confirmation: sourceLegConfirmation,
      deadline: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        code: "BAD_REQUEST",
        message: "invalid refuel authorization request",
        retriable: false,
        details: body.error.issues,
      });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      await requireSourceLegConsent(journey, body.data.confirmation);
      const quote = await options.store.getEffectiveQuote(journey.id);
      if (!quote) throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "journey quote does not exist");
      const terms = quote.record.refuelAuthorization as Record<string, any> | undefined;
      if (!terms || terms.schema !== "refuel402.refuel-authorization-terms.v1" || terms.enabled !== true) {
        return res.status(503).json({
          error: "REFUEL_PREAUTHORIZATION_NOT_READY",
          code: "REFUEL_PREAUTHORIZATION_NOT_READY",
          message: "one-signature refuel is dormant until the contract and sponsored execution gates are live-proven",
          retriable: false,
        });
      }
      if (!/^\d+$/.test(String(terms.maxSponsorExposureTinybar)) || BigInt(String(terms.maxSponsorExposureTinybar)) <= 0n) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "quote-bound sponsor exposure is invalid");
      }
      const deadline = Number(body.data.deadline);
      const nowSec = Math.floor(Date.now() / 1000);
      const ttl = Number(terms.authorizationTtlSeconds);
      if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(ttl) || deadline <= nowSec + 60 || deadline > nowSec + ttl) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "refuel authorization deadline is outside the quote-bound window");
      }
      const route = {
        wrapper: getAddress(String(terms.route?.wrapper)),
        htsToken: getAddress(String(terms.route?.htsToken)),
        router: getAddress(String(terms.route?.router)),
        whbar: getAddress(String(terms.route?.whbar)),
        wrapperRate: BigInt(String(terms.route?.wrapperRate)),
        swapPath: String(terms.route?.swapPath ?? "") as Hex,
      };
      const routeHash = refuelRouteHash(route);
      if (routeHash.toLowerCase() !== String(terms.routeHash).toLowerCase()) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "quote-bound refuel route hash is inconsistent");
      }
      const authorization = {
        owner: journey.account,
        token: getAddress(String(terms.token)),
        maxAmountIn: BigInt(String(terms.maxAmountIn)),
        exactHbarTinybar: BigInt(String(terms.exactHbarTinybar)),
        serviceFeeAmount: BigInt(String(terms.serviceFeeAmount)),
        recipient: journey.account,
        journeyNonce: journeyNonce(journey.id),
        deadline: BigInt(deadline),
        routeHash,
      };
      const permit2 = getAddress(String(terms.permit2));
      const spender = getAddress(String(terms.spender));
      const valid = await verifyTypedData({
        ...refuelAuthorizationTypedData({
          chainId: journey.mode === "mainnet" ? 295 : 296,
          permit2,
          spender,
          authorization,
        }),
        address: journey.account,
        signature: body.data.signature as Hex,
      }).catch(() => false);
      if (!valid) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "refuel authorization signature does not recover to the journey owner");
      }
      const id = refuelAuthorizationId(authorization);
      const recorded = await options.store.recordRefuelAuthorization({
        id,
        journeyId: journey.id,
        owner: authorization.owner,
        token: authorization.token,
        maxAmountIn: authorization.maxAmountIn.toString(),
        exactHbarTinybar: authorization.exactHbarTinybar.toString(),
        serviceFeeAmount: authorization.serviceFeeAmount.toString(),
        maxSponsorExposureTinybar: BigInt(String(terms.maxSponsorExposureTinybar)).toString(),
        recipient: authorization.recipient,
        journeyNonce: authorization.journeyNonce.toString(),
        deadline,
        routeHash,
        signature: body.data.signature as Hex,
        permit2,
        spender,
        route: {
          ...route,
          wrapperRate: route.wrapperRate.toString(),
        },
      });
      return res.status(201).json({
        schema: "refuel402.refuel-authorization-recorded.v1",
        authorization: {
          id,
          journeyId: journey.id,
          maxAmountIn: authorization.maxAmountIn.toString(),
          exactHbarTinybar: authorization.exactHbarTinybar.toString(),
          deadline,
          routeHash,
          state: recorded.refuelAuthorization?.state ?? "recorded",
        },
        journey: publicJourney(recorded),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/destination-quote", async (req, res) => {
    if (!options.destinationQuoteRefresher) {
      return res.status(503).json({
        error: "DESTINATION_QUOTE_REFRESH_NOT_READY",
        code: "DESTINATION_QUOTE_REFRESH_NOT_READY",
        message: "post-arrival destination quoting is not enabled",
        retriable: false,
      });
    }
    try {
      const quote = await options.destinationQuoteRefresher(req.params.id);
      return res.json({ schema: "refuel402.refreshed-destination-quote.v1", quote: quote.record });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/payment", async (req, res) => {
    const key = idempotencyKey(req);
    if (!key) {
      return res.status(400).json({
        error: "IDEMPOTENCY_KEY_REQUIRED",
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key must be 16-128 safe characters",
        retriable: false,
      });
    }
    if (!options.paymentVerifier) {
      return res.status(503).json({
        error: "EVM_X402_FACILITATOR_NOT_READY",
        code: "EVM_X402_FACILITATOR_NOT_READY",
        message: "EVM x402 verification/settlement is disabled until contract, facilitator, and sponsor proof gates pass",
        retriable: false,
      });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) {
        throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      }
      const quote = await options.store.getEffectiveQuote(journey.id);
      if (!quote) {
        throw new ProductLifecycleConflictError("QUOTE_NOT_FOUND", "journey quote does not exist");
      }
      // The settled payment is journey-scoped, so a refreshed destination quote
      // never implies a second settlement: replay is decided from durable state
      // before the facilitator is contacted at all.
      if (journey.payment) {
        return res.json({
          schema: "refuel402.product-payment.v1",
          payment: await options.store.recordPayment({
            journeyId: journey.id,
            idempotencyKey: key,
            quoteId: effectiveQuoteId(quote),
            payment: journey.payment,
          }),
        });
      }
      const paymentSignature = req.header("payment-signature");
      if (!paymentSignature) {
        const origin = process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
        const required = createProductPaymentRequired({
          quote,
          journey,
          resourceUrl: `${origin}/v1/product/journeys/${journey.id}/payment`,
        });
        res.setHeader("PAYMENT-REQUIRED", required.header);
        return res.status(402).json(required.body);
      }
      const verified = await options.paymentVerifier.verify({ journey, paymentSignature });
      const payment = await options.store.recordPayment({
        journeyId: journey.id,
        idempotencyKey: key,
        quoteId: effectiveQuoteId(quote),
        payment: verified,
      });
      return res.json({
        schema: "refuel402.product-payment.v1",
        payment,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/intents/:kind/authorize", async (req, res) => {
    const key = idempotencyKey(req);
    if (!key) {
      return res.status(400).json({
        error: "IDEMPOTENCY_KEY_REQUIRED",
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key must be 16-128 safe characters",
        retriable: false,
      });
    }
    const kind = z.enum(intentKinds).safeParse(req.params.kind);
    if (!kind.success) {
      return res.status(400).json({
        error: "UNKNOWN_INTENT_KIND",
        code: "UNKNOWN_INTENT_KIND",
        message: "intent kind is not supported",
        retriable: false,
      });
    }
    if (!options.intentBuilder) {
      return res.status(503).json({
        error: "PRODUCT_INTENT_BUILDER_NOT_READY",
        code: "PRODUCT_INTENT_BUILDER_NOT_READY",
        message: "live activation/approval/wrapper/router intent construction remains disabled until contract and sponsor proof gates pass",
        retriable: false,
      });
    }
    let journey: ProductJourneyRecord | null = null;
    try {
      journey = await options.store.getJourney(req.params.id);
      if (!journey) {
        throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      }
      // The activation intent is the source leg's sponsored step: it reserves
      // sponsor exposure and retires the owner's live activation authorization, so
      // it takes the same consent as the rest of the leg. Destination-leg kinds run
      // after arrival with the wallet on Hedera and are not covered by an
      // origin-chain consent; see docs/PRODUCT.md.
      if (kind.data === "activation") {
        const confirmation = z.object({ confirmation: sourceLegConfirmation })
          .safeParse(req.body ?? {});
        if (!confirmation.success) {
          return res.status(400).json({
            error: "BAD_REQUEST",
            code: "BAD_REQUEST",
            message: "activation authorization requires the owner's source leg consent",
            retriable: false,
          });
        }
        await requireSourceLegConsent(journey, confirmation.data.confirmation);
      }
      const built = await options.intentBuilder.build({
        journey,
        intentKind: kind.data,
        request: req.body,
      });
      if (
        getAddress(built.transaction.from) !== journey.account ||
        getAddress(built.authorization.account) !== journey.account ||
        built.authorization.mode !== journey.mode
      ) {
        throw new ProductLifecycleConflictError(
          "AUTHORIZATION_REPLAY",
          "intent builder returned a different account or network mode",
        );
      }
      const authorization = await options.store.createAuthorization({
        journeyId: journey.id,
        intentKind: kind.data,
        idempotencyKey: key,
        authorization: built.authorization,
      });
      return res.json({
        schema: "refuel402.product-authorization.v1",
        authorization: {
          id: authorization.id,
          journeyId: authorization.journeyId,
          intentKind: authorization.intentKind,
          rawTransactionHash: authorization.rawTransactionHash,
          matching: "exact_unsigned_fields_then_one_time_raw_transaction_consumption",
          expiresAt: authorization.expiresAt,
          state: authorization.state,
        },
        transaction: built.transaction,
      });
    } catch (error) {
      sendError(res, error, {
        journeyId: journey?.id ?? req.params.id,
        quoteId: journey?.quoteId ?? null,
        intentKind: kind.data,
      });
    }
  });

  router.post("/journeys/:id/intents/:kind/confirm", async (req, res) => {
    if (!options.receiptReconciler) {
      return res.status(503).json({
        error: "PRODUCT_RECEIPT_RECONCILER_NOT_READY",
        code: "PRODUCT_RECEIPT_RECONCILER_NOT_READY",
        message: "authoritative receipt reconciliation is not enabled",
        retriable: false,
      });
    }
    const kind = z.enum(intentKinds).safeParse(req.params.kind);
    const body = z.object({ ethereumHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body);
    if (!kind.success || kind.data === "router_execution" || !body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid intent confirmation", retriable: false });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const receipt = await options.receiptReconciler.reconcile({
        journey,
        ethereumHash: body.data.ethereumHash as Hex,
      });
      const confirmed = await options.store.confirmIntent({
        journeyId: journey.id,
        intentKind: kind.data,
        ethereumHash: body.data.ethereumHash as Hex,
        receipt,
      });
      return res.json({ schema: "refuel402.product-intent-confirmation.v1", journey: publicJourney(confirmed), receipt });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/reconcile", async (req, res) => {
    if (!options.receiptReconciler) {
      return res.status(503).json({
        error: "PRODUCT_RECEIPT_RECONCILER_NOT_READY",
        code: "PRODUCT_RECEIPT_RECONCILER_NOT_READY",
        message: "authoritative receipt reconciliation is not enabled",
        retriable: false,
      });
    }
    const body = z.object({ ethereumHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid reconciliation request", retriable: false });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const receipt = await options.receiptReconciler.reconcile({
        journey,
        ethereumHash: body.data.ethereumHash as Hex,
      });
      const reconciled = await options.store.recordReconciliation({
        journeyId: journey.id,
        ethereumHash: body.data.ethereumHash as Hex,
        receipt,
      });
      return res.json({ schema: "refuel402.product-reconciliation.v1", journey: publicJourney(reconciled), receipt });
    } catch (error) {
      sendError(res, error);
    }
  });

  /**
   * Owner retires a draft that never reached the outside world.
   *
   * Consent is a signature, not a flag: the per-journey reads are not
   * account-scoped, so a journey id is not a secret and must never be enough to
   * retire someone else's record. Eligibility is re-checked transactionally in
   * the store against the locked row; the pre-check here only buys a clearer
   * error. Nothing is deleted — the record stays readable by id, and the list
   * returns it again with ?includeAbandoned=true.
   */
  router.post("/journeys/:id/abandon", async (req, res) => {
    const body = z.object({
      confirmation: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid abandon request", retriable: false });
    }
    try {
      const journey = await options.store.getJourney(req.params.id);
      if (!journey) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const consent = journeyAbandonTypedData({
        journeyId: journey.id,
        account: journey.account,
        mode: journey.mode,
      });
      const consented = await verifyTypedData({
        ...consent,
        address: journey.account,
        signature: body.data.confirmation as Hex,
      }).catch(() => false);
      if (!consented) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "abandon consent does not recover to the journey account for this journey and network",
        );
      }
      if (journey.state !== "abandoned" && !journeyAbandonable(journey)) {
        throw new ProductLifecycleConflictError(
          "JOURNEY_STATE_CONFLICT",
          `journey in ${journey.state} has durable or in-flight evidence and cannot be abandoned`,
        );
      }
      const abandoned = await options.store.abandonJourney(journey.id);
      return res.json({ schema: "refuel402.product-journey-abandon.v1", journey: publicJourney(abandoned) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/journeys/:id/reconcile-submissions", async (req, res) => {
    const body = z.object({
      authorizationId: z.string().min(1).max(128).optional(),
      confirmation: sourceLegConfirmation.optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ error: "BAD_REQUEST", code: "BAD_REQUEST", message: "invalid reconcile request", retriable: false });
    }
    try {
      const existing = await options.store.getJourney(req.params.id);
      if (!existing) throw new ProductLifecycleConflictError("JOURNEY_NOT_FOUND", "journey does not exist");
      const hasSourceWalletBoundary = existing.events.some((event) => event.type === "bridge_wallet_boundary");
      const hasSourceBroadcast = existing.events.some((event) => event.type === "bridge_submitted") ||
        existing.events.some((event) => typeof event.record.sourceTransactionHash === "string");
      if (hasSourceWalletBoundary && !hasSourceBroadcast && existing.authorizations.length === 0 && existing.submissions.length === 0) {
        if (!body.data.confirmation) {
          throw new ProductLifecycleConflictError(
            "EVIDENCE_CONFLICT",
            "owner SourceLegConsent is required before releasing an unbroadcast source wallet boundary",
          );
        }
        await requireSourceLegConsent(existing, body.data.confirmation);
        const absenceReader = options.sourceBoundaryAbsence?.[existing.mode];
        const quote = await options.store.getEffectiveQuote(existing.id);
        if (!absenceReader || !quote) {
          throw new ProductLifecycleConflictError(
            "EVIDENCE_CONFLICT",
            "bridge wallet boundary remains locked: authoritative origin-chain/provider absence proof is unavailable",
          );
        }
        const absence = await absenceReader.proveNoBroadcast({ journey: existing, quote });
        if (absence.status !== "proven_absent") {
          throw new ProductLifecycleConflictError(
            "EVIDENCE_CONFLICT",
            `bridge wallet boundary remains locked: ${absence.reason}`,
          );
        }
        const released = await options.store.releaseUnbroadcastBridgeBoundary({
          journeyId: existing.id,
          evidence: absence.evidence,
        });
        return res.json({
          schema: "refuel402.product-reconcile-submissions.v1",
          journey: publicJourney(released),
          resolutions: [{
            authorizationId: "source_bridge_wallet_boundary",
            intentKind: "bridge",
            resolution: "rejected",
            reason: "authoritative_origin_evidence_proved_no_broadcast",
          }],
          recovery: deriveProductRecovery(released, quote),
        });
      }
      const reader = options.submissionEvidence?.[existing.mode];
      if (!reader) {
        return res.status(503).json({
          error: "SUBMISSION_RECONCILIATION_NOT_READY",
          code: "SUBMISSION_RECONCILIATION_NOT_READY",
          message: "mirror-backed submission reconciliation is not enabled",
          retriable: false,
        });
      }
      // A crash between consume() and markSubmitted strands the journey in
      // 'submitting' with a 'consumed' row that only a process restart used to
      // promote. Promote it here first so the user-facing button can release it.
      const promotion = await options.store.promoteExpiredConsumedSubmissions(existing.id);
      const journey = promotion.promoted.length > 0
        ? await options.store.getJourney(existing.id) ?? existing
        : existing;
      const targets = journey.authorizations.filter((authorization) =>
        authorization.state === "unknown" &&
        (!body.data.authorizationId || authorization.id === body.data.authorizationId));
      const named = body.data.authorizationId
        ? journey.authorizations.find((authorization) => authorization.id === body.data.authorizationId)
        : undefined;
      // A named authorization still inside the grace window is not a conflict:
      // it is in flight, so the client re-polls after revalidateAfterMs.
      if (body.data.authorizationId && targets.length === 0 && named?.state !== "consumed") {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "authorization is not in a reconcilable unknown state");
      }
      // Read phase first: any evidence conflict aborts before a single write.
      const outcomes = await Promise.all(targets.map((authorization) =>
        resolveUnknownSubmission({ journey, authorization, reader })));
      const conflict = outcomes.find((outcome) => outcome.resolution === "conflict");
      if (conflict) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", conflict.reason);
      }
      const resolutions: Array<{
        authorizationId: string;
        intentKind: ProductIntentKind;
        resolution: "submitted" | "rejected" | "ambiguous";
        reason: string;
        ethereumHash?: Hex;
      }> = [];
      for (const [index, outcome] of outcomes.entries()) {
        const authorization = targets[index]!;
        if (outcome.resolution === "submitted") {
          await options.store.resolveSubmissionAsSubmitted({
            authorizationId: authorization.id,
            ethereumHash: outcome.ethereumHash,
            evidence: outcome.evidence,
          });
        } else if (outcome.resolution === "rejected") {
          await options.store.resolveSubmissionAsRejected({
            authorizationId: authorization.id,
            reason: outcome.reason,
            evidence: outcome.evidence,
          });
        }
        resolutions.push({
          authorizationId: authorization.id,
          intentKind: authorization.intentKind,
          resolution: outcome.resolution as "submitted" | "rejected" | "ambiguous",
          reason: outcome.reason,
          ...(outcome.resolution === "submitted" ? { ethereumHash: outcome.ethereumHash } : {}),
        });
      }
      let current = await options.store.getJourney(journey.id) ?? journey;
      const nowSec = Math.floor(Date.now() / 1000);
      const unresolved = current.authorizations.some((authorization) =>
        ["unknown", "consumed"].includes(authorization.state) ||
        (authorization.state === "pending" && authorization.expiresAt > nowSec)) ||
        current.submissions.some((submission) => ["unknown", "consumed"].includes(submission.state));
      if (current.state === "review" && !unresolved) {
        current = await options.store.releaseReviewJourney(journey.id, nowSec);
      }
      const quote = await options.store.getEffectiveQuote(journey.id);
      return res.json({
        schema: "refuel402.product-reconcile-submissions.v1",
        journey: publicJourney(current),
        resolutions,
        recovery: {
          ...deriveProductRecovery(current, quote),
          // Evidence still inside the grace window: an empty resolution list is
          // not a final answer, so tell the client when to ask again.
          ...(promotion.nextGraceAtSec === null
            ? {}
            : { revalidateAfterMs: Math.max(1_000, (promotion.nextGraceAtSec - nowSec) * 1_000) }),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
