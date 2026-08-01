import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import {
  activityFacts,
  arrivalSummary,
  arrivedAmount,
  bridgeArrivalEvidence,
  bridgeEta,
  bridgeSubmissionEvidence,
  bridgeWaitNote,
  evidenceRows,
  hederaTransactionUrl,
  journeyHeading,
  journeySteps,
  journeySubtitle,
  journeySurface,
  originHashState,
  originTransactionUrl,
  primaryActionCopy,
  quoteFreshness,
  recoveryFraming,
  shortHash,
  termsChangeRows,
  walletPromptPlan,
} from "./journey-presentation.js";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { deriveJourneyPresentation, deriveJourneyProgress } from "./journey-view-model.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(root, "journey", file), "utf8");
const surfaces = ["JourneyView.jsx", "JourneyTimeline.jsx", "ArrivalConsent.jsx", "RecoveryCard.jsx", "AdoptCard.jsx", "TermsChangedCard.jsx", "ActivityDrawer.jsx", "JourneyChrome.jsx"];
const allSurfaces = surfaces.map(source).join("\n");

const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const PERMIT2_HASH = `0x${"ef".repeat(32)}`;

function journeyFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "5196c1d4-1c2f-4f3f-9a51-2f0f9c8b60a3",
    account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    state: "bridge_pending",
    payment: null,
    authorizations: [],
    submissions: [],
    events: [],
    ...overrides,
  };
}

function quoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "quote-1",
    expiresAt: 1_800_000_060,
    routeMode: "bridge_plus_refuel",
    asset: { symbol: "USDC.axl", destination: { decimals: 6 } },
    bridge: {
      estimatedSeconds: 1080,
      normalized: { sourceAmount: { amount: "25000000", decimals: 6, symbol: "USDC" } },
    },
    amountLedger: {
      source: { input: "25000000" },
      destination: { swapInputMaximum: "1380000", x402ProtocolFee: "550000", remainingAtMinimum: "23610000" },
      hbar: { exactOutputTinybar: "1000000000" },
    },
    ...overrides,
  };
}

const recovery = (overrides: Record<string, unknown> = {}) => ({
  schema: "refuel402.product-recovery.v1",
  journeyId: "5196c1d4-1c2f-4f3f-9a51-2f0f9c8b60a3",
  routeMode: "bridge_plus_refuel",
  state: "bridge_pending",
  disposition: "resume_safe",
  status: "replay_safe",
  nextAtomicStep: "poll_bridge",
  replaySafe: true,
  walletActionRequired: false,
  autoSignAllowed: false,
  autoSubmitAllowed: false,
  reason: "The source transaction hash is durable; provider and destination arrival polling is replay-safe.",
  ...overrides,
});

describe("journey surface routing", () => {
  const base = { journeyId: "5196c1d4-1c2f-4f3f-9a51-2f0f9c8b60a3", routeMode: "bridge_plus_refuel" };

  it("puts the server's worsened-terms gate above the provisional re-check, mirroring the intent table", () => {
    expect(journeySurface({
      ...base,
      quoteConsentGate: { consented: {}, refreshed: {} },
      recoveryProvisional: true,
      recovery: recovery({ nextAtomicStep: "destination_wallet_consent", disposition: "action_required" }),
    })).toBe("terms_changed");
  });

  it("never renders an actionable surface over a provisional decision", () => {
    expect(journeySurface({ ...base, recoveryProvisional: true, recovery: null })).toBe("rechecking");
    expect(journeySurface({
      ...base,
      recoveryProvisional: true,
      recovery: recovery({ nextAtomicStep: "destination_wallet_consent", disposition: "action_required" }),
    })).toBe("rechecking");
  });

  it("offers adoption only where the server named that endpoint", () => {
    const adopt = recovery({
      disposition: "blocked_unknown_submit_result",
      status: "blocked",
      nextAtomicStep: "operator_review",
      reason: "A source-wallet consent boundary was reached without an authoritative bridge transaction hash. … POST /v1/product/journeys/:id/bridge/adopt …",
    });
    expect(journeySurface({ ...base, recovery: adopt })).toBe("adopt");
    expect(journeySurface({
      ...base,
      recovery: recovery({ disposition: "blocked_unknown_submit_result", status: "blocked", nextAtomicStep: "operator_review", reason: "held for review" }),
    })).toBe("recovery");
  });

  it("routes arrival consent, waiting, terminal, and every blocked decision", () => {
    expect(journeySurface({
      ...base,
      arrivalConfirmed: true,
      recovery: recovery({ nextAtomicStep: "destination_wallet_consent", disposition: "action_required" }),
    })).toBe("arrival_consent");
    // bridge_only has no destination consent step and must never show that card.
    expect(journeySurface({ ...base, routeMode: "bridge_only", recovery: recovery({ nextAtomicStep: "destination_wallet_consent" }) }))
      .toBe("recovery");
    expect(journeySurface({ ...base, recovery: recovery() })).toBe("timeline");
    expect(journeySurface({ ...base, recovery: recovery({ disposition: "terminal", nextAtomicStep: "none" }) })).toBe("timeline");
    expect(journeySurface({ ...base, recovery: recovery({ nextAtomicStep: "reconcile_submissions", disposition: "operator_review" }) }))
      .toBe("recovery");
    expect(journeySurface({ ...base, recovery: recovery({ nextAtomicStep: "source_wallet_consent", disposition: "action_required" }) }))
      .toBe("recovery");
    expect(journeySurface({ journeyId: null, recovery: null })).toBe("timeline");
  });

  /**
   * Journey c4982fc7 on production: an ETH→WETH + 10 HBAR run died at its first
   * MetaMask prompt, having only created the pre-bridge `activation` authorization.
   * That authorization moved the server record to `authorizing`, the recovery
   * classifier read the state label as a post-payment position and answered
   * `destination_wallet_consent`, and this surface rendered "Your funds arrived"
   * over a journey with no bridge transaction, no arrival, and no payment.
   */
  it("never routes to the arrival surface without a recorded arrival", () => {
    const destinationStep = recovery({ nextAtomicStep: "destination_wallet_consent", disposition: "action_required" });
    expect(journeySurface({ ...base, arrivalConfirmed: false, recovery: destinationStep })).toBe("recovery");
    // Absent the flag entirely — an unmigrated caller must fail closed, not open.
    expect(journeySurface({ ...base, recovery: destinationStep })).toBe("recovery");
  });
});

