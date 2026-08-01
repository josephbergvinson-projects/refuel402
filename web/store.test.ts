import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { bridgeAdoptionOffered, derivePrimaryIntent, orchestrationFailureMessage, RECOVERY_REPOLL_MS, ORIGIN_TRANSACTION_HASH } from "./store.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(root, "store.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.jsx"), "utf8");
const section = (from: string, to: string) => store.slice(store.indexOf(from), store.indexOf(to));

const HASH = `0x${"5d".repeat(32)}`;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    loading: false,
    error: null,
    quoteRefresh: null,
    quoteConsentGate: null,
    journeyId: null,
    recoveryProvisional: false,
    recovery: null,
    routeMode: "bridge_plus_refuel",
    destinationQuoteLive: false,
    provider: { id: "auto", label: "Auto" },
    network: { chainId: 1, name: "Ethereum" },
    token: { id: "t", symbol: "USDC", disabled: false, blockers: [] },
    desiredHbarError: null,
    phase: "ready",
    quote: { capabilities: { execute: true } },
    quoteStale: false,
    quoteExpired: false,
    bridgeAdoptionHash: "",
    ...overrides,
  };
}

describe("orchestration failure copy", () => {
  it("acknowledges a completed sponsored activation without claiming the whole journey sent nothing", () => {
    const message = orchestrationFailureMessage(
      new Error("The saved quote could not prepare the Permit2 approval."),
      { journey: { events: [{ type: "intent_activation_confirmed" }] } },
    );
    expect(message).toContain("Destination setup completed");
    expect(message).toContain("no origin approval or bridge was sent");
    expect(message).not.toContain("nothing was sent");
  });

  it("defers to authoritative recovery when source-side evidence exists", () => {
    const message = orchestrationFailureMessage(
      new Error("The request stopped."),
      { journey: { events: [{ type: "bridge_wallet_boundary" }] } },
    );
    expect(message).toContain("recorded source-side evidence");
    expect(message).toContain("nothing will be replayed automatically");
  });

  it("preserves the original message before any durable event exists", () => {
    expect(orchestrationFailureMessage(new Error("No mutation occurred."), { journey: { events: [] } }))
      .toBe("No mutation occurred.");
  });
});

describe("compose defaults", () => {
  // Every invalidation message describes a quote going stale ("refresh to bind
  // the new maximum"). Firing one before the first quote exists reported a
  // problem with a quote that was never taken — changing a setting while
  // composing is just composing.
  it("only warns that a quote went stale when there was a quote to invalidate", () => {
    expect(store).toContain("const hadQuote = Boolean(quoteValue.peek())");
    expect(store).toContain("if (message && hadQuote) errorValue.value = message");
    // The single gate must cover every caller, so no writer may set the message
    // outside invalidateQuote's own two branches.
    expect(store.match(/if \(message\) errorValue\.value = message/g) ?? []).toHaveLength(1);
  });

  // The server's published default is what actually lands in the field; the
  // signal's initial value is only what shows before options resolve. Both had
  // to move, and the Railway env carried an explicit 100000000 that beat the
  // code default silently — so all three are asserted, not just the visible one.
  it("opens on 10 HBAR, the first preset, not on 1", () => {
    expect(store).toContain('const desiredHbarValue = signal("10")');
    expect(store).not.toContain('const desiredHbarValue = signal("1")');
    expect(store).not.toContain('defaults?.desiredHbar ?? "1"');
    expect(store.match(/defaults\?\.desiredHbar \?\? "10"/g)).toHaveLength(2);
  });
});

