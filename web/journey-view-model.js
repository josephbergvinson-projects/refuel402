const STEPS = [
  ["destination", "Prepare the same Hedera address"],
  ["bridge_submit", "Submit bridge from MetaMask"],
  ["arrival", "Confirm destination arrival"],
  ["permit2", "Approve the payment asset"],
  ["payment", "Settle the x402 fee"],
  ["execution", "Wrap and swap into HBAR"],
  ["reconcile", "Verify receipt and retained balance"],
];

/**
 * The pre-authorized flow in the order it actually happens: everything the
 * wallet has to sign is signed BEFORE the bridge, and nothing after arrival
 * needs the owner at all.
 *
 * The list above still describes the manual fallback, where the allowance, the
 * fee and the conversion really are three post-arrival prompts. Rendering that
 * one for a pre-authorized journey put two signed-before-the-bridge steps after
 * arrival, promised a fee signature this path does not take, and told the owner
 * to expect MetaMask for a conversion that runs unattended.
 */
const PREAUTHORIZED_STEPS = [
  ["destination", "Prepare the same Hedera address"],
  ["permit2", "Approve the payment asset"],
  ["authorize_refuel", "Authorize the refuel"],
  ["bridge_submit", "Submit bridge from MetaMask"],
  ["arrival", "Confirm destination arrival"],
  ["execution", "Convert into HBAR automatically"],
  ["reconcile", "Verify receipt and retained balance"],
];

/**
 * Durable evidence that this journey took the one-signature path: the witness is
 * recorded before the bridge, and the record survives for the whole journey.
 */
export function refuelPreauthorized(journey) {
  return Boolean(journey?.refuelAuthorization) || eventTypes(journey).has("refuel_authorization_recorded");
}

function eventTypes(journey) {
  return new Set((journey?.events ?? []).map((event) => String(event.type ?? "")));
}

/**
 * The one definition of "the transfer landed on Hedera", used by every surface
 * that is about to say so. A journey state name and a recovery step are both
 * derived values that have been wrong; a recorded arrival event is not.
 */
export function bridgeArrived(journey) {
  return eventTypes(journey).has("bridge_arrived");
}

/** The one definition of "the owner's wallet broadcast the origin transaction". */
export function bridgeSubmitted(journey) {
  const types = eventTypes(journey);
  return types.has("bridge_submitted") || types.has("bridge_submission_adopted");
}

function latestAuthorization(journey) {
  return [...(journey?.authorizations ?? [])].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0] ?? null;
}

function authorizationStep(kind) {
  if (kind === "activation") return "bridge_submit";
  if (kind === "permit2_approval") return "permit2";
  if (["wrapper_approval", "wrapper_execution", "router_approval", "router_execution"].includes(kind)) return "execution";
  return null;
}

