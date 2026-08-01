import { describe, expect, it } from "vitest";
import {
  JOURNEY_STATES,
  blockerLabel,
  buildCombinedQuoteRequest,
  formatTokenAmount,
  networkOptionsForProvider,
  nextOptionIndex,
  normalizeDesiredHbar,
  parseUnits,
  providerOptions,
  providerOptionsForNetwork,
  destinationTermsComparison,
  quoteFailureMessage,
  quoteStillValid,
  tokenOptionsForNetwork,
  transitionJourney,
} from "./product-model.js";

const options = {
  providers: [
    { id: "auto", label: "Auto", description: "Best route", strategy: "best_eligible_quote" },
    { id: "axelar", label: "Axelar / Squid", description: "Axelar", strategy: "explicit" },
    { id: "layerzero", label: "LayerZero / Stargate", description: "LayerZero", strategy: "explicit" },
  ],
  networks: [{
    chainId: "1",
    name: "Ethereum",
    providerOptions: [
      { id: "auto", label: "Auto", description: "Best route", strategy: "best_eligible_quote", assetIds: ["layerzero:mainnet:weth", "axelar:mainnet:qnt"], runtime: { discoverable: true, quoteReady: true, blockers: [] } },
      { id: "axelar", label: "Axelar / Squid", description: "Axelar", strategy: "explicit", assetIds: ["axelar:mainnet:qnt"], runtime: { discoverable: true, quoteReady: false, blockers: ["SAUCER_LIQUIDITY_POLICY"] } },
      { id: "layerzero", label: "LayerZero / Stargate", description: "LayerZero", strategy: "explicit", assetIds: ["layerzero:mainnet:weth"], runtime: { discoverable: true, quoteReady: true, blockers: [] } },
    ],
  }, {
    chainId: "43114",
    name: "Avalanche",
    providerOptions: [
      { id: "auto", label: "Auto", description: "Best route", strategy: "best_eligible_quote", assetIds: ["axelar:mainnet:wavax"], runtime: { discoverable: true, quoteReady: false, blockers: [] } },
      { id: "axelar", label: "Axelar / Squid", description: "Axelar", strategy: "explicit", assetIds: ["axelar:mainnet:wavax"], runtime: { discoverable: true, quoteReady: false, blockers: [] } },
      { id: "layerzero", label: "LayerZero / Stargate", description: "LayerZero", strategy: "explicit", assetIds: [], runtime: { discoverable: false, quoteReady: false, blockers: ["PROVIDER_NOT_AVAILABLE_ON_ORIGIN_NETWORK"] } },
    ],
  }],
  assets: [
    {
      id: "layerzero:mainnet:weth",
      provider: "layerzero",
      providerLabel: "LayerZero / Stargate",
      symbol: "WETH",
      name: "Wrapped Ether",
      icon: "weth.svg",
      originNetworks: ["1"],
      originTokens: [{ chainId: "1", address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18, symbol: "ETH", name: "Ether", native: true }],
      destination: { decimals: 18 },
      runtime: { quoteReady: true, blockers: [] },
    },
    {
      id: "axelar:mainnet:qnt",
      provider: "axelar",
      providerLabel: "Axelar / Squid",
      symbol: "QNT",
      name: "Quant",
      icon: "qnt.svg",
      originNetworks: ["1"],
      destination: { decimals: 6 },
      runtime: { quoteReady: false, blockers: ["SAUCER_LIQUIDITY_POLICY"] },
    },
  ],
};

const account = "0x1111111111111111111111111111111111111111";

