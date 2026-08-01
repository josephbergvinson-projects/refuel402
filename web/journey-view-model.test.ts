import { describe, expect, it } from "vitest";
import {
  activityActionLabel,
  deriveJourneyPresentation,
  deriveJourneyProgress,
} from "./journey-view-model.js";

const event = (type: string) => ({ type });

function recovery(overrides: Record<string, unknown>) {
  return {
    disposition: "action_required",
    status: "action_required",
    nextAtomicStep: "source_wallet_consent",
    reason: "fixture",
    ...overrides,
  } as any;
}

describe("authoritative journey view model", () => {
  it("maps the real WBTC never-broadcast shape to a fresh transfer, not submission review", () => {
    const journey = {
      id: "74191800-9d5d-4ef2-b813-6b500b8e893e",
      state: "ready",
      payment: null,
      submissions: [],
      authorizations: [{ intentKind: "activation", state: "expired", rawTransactionHash: null }],
      events: [event("journey_created"), event("destination_activation_funded"), event("authorization_created"), event("authorization_expired"), event("journey_reverted")],
    } as any;
    const presentation = deriveJourneyPresentation({ journey, recovery: recovery({ nextAtomicStep: "source_wallet_consent" }) });
    expect(presentation.title).toBe("No source transaction was broadcast");
    expect(presentation.action).toMatchObject({ kind: "new_transfer", label: "Start a fresh transfer", disabled: false });
    expect(presentation.reason).toMatch(/cannot be safely reused/i);
    expect(presentation.progress.map((row) => row.status)).toEqual([
      "done", "current", "pending", "pending", "pending", "pending", "pending",
    ]);
  });

  it("offers same-journey resend when the server proves the pre-boundary predicate", () => {
    const journey = {
      id: "74191800-9d5d-4ef2-b813-6b500b8e893e",
      state: "ready",
      payment: null,
      submissions: [],
      authorizations: [],
      events: [event("journey_created"), event("destination_activation_funded")],
    } as any;
    const presentation = deriveJourneyPresentation({
      journey,
      recovery: recovery({ sameJourneyResendAllowed: true }),
    });
    expect(presentation.action).toMatchObject({ kind: "resend_journey", label: "Send this journey again" });
    expect(presentation.reason).toMatch(/no bridge hash/i);
  });

  it("keeps durable bridge and arrival evidence done for the real arrival-confirmed shape", () => {
    const journey = {
      id: "5196311e-50a5-4717-8d0e-a83f586f60a3",
      state: "arrival_confirmed",
      payment: null,
      authorizations: [],
      submissions: [],
      events: [
        event("destination_activation_funded"),
        event("origin_approval_wallet_boundary"),
        event("bridge_wallet_boundary"),
        event("bridge_submitted"),
        event("bridge_arrived"),
      ],
    } as any;
    const decision = recovery({ nextAtomicStep: "destination_wallet_consent", reason: "Arrival is durable" });
    const stale = deriveJourneyPresentation({ journey, recovery: decision, quoteLive: false });
    expect(stale.action).toMatchObject({ kind: "refresh_destination", label: "Get a fresh destination quote" });
    expect(stale.progress.slice(0, 4).map((row) => row.status)).toEqual(["done", "done", "done", "pending"]);
    expect(stale.reason).toMatch(/does not prompt the wallet, authorize payment, or submit/i);
    const live = deriveJourneyPresentation({ journey, recovery: decision, quoteLive: true });
    expect(live.action.kind).toBe("continue_destination");
    expect(live.progress[3]).toMatchObject({ id: "permit2", status: "current" });
  });

  it("shows close-tab preauthorization and the exact cap-expiry manual fallback", () => {
    const base = {
      id: "5196311e-50a5-4717-8d0e-a83f586f60a3",
      state: "arrival_confirmed",
      payment: null,
      authorizations: [],
      submissions: [],
      events: [event("bridge_submitted"), event("bridge_arrived")],
    } as any;
    const decision = recovery({ nextAtomicStep: "destination_wallet_consent" });
    const waiting = deriveJourneyPresentation({
      journey: { ...base, refuelAuthorization: { state: "retry_scheduled" } },
      recovery: decision,
    });
    expect(waiting.title).toBe("Your refuel is pre-authorized");
    expect(waiting.reason).toContain("you do not need to stay here");
    expect(waiting.action).toMatchObject({ kind: "wait", disabled: true });

    const expired = deriveJourneyPresentation({
      journey: { ...base, refuelAuthorization: { state: "expired" } },
      recovery: decision,
      quoteLive: true,
    });
    expect(expired.title).toContain("price stayed above your cap for 2 hours");
    expect(expired.reason).toBe("Raise the cap and convert now →");
    expect(expired.action).toMatchObject({ kind: "continue_destination", disabled: false });
  });

  it("describes the real review shape as expired before broadcast with a safe reconciliation action", () => {
    const journey = {
      id: "c91992cb-dfc3-4ed3-ab76-130beda59398",
      state: "review",
      payment: null,
      submissions: [],
      authorizations: [{ intentKind: "permit2_approval", state: "expired", rawTransactionHash: null, updatedAt: 2 }],
      events: [event("destination_activation_funded"), event("bridge_submitted"), event("bridge_arrived"), event("authorization_expired")],
    } as any;
    const presentation = deriveJourneyPresentation({
      journey,
      recovery: recovery({ disposition: "operator_review", status: "blocked", nextAtomicStep: "reconcile_submissions" }),
    });
    expect(presentation.title).toBe("Authorization expired before broadcast");
    expect(presentation.action).toMatchObject({ kind: "reconcile", label: "Verify and release this journey" });
    expect(presentation.reason).toMatch(/No payment, raw transaction hash, or submission exists/);
    expect(presentation.progress[3]).toMatchObject({ id: "permit2", status: "action_required", statusLabel: "Action needed" });
  });

  // shortJourneyReference was tested here. It truncated a journey uuid for
  // display, and no surface should render one at all, so it is gone rather than
  // left exported for a future surface to pick up.
  it("uses precise Activity action labels", () => {
    expect(activityActionLabel("resume")).toBe("Resume");
    expect(activityActionLabel("inspect")).toBe("Inspect");
    expect(activityActionLabel("view")).toBe("View");
  });

  it("marks all steps done only for terminal journeys", () => {
    const rows = deriveJourneyProgress({ journey: { state: "completed", events: [] }, recovery: recovery({ disposition: "terminal", status: "terminal", nextAtomicStep: "none" }) });
    expect(rows.every((row) => row.status === "done")).toBe(true);
  });
});

