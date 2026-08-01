import { describe, expect, it } from "vitest";
import { deriveProductRecovery } from "../src/product-recovery.js";
import type { ProductJourneyRecord, StoredProductQuote } from "../src/product-lifecycle-store.js";

const quote = (routeMode: "bridge_only" | "bridge_plus_refuel"): StoredProductQuote => ({
  quoteId: "a".repeat(64),
  mode: "mainnet",
  account: "0x1111111111111111111111111111111111111111",
  requestedProvider: "auto",
  selectedProvider: "axelar",
  assetId: "axelar:mainnet:usdc",
  originChainId: "1",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
  executable: true,
  record: { routeMode },
});

const journey = (state: ProductJourneyRecord["state"], overrides: Partial<ProductJourneyRecord> = {}): ProductJourneyRecord => ({
  id: "journey-1",
  quoteId: "a".repeat(64),
  mode: "mainnet",
  account: "0x1111111111111111111111111111111111111111",
  requestedProvider: "auto",
  selectedProvider: "axelar",
  assetId: "axelar:mainnet:usdc",
  originChainId: "1",
  state,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  payment: null,
  authorizations: [],
  submissions: [],
  events: [],
  ...overrides,
});

describe("a live pre-authorized refuel owns the arrival", () => {
  const arrived = [
    { id: 1, type: "bridge_submitted", record: {}, createdAt: 1 },
    { id: 2, type: "bridge_arrived", record: {}, createdAt: 2 },
  ] as any;

  /**
   * Without this the server kept answering `destination_wallet_consent`, so the
   * surface offered a manual conversion while the executor was already running
   * one — two paths pointed at the same funds, with only a client-side check
   * between them.
   */
  it.each(["recorded", "executing", "retry_scheduled"] as const)(
    "asks for no wallet action while an authorization is %s",
    (state) => {
      const decision = deriveProductRecovery(
        journey("arrival_confirmed", { events: arrived, refuelAuthorization: { state } as any }),
        quote("bridge_plus_refuel"),
      );
      expect(decision).toMatchObject({
        disposition: "resume_safe",
        nextAtomicStep: "poll_refuel",
        walletActionRequired: false,
        replaySafe: true,
      });
    },
  );

  // A spent or abandoned authorization must hand the arrival back to the owner,
  // or a failed pre-authorization would strand the journey with no way forward.
  it.each(["completed", "fallback", "expired", "unknown"] as const)(
    "returns to explicit consent once the authorization is %s",
    (state) => {
      expect(deriveProductRecovery(
        journey("arrival_confirmed", { events: arrived, refuelAuthorization: { state } as any }),
        quote("bridge_plus_refuel"),
      )).toMatchObject({ nextAtomicStep: "destination_wallet_consent", walletActionRequired: true });
    },
  );

  it("still requires consent when there is no authorization at all", () => {
    expect(deriveProductRecovery(
      journey("arrival_confirmed", { events: arrived }),
      quote("bridge_plus_refuel"),
    )).toMatchObject({ nextAtomicStep: "destination_wallet_consent", walletActionRequired: true });
  });
});

