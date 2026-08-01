import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { createStore } from "./store.js";

/**
 * Behavioural cover for the store's journey-read path. The source-text pins in
 * product-shell.test.ts say the right calls exist; these drive them, because the
 * one bug this path shipped with (an absent destination quote crashing
 * applyServerJourney) was invisible to every string assertion.
 */

const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const JOURNEY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const RUNTIME = { discoverable: true, quoteReady: true, executable: true, blockers: [] };
const ROUTE_MODES = { bridge_only: RUNTIME, bridge_plus_refuel: RUNTIME };

// A catalog that actually resolves a provider/network/token, so the resend path
// can be driven. An empty catalog leaves networkValue null and every resend stops
// at the origin-network guard before reaching the behaviour under test.
const ASSETS = [{
  id: "usdc:mainnet:1",
  symbol: "USDC",
  provider: "axelar",
  originNetworks: ["1"],
  originTokens: [
    { chainId: "1", address: "0x1111111111111111111111111111111111111111", decimals: 6, symbol: "USDC", name: "USD Coin" },
  ],
  destination: { decimals: 6, standard: "hts" },
  runtime: RUNTIME,
  routeModes: ROUTE_MODES,
}];

const OPTIONS = {
  mode: "mainnet",
  hedera: { chainId: 295, name: "Hedera Mainnet" },
  providers: [{ id: "auto", label: "Auto", description: "best eligible", strategy: "best_eligible_quote" }],
  networks: [{
    chainId: "1",
    name: "Ethereum",
    assets: ["usdc:mainnet:1"],
    providerOptions: [{ id: "auto", assetIds: ["usdc:mainnet:1"], runtime: RUNTIME, routeModes: ROUTE_MODES }],
  }],
  assets: ASSETS,
  defaults: { routeMode: "bridge_plus_refuel", desiredHbar: "1", slippageBps: 100 },
  limits: { maximumSlippageBps: 300 },
  capabilities: { combinedQuote: true, execution: true },
};

