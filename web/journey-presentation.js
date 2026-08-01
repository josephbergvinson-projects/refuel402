import { destinationTermsComparison, formatTokenAmount } from "./product-model.js";
import { bridgeArrived, bridgeSubmitted } from "./journey-view-model.js";
import { bridgeAdoptionOffered } from "./store.js";
import { ORIGIN_TRANSACTION_HASH, WALLET_NETWORKS } from "./wallet.js";

/**
 * Pure presentation derivation for every post-start surface. Components in
 * web/journey/ read these results and render them; they never compute amounts,
 * timings, URLs, or step status themselves.
 *
 * Two rules are load-bearing here:
 *  - the server's own words are relocated, never rewritten: every function that
 *    produces plain language also carries the authoritative text alongside it;
 *  - a link is only ever produced from a reference the server actually recorded.
 */

const HEDERA_TRANSACTION_REFERENCE = /^(0x[0-9a-fA-F]{64}|\d+\.\d+\.\d+[-@]\d+[-.]\d+)$/;

// Plain-language copy for the seven authoritative steps in journey-view-model.js.
// `technicalLabel` keeps that module's wording available behind Details.
const STEP_COPY = {
  destination: {
    title: "Prepare your Hedera address",
    pending: "Associates the arriving token so it can land in your own wallet.",
    current: "Confirming on Hedera.",
    action_required: "This step needs you before anything else can continue.",
    done: "Ready to receive.",
  },
  bridge_submit: {
    title: "Send from your wallet",
    pending: "You approve and send the bridge transaction yourself.",
    current: "Confirm in MetaMask.",
    action_required: "Not sent yet.",
    done: "Sent.",
  },
  arrival: {
    title: "Cross to Hedera",
    pending: "The bridge delivers to the same address you sent from.",
    current: "Waiting for the bridge.",
    action_required: "Arrival needs review.",
    done: "Arrived.",
  },
  permit2: {
    title: "Approve the conversion allowance",
    pending: "One wallet approval, only for the amount this conversion may spend.",
    current: "Approve in MetaMask.",
    action_required: "Not approved yet.",
    done: "Approved.",
  },
  authorize_refuel: {
    title: "Authorize the refuel",
    pending: "One signature, before you bridge, capping what the conversion may spend.",
    current: "Sign in MetaMask.",
    action_required: "Not signed yet.",
    done: "Authorized — nothing more to sign.",
  },
  payment: {
    title: "Pay the service fee",
    pending: "One signature settles the fee for this conversion.",
    current: "Sign in MetaMask.",
    action_required: "Not settled yet.",
    done: "Settled.",
  },
  // On the pre-authorized path this runs unattended: the allowance and the
  // witness were both signed before the bridge, and the fee is taken inside the
  // same conversion. Promising a MetaMask prompt here left owners waiting for
  // one that never arrives.
  execution: {
    title: "Convert into HBAR",
    pending: "Runs automatically when your funds land — gas is sponsored.",
    current: "Converting — no wallet action needed.",
    action_required: "Conversion incomplete.",
    done: "Converted.",
  },
  reconcile: {
    title: "Confirm what you received",
    pending: "The server checks the exact HBAR and the balance you kept.",
    current: "Verifying on-chain.",
    action_required: "Receipt needs review.",
    done: "Verified.",
  },
};

// The destination legs the orchestrator walks, in order. Each one is a separate
// explicit wallet prompt; none of them is ever auto-signed.
const DESTINATION_PROMPTS = [
  { key: "permit2_approval", label: "Approve the conversion allowance", kind: "approval" },
  { key: "payment", label: "Sign the service payment", kind: "payment" },
  { key: "wrapper_approval", label: "Approve the wrapper", kind: "approval", wrapperOnly: true },
  { key: "wrapper_execution", label: "Wrap the asset", kind: "swap", wrapperOnly: true },
  { key: "router_approval", label: "Approve the swap", kind: "approval" },
  { key: "router_execution", label: "Run the swap", kind: "swap" },
];

function latestEvent(journey, type) {
  return [...(journey?.events ?? [])].reverse().find((event) => String(event?.type ?? "") === type) ?? null;
}

function latestAuthorization(journey, intentKind) {
  return [...(journey?.authorizations ?? [])]
    .filter((row) => row?.intentKind === intentKind)
    .sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0))[0] ?? null;
}

