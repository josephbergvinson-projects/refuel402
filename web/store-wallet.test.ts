import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { createStore } from "./store.js";

/**
 * Behavioural cover for the two wallet-shaped promises the surface now makes:
 * the origin network follows the wallet's own chain (this is a one-directional
 * bridge, so the origin IS wherever the wallet is), and Disconnect actually ends
 * the session instead of re-running connect.
 *
 * Driven through createStore with a fake EIP-1193-shaped wallet, because the
 * source-text pins in product-shell.test.ts can only say the calls exist.
 */

const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const ASSETS = [
  {
    id: "usdc:mainnet:1",
    symbol: "USDC",
    provider: "axelar",
    originNetworks: ["1", "42161"],
    originTokens: [
      { chainId: "1", address: "0x1111111111111111111111111111111111111111", decimals: 6, symbol: "USDC", name: "USD Coin" },
      { chainId: "42161", address: "0x2222222222222222222222222222222222222222", decimals: 6, symbol: "USDC", name: "USD Coin" },
    ],
    destination: { decimals: 6, standard: "hts" },
    runtime: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
    routeModes: {
      bridge_only: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
      bridge_plus_refuel: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
    },
  },
];

const NETWORK_OPTION = {
  id: "auto",
  assetIds: ["usdc:mainnet:1"],
  runtime: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
  routeModes: {
    bridge_only: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
    bridge_plus_refuel: { discoverable: true, quoteReady: true, executable: true, blockers: [] },
  },
};

const OPTIONS = {
  mode: "mainnet",
  hedera: { chainId: 295, name: "Hedera Mainnet" },
  providers: [{ id: "auto", label: "Auto", description: "best eligible", strategy: "best_eligible_quote" }],
  networks: [
    { chainId: "1", name: "Ethereum", assets: ["usdc:mainnet:1"], providerOptions: [NETWORK_OPTION] },
    { chainId: "42161", name: "Arbitrum", assets: ["usdc:mainnet:1"], providerOptions: [NETWORK_OPTION] },
  ],
  assets: ASSETS,
  defaults: { routeMode: "bridge_plus_refuel", desiredHbar: "1", slippageBps: 100 },
  limits: { maximumSlippageBps: 300, maximumConfiguredHbarTinybar: "5000000000" },
  capabilities: { combinedQuote: true, execution: true },
};