export function deriveJourneyProgress({ journey, recovery, quoteLive = false, routeMode = "bridge_plus_refuel" } = {}) {
  const types = eventTypes(journey);
  const stepRows = routeMode === "bridge_only"
    ? STEPS.slice(0, 3)
    : refuelPreauthorized(journey) ? PREAUTHORIZED_STEPS : STEPS;
  const done = new Set();
  if (types.has("destination_activation_funded")) done.add("destination");
  if (types.has("bridge_submitted")) done.add("bridge_submit");
  if (types.has("bridge_arrived")) done.add("arrival");
  if (types.has("refuel_authorization_recorded")) done.add("authorize_refuel");
  if (types.has("intent_permit2_approval_confirmed")) done.add("permit2");
  if (journey?.payment || types.has("payment_settled")) done.add("payment");
  if (types.has("intent_router_execution_confirmed")) done.add("execution");
  // A retired draft is terminal but nothing about it was ever done, so it must
  // not inherit the completed-journey shortcut that fills every step.
  // Only the server's own `completed` record fills the rail. A terminal recovery
  // disposition is a derived value, and deriving "every step done" from it is how
  // a journey that did nothing came to render as a finished one.
  if (journey?.state === "completed") {
    for (const [id] of stepRows) done.add(id);
  }

  let current = null;
  const quoteRefreshRequired = recovery?.nextAtomicStep === "destination_wallet_consent" &&
    routeMode === "bridge_plus_refuel" && !quoteLive;
  if (recovery?.nextAtomicStep === "source_wallet_consent") {
    current = done.has("destination") ? "bridge_submit" : "destination";
  } else if (recovery?.nextAtomicStep === "poll_refuel") {
    // Arrival is done and the conversion is running unattended.
    current = done.has("permit2") ? done.has("payment") ? "execution" : "payment" : "permit2";
  } else if (recovery?.nextAtomicStep === "poll_bridge") {
    current = done.has("bridge_submit") ? "arrival" : "bridge_submit";
  } else if (recovery?.nextAtomicStep === "destination_wallet_consent" && quoteLive) {
    current = done.has("permit2") ? done.has("payment") ? "execution" : "payment" : "permit2";
  } else if (["reconcile_submissions", "operator_review"].includes(recovery?.nextAtomicStep)) {
    current = authorizationStep(latestAuthorization(journey)?.intentKind) ??
      (done.has("arrival") ? "permit2" : done.has("bridge_submit") ? "arrival" : "bridge_submit");
  }
  if (!current && !quoteRefreshRequired && recovery?.disposition !== "terminal") {
    current = stepRows.find(([id]) => !done.has(id))?.[0] ?? null;
  }

  return stepRows.map(([id, label]) => {
    const status = done.has(id)
      ? "done"
      : id === current
        ? recovery?.status === "blocked" ? "action_required" : "current"
        : "pending";
    return {
      id,
      label,
      status,
      statusLabel: status === "done" ? "Done" : status === "current" ? "Current" : status === "action_required" ? "Action needed" : "Pending",
    };
  });
}