export function shortHash(value) {
  const text = String(value ?? "");
  return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

/** HashScan link for a Hedera reference the server recorded. Never guessed. */
export function hederaTransactionUrl(mode, reference) {
  const base = WALLET_NETWORKS[mode === "testnet" ? "testnet" : "mainnet"]?.explorer;
  const value = String(reference ?? "").trim();
  if (!base || !HEDERA_TRANSACTION_REFERENCE.test(value)) return null;
  return `${base}/transaction/${value}`;
}

/**
 * Where to follow the origin leg. The provider's own tracking URL wins when the
 * server stored one, because it follows the cross-chain transfer rather than a
 * single transaction. Otherwise the origin chain's block explorer, taken from the
 * `explorer` field the support catalog declares for that chain — never inferred
 * from a chain id, so a link is only built from a URL somebody wrote down.
 */
export function originTransactionUrl(journey, { networks = [], chainId = null } = {}) {
  const url = latestEvent(journey, "bridge_submission_adopted")?.record?.evidence?.providerUrl;
  if (typeof url === "string" && url.startsWith("https://")) return url;
  const hash = latestEvent(journey, "bridge_submitted")?.record?.sourceTransactionHash
    ?? latestEvent(journey, "bridge_submission_adopted")?.record?.sourceTransactionHash
    ?? null;
  if (!ORIGIN_TRANSACTION_HASH.test(String(hash ?? ""))) return null;
  const target = String(chainId ?? journey?.originChainId ?? "");
  const base = String((networks ?? []).find((network) => String(network.chainId) === target)?.explorer ?? "")
    .replace(/\/$/, "");
  return base.startsWith("https://") ? `${base}/tx/${hash}` : null;
}

function stepEvidence(id, journey, mode, networks) {
  if (id === "destination") {
    const hash = latestAuthorization(journey, "activation")?.ethereumHash;
    return { reference: hash ?? null, href: hederaTransactionUrl(mode, hash), label: "View on HashScan" };
  }
  if (id === "bridge_submit") {
    const hash = latestEvent(journey, "bridge_submitted")?.record?.sourceTransactionHash ?? null;
    const href = originTransactionUrl(journey, { networks });
    return { reference: hash, href, label: href?.includes("/tx/") ? "View on the origin explorer" : "Track on the bridge provider" };
  }
  if (id === "arrival") {
    const record = latestEvent(journey, "bridge_arrived")?.record ?? {};
    const reference = record.destinationTransactionId ?? record.destinationTransactionHash ?? null;
    return { reference, href: hederaTransactionUrl(mode, reference), label: "View on HashScan" };
  }
  if (id === "permit2") {
    const hash = latestAuthorization(journey, "permit2_approval")?.ethereumHash;
    return { reference: hash ?? null, href: hederaTransactionUrl(mode, hash), label: "View on HashScan" };
  }
  if (id === "payment") {
    const reference = journey?.payment?.settlementReference ?? null;
    return { reference, href: hederaTransactionUrl(mode, reference), label: "View on HashScan" };
  }
  if (id === "execution") {
    // The pre-authorized conversion is one contract call by the executor, so it
    // has no wallet authorization row to read a hash from. Without this the one
    // step the owner most wants to verify — where their HBAR came from — was the
    // only step on a completed journey with nothing to click.
    const hash = journey?.refuelAuthorization?.executionReference
      ?? latestAuthorization(journey, "router_execution")?.ethereumHash
      ?? latestAuthorization(journey, "wrapper_execution")?.ethereumHash;
    return { reference: hash ?? null, href: hederaTransactionUrl(mode, hash), label: "View on HashScan" };
  }
  return { reference: null, href: null, label: null };
}

/**
 * Plain-language rows for the vertical timeline, built on top of the
 * authoritative status rows from deriveJourneyProgress.
 */
export function journeySteps({ progress = [], journey = null, mode = "mainnet", networks = [] } = {}) {
  return progress.map((step) => {
    const copy = STEP_COPY[step.id] ?? {};
    const evidence = stepEvidence(step.id, journey, mode, networks);
    return {
      id: step.id,
      status: step.status,
      statusLabel: step.statusLabel,
      title: copy.title ?? step.label,
      technicalLabel: step.label,
      // Only what is happening now, or what already happened, carries a line of
      // prose. Explaining every future step as well made a seven-line rail read
      // as a wizard that walks you through each one, when in truth the wallet
      // work is finished up front and the rest is the server reporting back.
      detail: step.status === "pending" ? null : (copy[step.status] ?? null),
      reference: evidence.reference,
      referenceShort: evidence.reference ? shortHash(evidence.reference) : null,
      link: evidence.href ? { href: evidence.href, label: evidence.label } : null,
    };
  });
}

/**
 * Provider ETA for the bridge wait. It is an estimate from the quote, not a
 * promise: once it is exceeded the chip says so instead of counting past zero.
 */
export function bridgeEta({ journey = null, quote = null, nowMs = Date.now() } = {}) {
  const submitted = latestEvent(journey, "bridge_submitted");
  const estimateSeconds = Number(quote?.bridge?.estimatedSeconds ?? 0);
  if (!submitted || !Number.isFinite(estimateSeconds) || estimateSeconds <= 0) return null;
  const estimateMinutes = Math.max(1, Math.round(estimateSeconds / 60));
  const submittedAt = Number(submitted.createdAt ?? 0);
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) {
    return { label: `~${estimateMinutes} min`, overdue: false, estimateMinutes, remainingMinutes: estimateMinutes, hint: etaHint(estimateMinutes) };
  }
  const remainingSeconds = estimateSeconds - (nowMs - submittedAt) / 1000;
  if (remainingSeconds <= 0) {
    return {
      label: `Over the ~${estimateMinutes} min estimate`,
      overdue: true,
      estimateMinutes,
      remainingMinutes: 0,
      hint: etaHint(estimateMinutes),
    };
  }
  const remainingMinutes = Math.max(1, Math.round(remainingSeconds / 60));
  return { label: `~${remainingMinutes} min left`, overdue: false, estimateMinutes, remainingMinutes, hint: etaHint(estimateMinutes) };
}