describe("server-authoritative product recovery", () => {
  it("permits only replay-safe bridge polling after a durable source hash", () => {
    expect(deriveProductRecovery(journey("bridge_pending"), quote("bridge_plus_refuel"))).toMatchObject({
      disposition: "resume_safe",
      nextAtomicStep: "poll_bridge",
      replaySafe: true,
      autoSignAllowed: false,
      autoSubmitAllowed: false,
    });
  });

  it("blocks automatic resubmission when a source wallet boundary has no authoritative hash", () => {
    const decision = deriveProductRecovery(journey("ready", {
      events: [{ id: 1, type: "bridge_wallet_boundary", record: {}, createdAt: Date.now() }],
    }), quote("bridge_plus_refuel"));
    expect(decision).toMatchObject({
      disposition: "blocked_unknown_submit_result",
      nextAtomicStep: "operator_review",
      replaySafe: false,
      sameJourneyResendAllowed: false,
    });
    expect(decision.reason).toContain("POST /v1/product/journeys/:id/bridge/adopt");
  });

  it("marks source wallet consent as re-pollable rather than terminal", () => {
    for (const state of ["ready", "bridge_ready", "activation_pending"] as const) {
      expect(deriveProductRecovery(journey(state), quote("bridge_plus_refuel"))).toMatchObject({
        nextAtomicStep: "source_wallet_consent",
        sameJourneyResendAllowed: true,
        revalidateAfterMs: 15_000,
      });
    }
  });

  it("separates bridge-only completion from fresh downstream refuel consent", () => {
    expect(deriveProductRecovery(journey("arrival_confirmed"), quote("bridge_only"))).toMatchObject({
      disposition: "resume_safe",
      nextAtomicStep: "poll_bridge",
      routeMode: "bridge_only",
    });
    expect(deriveProductRecovery(journey("arrival_confirmed"), quote("bridge_plus_refuel"))).toMatchObject({
      disposition: "action_required",
      nextAtomicStep: "destination_wallet_consent",
      autoSignAllowed: false,
      autoSubmitAllowed: false,
    });
  });

  const bridged = [
    { id: 1, type: "bridge_submitted", record: { sourceTransactionHash: `0x${"5d".repeat(32)}` }, createdAt: Date.now() },
    { id: 2, type: "bridge_arrived", record: { destinationAmountReceived: "23610000" }, createdAt: Date.now() },
  ] as ProductJourneyRecord["events"];

  it("keeps the post-payment refuel legs drivable instead of blocking on the settled payment", () => {
    for (const state of ["payment_pending", "payment_settled", "authorizing"] as const) {
      expect(deriveProductRecovery(journey(state, { events: bridged }), quote("bridge_plus_refuel")), state).toMatchObject({
        disposition: "action_required",
        status: "action_required",
        nextAtomicStep: "destination_wallet_consent",
        walletActionRequired: true,
        replaySafe: false,
        autoSignAllowed: false,
        autoSubmitAllowed: false,
      });
    }
    for (const state of ["submitting", "execution_pending"] as const) {
      expect(deriveProductRecovery(journey(state), quote("bridge_plus_refuel")), state).toMatchObject({
        disposition: "blocked_unknown_submit_result",
        status: "blocked",
        nextAtomicStep: "operator_review",
      });
    }
  });

  /**
   * Journey c4982fc7 on production. `authorizing` is written when ANY intent
   * authorization row is created, and the first one is the PRE-BRIDGE `activation`
   * leg — so reading position from the state label answered "destination consent"
   * for a journey with no bridge transaction, no arrival and no payment, which the
   * frontend then rendered as "Your funds arrived".
   */
  it("never names a destination step before a durable bridge hash exists", () => {
    const activationOnly = journey("authorizing", {
      events: [
        { id: 1, type: "journey_created", record: {}, createdAt: Date.now() },
        { id: 2, type: "destination_activation_funded", record: {}, createdAt: Date.now() },
        { id: 3, type: "authorization_created", record: { intentKind: "activation" }, createdAt: Date.now() },
      ] as ProductJourneyRecord["events"],
      authorizations: [{
        id: "auth-1",
        journeyId: "journey-1",
        intentKind: "activation",
        state: "pending",
        ethereumHash: null,
        rawTransactionHash: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }] as ProductJourneyRecord["authorizations"],
    });
    const decision = deriveProductRecovery(activationOnly, quote("bridge_plus_refuel"));
    expect(decision).toMatchObject({
      disposition: "action_required",
      nextAtomicStep: "source_wallet_consent",
      walletActionRequired: true,
      replaySafe: false,
      sameJourneyResendAllowed: true,
      revalidateAfterMs: 15_000,
    });
    expect(decision.reason).toContain("activation");
    expect(decision.reason).toContain("nothing was spent");
  });

  it("waits for arrival rather than offering a destination step on a submitted-but-unarrived bridge", () => {
    const submittedOnly = journey("authorizing", {
      events: [{ id: 1, type: "bridge_submitted", record: { sourceTransactionHash: `0x${"5d".repeat(32)}` }, createdAt: Date.now() }] as ProductJourneyRecord["events"],
    });
    expect(deriveProductRecovery(submittedOnly, quote("bridge_plus_refuel"))).toMatchObject({
      disposition: "resume_safe",
      nextAtomicStep: "poll_bridge",
      replaySafe: true,
      walletActionRequired: false,
    });
  });

  it("routes unknown policy-RPC results to submission reconciliation", () => {
    expect(deriveProductRecovery(journey("review", {
      submissions: [{
        id: "submission-1",
        authorizationId: "authorization-1",
        journeyId: "journey-1",
        rawTransactionHash: `0x${"ab".repeat(32)}`,
        state: "unknown",
        ethereumHash: null,
        reason: "restart",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }), quote("bridge_plus_refuel"))).toMatchObject({
      disposition: "blocked_unknown_submit_result",
      status: "blocked",
      nextAtomicStep: "reconcile_submissions",
    });
  });

  it("routes a journey stranded in submitting by consumed evidence to reconciliation, not operator review", () => {
    expect(deriveProductRecovery(journey("submitting", {
      authorizations: [{
        id: "authorization-1",
        mode: "mainnet",
        account: "0x1111111111111111111111111111111111111111",
        chainId: 295,
        nonce: 3,
        to: "0x2222222222222222222222222222222222222222",
        dataHash: `0x${"11".repeat(32)}`,
        value: 0n,
        gasLimitMaximum: 100_000n,
        maxGasAllowanceTinybar: 1_000_000n,
        expiresAt: Math.floor(Date.now() / 1_000) - 400,
        journeyId: "journey-1",
        intentKind: "activation",
        rawTransactionHash: `0x${"ab".repeat(32)}`,
        state: "consumed",
        ethereumHash: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }), quote("bridge_plus_refuel"))).toMatchObject({
      disposition: "blocked_unknown_submit_result",
      status: "blocked",
      nextAtomicStep: "reconcile_submissions",
    });
  });

  it("names the expired-pending cause when review has no unknown evidence", () => {
    const decision = deriveProductRecovery(journey("review"), quote("bridge_plus_refuel"));
    expect(decision).toMatchObject({
      disposition: "operator_review",
      status: "blocked",
      nextAtomicStep: "reconcile_submissions",
    });
    expect(decision.reason).toContain("expired while still pending");
  });
});