describe("product model", () => {
  it("allows only state-machine transitions defined by the product contract", () => {
    expect(transitionJourney("ready", "submitting_bridge")).toBe("submitting_bridge");
    expect(() => transitionJourney("ready", "completed")).toThrow("invalid journey transition");
  });

  it("models recovery landings and expiry edges explicitly instead of loosening the walk", () => {
    expect(JOURNEY_STATES).toContain("recovery_quote_ready");
    expect(transitionJourney("quoting", "recovery_quote_ready")).toBe("recovery_quote_ready");
    expect(transitionJourney("recovery_quote_ready", "approving_payment_asset")).toBe("approving_payment_asset");
    expect(transitionJourney("recovery_quote_ready", "expired")).toBe("expired");
    expect(transitionJourney("arrival_confirmed", "recovery_quote_ready")).toBe("recovery_quote_ready");
    expect(() => transitionJourney("idle", "recovery_quote_ready")).toThrow("invalid journey transition");
  });

  it("re-enters destination execution from recovery when the owner accepts refreshed terms", () => {
    expect(transitionJourney("recovery_required", "approving_payment_asset")).toBe("approving_payment_asset");
    // The edge is a resumption of one journey, not a general shortcut into execution.
    expect(() => transitionJourney("recovery_required", "settling_x402")).toThrow("invalid journey transition");
    expect(() => transitionJourney("idle", "approving_payment_asset")).toThrow("invalid journey transition");
  });

  it("compares consented and refreshed destination terms in the owner's own units", () => {
    const gate = {
      consented: { swapInputMaximum: "3000000", minimumRetained: "2000000", desiredHbarTinybar: "100000000" },
      refreshed: { swapInputMaximum: "3400000", minimumRetained: "1600000", desiredHbarTinybar: "100000000" },
    };
    const rows = destinationTermsComparison(gate, { asset: { symbol: "USDC", destination: { decimals: 6 } } });
    expect(rows.map((row) => [row.field, row.consented, row.refreshed, row.changed])).toEqual([
      ["swapInputMaximum", "3 USDC", "3.4 USDC", true],
      ["minimumRetained", "2 USDC", "1.6 USDC", true],
      ["desiredHbarTinybar", "1 HBAR", "1 HBAR", false],
    ]);
    expect(rows.every((row) => row.label.length > 0)).toBe(true);
  });

  it("permits server-authoritative landings from any state without loosening the local walk", () => {
    expect(transitionJourney("idle", "recovery_quote_ready", { authoritative: true })).toBe("recovery_quote_ready");
    expect(transitionJourney("unsupported", "bridge_pending", { authoritative: true })).toBe("bridge_pending");
    expect(transitionJourney("expired", "completed", { authoritative: true })).toBe("completed");
    // Mid-run wallet stages are never a server landing; the walk still applies.
    expect(() => transitionJourney("idle", "approving_payment_asset", { authoritative: true }))
      .toThrow("invalid journey transition");
  });

  it("lets pre-quote validation failures land on failed from idle and expired", () => {
    // Slippage/amount/chain-switch validation throws before "quoting" is entered.
    expect(transitionJourney("idle", "failed")).toBe("failed");
    expect(transitionJourney("expired", "failed")).toBe("failed");
    expect(transitionJourney("failed", "quoting")).toBe("quoting");
    expect(transitionJourney("failed", "idle")).toBe("idle");
  });

  it("keeps journey abandonment out of the graph instead of loosening mid-run states", () => {
    for (const from of ["bridge_pending", "recovery_required", "recovery_quote_ready", "submitting_bridge", "settling_x402"]) {
      expect(() => transitionJourney(from, "discovering")).toThrow("invalid journey transition");
      expect(() => transitionJourney(from, "discovering", { authoritative: true })).toThrow("invalid journey transition");
    }
  });

  it("wraps provider/network/token keyboard navigation deterministically", () => {
    expect(nextOptionIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(nextOptionIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextOptionIndex(1, 3, "Home")).toBe(0);
    expect(nextOptionIndex(1, 3, "End")).toBe(2);
  });

  it("orders provider before provider-scoped network and asset choices without silent fallback", () => {
    expect(providerOptions(options).map((provider) => [provider.id, provider.networkIds])).toEqual([
      ["auto", ["1", "43114"]],
      ["axelar", ["1", "43114"]],
      ["layerzero", ["1"]],
    ]);
    expect(networkOptionsForProvider(options, "layerzero").map((network) => network.chainId)).toEqual(["1"]);
    expect(networkOptionsForProvider(options, "axelar").map((network) => network.chainId)).toEqual(["1", "43114"]);
    expect(providerOptionsForNetwork(options, "1").map((provider) => provider.id)).toEqual([
      "auto",
      "axelar",
      "layerzero",
    ]);
    const tokens = tokenOptionsForNetwork(options, "1", "auto");
    expect(tokens.map((token) => [token.symbol, token.disabled])).toEqual([
      ["ETH", false],
      ["QNT", true],
    ]);
    expect(tokenOptionsForNetwork(options, "1", "layerzero", "stargate")[0]).toMatchObject({ symbol: "ETH", native: true });
    expect(tokenOptionsForNetwork(options, "1", "axelar").map((token) => token.symbol)).toEqual(["QNT"]);
    expect(tokens[1].blockers).toContain("ORIGIN_TOKEN_DISCOVERY_REQUIRED");
    expect(tokens[1].icon).toBeNull();
  });

  it("builds a provider-bound same-wallet quote request with canonical bridge and HBAR amounts", () => {
    const provider = providerOptionsForNetwork(options, "1")[0];
    const token = tokenOptionsForNetwork(options, "1", provider.id)[0];
    expect(buildCombinedQuoteRequest({
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider,
      token,
      amount: "1.25",
      desiredHbar: "1.25000000",
      slippageBps: 100,
    })).toMatchObject({
      provider: "auto",
      amountBaseUnits: "1250000000000000000",
      desiredHbar: "1.25",
      refuelProtection: { preset: "flexible" },
    });
    expect(() => buildCombinedQuoteRequest({
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider: { id: "axelar" },
      token,
      amount: "1.25",
      desiredHbar: "1",
      slippageBps: 100,
    })).toThrow("does not belong");
  });

  it("encodes Custom as one exact destination-token cap in base units", () => {
    const provider = providerOptionsForNetwork(options, "1")[0];
    const token = tokenOptionsForNetwork(options, "1", provider.id)[0];
    expect(buildCombinedQuoteRequest({
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider,
      token,
      amount: "1.25",
      desiredHbar: "1",
      slippageBps: 100,
      refuelProtectionPreset: "custom",
      customRefuelCap: "0.0008",
    }).refuelProtection).toEqual({ preset: "custom", customMaxAmountIn: "800000000000000" });
  });

  it("builds an explicit bridge-only request without claiming HBAR", () => {
    const provider = providerOptionsForNetwork(options, "1")[0];
    const token = tokenOptionsForNetwork(options, "1", provider.id)[0];
    expect(buildCombinedQuoteRequest({
      routeMode: "bridge_only",
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider,
      token,
      amount: "1.25",
      desiredHbar: "",
      slippageBps: 100,
    })).toMatchObject({
      routeMode: "bridge_only",
      amountBaseUnits: "1250000000000000000",
      desiredHbar: "0",
    });
  });

  it("rejects zero bridge or HBAR amounts before the quote request", () => {
    const provider = providerOptionsForNetwork(options, "1")[0];
    const token = tokenOptionsForNetwork(options, "1", provider.id)[0];
    expect(() => buildCombinedQuoteRequest({
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider,
      token,
      amount: "0",
      desiredHbar: "1",
      slippageBps: 100,
    })).toThrow("greater than zero");
    expect(() => buildCombinedQuoteRequest({
      mode: "mainnet",
      account,
      network: { chainId: "1" },
      provider,
      token,
      amount: "1",
      desiredHbar: "0",
      slippageBps: 100,
    })).toThrow("desired HBAR must be greater than zero");
  });

  it("uses exact decimal parsing for both bridge input and editable desired HBAR", () => {
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(() => parseUnits("0.0000001", 6)).toThrow("more than 6 decimals");
    expect(normalizeDesiredHbar("1.25000000")).toEqual({ tinybar: 125_000_000n, decimal: "1.25" });
    expect(normalizeDesiredHbar("0.00000001").tinybar).toBe(1n);
    expect(() => normalizeDesiredHbar("1.000000001")).toThrow("more than 8 decimals");
  });

  it("truncates token amounts deterministically without visual ellipsis or hidden rounding", () => {
    expect(formatTokenAmount("1234567", 6, "USDC")).toMatchObject({ display: "1.234567", full: "1.234567" });
    expect(formatTokenAmount("123456789", 8, "WBTC")).toMatchObject({ display: "1.23456789" });
    expect(formatTokenAmount("123456789", 8, "HBAR")).toMatchObject({ display: "1.23456789" });
    expect(formatTokenAmount("1234567890123456789", 18, "ETH")).toMatchObject({ display: "1.23456789", full: "1.234567890123456789", truncated: true });
    expect(formatTokenAmount("1", 18, "ETH")).toMatchObject({ display: "<0.00000001", full: "0.000000000000000001" });
    expect(formatTokenAmount("999999999999999999999999", 6, "USDC").display).toBe("999999999999999999.999999");
    expect(formatTokenAmount("1000000", 6, "USDC").display).not.toContain("...");
  });

  it("requests the expensive route maximum only for an explicit Max action", () => {
    const provider = providerOptionsForNetwork(options, "1")[0];
    const token = tokenOptionsForNetwork(options, "1", provider.id)[0];
    const request = buildCombinedQuoteRequest({
      mode: "mainnet", account, network: { chainId: "1" }, provider, token,
      amount: "2", desiredHbar: "10", slippageBps: 100, solveMaximumHbar: true,
    });
    expect(request.solveMaximumHbar).toBe(true);
  });

  it("invalidates quotes on account, provider, asset, network, or expiry drift", () => {
    const quote = {
      expiresAt: 200,
      mode: "mainnet",
      account,
      providerSelection: { requested: "auto", selected: "layerzero" },
      asset: { id: "asset" },
      destination: { desiredHbarTinybar: "100000000" },
      bridge: { originChainId: "1" },
    };
    const current = {
      mode: "mainnet",
      account: quote.account,
      provider: { id: "auto" },
      token: { assetId: "asset" },
      network: { chainId: "1" },
      desiredHbarTinybar: 100_000_000n,
    };
    expect(quoteStillValid(quote, current, 100)).toBe(true);
    expect(quoteStillValid(quote, { ...current, provider: { id: "axelar" } }, 100)).toBe(false);
    expect(quoteStillValid(quote, { ...current, account: "0x2222222222222222222222222222222222222222" }, 100)).toBe(false);
    expect(quoteStillValid(quote, { ...current, desiredHbarTinybar: 200_000_000n }, 100)).toBe(false);
    expect(quoteStillValid(quote, current, 201)).toBe(false);
  });

  it("renders the exact lower live constraint instead of a generic maximum error", () => {
    const error = Object.assign(new Error("desired HBAR exceeds maximum"), {
      body: {
        code: "DESIRED_HBAR_EXCEEDS_MAXIMUM",
        details: {
          desiredTinybar: "2000000000",
          maximumTinybar: "546875000",
          limitingConstraint: "DESTINATION_AFFORDABILITY",
          solverResolutionTinybar: "78125000",
        },
      },
    });
    expect(quoteFailureMessage(error)).toBe(
      "20 HBAR requested; current maximum 5.46875 HBAR because the bridged amount cannot cover the swap, fee, and retained-asset minimum. Conservative unresolved interval: 0.78125 HBAR.",
    );
  });

  it("does not describe a lower exact-output route failure as exceeding a higher maximum", () => {
    const error = Object.assign(new Error("exact output unavailable"), {
      body: {
        code: "DESIRED_HBAR_ROUTE_INFEASIBLE",
        details: {
          desiredTinybar: "1",
          maximumTinybar: "1875000000",
          limitingConstraint: "DESTINATION_AFFORDABILITY",
          solverResolutionTinybar: "78125000",
        },
      },
    });
    expect(quoteFailureMessage(error)).toBe(
      "0.00000001 HBAR requested; that exact output is unavailable because the bridged amount cannot cover the swap, fee, and retained-asset minimum. A separate bounded maximum search found 18.75 HBAR; use Max or try another amount/provider. Conservative unresolved interval: 0.78125 HBAR.",
    );
  });

  it("renders stable support reasons", () => {
    expect(blockerLabel("SAUCER_ROUTE_UNAVAILABLE")).toMatch(/SaucerSwap route/);
    expect(blockerLabel("AUTO_PROVIDER_NO_QUOTE_READY_ROUTE")).toMatch(/Auto/);
    expect(blockerLabel("PROVIDER_API_AUTHORIZATION_REQUIRED")).toBe("Provider API authorization required");
    expect(blockerLabel("SAUCER_FAIR_VALUE_DEVIATION")).toBe("Route price deviates from market evidence; refuel paused");
    expect(blockerLabel("SAUCER_LIQUIDITY_POLICY")).toBe("SaucerSwap liquidity is below the product floor");
  });
});