function etaHint(estimateMinutes) {
  return `The bridge provider quoted about ${estimateMinutes} minutes. Arrival is confirmed from chain evidence, not from this timer.`;
}

/** One line of honest context while the bridge poll is running. */
export function bridgeWaitNote(checkpoint) {
  if (!checkpoint || checkpoint.phase !== "bridge_pending") return null;
  const elapsed = Math.max(0, Math.round(Number(checkpoint.elapsedMs ?? 0) / 1000));
  // The provider's own status word used to lead this line ("source gateway
  // called"). It is the bridge's internal vocabulary, it is not checkable by the
  // person reading it, and it crowded out the only fact here that is: how long
  // this has been running.
  return `Still checking · last checked ${elapsed}s after you sent it`;
}

function assetFormat(quote) {
  const symbol = quote?.asset?.symbol ?? "asset";
  const decimals = Number(quote?.asset?.destination?.decimals ?? 0);
  return (value) => {
    const amount = formatTokenAmount(value ?? 0, decimals, symbol);
    return { display: `${amount.display} ${symbol}`, full: `${amount.full} ${symbol}` };
  };
}

/**
 * The three-or-four figures the arrival consent is made of, in the same order
 * the server compares them in QUOTE_ECONOMICS_WORSENED.
 */
export function arrivalSummary(quote) {
  const destination = quote?.amountLedger?.destination;
  const hbarLedger = quote?.amountLedger?.hbar;
  if (!destination || !hbarLedger) return null;
  const asset = assetFormat(quote);
  const hbar = formatTokenAmount(hbarLedger.exactOutputTinybar ?? 0, 8, "HBAR");
  const converts = asset(destination.swapInputMaximum);
  const fee = asset(destination.x402ProtocolFee);
  const keeps = asset(destination.remainingAtMinimum);
  return {
    symbol: quote?.asset?.symbol ?? "asset",
    exactHbar: hbar,
    rows: [
      { key: "converts", label: "Converts at most", value: `≤ ${converts.display}`, title: `at most ${converts.full}` },
      { key: "fee", label: "Service fee", value: fee.display, title: fee.full },
      { key: "keeps", label: "You keep at least", value: `≥ ${keeps.display}`, title: `at least ${keeps.full}` },
      { key: "hbar", label: "You receive", value: `exactly ${hbar.display} HBAR`, title: `exactly ${hbar.full} HBAR`, accent: true },
    ],
  };
}