function harness({ chainId = 1 }: { chainId?: number } = {}) {
  let notify: ((snapshot: unknown) => void) | null = null;
  let snapshot = { installed: true, account: ACCOUNT, chainId, connected: true };
  const cleared: (string | null)[] = [];
  const revoked: string[] = [];
  const wallet = {
    subscribe(handler: (value: unknown) => void) { notify = handler; handler(snapshot); return () => { notify = null; }; },
    async restore() { notify?.(snapshot); return snapshot; },
    async connect() { return snapshot; },
    async disconnect() {
      revoked.push("wallet_revokePermissions");
      snapshot = { ...snapshot, account: null, connected: false };
      notify?.(snapshot);
      return { ...snapshot, revoked: true };
    },
    async switchChain(next: number) { this.emitChain(next); },
    async nativeBalance() { return 0n; },
    async tokenBalance() { return 1_000_000n; },
    assertSameAddress() { /* asserted by wallet.js in production */ },
    destroy() { /* no timers in the fake */ },
    emitChain(next: number) {
      snapshot = { ...snapshot, chainId: next };
      notify?.(snapshot);
    },
  };
  const client = {
    async request(path: string) {
      if (path.startsWith("/v1/product/options")) return OPTIONS;
      if (path.startsWith("/v1/product/journeys")) return { items: [], nextBefore: null };
      throw new Error(`unexpected client request ${path}`);
    },
  };
  const persistence = {
    read: () => ({ journeyId: null, source: "none" }),
    persist: () => undefined,
    clear: (account: string | null) => { cleared.push(account); },
    // Only ever strips the journey param. The store has no way to ADD one: it
    // never writes an id into the address bar.
    clearUrl: () => undefined,
  };
  const orchestrator = {
    destinationQuote: { quoteId: "stale-from-the-previous-session" },
    forget() { this.destinationQuote = null; },
    async fetchJourneyDecision() { return { journey: null, quote: null, recovery: null }; },
    async request() { return {}; },
  };
  const store = createStore({
    wallet,
    client,
    persistence,
    orchestrator,
    location: { search: "", origin: "https://example.invalid" },
  });
  return { store, wallet, orchestrator, cleared, revoked };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the origin network follows the wallet's chain", () => {
  it("selects the origin network the wallet is already on", async () => {
    const { store } = harness({ chainId: 42161 });
    await store.actions.init();
    await settle();

    expect(store.state.network.value?.chainId).toBe("42161");
    expect(store.state.tokenBalanceStatus.value).not.toBe("wrong_chain");
    store.actions.dispose();
  });

  it("moves the selection when the wallet moves, and reads the balance there", async () => {
    const { store, wallet } = harness({ chainId: 1 });
    await store.actions.init();
    await settle();
    expect(store.state.network.value?.chainId).toBe("1");

    wallet.emitChain(42161);
    await settle();

    expect(store.state.network.value?.chainId).toBe("42161");
    expect(store.state.token.value?.address).toBe("0x2222222222222222222222222222222222222222");
    expect(store.state.tokenBalanceStatus.value).toBe("ready");
    store.actions.dispose();
  });

  it("keeps the chosen asset when it also bridges from the chain the wallet moved to", async () => {
    const { store, wallet } = harness({ chainId: 1 });
    await store.actions.init();
    await settle();
    const assetId = store.state.token.value?.assetId;

    wallet.emitChain(42161);
    await settle();

    expect(store.state.token.value?.assetId).toBe(assetId);
    store.actions.dispose();
  });

  it("ignores a chain the catalog does not bridge from, Hedera included", async () => {
    const { store, wallet } = harness({ chainId: 1 });
    await store.actions.init();
    await settle();

    // The orchestrator moves the wallet to Hedera and back on every leg; that
    // must never rewrite the origin selection.
    wallet.emitChain(295);
    await settle();

    expect(store.state.network.value?.chainId).toBe("1");
    expect(store.state.tokenBalanceStatus.value).toBe("wrong_chain");
    store.actions.dispose();
  });

  it("offers an explicit switch back rather than leaving wrong_chain as a dead end", async () => {
    const { store, wallet } = harness({ chainId: 1 });
    await store.actions.init();
    await settle();
    wallet.emitChain(295);
    await settle();
    expect(store.state.tokenBalanceStatus.value).toBe("wrong_chain");

    await store.actions.switchToOriginNetwork();
    await settle();

    expect(store.state.tokenBalanceStatus.value).toBe("ready");
    store.actions.dispose();
  });
});

describe("disconnecting the wallet", () => {
  it("ends the session, clears the stored pointer, and drops the cached continuation", async () => {
    const { store, orchestrator, cleared, revoked } = harness();
    await store.actions.init();
    await settle();
    store.actions.setAmount("25");
    expect(store.state.account.value).toBe(ACCOUNT);

    await store.actions.disconnectWallet();
    await settle();

    expect(store.state.account.value).toBeNull();
    expect(revoked).toContain("wallet_revokePermissions");
    // Reconnecting must not re-adopt the journey the owner just walked away from.
    expect(cleared).toContain(ACCOUNT);
    expect(orchestrator.destinationQuote).toBeNull();
    expect(store.state.sourceAmount.value).toBe("");
    expect(store.state.tokenBalanceStatus.value).toBe("idle");
    expect(store.state.activityItems.value).toEqual([]);
    // A disconnect is not an account swap; announcing one would be false.
    expect(store.state.error.value).toBeNull();
    store.actions.dispose();
  });
});