describe("nothing claims a transfer landed without evidence for it", () => {
  const destinationStep = recovery({ nextAtomicStep: "destination_wallet_consent", disposition: "action_required" });

  it("does not headline an arrival, or fill the rail, on a journey that never bridged", () => {
    const stalled = journeyFixture({
      state: "authorizing",
      events: [{ type: "journey_created" }, { type: "destination_activation_funded" }, { type: "authorization_created" }],
      authorizations: [{ intentKind: "activation", state: "pending", updatedAt: 2 }],
    });
    const presentation = deriveJourneyPresentation({ journey: stalled, recovery: destinationStep, quoteLive: true });
    expect(presentation.title).toBe("Nothing was bridged");
    expect(presentation.action.kind).toBe("new_transfer");
    expect(presentation.reason).toContain("nothing was spent");

    // The Hedera association really was sponsor-funded, so that one step is done
    // on the evidence. Nothing downstream of it is, and none of it may read as done.
    const progress = deriveJourneyProgress({ journey: stalled, recovery: destinationStep, quoteLive: true });
    expect(progress.filter((step: { status: string }) => step.status === "done").map((step: { id: string }) => step.id))
      .toEqual(["destination"]);
    expect(progress.filter((step: { id: string; status: string }) =>
      ["bridge_submit", "arrival", "permit2", "payment", "execution", "reconcile"].includes(step.id)
        && step.status === "done")).toHaveLength(0);
  });

  it("distinguishes a bridge that is late from one that never happened", () => {
    const inFlight = journeyFixture({
      state: "authorizing",
      events: [{ type: "journey_created" }, { type: "bridge_submitted", record: { sourceTransactionHash: HASH } }],
    });
    expect(deriveJourneyPresentation({ journey: inFlight, recovery: destinationStep }).title)
      .toBe("Bridge has not arrived yet");
  });

  it("a terminal disposition alone never fills the rail; only the completed record does", () => {
    const terminal = recovery({ disposition: "terminal", status: "terminal", nextAtomicStep: "none" });
    const nothingHappened = journeyFixture({ state: "authorizing", events: [{ type: "journey_created" }] });
    expect(deriveJourneyProgress({ journey: nothingHappened, recovery: terminal })
      .filter((step: { status: string }) => step.status === "done")).toHaveLength(0);

    const finished = journeyFixture({
      state: "completed",
      events: [{ type: "bridge_submitted" }, { type: "bridge_arrived" }, { type: "journey_reconciled" }],
    });
    expect(deriveJourneyProgress({ journey: finished, recovery: terminal })
      .every((step: { status: string }) => step.status === "done")).toBe(true);
  });

  it("reads arrival and submission from events, not from state names", () => {
    expect(bridgeArrivalEvidence(journeyFixture({ state: "completed", events: [] }))).toBeNull();
    expect(bridgeSubmissionEvidence(journeyFixture({ state: "bridge_pending", events: [] }))).toBeNull();
    const arrived = bridgeArrivalEvidence(journeyFixture({
      events: [{ type: "bridge_arrived", record: { destinationTransactionId: "0.0.1001-1785361003-370000000" } }],
    }));
    expect(arrived.confirmed).toBe(true);
    expect(arrived.reference).toBe("0.0.1001-1785361003-370000000");
  });
});