describe("store phase discipline", () => {
  it("writes the journey phase from exactly one site, through the enforced transition map", () => {
    expect(store.match(/phaseValue\.value\s*=(?!=)/g)).toHaveLength(1);
    expect(store).toContain("phaseValue.value = options?.reset ? next : transitionJourney(phaseValue.peek(), next, options)");
    expect(store).toContain('if (options?.reset && !JOURNEY_STATES.includes(next)) throw new Error("unknown journey state")');
    // Components can only read the phase: `state.phase` is a computed.
    expect(store).toContain("phase: computed(() => phaseValue.value)");
  });

  it("keeps the authoritative-landing escape hatch on server decisions only", () => {
    const apply = section("function applyServerJourney(response)", "function stopRecoveryPolling()");
    expect(apply).toContain('setPhase("completed", { authoritative: true })');
    expect(apply).toContain('setPhase("recovery_quote_ready", { authoritative: true })');
    expect(apply).toContain('setPhase("recovery_required", { authoritative: true })');
    expect(apply).not.toContain("refreshDestinationQuote");
  });

  it("uses one local reset path with the single out-of-graph landing", () => {
    expect(store).toContain("function resetSelectedJourneyState()");
    expect(store).toContain('setPhase("idle", { reset: true })');
    expect(store.match(/\{ reset: true \}/g)?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("store recovery semantics", () => {
  it("guards recovery against an in-flight run and re-attempted pointers", () => {
    expect(store).toContain("let runInFlight = false");
    expect(store).toContain("if (!account || runInFlight) return");
    expect(store).toContain("recoveryAttemptedFor = identity.journeyId");
    expect(store).toContain("if (!reference.journeyId || recoveryAttemptedFor === reference.journeyId) return");
    expect(store).toContain("let primaryActionInFlight = false");
    expect(store).toContain("if (primaryActionInFlight) return");
    expect(store).toContain("if (walletConnectPromise) return walletConnectPromise");
  });

  it("runs one re-poll at a time and never lands an older decision over a newer one", () => {
    expect(store).toContain("let recoveryRepollInFlight = false");
    expect(store).toContain("const sequence = ++recoveryRepollSequence");
    const repoll = section("async function repollRecoveryDecision()", "async function recoverCurrentJourney(");
    expect(repoll.indexOf("if (sequence !== recoveryRepollSequence) return"))
      .toBeLessThan(repoll.indexOf("applyServerJourney(decision)"));
    expect(repoll).toContain("recoveryRepollInFlight = false");
    expect(RECOVERY_REPOLL_MS).toBe(12_000);
  });

  it("re-polls only safe server reads and never mints a quote unattended", () => {
    const repollable = section("function recoveryRepollable()", "function scheduleRecoveryRepoll()");
    expect(repollable).toContain("if (quoteConsentGateValue.peek()) return false");
    expect(repollable).toContain('if (recovery.nextAtomicStep === "poll_bridge") return recovery.replaySafe === true');
    expect(repollable).toContain("Number.isFinite(recovery.revalidateAfterMs)");
    const timer = section("function startQuoteTimer()", "function restoreRecoveredSelection(");
    expect(timer).not.toContain("refreshDestinationQuote");
    expect(timer).not.toContain("scheduleRecoveryRepoll");
    expect(store).not.toContain("MAX_UNATTENDED_QUOTE_REFRESHES");
    // The only bounded refresh budget is the orchestrator's, surfaced honestly.
    expect(store).toContain("onQuoteRefresh: (event)");
    expect(store).toContain("quoteRefreshValue.value = event.active ? event : null");
  });

  it("treats a local pointer as provisional until the server re-check lands", () => {
    expect(store).toContain("recoveryProvisionalValue.value = true");
    const failure = section("async function recoverCurrentJourney(", "async function refreshRecoveryDestinationQuote()")
      .slice(section("async function recoverCurrentJourney(", "async function refreshRecoveryDestinationQuote()").indexOf("} catch (error) {"));
    expect(failure).toContain("recoveryProvisionalValue.value = true");
    expect(failure).toContain("The server record remains unchanged");
    expect(failure).not.toContain("scheduleRecoveryRepoll");
  });

  it("never persists editable draft fields or provisional lifecycle decisions", () => {
    const persisted = section("function persistJourneyCheckpoint()", "// ----------------------------------------------------------- orchestrator");
    expect(persisted).toContain("journeyId: journeyIdValue.peek()");
    expect(persisted).toContain("mode: modeValue.peek()");
    expect(persisted).toContain("routeMode: routeModeValue.peek()");
    for (const leak of ["quote:", "journey:", "recovery:", "sourceAmount", "desiredHbar", "slippage", "events"]) {
      expect(persisted).not.toContain(leak);
    }
  });

  it("detaches locally without deleting, replaying, or mutating the server journey", () => {
    const detach = section("async function startNewTransfer()", "// --------------------------------------------------------------- activity");
    expect(detach).toContain("persistence.clear(account)");
    expect(detach).toContain("resetSelectedJourneyState()");
    expect(detach).not.toContain("orchestrator.");
    expect(detach).not.toContain("client.");
    expect(detach).not.toContain("fetch(");
  });

  it("gates worsened post-consent terms behind exactly one explicit acceptance", () => {
    expect(store).toContain("function raiseTermsGate(error)");
    expect(store).toContain('error?.body?.code === "QUOTE_ECONOMICS_WORSENED" ? error.body.details : null');
    const gate = section("function raiseTermsGate(error)", "function resetTokenBalance(");
    expect(gate).not.toContain("executeJourney");
    expect(gate).not.toContain("continueRefuel");
    expect(gate).not.toContain("wallet.");
    const execute = section("async function executeJourney()", "async function reconcileSubmissions()");
    expect(execute).toContain("const acceptedNewTerms = Boolean(quoteConsentGateValue.peek() && journeyIdValue.peek())");
    expect(execute).toContain("orchestrator.refreshDestinationQuote({ journeyId: journeyIdValue.peek() })");
    expect(execute).toContain("if (raiseTermsGate(error)) {");
    // Cleared by the accepting click or local detachment only — never by a
    // timer, read, re-poll, or phase callback.
    expect(store.match(/quoteConsentGateValue\.value = null/g)).toHaveLength(2);
    const onPhase = section("onPhase: (phase)", "onJourney: (identity)");
    expect(onPhase).not.toContain("quoteConsentGate");
  });

  it("binds owner-signed bridge adoption to the typed hash only", () => {
    expect(bridgeAdoptionOffered({ nextAtomicStep: "operator_review", reason: "use /bridge/adopt" })).toBe(true);
    expect(bridgeAdoptionOffered({ nextAtomicStep: "operator_review", reason: "review" })).toBe(false);
    expect(bridgeAdoptionOffered({ nextAtomicStep: "poll_bridge", reason: "/bridge/adopt" })).toBe(false);
    expect(ORIGIN_TRANSACTION_HASH.test(HASH)).toBe(true);
    const adopt = section("async function adoptBridge(", "async function abandonJourney(");
    expect(adopt).toContain("ORIGIN_TRANSACTION_HASH.test(hash)");
    expect(adopt).toContain("wallet.signBridgeAdoption");
    expect(adopt).toContain("client.adoptBridge(journeyIdValue.peek(), { sourceTransactionHash: hash, confirmation })");
    // The hash is the owner's typed value only: never read back from the server
    // journey record, a checkpoint, or a quote.
    expect(adopt).not.toMatch(/journeyValue\b/);
    expect(adopt).not.toMatch(/quoteValue\b/);
    expect(adopt).not.toMatch(/persistence\./);
  });

  it("never navigates destructively and never auto-signs", () => {
    expect(store).not.toMatch(/location\.(reload|assign|replace)/);
    expect(app).not.toMatch(/location\.(reload|assign|replace)/);
    for (const source of [store, app]) {
      expect(source).not.toContain("setInterval(() => actions");
    }
  });

  it("loads options before wallet subscribe/restore", () => {
    const init = section("async function init()", "function dispose()");
    expect(init.indexOf("await loadOptions(modeValue.peek())")).toBeLessThan(init.indexOf("wallet.subscribe"));
    expect(init.indexOf("wallet.subscribe")).toBeLessThan(init.indexOf("wallet.restore()"));
  });

  it("asks the server to solve the maximum HBAR without crossing a wallet boundary", () => {
    const maximum = section("async function requestMaximumHbar()", "// --------------------------------------------------------------- recovery");
    expect(maximum).toContain("solveMaximumHbar: true");
    expect(maximum).toContain("feasibility?.maximumTinybar");
    expect(maximum).not.toContain("wallet.");
  });
});

describe("derivePrimaryIntent", () => {
  it("asks for a wallet before anything else", () => {
    expect(derivePrimaryIntent(snapshot({ account: null })).kind).toBe("connect_wallet");
  });

  it("blocks on an in-flight load", () => {
    const intent = derivePrimaryIntent(snapshot({ loading: true, journeyId: "j" }));
    expect(intent).toMatchObject({ kind: "busy", disabled: true, busy: true, detail: "recovering" });
    expect(derivePrimaryIntent(snapshot({ loading: true, quoteRefresh: { attempt: 1 } })).detail).toBe("quote_refresh");
  });

  it("ranks the worsened-terms gate above the provisional re-check", () => {
    const intent = derivePrimaryIntent(snapshot({
      journeyId: "j",
      recoveryProvisional: true,
      quoteConsentGate: { consented: {}, refreshed: {} },
    }));
    expect(intent.kind).toBe("accept_new_terms");
    expect(intent.disabled).toBe(false);
    expect(intent.allowNewTransfer).toBe(true);
  });

  it("offers nothing while a locally-pointed journey is still provisional", () => {
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recoveryProvisional: true })))
      .toMatchObject({ kind: "rechecking", disabled: true, allowNewTransfer: false });
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recoveryProvisional: true, error: "read failed" })).allowNewTransfer).toBe(true);
  });

  it("maps each server recovery decision onto one action", () => {
    const withRecovery = (recovery: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      derivePrimaryIntent(snapshot({ journeyId: "j", recovery, ...extra }));
    expect(withRecovery({ disposition: "terminal" })).toMatchObject({ kind: "complete", disabled: true, allowNewTransfer: true });
    expect(withRecovery({ nextAtomicStep: "source_wallet_consent" }).kind).toBe("new_transfer");
    expect(withRecovery({ nextAtomicStep: "source_wallet_consent", sameJourneyResendAllowed: true }).kind).toBe("resend_journey");
    expect(withRecovery({ nextAtomicStep: "poll_bridge" })).toMatchObject({ kind: "wait_bridge", disabled: true });
    expect(withRecovery({ nextAtomicStep: "reconcile_submissions" }).kind).toBe("reconcile");
    expect(withRecovery({ disposition: "blocked_unknown_submit_result" })).toMatchObject({ kind: "blocked", disabled: true });
  });

  it("requires a valid typed hash before bridge adoption is clickable", () => {
    const recovery = { nextAtomicStep: "operator_review", reason: "bind via /bridge/adopt" };
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recovery })))
      .toMatchObject({ kind: "adopt_bridge", disabled: true, detail: "hash_required" });
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recovery, bridgeAdoptionHash: "0xabc" })))
      .toMatchObject({ kind: "adopt_bridge", disabled: true, detail: "invalid_hash" });
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recovery, bridgeAdoptionHash: HASH })).disabled).toBe(false);
  });

  it("separates the destination refresh from the destination consent", () => {
    const recovery = { nextAtomicStep: "destination_wallet_consent" };
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recovery })).kind).toBe("refresh_destination");
    expect(derivePrimaryIntent(snapshot({ journeyId: "j", recovery, destinationQuoteLive: true })).kind).toBe("continue_destination");
  });

  it("walks the compose preconditions before offering a quote or a start", () => {
    expect(derivePrimaryIntent(snapshot({ provider: null })).kind).toBe("select_provider");
    expect(derivePrimaryIntent(snapshot({ network: null })).kind).toBe("select_network");
    expect(derivePrimaryIntent(snapshot({ token: null })).kind).toBe("select_token");
    expect(derivePrimaryIntent(snapshot({ token: { disabled: true, blockers: ["STALE_QUOTE"] } })))
      .toMatchObject({ kind: "route_unavailable", disabled: true, detail: "STALE_QUOTE" });
    expect(derivePrimaryIntent(snapshot({ desiredHbarError: "desired HBAR must be greater than zero" })).kind)
      .toBe("invalid_desired_hbar");
    expect(derivePrimaryIntent(snapshot({ phase: "quoting" }))).toMatchObject({ kind: "quoting", disabled: true, busy: true });
    expect(derivePrimaryIntent(snapshot({ quote: null })).kind).toBe("request_quote");
    expect(derivePrimaryIntent(snapshot({ quoteStale: true })).kind).toBe("refresh_quote");
    expect(derivePrimaryIntent(snapshot({ quoteExpired: true })).kind).toBe("refresh_quote");
    expect(derivePrimaryIntent(snapshot({ quote: { capabilities: { execute: false } } })))
      .toMatchObject({ kind: "launch_paused", disabled: true });
    expect(derivePrimaryIntent(snapshot()).kind).toBe("start_journey");
  });

  it("ignores the desired-HBAR error in bridge-only mode", () => {
    expect(derivePrimaryIntent(snapshot({ routeMode: "bridge_only", desiredHbarError: "invalid" })).kind)
      .toBe("start_journey");
  });
});