function harness({ decision, persisted = JOURNEY, wallet: walletOverrides = {} }: {
  decision: unknown;
  persisted?: string | null;
  wallet?: Record<string, unknown>;
}) {
  const requests: string[] = [];
  let notify: ((snapshot: unknown) => void) | null = null;
  const wallet = {
    subscribe(handler: (snapshot: unknown) => void) { notify = handler; return () => { notify = null; }; },
    async restore() { notify?.({ installed: true, account: ACCOUNT, chainId: 1, connected: true }); },
    async connect() { return ACCOUNT; },
    async nativeBalance() { return 0n; },
    async tokenBalance() { return 0n; },
    assertSameAddress() { /* same-address is asserted by wallet.js in production */ },
    destroy() { /* no timers in the fake */ },
    ...walletOverrides,
  };
  const client = {
    async request(path: string) {
      requests.push(path);
      if (path.startsWith("/v1/product/options")) return OPTIONS;
      // A live replacement quote for the resend path: executable, with a bridge
      // transaction and the same-address set the wallet asserts before signing.
      if (path.startsWith("/v1/product/quote")) {
        return {
          quoteId: "b".repeat(64),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          routeMode: "bridge_plus_refuel",
          capabilities: { execute: true },
          bridge: {
            originChainId: "1",
            originToken: "0x1111111111111111111111111111111111111111",
            transaction: { to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0" },
            normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
          },
          amountLedger: { hbar: { exactOutputTinybar: "1000000000" } },
          destination: { slippageBps: 100 },
          sameAddress: { bridgeFrom: ACCOUNT, bridgeTo: ACCOUNT, hederaDestination: ACCOUNT },
          feasibility: null,
        };
      }
      throw new Error(`unexpected client request ${path}`);
    },
  };
  const persistence = {
    read: () => ({ journeyId: persisted, account: ACCOUNT, source: "pointer" }),
    persist: () => undefined,
    clear: () => undefined,
    clearUrl: () => undefined,
  };
  const orchestrator = {
    async fetchJourneyDecision(journeyId: string) {
      requests.push(`decision:${journeyId}`);
      return decision;
    },
    async request(path: string) { requests.push(path); return {}; },
  };
  const store = createStore({
    wallet,
    client,
    persistence,
    orchestrator,
    location: { search: "", origin: "https://example.invalid" },
  });
  return { store, requests };
}

const bridgePendingDecision = {
  journey: {
    id: JOURNEY,
    account: ACCOUNT,
    mode: "mainnet",
    state: "bridge_pending",
    authorizations: [],
    submissions: [],
    payment: null,
    events: [{ type: "journey_created" }, { type: "destination_activation_funded" }, { type: "bridge_submitted" }],
  },
  // A journey waiting on the bridge has no destination quote yet.
  quote: null,
  recovery: {
    journeyId: JOURNEY,
    routeMode: "bridge_plus_refuel",
    disposition: "action_required",
    status: "action_required",
    nextAtomicStep: "poll_bridge",
    replaySafe: true,
    reason: "The bridge submission is durable and the provider reports the transfer as ongoing.",
  },
};

describe("applying a server journey decision", () => {
  it("lands a bridge-pending journey that has no destination quote", async () => {
    const { store } = harness({ decision: bridgePendingDecision });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.state.journeyId.value).toBe(JOURNEY);
    // The regression: comparing two absent quote ids matched and then
    // dereferenced the absent refresh event, so the read failed and the surface
    // stayed provisional forever.
    expect(store.state.recoveryProvisional.value).toBe(false);
    expect(store.state.error.value).not.toMatch(/Cannot read properties/);
    expect(store.state.surface.value).toBe("journey");
    expect(store.state.recovery.value?.nextAtomicStep).toBe("poll_bridge");
    expect(store.state.phase.value).toBe("recovery_required");
    expect(store.state.destinationQuoteState.value.live).toBe(false);
    expect(store.state.primaryIntent.value.kind).toBe("wait_bridge");
    expect(store.state.primaryIntent.value.disabled).toBe(true);
    store.actions.dispose();
  });

  it("binds the destination quote id only when the server refreshed that exact quote", async () => {
    const quote = { quoteId: "q".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 120, routeMode: "bridge_plus_refuel" };
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        quote,
        journey: {
          ...bridgePendingDecision.journey,
          state: "arrival_confirmed",
          events: [
            ...bridgePendingDecision.journey.events,
            { type: "bridge_arrived" },
            { type: "destination_quote_refreshed", record: { quoteId: quote.quoteId } },
          ],
        },
        recovery: { ...bridgePendingDecision.recovery, nextAtomicStep: "destination_wallet_consent", replaySafe: false },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A journey awaiting destination consent has nothing in the air, so it is
    // offered rather than adopted. Opening it is the owner's action.
    expect(store.state.surface.value).toBe("compose");
    expect(store.state.resumeOffer.value?.journeyId).toBe(JOURNEY);
    await store.actions.acceptResumeOffer();

    expect(store.state.destinationQuoteState.value.exact).toBe(true);
    expect(store.state.destinationQuoteState.value.live).toBe(true);
    expect(store.state.primaryIntent.value.kind).toBe("continue_destination");
    expect(store.state.phase.value).toBe("recovery_quote_ready");
    store.actions.dispose();
  });

  it("refuses to bind a quote the server never named in a refresh event", async () => {
    const quote = { quoteId: "q".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 120, routeMode: "bridge_plus_refuel" };
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        quote,
        journey: { ...bridgePendingDecision.journey, state: "arrival_confirmed", events: [{ type: "bridge_arrived" }] },
        recovery: { ...bridgePendingDecision.recovery, nextAtomicStep: "destination_wallet_consent", replaySafe: false },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.actions.acceptResumeOffer();

    expect(store.state.destinationQuoteState.value.exact).toBe(false);
    expect(store.state.destinationQuoteState.value.canApprove).toBe(false);
    // An unbound quote is a refresh, never a consent.
    expect(store.state.primaryIntent.value.kind).toBe("refresh_destination");
    store.actions.dispose();
  });

  it("loads options before it reads any journey, and reads a journey only once", async () => {
    const { store, requests } = harness({ decision: bridgePendingDecision });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests[0]).toContain("/v1/product/options");
    // The read that decides whether a stored pointer may take the screen IS the
    // read the adoption uses. Asking twice on every load would be a wasted round
    // trip on the slowest moment of the page.
    expect(requests.filter((path) => path.startsWith("decision:"))).toEqual([`decision:${JOURNEY}`]);
    store.actions.dispose();
  });

  it("stays on compose when no pointer selects a journey", async () => {
    const { store, requests } = harness({ decision: bridgePendingDecision, persisted: null });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.state.surface.value).toBe("compose");
    expect(store.state.journeyId.value).toBe(null);
    expect(requests.some((path) => path.startsWith("decision:"))).toBe(false);
    store.actions.dispose();
  });

  // The reported defect: opening the site adopted whatever journey the last visit
  // left behind, so a transfer that was never sent replaced the compose card
  // before anything could be typed — and because an adopted journey locks the
  // draft, the origin network stopped following the wallet too.
  it("never lets a stored pointer with nothing in flight take the compose surface", async () => {
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        journey: { ...bridgePendingDecision.journey, state: "ready", events: [{ type: "journey_created" }] },
        recovery: {
          ...bridgePendingDecision.recovery,
          nextAtomicStep: "source_wallet_consent",
          replaySafe: false,
          reason: "No source transaction hash is durable.",
        },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.state.surface.value).toBe("compose");
    expect(store.state.journeyId.value).toBe(null);
    expect(store.state.draftLocked.value).toBe(false);
    // Offered, not imposed — and dismissing it must not leave it to come back.
    expect(store.state.resumeOffer.value?.journeyId).toBe(JOURNEY);
    store.actions.dismissResumeOffer();
    expect(store.state.resumeOffer.value).toBe(null);
    store.actions.dispose();
  });

  // A bridge with funds in the air still resumes by itself for immediate owner
  // visibility. The server sweeper now owns arrival materialization as well.
  it("offers a safe same-journey resend only after the owner selects the journey", async () => {
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        journey: { ...bridgePendingDecision.journey, state: "ready", events: [{ type: "journey_created" }] },
        recovery: {
          ...bridgePendingDecision.recovery,
          nextAtomicStep: "source_wallet_consent",
          replaySafe: false,
          sameJourneyResendAllowed: true,
          reason: "No source transaction hash is durable.",
        },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state.primaryIntent.value.kind).not.toBe("resend_journey");
    await store.actions.acceptResumeOffer();
    expect(store.state.primaryIntent.value.kind).toBe("resend_journey");
    store.actions.dispose();
  });

  /**
   * The consent domain and the chain the wallet is switched to must be the same
   * value. They used to be derived separately — the domain from the journey, the
   * switch from the selected network — and a restored selection falls back to the
   * previous network whenever the catalog no longer lists the journey's chain.
   * MetaMask refuses eth_signTypedData_v4 whose domain chain is not active, so the
   * divergence produced no prompt at all: exactly the silent pre-prompt failure
   * this feature exists to remove. Refuse in words instead.
   */
  it("refuses to sign a re-bind when the journey's origin chain is not the selected one", async () => {
    let signed = false;
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        quote: {
          quoteId: "a".repeat(64),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          routeMode: "bridge_plus_refuel",
          bridge: {
            originChainId: "1",
            originToken: "0x1111111111111111111111111111111111111111",
            normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
          },
          amountLedger: { hbar: { exactOutputTinybar: "1000000000" } },
          destination: { slippageBps: 100 },
        },
        journey: {
          ...bridgePendingDecision.journey,
          state: "ready",
          assetId: "usdc:mainnet:1",
          // The journey belongs to a chain this catalog does not offer, so the
          // restored selection stays on Ethereum.
          originChainId: "8453",
          events: [{ type: "journey_created" }],
        },
        recovery: {
          ...bridgePendingDecision.recovery,
          nextAtomicStep: "source_wallet_consent",
          replaySafe: false,
          sameJourneyResendAllowed: true,
          reason: "No source transaction hash is durable.",
        },
      },
      wallet: {
        switchChain: async () => undefined,
        signJourneySourceLeg: async () => { signed = true; return "0x"; },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.actions.acceptResumeOffer();
    await store.actions.submitPrimary();

    expect(signed).toBe(false);
    expect(store.state.error.value).toContain("Nothing was sent");
    expect(store.state.error.value).toContain("origin network");
    store.actions.dispose();
  });

  /**
   * Re-binding now needs the owner's EIP-712 consent, which means one more thing
   * the owner can decline. Declining must not recreate the defect this whole
   * feature exists to remove: the journey has to stay offered, not become a dead
   * end. Nothing was signed and nothing was sent, so the only correct outcome is
   * "say why, and let them press it again".
   */
  it("keeps the journey resendable when the owner declines the re-bind consent", async () => {
    const declined = new Error("wallet request rejected by the user");
    const { store } = harness({
      decision: {
        ...bridgePendingDecision,
        // The bound quote is what repopulates the draft, so the resend can rebuild
        // the same request instead of asking the owner to retype it.
        quote: {
          quoteId: "a".repeat(64),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          routeMode: "bridge_plus_refuel",
          bridge: {
            originChainId: "1",
            originToken: "0x1111111111111111111111111111111111111111",
            normalized: { sourceAmount: { amount: "1000000", decimals: 6, symbol: "USDC" } },
          },
          amountLedger: { hbar: { exactOutputTinybar: "1000000000" } },
          destination: { slippageBps: 100 },
        },
        journey: {
          ...bridgePendingDecision.journey,
          state: "ready",
          assetId: "usdc:mainnet:1",
          originChainId: "1",
          events: [{ type: "journey_created" }],
        },
        recovery: {
          ...bridgePendingDecision.recovery,
          nextAtomicStep: "source_wallet_consent",
          replaySafe: false,
          sameJourneyResendAllowed: true,
          reason: "No source transaction hash is durable.",
        },
      },
      wallet: {
        switchChain: async () => undefined,
        signJourneySourceLeg: async () => { throw declined; },
      },
    });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.actions.acceptResumeOffer();
    expect(store.state.primaryIntent.value.kind).toBe("resend_journey");

    await store.actions.submitPrimary();

    // Said in the product's voice, and it states that nothing moved.
    expect(store.state.error.value).toContain("declined the consent signature");
    expect(store.state.error.value).toContain("nothing was signed and nothing was spent");
    // The server never heard about this, so the decision on screen is still the
    // one it gave us: no provisional re-read, and the button stays pressable.
    // Marking it provisional would grey the resend for the revalidate window and
    // claim the app was waiting on the server when it is waiting on the owner.
    expect(store.state.journeyId.value).toBe(JOURNEY);
    expect(store.state.recoveryProvisional.value).toBe(false);
    expect(store.state.primaryIntent.value.kind).toBe("resend_journey");
    expect(store.state.primaryIntent.value.disabled).toBeFalsy();
    store.actions.dispose();
  });

  it("resumes a journey whose bridge is still in flight without being asked", async () => {
    const { store } = harness({ decision: bridgePendingDecision });
    await store.actions.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.state.surface.value).toBe("journey");
    expect(store.state.journeyId.value).toBe(JOURNEY);
    expect(store.state.resumeOffer.value).toBe(null);
    store.actions.dispose();
  });
});