describe("timeline steps", () => {
  const progress = deriveJourneyProgress({
    journey: journeyFixture({ events: [{ type: "destination_activation_funded" }, { type: "bridge_submitted" }] }),
    recovery: recovery(),
  });

  // The pre-authorized conversion is one executor contract call with no wallet
  // authorization row, so the step the owner most wants to verify — where their
  // HBAR came from — was the only one on a finished journey with nothing to click.
  it("links the pre-authorized conversion to its own execution transaction", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const steps = journeySteps({
      progress: [{ id: "execution", status: "done", label: "Wrap and swap into HBAR", statusLabel: "Done" }],
      journey: { ...journeyFixture(), refuelAuthorization: { state: "completed", executionReference: hash } },
      mode: "mainnet",
    });
    expect(steps[0].reference).toBe(hash);
    expect(steps[0].link?.href).toContain(hash);
    expect(steps[0].link?.label).toBe("View on HashScan");
  });

  it("speaks plain language while keeping the authoritative label available", () => {
    const steps = journeySteps({ progress, journey: journeyFixture(), mode: "mainnet" });
    expect(steps.map((step: { title: string }) => step.title)).toEqual([
      "Prepare your Hedera address",
      "Send from your wallet",
      "Cross to Hedera",
      "Approve the conversion allowance",
      "Pay the service fee",
      "Convert into HBAR",
      "Confirm what you received",
    ]);
    expect(steps[4].technicalLabel).toBe("Settle the x402 fee");
    // Only the live step and the ones already behind you carry prose. Explaining
    // every future step too made the rail read as a wizard that walks you
    // through each one, when the wallet work is finished up front.
    for (const step of steps as Array<{ status: string; detail: string | null }>) {
      if (step.status === "pending") expect(step.detail).toBeNull();
      else expect(typeof step.detail).toBe("string");
    }
    expect(steps.some((step: { detail: string | null }) => typeof step.detail === "string")).toBe(true);
  });

  it("keeps the authoritative status from deriveJourneyProgress untouched", () => {
    const steps = journeySteps({ progress, journey: journeyFixture(), mode: "mainnet" });
    expect(steps.map((step: { status: string }) => step.status)).toEqual(progress.map((step: { status: string }) => step.status));
  });

  it("links a recorded Hedera reference to HashScan for the connected mode only", () => {
    const journey = journeyFixture({
      payment: { settlementReference: OTHER_HASH, paymentIdentity: "pay-1" },
      authorizations: [{ intentKind: "permit2_approval", ethereumHash: HASH, state: "submitted", updatedAt: 2 }],
      events: [
        { type: "bridge_arrived", record: { destinationTransactionId: "0.0.1234-1699999999-123456789" } },
      ],
    });
    const mainnet = journeySteps({ progress, journey, mode: "mainnet" });
    expect(mainnet[2].link.href).toBe("https://hashscan.io/mainnet/transaction/0.0.1234-1699999999-123456789");
    expect(mainnet[3].link.href).toBe(`https://hashscan.io/mainnet/transaction/${HASH}`);
    expect(mainnet[4].link.href).toBe(`https://hashscan.io/mainnet/transaction/${OTHER_HASH}`);
    const testnet = journeySteps({ progress, journey, mode: "testnet" });
    expect(testnet[3].link.href).toBe(`https://hashscan.io/testnet/transaction/${HASH}`);
  });

  it("never invents an origin explorer URL and shows the hash instead", () => {
    const journey = journeyFixture({ events: [{ type: "bridge_submitted", record: { sourceTransactionHash: HASH } }] });
    const [, submit] = journeySteps({ progress, journey, mode: "mainnet" });
    expect(submit.link).toBeNull();
    expect(submit.reference).toBe(HASH);
    expect(submit.referenceShort).toBe(shortHash(HASH));
    expect(submit.referenceShort).not.toContain("...");
  });

  it("uses the provider URL the server stored with adopted evidence when one exists", () => {
    const journey = journeyFixture({
      events: [
        { type: "bridge_submitted", record: { sourceTransactionHash: HASH } },
        { type: "bridge_submission_adopted", record: { evidence: { providerUrl: "https://axelarscan.io/gmp/0xabc" } } },
      ],
    });
    expect(originTransactionUrl(journey)).toBe("https://axelarscan.io/gmp/0xabc");
    expect(journeySteps({ progress, journey, mode: "mainnet" })[1].link).toEqual({
      href: "https://axelarscan.io/gmp/0xabc",
      label: "Track on the bridge provider",
    });
  });

  it("refuses any reference that is not a hash or consensus id the server recorded", () => {
    expect(hederaTransactionUrl("mainnet", "javascript:alert(1)")).toBeNull();
    expect(hederaTransactionUrl("mainnet", "")).toBeNull();
    expect(hederaTransactionUrl("mainnet", null)).toBeNull();
    expect(hederaTransactionUrl("mainnet", "0xnothex")).toBeNull();
    expect(originTransactionUrl(journeyFixture({
      events: [{ type: "bridge_submission_adopted", record: { evidence: { providerUrl: "http://axelarscan.io/gmp/0xabc" } } }],
    }))).toBeNull();
  });
});