/** What the server recorded as actually credited at the destination. */
export function arrivedAmount({ journey = null, quote = null } = {}) {
  const received = latestEvent(journey, "bridge_arrived")?.record?.destinationAmountReceived;
  if (received === undefined || received === null) return null;
  return assetFormat(quote)(received);
}

/**
 * The single test for "did this transfer actually land". Only a recorded
 * `bridge_arrived` event answers it — never a journey state name, and never a
 * recovery step. A server decision that names a destination step on a journey
 * with no arrival event is a contradiction, and the surface that renders it must
 * say what the server says instead of celebrating an arrival that never happened.
 */
export function bridgeArrivalEvidence(journey) {
  if (!bridgeArrived(journey)) return null;
  const event = latestEvent(journey, "bridge_arrived");
  const record = event?.record ?? {};
  return {
    confirmed: true,
    reference: record.destinationTransactionId ?? record.destinationTransactionHash ?? null,
    amountReceived: record.destinationAmountReceived ?? null,
    at: event?.createdAt ?? null,
  };
}

/** Did the owner's wallet ever broadcast the origin bridge transaction? */
export function bridgeSubmissionEvidence(journey) {
  if (!bridgeSubmitted(journey)) return null;
  const submitted = latestEvent(journey, "bridge_submitted") ?? latestEvent(journey, "bridge_submission_adopted");
  const record = submitted?.record ?? {};
  return {
    reference: record.sourceTransactionHash ?? null,
    adopted: submitted?.type === "bridge_submission_adopted",
    at: submitted?.createdAt ?? null,
  };
}

