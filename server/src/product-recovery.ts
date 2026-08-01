import {
  sourceJourneyResendable,
  type ProductJourneyRecord,
  type StoredProductQuote,
} from "./product-lifecycle-store.js";
import type { ProductRouteMode } from "./support.js";

export type ProductRecoveryDecision = {
  schema: "refuel402.product-recovery.v1";
  journeyId: string;
  routeMode: ProductRouteMode;
  state: ProductJourneyRecord["state"];
  disposition: "terminal" | "resume_safe" | "action_required" | "blocked_unknown_submit_result" | "operator_review";
  status: "terminal" | "replay_safe" | "action_required" | "blocked";
  nextAtomicStep:
    | "none"
    | "poll_bridge"
    | "poll_refuel"
    | "source_wallet_consent"
    | "destination_wallet_consent"
    | "reconcile_submissions"
    | "operator_review";
  replaySafe: boolean;
  walletActionRequired: boolean;
  autoSignAllowed: false;
  autoSubmitAllowed: false;
  sameJourneyResendAllowed: boolean;
  revalidateAfterMs?: number;
  reason: string;
};

function routeMode(quote: StoredProductQuote | null): ProductRouteMode {
  return quote?.record.routeMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel";
}

export function deriveProductRecovery(
  journey: ProductJourneyRecord,
  quote: StoredProductQuote | null,
): ProductRecoveryDecision {
  const mode = routeMode(quote);
  const base = {
    schema: "refuel402.product-recovery.v1" as const,
    journeyId: journey.id,
    routeMode: mode,
    state: journey.state,
    autoSignAllowed: false as const,
    autoSubmitAllowed: false as const,
    sameJourneyResendAllowed: sourceJourneyResendable(journey),
  };
  const blocked = (reason: string): ProductRecoveryDecision => ({
    ...base,
    disposition: "blocked_unknown_submit_result",
    status: "blocked",
    nextAtomicStep: "operator_review",
    replaySafe: false,
    walletActionRequired: false,
    reason,
  });
  // The one decision for a journey that never produced a durable bridge hash. It
  // names the authorization that moved the record's state, so an owner is not told
  // a destination step is next on a transfer that never left the origin chain.
  const preBridgeConsent = (): ProductRecoveryDecision => {
    const pendingIntent = [...journey.authorizations]
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
      .find((authorization) => authorization.state === "pending")?.intentKind ?? null;
    return {
      ...base,
      disposition: "action_required",
      status: "action_required",
      nextAtomicStep: "source_wallet_consent",
      replaySafe: false,
      walletActionRequired: true,
      revalidateAfterMs: 15_000,
      reason: pendingIntent
        ? `A ${pendingIntent} authorization was issued, but no bridge transaction hash is durable: nothing left the origin chain and nothing was spent. Request a fresh quote before a new explicit wallet action; automatic signing and reuse of the stale provider transaction are forbidden.`
        : "No source transaction hash is durable. Automatic source signing/submission and reuse of the possibly stale provider transaction are forbidden; request a fresh quote before a new explicit wallet action.",
    };
  };
  // Terminal by owner decision, and checked first: an abandoned record must
  // never be offered as resumable, whatever else its event log contains.
  if (journey.state === "abandoned") {
    return {
      ...base,
      disposition: "terminal",
      status: "terminal",
      nextAtomicStep: "none",
      replaySafe: true,
      walletActionRequired: false,
      reason: "You retired this draft. The record, its quote and its events are preserved and read-only; start a new transfer instead.",
    };
  }
  const unknown = journey.submissions.some((submission) => ["unknown", "consumed"].includes(submission.state)) ||
    journey.authorizations.some((authorization) => ["unknown", "consumed"].includes(authorization.state));
  if (unknown || journey.state === "review") {
    return {
      ...base,
      disposition: unknown ? "blocked_unknown_submit_result" : "operator_review",
      status: "blocked",
      nextAtomicStep: "reconcile_submissions",
      replaySafe: false,
      walletActionRequired: false,
      reason: unknown
        ? "A prior sponsored submission has an unknown or in-flight result. POST /v1/product/journeys/:id/reconcile-submissions resolves it from mirror evidence; automatic signing or resubmission is forbidden."
        : "Review was entered by an authorization that expired while still pending; nothing was ever broadcast. POST /v1/product/journeys/:id/reconcile-submissions releases the journey to its durable-event state.",
    };
  }
  const sourceWalletBoundary = journey.events.some((event) =>
    event.type === "origin_approval_wallet_boundary" || event.type === "bridge_wallet_boundary");
  const bridgeSubmitted = journey.events.some((event) =>
    event.type === "bridge_submitted" || event.type === "bridge_submission_adopted");
  const bridgeArrived = journey.events.some((event) => event.type === "bridge_arrived");
  if (sourceWalletBoundary && !bridgeSubmitted) {
    return blocked("A source-wallet consent boundary was reached without an authoritative bridge transaction hash. If the bridge transaction was broadcast, bind it from chain and provider evidence with POST /v1/product/journeys/:id/bridge/adopt; never approve or resubmit automatically.");
  }
  if (journey.state === "completed") {
    return {
      ...base,
      disposition: "terminal",
      status: "terminal",
      nextAtomicStep: "none",
      replaySafe: true,
      walletActionRequired: false,
      reason: mode === "bridge_only" ? "Bridge-only arrival is complete." : "Bridge and refuel reconciliation is complete.",
    };
  }
  if (journey.state === "bridge_pending") {
    return {
      ...base,
      disposition: "resume_safe",
      status: "replay_safe",
      nextAtomicStep: "poll_bridge",
      replaySafe: true,
      walletActionRequired: false,
      reason: "The source transaction hash is durable; provider and destination arrival polling is replay-safe.",
    };
  }
  // A live pre-authorized refuel owns this arrival. Without this branch the
  // server kept answering `destination_wallet_consent`, so the surface offered
  // the owner a manual conversion while the executor was already running one —
  // two paths pointed at the same funds, with only the client-side gate between
  // them. Nothing is signed here: the owner already consented in the witness.
  if (journey.state === "arrival_confirmed" && bridgeArrived) {
    const live = journey.refuelAuthorization?.state;
    if (live === "recorded" || live === "executing" || live === "retry_scheduled") {
      return {
        ...base,
        disposition: "resume_safe",
        status: "replay_safe",
        nextAtomicStep: "poll_refuel",
        replaySafe: true,
        walletActionRequired: false,
        revalidateAfterMs: 10_000,
        reason: "Your refuel is pre-authorized and running; it converts automatically and needs no further wallet action.",
      };
    }
  }
  if (journey.state === "arrival_confirmed") {
    return mode === "bridge_only" ? {
      ...base,
      disposition: "resume_safe",
      status: "replay_safe",
      nextAtomicStep: "poll_bridge",
      replaySafe: true,
      walletActionRequired: false,
      reason: "Bridge-only arrival can be terminalized without a wallet action.",
    } : {
      ...base,
      disposition: "action_required",
      status: "action_required",
      nextAtomicStep: "destination_wallet_consent",
      replaySafe: false,
      walletActionRequired: true,
      reason: "Arrival is durable; the next refuel step requires fresh explicit wallet consent.",
    };
  }
  // Nothing is in flight here (unknown/consumed evidence returned above): the
  // remaining refuel legs are simply unstarted, and each one still needs its own
  // explicit wallet click. Blocking them would strand a settled x402 payment.
  //
  // `authorizing` is NOT a position in this walk: it is written the moment any
  // intent authorization row is created, and the first such intent is the
  // pre-bridge `activation` leg. Reaching a destination step from the state label
  // alone is what told an owner their funds had arrived on a journey that never
  // broadcast a bridge transaction, so both gates below read durable evidence.
  if (["payment_pending", "payment_settled", "authorizing"].includes(journey.state)) {
    if (!bridgeSubmitted) return preBridgeConsent();
    if (!bridgeArrived) {
      return {
        ...base,
        disposition: "resume_safe",
        status: "replay_safe",
        nextAtomicStep: "poll_bridge",
        replaySafe: true,
        walletActionRequired: false,
        reason: "The source transaction hash is durable but no arrival is recorded yet; provider and destination arrival polling is replay-safe.",
      };
    }
    return {
      ...base,
      disposition: "action_required",
      status: "action_required",
      nextAtomicStep: "destination_wallet_consent",
      replaySafe: false,
      walletActionRequired: true,
      reason: journey.state === "payment_pending"
        ? "The destination approval is durable; the x402 payment still requires fresh explicit wallet consent."
        : "The x402 payment is durable and is never re-charged; each remaining sponsored leg requires fresh explicit wallet consent against a live destination quote.",
    };
  }
  if (["submitting", "execution_pending"].includes(journey.state)) {
    return blocked("A sponsored submission is already in flight. Inspect its authoritative authorization, submission, and receipt state before any continuation.");
  }
  if (["ready", "bridge_ready", "activation_pending"].includes(journey.state)) {
    return preBridgeConsent();
  }
  // Any remaining state that never produced a bridge hash is pre-bridge, whatever
  // its label says. This is last so an in-flight sponsored submission still
  // blocks above rather than being offered as a fresh start.
  if (!bridgeSubmitted) return preBridgeConsent();
  return {
    ...base,
    disposition: "action_required",
    status: "action_required",
    nextAtomicStep: "operator_review",
    replaySafe: false,
    walletActionRequired: false,
    reason: `Journey state ${journey.state} requires explicit review before another mutation.`,
  };
}