describe("bridge ETA and wait note", () => {
  const nowMs = 1_800_000_000_000;

  it("counts down from the provider estimate the quote carries", () => {
    const journey = journeyFixture({ events: [{ type: "bridge_submitted", createdAt: nowMs - 4 * 60_000, record: {} }] });
    const eta = bridgeEta({ journey, quote: quoteFixture(), nowMs });
    expect(eta.label).toBe("~14 min left");
    expect(eta.overdue).toBe(false);
    expect(eta.hint).toContain("Arrival is confirmed from chain evidence");
  });

  it("says the estimate was exceeded instead of counting past zero", () => {
    const journey = journeyFixture({ events: [{ type: "bridge_submitted", createdAt: nowMs - 40 * 60_000, record: {} }] });
    const eta = bridgeEta({ journey, quote: quoteFixture(), nowMs });
    expect(eta.overdue).toBe(true);
    expect(eta.label).toBe("Over the ~18 min estimate");
  });

  it("shows nothing when the quote carries no estimate or nothing was submitted", () => {
    expect(bridgeEta({ journey: journeyFixture(), quote: quoteFixture(), nowMs })).toBeNull();
    expect(bridgeEta({
      journey: journeyFixture({ events: [{ type: "bridge_submitted", createdAt: nowMs, record: {} }] }),
      quote: quoteFixture({ bridge: { estimatedSeconds: 0 } }),
      nowMs,
    })).toBeNull();
  });

  it("reports the poll honestly, in plain words, and only while polling", () => {
    const note = bridgeWaitNote({ phase: "bridge_pending", providerStatus: "source_gateway_called", elapsedMs: 65_000 });
    expect(note).toBe("Still checking · last checked 65s after you sent it");
    // The provider's internal status word must not be quoted at the owner.
    expect(note).not.toContain("source gateway called");
    expect(bridgeWaitNote({ phase: "source_transaction_returned" })).toBeNull();
    expect(bridgeWaitNote(null)).toBeNull();
  });
});

describe("arrival consent figures", () => {
  it("states converts / keeps / receives with full precision behind the title", () => {
    const summary = arrivalSummary(quoteFixture());
    expect(summary.rows.map((row: { value: string }) => row.value)).toEqual([
      "≤ 1.38 USDC.axl",
      "0.55 USDC.axl",
      "≥ 23.61 USDC.axl",
      "exactly 10 HBAR",
    ]);
    expect(summary.rows[3].accent).toBe(true);
    expect(summary.exactHbar.display).toBe("10");
  });

  it("renders a sub-precision amount as a bound, never as zero, and never with an ellipsis", () => {
    const summary = arrivalSummary(quoteFixture({
      asset: { symbol: "USDC", destination: { decimals: 18 } },
      amountLedger: {
        destination: { swapInputMaximum: "1", x402ProtocolFee: "1", remainingAtMinimum: "1" },
        hbar: { exactOutputTinybar: "1000000000" },
      },
    }));
    expect(summary.rows[0].value).toBe("≤ <0.000001 USDC");
    expect(summary.rows[0].title).toBe("at most 0.000000000000000001 USDC");
    for (const row of summary.rows) expect(row.value).not.toContain("…");
  });

  it("reports what the server recorded as credited, or nothing", () => {
    const journey = journeyFixture({ events: [{ type: "bridge_arrived", record: { destinationAmountReceived: "25000000" } }] });
    expect(arrivedAmount({ journey, quote: quoteFixture() })).toEqual({ display: "25 USDC.axl", full: "25 USDC.axl" });
    expect(arrivedAmount({ journey: journeyFixture(), quote: quoteFixture() })).toBeNull();
  });
});