function completedLegs(journey) {
  const done = new Set(
    (journey?.events ?? [])
      .map((event) => /^intent_(.+)_confirmed$/.exec(String(event?.type ?? ""))?.[1])
      .filter(Boolean),
  );
  if (journey?.payment) done.add("payment");
  return done;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * How many wallet prompts are still ahead, derived from server evidence for the
 * legs already durable. Nothing here signs; it only tells the truth about what
 * the next click will ask for.
 */
export function walletPromptPlan({ journey = null, quote = null } = {}) {
  const wrapper = Boolean(quote?.asset?.destination?.wrapper);
  const done = completedLegs(journey);
  // A live pre-authorization has already bought every one of these with the
  // witness the owner signed before bridging. Counting them anyway announced
  // "5 wallet confirmations · 2 approvals · 1 payment signature" to someone who
  // will not be asked for a single one.
  const preauthorized = ["recorded", "executing", "retry_scheduled"]
    .includes(String(journey?.refuelAuthorization?.state ?? ""));
  const remaining = preauthorized
    ? []
    : DESTINATION_PROMPTS
      .filter((prompt) => (!prompt.wrapperOnly || wrapper) && !done.has(prompt.key));
  const counts = remaining.reduce((totals, prompt) => ({ ...totals, [prompt.kind]: (totals[prompt.kind] ?? 0) + 1 }), {});
  const parts = [];
  if (counts.approval) parts.push(countLabel(counts.approval, "approval", "approvals"));
  if (counts.payment) parts.push(countLabel(counts.payment, "payment signature", "payment signatures"));
  if (counts.swap) parts.push(countLabel(counts.swap, "conversion step", "conversion steps"));
  return {
    total: remaining.length,
    remaining,
    summary: remaining.length
      ? `${countLabel(remaining.length, "wallet confirmation", "wallet confirmations")} · ${parts.join(" · ")}`
      // "No wallet confirmations remain" is true of a finished journey too, and
      // this one has not finished — it converts on its own from here.
      : preauthorized
        ? "Nothing left to sign — your refuel is already authorized and converts on its own."
        : "No wallet confirmations remain for this journey.",
  };
}

/** Ring geometry inputs for quote freshness. Expiry is never a failure state. */
export function quoteFreshness({ remaining = 0, total = 0, expired = false } = {}) {
  const secondsRemaining = Math.max(0, Math.round(Number(remaining) || 0));
  const window = Math.max(secondsRemaining, Math.round(Number(total) || 0));
  const isExpired = expired || secondsRemaining <= 0;
  return {
    remaining: secondsRemaining,
    total: window,
    expired: isExpired,
    tone: isExpired || secondsRemaining <= 15 ? "warning" : "brand",
    caption: isExpired ? "0" : String(secondsRemaining),
    note: isExpired
      ? "This quote expired. Refreshing asks the server for new numbers — it is not a wallet action and nothing was signed."
      : "Quote freshness. When it expires you refresh it yourself; nothing signs or resubmits automatically.",
  };
}

/** Before/after rows for a server-refused post-consent re-quote. */
export function termsChangeRows(gate, quote) {
  if (!gate?.consented || !gate?.refreshed) return [];
  return destinationTermsComparison(gate, quote).map((row) => ({
    field: row.field,
    label: row.label,
    before: row.consented,
    after: row.refreshed,
    changed: row.changed,
  }));
}

/**
 * A plain restatement of the server's own decision. It describes what the
 * server did or did not observe and what the offered action does — it never
 * diagnoses a cause the server did not name. `reason` stays verbatim beside it.
 */
export function recoveryFraming(recovery) {
  const step = recovery?.nextAtomicStep;
  const reason = recovery?.reason ?? null;
  if (step === "reconcile_submissions") {
    return {
      plain: "The result of an earlier step is not resolved yet. The server can re-read chain evidence and release this journey to its last durable step. Nothing is signed, replayed, or resubmitted.",
      reason,
    };
  }
  if (recovery?.disposition === "blocked_unknown_submit_result") {
    return {
      plain: "One earlier submission has an unknown outcome, so the server will not run anything else on this journey. Your funds and every recorded hash stay exactly where they are.",
      reason,
    };
  }
  if (step === "source_wallet_consent") {
    return {
      plain: "No bridge transaction was ever broadcast for this journey, so nothing is in flight and nothing was spent. A fresh transfer starts cleanly; this journey stays preserved.",
      reason,
    };
  }
  if (step === "operator_review") {
    return {
      plain: "This journey is held for review. No next step is offered until the server changes its decision.",
      reason,
    };
  }
  return { plain: null, reason };
}

export function originHashState(value) {
  const hash = String(value ?? "").trim();
  if (!hash) {
    return { hash, empty: true, valid: false, message: "Paste the origin transaction hash your wallet broadcast. Nothing is filled in or guessed for you." };
  }
  if (!ORIGIN_TRANSACTION_HASH.test(hash)) {
    return { hash, empty: false, valid: false, message: "Enter 0x followed by 64 hexadecimal characters." };
  }
  return { hash, empty: false, valid: true, message: "You will sign an ownership consent for this exact hash. The server binds it only if chain and provider evidence match." };
}

/**
 * Which post-start surface to render. The order mirrors derivePrimaryIntent in
 * store.js exactly: the server's worsened-terms gate outranks the provisional
 * re-check, and a provisional decision never renders an actionable card.
 */
export function journeySurface({
  journeyId = null,
  recovery = null,
  recoveryProvisional = false,
  quoteConsentGate = null,
  routeMode = "bridge_plus_refuel",
  arrivalConfirmed = false,
} = {}) {
  if (!journeyId) return "timeline";
  if (quoteConsentGate) return "terms_changed";
  if (recoveryProvisional) return "rechecking";
  if (!recovery) return "timeline";
  if (bridgeAdoptionOffered(recovery)) return "adopt";
  if (recovery.disposition === "terminal") return "timeline";
  if (recovery.nextAtomicStep === "destination_wallet_consent" && routeMode !== "bridge_only") {
    // The arrival surface is a claim about the owner's money. It is only ever
    // reachable from a recorded arrival, so a destination step asserted without
    // one falls through to the surface that quotes the server verbatim.
    return arrivalConfirmed ? "arrival_consent" : "recovery";
  }
  if (recovery.nextAtomicStep === "poll_refuel") return "timeline";
  if (recovery.nextAtomicStep === "poll_bridge") return "timeline";
  return "recovery";
}

/** Heading for a surface, in the user's words, with the server's title kept. */
export function journeyHeading({ surface = "timeline", recovery = null, routeMode = "bridge_plus_refuel", presentation = null } = {}) {
  // deriveJourneyPresentation's title is already plain for the decisions that
  // have one; the server's own state name stays in the Details evidence rows.
  const serverTitle = presentation?.title ?? null;
  if (surface === "rechecking") return { title: "Checking this journey" };
  if (surface === "terms_changed") return { title: "The route price moved" };
  if (surface === "adopt") return { title: "We need the transaction hash" };
  if (surface === "arrival_consent") return { title: "Your funds arrived" };
  if (recovery?.disposition === "terminal") {
    // A retired draft is terminal but nothing was completed, so the view
    // model's own title wins here rather than being overwritten with a
    // congratulation the owner never earned.
    if (recovery.state === "abandoned") return { title: serverTitle ?? "Draft retired" };
    return { title: routeMode === "bridge_only" ? "Bridge complete" : "Journey complete" };
  }
  if (surface === "recovery") return { title: serverTitle ?? "This journey needs a decision" };
  if (recovery?.nextAtomicStep === "poll_refuel") return { title: "Converting to HBAR" };
  if (recovery?.nextAtomicStep === "poll_bridge") return { title: "Bridging to Hedera" };
  return { title: serverTitle ?? "Journey in progress" };
}

/** One-line identity for the header: short reference plus the consented route. */
export function journeySubtitle({ quote = null, routeMode = "bridge_plus_refuel" } = {}) {
  // The journey uuid used to lead this line. It named the record rather than the
  // transfer; the amounts do the identifying, and the id is one labelled support
  // reference at the end of Details.
  const parts = [];
  const source = quote?.bridge?.normalized?.sourceAmount;
  const destination = quote?.amountLedger?.destination;
  if (source?.amount !== undefined && source?.decimals !== undefined) {
    const amount = formatTokenAmount(source.amount, source.decimals, source.symbol);
    parts.push(`${amount.display} ${source.symbol}`);
  }
  if (destination?.remainingAtMinimum !== undefined) {
    const asset = assetFormat(quote);
    const kept = asset(destination.remainingAtMinimum);
    const exact = quote?.amountLedger?.hbar?.exactOutputTinybar;
    const hbar = routeMode === "bridge_only" || !exact
      ? null
      : `${formatTokenAmount(exact, 8, "HBAR").display} HBAR`;
    parts.push(hbar ? `≥ ${kept.display} + exactly ${hbar}` : `≥ ${kept.display}`);
  }
  return parts.join(" · ");
}

/** Plain-language copy for the one primary action, keyed on the store intent. */
export function primaryActionCopy(intent, context = {}) {
  const { presentation = null, routeMode = "bridge_plus_refuel", exactHbar = null, quoteRefresh = null } = context;
  const kind = intent?.kind ?? "busy";
  if (kind === "connect_wallet") return { label: "Connect MetaMask", note: "One wallet from origin to Hedera." };
  if (kind === "busy") {
    if (quoteRefresh) {
      return {
        label: "Refreshing the quote…",
        note: "Server-side only: the next step needs more time on the clock. No wallet action, payment, or submission happens while it refreshes.",
      };
    }
    return {
      label: intent?.detail === "recovering" ? "Reading this journey…" : "Checking support…",
      note: "Reading the server record. Nothing is signed or submitted by a read.",
    };
  }
  if (kind === "rechecking") {
    return {
      label: "Re-checking with the server…",
      note: "The locally stored pointer is provisional. Nothing is offered until the server confirms this exact journey.",
    };
  }
  if (kind === "accept_new_terms") {
    return {
      label: "Accept the new terms and continue",
      note: "The route price moved after you approved, so nothing continued and nothing extra was charged. Accepting re-quotes at the live price; if it is still worse than the terms above, the new numbers are shown again instead of continuing.",
    };
  }
  if (kind === "adopt_bridge") {
    return {
      label: "Sign consent and bind this transaction",
      note: "You sign an off-chain ownership consent for the exact hash you entered. Nothing is submitted or resubmitted.",
    };
  }
  if (kind === "reconcile") {
    return {
      label: presentation?.action?.label ?? "Verify prior submission evidence",
      note: "A read-only check against chain evidence. Nothing is signed, replayed, or resubmitted.",
    };
  }
  if (kind === "new_transfer") {
    return { label: "Start a fresh transfer", note: "This journey stays preserved in Activity exactly as the server recorded it." };
  }
  if (kind === "resend_journey") {
    return {
      label: "Send this journey again",
      note: "A live re-quote is bound to this same journey before any wallet boundary. You still approve the source action in MetaMask.",
    };
  }
  if (kind === "wait_refuel") {
    return {
      label: "Converting automatically…",
      note: "You already authorized this conversion, within your cap. Nothing else needs signing, and you can close this tab.",
    };
  }
  if (kind === "wait_bridge") {
    return { label: "Waiting for arrival", note: "Arrival is checked for you. No wallet action is needed at this step." };
  }
  if (kind === "continue_destination") {
    return {
      label: exactHbar ? `Approve conversion → ${exactHbar} HBAR` : "Approve the conversion",
      note: "You are prompted step by step in MetaMask and can cancel at any prompt.",
    };
  }
  if (kind === "refresh_destination") {
    return {
      label: "Refresh the quote",
      note: "Refreshing is not a wallet action: it asks the server for current numbers so you can review them before consenting.",
    };
  }
  if (kind === "complete") {
    if (presentation?.action?.label === "Retired") {
      return {
        label: "Retired",
        note: "You retired this draft. Its server record and events are preserved; nothing was deleted.",
      };
    }
    return {
      label: routeMode === "bridge_only" ? "Bridge complete" : "Journey complete",
      note: "This journey is finished. Its server record stays available in Activity.",
    };
  }
  if (kind === "blocked") {
    return {
      label: "Needs review before anything continues",
      note: "This journey will not be replayed. Its immutable reference is preserved if you start a separate transfer.",
    };
  }
  // An unmapped intent degrades to a neutral word. It used to print the store's
  // own vocabulary onto the one primary button.
  return { label: "Continue", note: presentation?.reason ?? null };
}

// The wallet-signed legs that produce a Hedera transaction, in walk order.
const AUTHORIZATION_EVIDENCE = [
  ["activation", "Hedera token association"],
  ["permit2_approval", "Allowance approval"],
  ["wrapper_approval", "Wrapper approval"],
  ["wrapper_execution", "Wrap to HTS"],
  ["router_approval", "Swap approval"],
  ["router_execution", "Conversion to HBAR"],
];

/**
 * The Details disclosure: what happened on chain, and where to go and check it.
 *
 * This used to be the internal lifecycle dumped verbatim — journey id, recovery
 * disposition, next atomic step, replay-safe and wallet-action booleans, route
 * mode, quote id and expiry, an x402 payment identity, a poll counter, and one row
 * per authorization and submission carrying its internal state name. None of that
 * is checkable by the person reading it, and it crowded out the two things that
 * are: the transaction hashes, and a link to an explorer that can confirm them.
 *
 * Every row here is a real reference the server recorded, hyperlinked wherever the
 * chain it belongs to declares an explorer. Amounts come from the same records.
 * Nothing else survives: the journey uuid used to close this list as a "Support
 * reference", and a uuid is not a thing an owner can check, compare, or act on.
 */
export function evidenceRows({
  journey = null,
  quote = null,
  mode = "mainnet",
  networks = [],
} = {}) {
  const submitted = latestEvent(journey, "bridge_submitted")?.record
    ?? latestEvent(journey, "bridge_submission_adopted")?.record
    ?? {};
  const arrived = latestEvent(journey, "bridge_arrived")?.record ?? {};
  const asset = assetFormat(quote);
  const rows = [];
  const seen = new Set();
  const push = (label, value, { title = null, href = null } = {}) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value), title: title ?? String(value), href });
  };
  // A reference is always shortened for display and kept whole in the title, so a
  // hash stays copyable and comparable without stretching the row. Each distinct
  // hash appears once: the same transaction reaches this function from more than
  // one server record.
  const reference = (label, value, href) => {
    if (!value || seen.has(String(value))) return;
    seen.add(String(value));
    push(label, shortHash(String(value)), { title: String(value), href: href ?? null });
  };

  reference(
    "Origin transaction",
    submitted.sourceTransactionHash,
    originTransactionUrl(journey, { networks, chainId: journey?.originChainId }),
  );
  const credit = arrived.destinationTransactionId ?? arrived.destinationTransactionHash ?? null;
  reference("Arrival on Hedera", credit, hederaTransactionUrl(mode, credit));
  if (arrived.destinationAmountReceived !== undefined && arrived.destinationAmountReceived !== null) {
    const amount = asset(arrived.destinationAmountReceived);
    push("Amount credited", amount.display, { title: amount.full });
  }
  for (const [kind, label] of AUTHORIZATION_EVIDENCE) {
    const hash = latestAuthorization(journey, kind)?.ethereumHash ?? null;
    reference(label, hash, hederaTransactionUrl(mode, hash));
  }
  const settlement = journey?.payment?.settlementReference ?? null;
  reference("Service fee payment", settlement, hederaTransactionUrl(mode, settlement));
  // Any remaining hash the server recorded, and never dropped just because this
  // function has no friendly name for its leg: a transaction hash is the evidence.
  // The named legs are already labelled from the table above, so anything reaching
  // here stays generically labelled rather than borrowing the server's internal
  // intent vocabulary ("router approval transaction") for a row heading.
  for (const authorization of journey?.authorizations ?? []) {
    const hash = authorization?.ethereumHash ?? null;
    reference("Sponsored transaction", hash, hederaTransactionUrl(mode, hash));
  }
  for (const submission of journey?.submissions ?? []) {
    const hash = submission?.ethereumHash ?? submission?.rawTransactionHash ?? null;
    reference("Sponsored submission", hash, hederaTransactionUrl(mode, hash));
  }

  const exact = quote?.amountLedger?.hbar?.exactOutputTinybar ?? null;
  if (exact) {
    const hbar = formatTokenAmount(exact, 8, "HBAR");
    push("HBAR requested", `${hbar.display} HBAR`, { title: `${hbar.full} HBAR` });
  }
  // The bridge provider's status enum, the poll counter and the journey uuid all
  // used to close this list. None of the three is checkable by the person reading
  // it: arrival is already stated by the "Arrival on Hedera" hash row and by the
  // timeline, and progress is reported in human words by the wait note.
  return rows;
}