describe("pre-authorized journey rail", () => {
  const preauthorized = {
    refuelAuthorization: { state: "recorded" },
    events: [
      { type: "destination_activation_funded" },
      { type: "intent_permit2_approval_confirmed" },
      { type: "refuel_authorization_recorded" },
      { type: "bridge_submitted" },
    ],
  };

  // Everything the wallet signs is signed BEFORE the bridge. Rendering the
  // manual rail put two already-signed steps after arrival and promised a fee
  // signature this path never takes.
  it("orders the rail the way the one-signature flow actually happens", () => {
    const rows = deriveJourneyProgress({ journey: preauthorized, recovery: { nextAtomicStep: "poll_bridge" } });
    expect(rows.map((row) => row.id)).toEqual([
      "destination", "permit2", "authorize_refuel", "bridge_submit", "arrival", "execution", "reconcile",
    ]);
    expect(rows.map((row) => row.id)).not.toContain("payment");
    for (const id of ["destination", "permit2", "authorize_refuel", "bridge_submit"]) {
      expect(rows.find((row) => row.id === id)?.status).toBe("done");
    }
  });

  // The witness is recorded PART WAY THROUGH, so gating the rail on it showed the
  // manual order at step one — allowance and fee after "Cross to Hedera" — which
  // is precisely the post-arrival flow this path exists to remove. At step one is
  // when the owner reads the list to learn what is coming.
  it("shows the one-signature order from the very first step, before anything is signed", () => {
    const rows = deriveJourneyProgress({
      journey: { events: [{ type: "destination_activation_started" }] },
      recovery: { nextAtomicStep: "source_wallet_consent" },
      quote: { refuelAuthorization: { enabled: true } },
    });
    expect(rows.map((row) => row.id)).toEqual([
      "destination", "permit2", "authorize_refuel", "bridge_submit", "arrival", "execution", "reconcile",
    ]);
    // Nothing signed yet, so nothing is done — but the ORDER is already honest.
    expect(rows.every((row) => row.status !== "done")).toBe(true);
  });

  it("keeps the one-signature rail once the witness exists even without the quote", () => {
    const rows = deriveJourneyProgress({
      journey: { refuelAuthorization: { state: "recorded" }, events: [] },
      recovery: { nextAtomicStep: "poll_bridge" },
    });
    expect(rows.map((row) => row.id)).toContain("authorize_refuel");
  });

  it("keeps the manual rail, fee prompt and all, when nothing was pre-authorized", () => {
    const rows = deriveJourneyProgress({
      journey: { events: [{ type: "destination_activation_funded" }] },
      recovery: { nextAtomicStep: "poll_bridge" },
    });
    expect(rows.map((row) => row.id)).toEqual([
      "destination", "bridge_submit", "arrival", "permit2", "payment", "execution", "reconcile",
    ]);
  });
});