describe("wallet prompt plan", () => {
  it("counts every remaining explicit prompt for a wrapper-free route", () => {
    const plan = walletPromptPlan({ journey: journeyFixture(), quote: quoteFixture() });
    expect(plan.total).toBe(4);
    expect(plan.summary).toBe("4 wallet confirmations · 2 approvals · 1 payment signature · 1 conversion step");
  });

  // A live pre-authorization already bought all of these with the witness signed
  // before bridging. Counting them announced "5 wallet confirmations · 2
  // approvals · 1 payment signature" to someone who will not be asked for one.
  it.each(["recorded", "executing", "retry_scheduled"])(
    "promises no further prompts while a refuel authorization is %s",
    (authState) => {
      const journey = journeyFixture({ refuelAuthorization: { state: authState } });
      const plan = walletPromptPlan({ journey, quote: quoteFixture() });
      expect(plan.total).toBe(0);
      expect(plan.remaining).toEqual([]);
      expect(plan.summary).toBe("Nothing left to sign — your refuel is already authorized and converts on its own.");
    },
  );

  it("counts them again once the authorization is spent or abandoned", () => {
    const journey = journeyFixture({ refuelAuthorization: { state: "fallback" } });
    expect(walletPromptPlan({ journey, quote: quoteFixture() }).total).toBe(4);
  });

  it("adds the wrapper legs only when the quote's asset needs one", () => {
    const quote = quoteFixture({ asset: { symbol: "WBTC", destination: { decimals: 8, wrapper: "0xwrapper" } } });
    expect(walletPromptPlan({ journey: journeyFixture(), quote }).total).toBe(6);
  });

  it("subtracts the legs the server already recorded as durable", () => {
    const journey = journeyFixture({
      payment: { paymentIdentity: "pay-1" },
      events: [{ type: "intent_permit2_approval_confirmed" }, { type: "intent_router_approval_confirmed" }],
    });
    const plan = walletPromptPlan({ journey, quote: quoteFixture() });
    expect(plan.total).toBe(1);
    expect(plan.remaining[0].key).toBe("router_execution");
    expect(walletPromptPlan({
      journey: journeyFixture({
        payment: { paymentIdentity: "pay-1" },
        events: [
          { type: "intent_permit2_approval_confirmed" },
          { type: "intent_router_approval_confirmed" },
          { type: "intent_router_execution_confirmed" },
        ],
      }),
      quote: quoteFixture(),
    }).summary).toBe("No wallet confirmations remain for this journey.");
  });
});

describe("quote freshness", () => {
  it("reads expiry as a refresh, never as a failure", () => {
    const expired = quoteFreshness({ remaining: 0, total: 60, expired: true });
    expect(expired.expired).toBe(true);
    expect(expired.caption).toBe("0");
    expect(expired.note).toContain("not a wallet action");
    expect(expired.note.toLowerCase()).not.toContain("failed");
    expect(quoteFreshness({ remaining: 41, total: 60 }).note).toContain("nothing signs or resubmits automatically");
  });

  it("never lets the ring exceed its own window and warns near the end", () => {
    expect(quoteFreshness({ remaining: 90, total: 60 })).toMatchObject({ remaining: 90, total: 90, tone: "brand" });
    expect(quoteFreshness({ remaining: 9, total: 60 }).tone).toBe("warning");
  });
});

describe("changed terms", () => {
  const gate = {
    consented: { swapInputMaximum: "1380000", minimumRetained: "23610000", desiredHbarTinybar: "1000000000" },
    refreshed: { swapInputMaximum: "1520000", minimumRetained: "23470000", desiredHbarTinybar: "1000000000" },
  };

  it("shows before and after for exactly the three consented figures", () => {
    const rows = termsChangeRows(gate, quoteFixture());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ before: "1.38 USDC.axl", after: "1.52 USDC.axl", changed: true });
    expect(rows[2]).toMatchObject({ before: "10 HBAR", after: "10 HBAR", changed: false });
    expect(termsChangeRows(null, quoteFixture())).toEqual([]);
  });
});

describe("origin hash entry", () => {
  it("accepts only 0x plus 64 hex and never fills anything in", () => {
    expect(originHashState("")).toMatchObject({ empty: true, valid: false });
    expect(originHashState("")).toHaveProperty("hash", "");
    expect(originHashState("0x1234")).toMatchObject({ empty: false, valid: false });
    expect(originHashState("0x1234").message).toContain("64 hexadecimal");
    expect(originHashState(` ${HASH} `)).toMatchObject({ hash: HASH, valid: true });
    expect(originHashState(HASH).message).toContain("ownership consent");
  });
});