export function deriveJourneyPresentation({ journey, recovery, quoteLive = false, routeMode = "bridge_plus_refuel" } = {}) {
  const base = {
    progress: deriveJourneyProgress({ journey, recovery, quoteLive, routeMode }),
    // The server's raw lifecycle state used to be the page heading, so a journey
    // read before its decision landed announced itself as "authorizing" or
    // "execution pending". Every branch below that knows something real supplies
    // its own plain title.
    title: "Journey in progress",
    reason: recovery?.reason ?? "Read the authoritative journey state before continuing.",
    action: { kind: "inspect", label: "Inspect journey", disabled: true },
    allowNewTransfer: Boolean(journey),
  };
  if (!journey || !recovery) return base;
  if (journey.state === "abandoned") {
    return {
      ...base,
      title: "Draft retired",
      action: { kind: "complete", label: "Retired", disabled: true },
      reason: recovery.reason,
    };
  }
  if (recovery.disposition === "terminal") {
    return { ...base, title: routeMode === "bridge_only" ? "Bridge complete" : "Journey complete", action: { kind: "complete", label: "Journey complete", disabled: true } };
  }
  if (recovery.nextAtomicStep === "source_wallet_consent") {
    const resend = recovery.sameJourneyResendAllowed === true;
    return {
      ...base,
      title: "No source transaction was broadcast",
      action: resend
        ? { kind: "resend_journey", label: "Send this journey again", disabled: false }
        : { kind: "new_transfer", label: "Start a fresh transfer", disabled: false },
      reason: resend
        ? "Nothing reached a source wallet boundary and no bridge hash exists. A live re-quote can stay on this journey, preserving any completed destination activation."
        : "The prior one-time authorization cannot be safely reused. Start a fresh quote; this journey remains preserved in Activity.",
    };
  }
  if (recovery.nextAtomicStep === "poll_refuel") {
    return {
      ...base,
      title: "Converting to HBAR",
      action: { kind: "wait", label: "Converting automatically…", disabled: true },
      reason: recovery.reason,
    };
  }
  if (recovery.nextAtomicStep === "poll_bridge") {
    return { ...base, title: "Bridge in progress", action: { kind: "wait", label: "Checking bridge arrival…", disabled: true } };
  }
  if (recovery.nextAtomicStep === "destination_wallet_consent") {
    const refuelAuthorization = journey.refuelAuthorization ?? null;
    if (bridgeArrived(journey) && ["recorded", "executing", "retry_scheduled"].includes(refuelAuthorization?.state)) {
      return {
        ...base,
        title: "Your refuel is pre-authorized",
        reason: "When your funds land we convert automatically — you do not need to stay here.",
        action: { kind: "wait", label: "Waiting within your cap…", disabled: true },
      };
    }
    if (bridgeArrived(journey) && refuelAuthorization?.state === "unknown") {
      return {
        ...base,
        title: "Refuel submission outcome is unknown",
        reason: "The authorization will not be retried or replaced until authoritative chain evidence resolves the claimed dispatch.",
        action: { kind: "inspect", label: "Inspect submission evidence", disabled: true },
      };
    }
    if (bridgeArrived(journey) && refuelAuthorization?.state === "expired") {
      return {
        ...base,
        title: "The price stayed above your cap for 2 hours, so nothing was spent",
        reason: "Raise the cap and convert now →",
        action: quoteLive
          ? { kind: "continue_destination", label: "Raise the cap and convert now", disabled: false }
          : { kind: "refresh_destination", label: "Refresh price and raise the cap", disabled: false },
      };
    }
    if (bridgeArrived(journey) && refuelAuthorization?.state === "fallback") {
      return {
        ...base,
        title: "Automatic refuel stopped safely",
        reason: "Nothing was spent above your cap. Review fresh terms and convert manually when you choose.",
        action: quoteLive
          ? { kind: "continue_destination", label: "Review and convert manually", disabled: false }
          : { kind: "refresh_destination", label: "Refresh price for manual completion", disabled: false },
      };
    }
    // A destination step is only meaningful after a recorded arrival. Without one
    // the step is asserted over evidence that does not exist, and the surface must
    // not repeat the assertion as a headline.
    if (!bridgeArrived(journey)) {
      return {
        ...base,
        title: bridgeSubmitted(journey) ? "Bridge has not arrived yet" : "Nothing was bridged",
        action: { kind: "new_transfer", label: "Start a fresh transfer", disabled: false },
        reason: bridgeSubmitted(journey)
          ? "The server offered a destination step, but no arrival is recorded for this journey. Nothing is signed or submitted while that is unresolved."
          : "No bridge transaction was ever broadcast for this journey, so nothing is in flight and nothing was spent. Start a fresh transfer; this journey stays preserved in Activity.",
      };
    }
    return {
      ...base,
      title: "Arrival confirmed",
      reason: quoteLive
        ? "Arrival and the destination quote are ready. Continuing requires fresh explicit wallet consent."
        : "Arrival is confirmed. Get a fresh destination quote to review the remaining route; this does not prompt the wallet, authorize payment, or submit anything.",
      action: quoteLive
        ? { kind: "continue_destination", label: "Continue with destination consent", disabled: false }
        : { kind: "refresh_destination", label: "Get a fresh destination quote", disabled: false },
    };
  }
  if (recovery.nextAtomicStep === "reconcile_submissions") {
    const neverBroadcast = !(journey.authorizations ?? []).some((authorization) => authorization.rawTransactionHash) &&
      !(journey.submissions ?? []).length && !journey.payment;
    return {
      ...base,
      title: neverBroadcast ? "Authorization expired before broadcast" : "Submission evidence needs review",
      action: { kind: "reconcile", label: neverBroadcast ? "Verify and release this journey" : "Verify prior submission evidence", disabled: false },
      reason: neverBroadcast
        ? "No payment, raw transaction hash, or submission exists. A read-only mirror reconciliation can release this journey to its last durable step; nothing is signed or resubmitted."
        : recovery.reason,
    };
  }
  if (recovery.nextAtomicStep === "operator_review" && String(recovery.reason ?? "").includes("/bridge/adopt")) {
    return { ...base, title: "Origin transaction evidence required", action: { kind: "adopt_bridge", label: "Bind origin transaction", disabled: false } };
  }
  if (recovery.disposition === "blocked_unknown_submit_result") {
    return { ...base, title: "Submission outcome is unknown", action: { kind: "inspect", label: "Inspect submission evidence", disabled: true } };
  }
  return base;
}

export function activityActionLabel(action) {
  return action === "resume" ? "Resume" : action === "inspect" ? "Inspect" : "View";
}

// shortJourneyReference lived here: it truncated a journey uuid for display. No
// surface should render one at all, so the helper is gone rather than left
// exported for a future surface to pick up.