/** Server-bounded, account-scoped Activity row facts. */
/**
 * The pill tone for one activity row. A retired draft is deliberately the
 * quietest tone on the list: it is neither a success nor a problem, and it
 * must never borrow the green that means a transfer actually landed.
 */
export function activityStateTone(state) {
  if (state === "completed") return "success";
  if (state === "review" || state === "failed") return "warning";
  return "neutral";
}

/**
 * Plain words for the server's lifecycle states. Every row used to wear the raw
 * enum — "activation pending", "execution pending", "payment settled" — which is
 * the server's own vocabulary for its state machine and tells the owner nothing
 * about their money. The tone table above already mapped these; only the label was
 * left unmapped. Anything unrecognized reads as "In progress" rather than leaking
 * a new enum the moment the server grows one.
 */
const ACTIVITY_STATE_LABELS = {
  completed: "Complete",
  review: "Needs review",
  failed: "Stopped",
  abandoned: "Retired draft",
  ready: "Draft",
  bridge_ready: "Draft",
  bridge_pending: "Bridging",
  arrival_confirmed: "Arrived",
};

export function activityStateLabel(state) {
  return ACTIVITY_STATE_LABELS[state] ?? "In progress";
}

export function activityFacts(row) {
  const facts = [];
  if (row?.sourceAmount) {
    const amount = formatTokenAmount(row.sourceAmount.amount, row.sourceAmount.decimals, row.sourceAmount.symbol);
    facts.push({ key: "source", text: `${amount.display} ${row.sourceAmount.symbol}`, title: `${amount.full} ${row.sourceAmount.symbol}` });
  }
  if (row?.minimumRetained !== null && row?.minimumRetained !== undefined) {
    const amount = formatTokenAmount(row.minimumRetained, row.destinationDecimals, row.assetSymbol);
    facts.push({ key: "retained", text: `≥ ${amount.display} ${row.assetSymbol} kept`, title: `at least ${amount.full} ${row.assetSymbol}` });
  }
  if (row?.exactHbarTinybar !== null && row?.exactHbarTinybar !== undefined && BigInt(row.exactHbarTinybar) > 0n) {
    const amount = formatTokenAmount(row.exactHbarTinybar, 8, "HBAR");
    facts.push({ key: "hbar", text: `exactly ${amount.display} HBAR`, title: `exactly ${amount.full} HBAR` });
  }
  return {
    title: row?.sourceAmount ? `${row.sourceAmount.symbol} to Hedera` : String(row?.assetSymbol ?? "Journey"),
    state: activityStateLabel(row?.state),
    // No internal id: the list carries no transaction hash to link, and a truncated
    // uuid is not something the reader can check or act on. Asset, amounts and time
    // identify a row; Details on the opened journey holds the on-chain references.
    facts,
  };
}