describe("evidence and server voice", () => {
  it("holds the on-chain references, linked to an explorer, and no internal lifecycle", () => {
    const journey = journeyFixture({
      originChainId: "1",
      payment: { paymentIdentity: "pay-1", settlementReference: OTHER_HASH },
      // Distinct hashes per leg, as on chain: each reference is listed once.
      authorizations: [{ intentKind: "permit2_approval", state: "submitted", ethereumHash: PERMIT2_HASH, updatedAt: 1 }],
      submissions: [{ state: "unknown", reason: "receipt not observed", rawTransactionHash: PERMIT2_HASH }],
      events: [
        { type: "bridge_submitted", record: { sourceTransactionHash: HASH } },
        { type: "bridge_arrived", record: { destinationTransactionId: "0.0.1-2-3", providerStatus: "executed", destinationAmountReceived: "23610000" } },
      ],
    });
    const rows = evidenceRows({
      journey,
      quote: quoteFixture(),
      mode: "mainnet",
      networks: [{ chainId: "1", name: "Ethereum", explorer: "https://etherscan.io" }],
    });
    const labels = rows.map((row: { label: string }) => row.label);
    // Gone: none of this was checkable by the person reading it.
    for (const retired of [
      "Journey id", "Server journey state", "Recovery disposition", "Next atomic step",
      "Replay safe", "Wallet action required", "Auto-sign / auto-submit", "Route mode",
      "Quote id", "Quote expires", "x402 payment identity", "Server reason", "Submission",
      // The journey uuid used to close this list as a "Support reference", and the
      // provider's status enum and the raw poll counter sat just above it.
      "Support reference", "Provider status", "Arrival checks",
    ]) expect(labels, retired).not.toContain(retired);
    // No row may carry the journey uuid, in its value or in its tooltip.
    for (const row of rows as { value: string; title: string | null }[]) {
      expect(row.value).not.toContain(journey.id);
      expect(row.title ?? "").not.toContain(journey.id);
    }

    // Kept, and hyperlinked to the chain that can confirm it.
    const origin = rows.find((row: { label: string }) => row.label === "Origin transaction");
    expect(origin.value).toBe(shortHash(HASH));
    expect(origin.title).toBe(HASH);
    expect(origin.href).toBe(`https://etherscan.io/tx/${HASH}`);

    const arrival = rows.find((row: { label: string }) => row.label === "Arrival on Hedera");
    expect(arrival.value).toBe("0.0.1-2-3");
    expect(arrival.href).toBe("https://hashscan.io/mainnet/transaction/0.0.1-2-3");

    expect(rows.find((row: { label: string }) => row.label === "Allowance approval").href)
      .toBe(`https://hashscan.io/mainnet/transaction/${PERMIT2_HASH}`);
    // The submission repeats the approval's hash, so it is not listed a second time.
    expect(rows.filter((row: { title: string }) => row.title === PERMIT2_HASH)).toHaveLength(1);
    expect(rows.find((row: { label: string }) => row.label === "Service fee payment").href)
      .toBe(`https://hashscan.io/mainnet/transaction/${OTHER_HASH}`);
    expect(rows.find((row: { label: string }) => row.label === "Amount credited").value).toBe("23.61 USDC.axl");
    // Every row is evidence the owner cannot otherwise see. "HBAR requested" was
    // not: they chose that number, it is in the subtitle above, and early in a
    // journey it was the only row — so Details opened to restate their own input.
    expect(labels).not.toContain("HBAR requested");
    // Every remaining row is something only the server can tell them.
    expect(labels).toContain("Amount credited");
    expect(labels.every((label: string) => label !== "HBAR requested")).toBe(true);
  });

  it("renders nothing at all before there is any evidence to show", () => {
    expect(evidenceRows({
      journey: journeyFixture({ events: [] }),
      quote: { amountLedger: { hbar: { exactOutputTinybar: "1000000000" } } },
    })).toEqual([]);
  });

  it("offers no link for a chain the catalog declares no explorer for", () => {
    const rows = evidenceRows({
      journey: journeyFixture({ originChainId: "999", events: [{ type: "bridge_submitted", record: { sourceTransactionHash: HASH } }] }),
      networks: [{ chainId: "1", explorer: "https://etherscan.io" }],
    });
    const origin = rows.find((row: { label: string }) => row.label === "Origin transaction");
    expect(origin.value).toBe(shortHash(HASH));
    expect(origin.href).toBeNull();
  });

  it("restates the server decision without diagnosing anything it did not say", () => {
    expect(recoveryFraming(recovery({ nextAtomicStep: "reconcile_submissions" })).plain).toContain("Nothing is signed, replayed, or resubmitted");
    expect(recoveryFraming(recovery({ nextAtomicStep: "source_wallet_consent" })).plain).toContain("nothing is in flight");
    expect(recoveryFraming(recovery({ disposition: "blocked_unknown_submit_result", nextAtomicStep: "operator_review" })).plain)
      .toContain("unknown outcome");
    expect(recoveryFraming(recovery()).plain).toBeNull();
    expect(recoveryFraming(recovery()).reason).toBe(recovery().reason);
  });

  it("keeps headings and the identity line honest", () => {
    expect(journeyHeading({ surface: "arrival_consent" }).title).toBe("Your funds arrived");
    expect(journeyHeading({ surface: "timeline", recovery: recovery({ disposition: "terminal" }), routeMode: "bridge_only" }).title)
      .toBe("Bridge complete");
    expect(journeyHeading({ surface: "timeline", recovery: recovery() }).title).toBe("Bridging to Hedera");
    // The identity line names the transfer by its amounts. The journey uuid used to
    // lead it; it identified the record rather than the money that moved.
    expect(journeySubtitle({ quote: quoteFixture() }))
      .toBe("25 USDC · ≥ 23.61 USDC.axl + exactly 10 HBAR");
    expect(journeySubtitle({ quote: quoteFixture(), routeMode: "bridge_only" }))
      .toBe("25 USDC · ≥ 23.61 USDC.axl");
  });
});

describe("primary action copy", () => {
  it("frames a refresh as a read, never as a wallet action or a failure", () => {
    const copy = primaryActionCopy({ kind: "refresh_destination" });
    expect(copy.label).toBe("Refresh the quote");
    expect(copy.note).toContain("not a wallet action");
  });

  it("names the exact HBAR on the consent action", () => {
    expect(primaryActionCopy({ kind: "continue_destination" }, { exactHbar: "10" }).label).toBe("Approve conversion → 10 HBAR");
    expect(primaryActionCopy({ kind: "continue_destination" }, {}).label).toBe("Approve the conversion");
  });

  it("never promises anything about a blocked or accepted-terms journey", () => {
    expect(primaryActionCopy({ kind: "blocked" }).note).toContain("will not be replayed");
    expect(primaryActionCopy({ kind: "accept_new_terms" }).note).toContain("nothing extra was charged");
    expect(primaryActionCopy({ kind: "reconcile" }, { presentation: { action: { label: "Verify and release this journey" } } }).label)
      .toBe("Verify and release this journey");
    expect(primaryActionCopy({ kind: "busy" }, { quoteRefresh: { attempt: 1 } }).note).toContain("No wallet action");
  });
});

describe("activity rows", () => {
  it("summarises a server row without inventing anything", () => {
    const facts = activityFacts({
      journeyId: "5196c1d4-1c2f-4f3f-9a51-2f0f9c8b60a3",
      state: "arrival_confirmed",
      action: "resume",
      sourceAmount: { amount: "25000000", decimals: 6, symbol: "USDC" },
      minimumRetained: "23610000",
      destinationDecimals: 6,
      assetSymbol: "USDC.axl",
      exactHbarTinybar: "1000000000",
    });
    expect(facts.title).toBe("USDC to Hedera");
    // Plain words, not the server's lifecycle enum. Rows used to read
    // "arrival confirmed", "execution pending", "payment settled".
    expect(facts.state).toBe("Arrived");
    // No truncated uuid: the list has no hash to link, so it names the transfer.
    expect(facts.reference).toBeUndefined();
    expect(facts.facts.map((fact: { text: string }) => fact.text)).toEqual([
      "25 USDC",
      "≥ 23.61 USDC.axl kept",
      "exactly 10 HBAR",
    ]);
    expect(activityFacts({ journeyId: "x", state: "ready", assetSymbol: "USDC.axl" }).facts).toEqual([]);
  });
});

describe("journey surface source discipline", () => {
  it("never reloads, navigates, or writes the journey phase", () => {
    expect(allSurfaces).not.toMatch(/location\.(reload|assign|replace)/);
    expect(allSurfaces).not.toMatch(/setPhase|phaseValue/);
    expect(allSurfaces).not.toMatch(/localStorage|sessionStorage/);
  });

  it("routes every wallet-capable action through the store's single dispatch", () => {
    expect(allSurfaces).not.toMatch(/wallet\.|eth_(requestAccounts|sendTransaction|signTypedData_v4|chainId)/);
    expect(allSurfaces).not.toMatch(/orchestrator\./);
    // Only the store's own action entry points may be called from a surface.
    const called = [...allSurfaces.matchAll(/actions\.([A-Za-z]+)/g)].map((match) => match[1]);
    expect([...new Set(called)].sort()).toEqual([
      "abandonJourney",
      "cancelRecovery",
      "closeActivity",
      "loadMoreActivity",
      "selectActivityJourney",
      "setBridgeAdoptionHash",
      "startNewTransfer",
      "submitPrimary",
    ]);
  });

  it("never auto-signs, auto-accepts, or auto-refreshes on mount or on a timer", () => {
    expect(allSurfaces).not.toMatch(/useEffect/);
    expect(allSurfaces).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    // Every dispatch is inside an explicit onClick handler.
    for (const call of allSurfaces.matchAll(/actions\.(submitPrimary|startNewTransfer|selectActivityJourney|loadMoreActivity)\(/g)) {
      const before = allSurfaces.slice(Math.max(0, call.index - 120), call.index);
      expect(before).toMatch(/onClick/);
    }
  });

  it("keeps exactly one Details disclosure per surface and never a bare Disclosure", () => {
    for (const file of ["JourneyTimeline.jsx", "ArrivalConsent.jsx", "RecoveryCard.jsx", "AdoptCard.jsx", "TermsChangedCard.jsx"]) {
      const text = source(file);
      expect(text.match(/<Evidence\b/g)).toHaveLength(1);
      expect(text).not.toMatch(/<Disclosure\b/);
    }
    expect(source("JourneyChrome.jsx").match(/<Disclosure\b/g)).toHaveLength(1);
  });

  it("never auto-fills or guesses the origin transaction hash", () => {
    const adopt = source("AdoptCard.jsx");
    expect(adopt).toContain("value={state.bridgeAdoptionHash.value}");
    expect(adopt).toContain("actions.setBridgeAdoptionHash(event.currentTarget.value)");
    expect(adopt).not.toMatch(/sourceTransactionHash\s*\?\?/);
    expect(adopt).not.toMatch(/defaultValue|autoFill|autofill/);
    expect(adopt).toContain("EIP-712");
  });

  it("scopes Activity to the connected account and resumes only through the server read", () => {
    const drawer = source("ActivityDrawer.jsx");
    expect(drawer).toContain("actions.selectActivityJourney(row.journeyId)");
    expect(drawer).toContain("{account ? active.map(");
    expect(drawer).not.toMatch(/journeyPersistence|persistence\./);
  });

  it("splits drafts from real journeys on the server's own eligibility flag", () => {
    const drawer = source("ActivityDrawer.jsx");
    // The drawer must never re-derive what may be retired; the server says so.
    expect(drawer).toContain("const active = items.filter((row) => !row.abandonable)");
    expect(drawer).toContain("const drafts = items.filter((row) => row.abandonable)");
    expect(drawer).toContain("{row.abandonable");
    expect(drawer).toContain("actions.abandonJourney(row.journeyId)");
    // Retiring one row must not disable every other control in the drawer.
    expect(drawer).toContain("state.activityAbandoning.value");
    expect(drawer).toContain("loading={abandoning === row.journeyId}");
  });

  it("derives every amount in the presentation module, never inline in a component", () => {
    expect(allSurfaces).not.toMatch(/BigInt\(|10n|\bformatUnits\(/);
    expect(allSurfaces).not.toMatch(/formatTokenAmount\(/);
  });
});

describe("router completeness", () => {
  it("has exactly one routing decision and a branch for every surface it can return", () => {
    const view = source("JourneyView.jsx");
    expect(view.match(/journeySurface\(/g)).toHaveLength(1);
    for (const name of ["terms_changed", "rechecking", "adopt", "arrival_consent", "recovery"]) {
      expect(view).toContain(`surface === "${name}"`);
    }
    // "timeline" is the fallthrough, so it must not also be a branch.
    expect(view).not.toContain('surface === "timeline"');
    expect(view).toContain("return <JourneyTimeline />");
  });
});

describe("evidence never renders a placeholder as a fact", () => {
  it("drops the parts of a partial authorization or submission the server left unset", () => {
    const rows = evidenceRows({
      journeyId: "ffffffff-6666-4666-8666-ffffffffffff",
      journey: {
        state: "completed",
        events: [],
        // Server records vary in shape by leg; the ones below are each missing
        // the field the row used to interpolate unconditionally.
        authorizations: [
          { intentKind: "permit2_approval", ethereumHash: `0x${"ab".repeat(32)}` },
          { intentKind: "router_execution", state: "submitted" },
          {},
        ],
        submissions: [
          { kind: "bridge", ethereumHash: `0x${"5d".repeat(32)}` },
          { state: "submitted", reason: "provider accepted" },
          {},
        ],
      },
      recovery: null,
      quote: null,
    });
    for (const row of rows) {
      expect(row.value).not.toContain("undefined");
      expect(row.value).not.toContain("null");
      expect(row.value.trim()).not.toBe("");
      expect(row.title === null || typeof row.title === "string").toBe(true);
    }
    // The hash is still evidence: relocated and named by its leg, never dropped.
    expect(rows.some((row: any) => row.title === `0x${"5d".repeat(32)}`)).toBe(true);
    expect(rows.some((row: any) => row.title === `0x${"ab".repeat(32)}`)).toBe(true);
  });
});
