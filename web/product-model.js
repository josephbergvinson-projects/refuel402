export const JOURNEY_STATES = [
  "idle",
  "discovering",
  "unsupported",
  "quoting",
  "ready",
  "activating_destination",
  "approving_refuel_allowance",
  "authorizing_refuel",
  "submitting_bridge",
  "bridge_pending",
  "arrival_confirmed",
  "recovery_required",
  "recovery_quote_ready",
  "approving_payment_asset",
  "authorizing_x402",
  "settling_x402",
  "executing_refuel",
  "reconciling",
  "completed",
  "failed",
  "expired",
  // Owner retired a draft that never reached the outside world. Terminal, and
  // never the same thing as completed.
  "abandoned",
];

const transitions = {
  // Quote validation (chain switch, slippage, amount) fails before "quoting" is
  // entered, so idle/expired must be able to land on failed and retry.
  idle: ["discovering", "quoting", "failed"],
  discovering: ["unsupported", "quoting", "failed", "idle"],
  unsupported: ["discovering", "quoting", "idle"],
  quoting: ["ready", "unsupported", "failed", "idle", "discovering", "recovery_quote_ready", "recovery_required"],
  ready: ["activating_destination", "approving_refuel_allowance", "authorizing_refuel", "submitting_bridge", "quoting", "expired", "failed", "discovering", "idle"],
  approving_refuel_allowance: ["authorizing_refuel", "submitting_bridge", "failed", "expired"],
  activating_destination: ["approving_refuel_allowance", "authorizing_refuel", "submitting_bridge", "failed", "expired"],
  authorizing_refuel: ["submitting_bridge", "failed", "expired"],
  submitting_bridge: ["bridge_pending", "failed", "expired"],
  bridge_pending: ["arrival_confirmed", "failed", "expired"],
  arrival_confirmed: ["recovery_required", "recovery_quote_ready", "approving_payment_asset", "authorizing_x402", "completed", "failed", "expired"],
  // approving_payment_asset is the re-entry edge for a journey the server stopped
  // mid-execution (worsened re-quote): one explicit acceptance resumes the legs.
  recovery_required: ["bridge_pending", "arrival_confirmed", "recovery_quote_ready", "approving_payment_asset", "quoting", "completed", "failed", "idle"],
  recovery_quote_ready: ["approving_payment_asset", "quoting", "recovery_required", "expired", "completed", "failed", "idle"],
  approving_payment_asset: ["authorizing_x402", "failed", "expired"],
  authorizing_x402: ["settling_x402", "failed", "expired"],
  settling_x402: ["executing_refuel", "failed", "expired"],
  executing_refuel: ["reconciling", "failed", "expired"],
  reconciling: ["completed", "failed"],
  completed: ["idle", "discovering"],
  // A retired draft only ever leads back to composing a new one.
  abandoned: ["idle", "discovering"],
  // failed is retryable: a still-valid consent context may re-enter the walk at
  // the stage that failed.
  failed: ["idle", "discovering", "quoting", "activating_destination", "approving_refuel_allowance", "authorizing_refuel", "submitting_bridge", "approving_payment_asset"],
  expired: ["quoting", "discovering", "idle", "failed"],
};

// A server-applied recovery decision lands the UI from any local state: for these
// states the journey record, not the local walk, is authoritative.
const serverAuthoritativeStates = new Set([
  "bridge_pending",
  "arrival_confirmed",
  "recovery_required",
  "recovery_quote_ready",
  "completed",
  "abandoned",
]);

export function transitionJourney(current, next, { authoritative = false } = {}) {
  if (!JOURNEY_STATES.includes(current) || !JOURNEY_STATES.includes(next)) {
    throw new Error("unknown journey state");
  }
  if (authoritative && serverAuthoritativeStates.has(next)) return next;
  if (!transitions[current].includes(next)) {
    throw new Error(`invalid journey transition ${current} -> ${next}`);
  }
  return next;
}

export function nextOptionIndex(currentIndex, optionCount, key) {
  if (optionCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key === "ArrowUp") return currentIndex <= 0 ? optionCount - 1 : currentIndex - 1;
  if (key === "ArrowDown") return (currentIndex + 1) % optionCount;
  return currentIndex;
}

export function routeRuntime(option, routeMode = "bridge_plus_refuel") {
  return option?.routeModes?.[routeMode] ?? option?.runtime ?? {
    discoverable: false,
    quoteReady: false,
    executable: false,
    blockers: ["ROUTE_MODE_UNAVAILABLE"],
  };
}

export function providerOptions(options, search = "", routeMode = options?.defaults?.routeMode ?? "bridge_plus_refuel") {
  const query = search.trim().toLowerCase();
  return (options?.providers ?? [])
    .map((provider) => {
      const networkScopes = (options?.networks ?? [])
        .map((network) => ({
          network,
          option: (network.providerOptions ?? []).find((candidate) => candidate.id === provider.id),
        }))
        .filter(({ option }) => routeRuntime(option, routeMode).discoverable || option?.assetIds?.length);
      return {
        ...provider,
        networkIds: networkScopes.map(({ network }) => String(network.chainId)),
        assetIds: [...new Set(networkScopes.flatMap(({ option }) => option.assetIds ?? []))],
        runtime: {
          discoverable: networkScopes.length > 0,
          quoteReady: networkScopes.some(({ option }) => routeRuntime(option, routeMode).quoteReady),
          executable: networkScopes.some(({ option }) => routeRuntime(option, routeMode).executable),
          blockers: [...new Set(networkScopes.flatMap(({ option }) => routeRuntime(option, routeMode).blockers))],
        },
      };
    })
    .filter((provider) =>
      !query || [provider.label, provider.description].some((value) => value.toLowerCase().includes(query)),
    );
}

export function networkOptionsForProvider(options, providerId, search = "", routeMode = options?.defaults?.routeMode ?? "bridge_plus_refuel") {
  const query = search.trim().toLowerCase();
  return (options?.networks ?? [])
    .map((network) => ({
      ...network,
      providerOption: (() => {
        const option = (network.providerOptions ?? []).find((candidate) => candidate.id === providerId);
        return option ? { ...option, runtime: routeRuntime(option, routeMode) } : option;
      })(),
    }))
    .filter((network) => network.providerOption?.runtime?.discoverable || network.providerOption?.assetIds?.length)
    .filter((network) => !query || network.name.toLowerCase().includes(query));
}

export function providerOptionsForNetwork(options, chainId, search = "") {
  const network = (options?.networks ?? []).find((candidate) => String(candidate.chainId) === String(chainId));
  const query = search.trim().toLowerCase();
  return (network?.providerOptions ?? options?.providers ?? [])
    .filter((provider) =>
      !query || [provider.label, provider.description].some((value) => value.toLowerCase().includes(query)),
    );
}

export function tokenOptionsForNetwork(options, chainId, providerId = "auto", search = "", routeMode = options?.defaults?.routeMode ?? "bridge_plus_refuel") {
  const query = search.trim().toLowerCase();
  const rows = [];
  for (const asset of options?.assets ?? []) {
    if (!asset.originNetworks.includes(String(chainId))) continue;
    if (providerId !== "auto" && asset.provider !== providerId) continue;
    const origins = (asset.originTokens ?? []).filter((token) => token.chainId === String(chainId));
    const runtime = routeRuntime(asset, routeMode);
    if (origins.length === 0) {
      rows.push({
        id: `${asset.id}:undiscovered`,
        assetId: asset.id,
        provider: asset.provider,
        providerLabel: asset.providerLabel,
        symbol: asset.symbol,
        name: asset.name,
        // No origin token has been discovered, so no token icon is authoritative.
        // Use the deterministic symbol fallback instead of fetching an asset-level
        // URL that may not represent a real provider-discovered origin token.
        icon: null,
        address: null,
        decimals: asset.destination.decimals,
        disabled: true,
        blockers: ["ORIGIN_TOKEN_DISCOVERY_REQUIRED", ...runtime.blockers],
        asset,
      });
      continue;
    }
    for (const token of origins) {
      rows.push({
        id: `${asset.id}:${token.chainId}:${token.address}`,
        assetId: asset.id,
        provider: asset.provider,
        providerLabel: asset.providerLabel,
        symbol: token.symbol,
        name: token.name,
        icon: token.icon ?? asset.icon,
        address: token.address,
        decimals: token.decimals,
        native: token.native === true || token.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        disabled: !runtime.quoteReady,
        blockers: runtime.blockers,
        asset,
      });
    }
  }
  const filtered = query
    ? rows.filter((row) =>
        [row.symbol, row.name, row.providerLabel].some((value) => value.toLowerCase().includes(query)),
      )
    : rows;
  return filtered.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return a.symbol.localeCompare(b.symbol);
  });
}

export function parseUnits(value, decimals) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d*)?$/.test(text)) throw new Error("enter a valid amount");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`amount has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
}

export function formatUnits(value, decimals, precision = 6) {
  const amount = BigInt(value ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function tokenDisplayDecimals(symbol, decimals) {
  const normalized = String(symbol ?? "").toUpperCase();
  if (/^(USDC|USDC\.AXL|USDT|USDT0|DAI)$/.test(normalized)) return Math.min(decimals, 6);
  if (/^(HBAR|WHBAR|WBTC)$/.test(normalized)) return Math.min(decimals, 8);
  if (/^(ETH|WETH)$/.test(normalized)) return Math.min(decimals, 8);
  return Math.min(decimals, 6);
}

export function formatTokenAmount(value, decimals, symbol, maximumDisplayDecimals) {
  const amount = BigInt(value ?? 0);
  const precision = maximumDisplayDecimals === undefined
    ? tokenDisplayDecimals(symbol, decimals)
    : Math.max(0, Math.min(decimals, Number(maximumDisplayDecimals)));
  const display = formatUnits(amount, decimals, precision);
  const full = formatUnits(amount, decimals, decimals);
  if (amount > 0n && display === "0" && precision > 0) {
    return {
      display: `<${formatUnits(10n ** BigInt(decimals - precision), decimals, precision)}`,
      full,
      precision,
      truncated: true,
    };
  }
  return { display, full, precision, truncated: display !== full };
}

// The three figures a destination consent is made of, in the server's
// QUOTE_ECONOMICS_WORSENED details order.
const destinationTerms = [
  ["swapInputMaximum", "Most of your bridged asset that can be spent", "asset"],
  ["minimumRetained", "Least bridged asset you keep", "asset"],
  ["desiredHbarTinybar", "Exact HBAR you receive", "hbar"],
];

export function destinationTermsComparison({ consented, refreshed } = {}, quote) {
  const symbol = quote?.asset?.symbol ?? "asset";
  const decimals = Number(quote?.asset?.destination?.decimals ?? 0);
  return destinationTerms.map(([field, label, unit]) => {
    const show = (value) => unit === "hbar"
      ? `${formatTokenAmount(value ?? 0, 8, "HBAR").display} HBAR`
      : `${formatTokenAmount(value ?? 0, decimals, symbol).display} ${symbol}`;
    return {
      field,
      label,
      consented: show(consented?.[field]),
      refreshed: show(refreshed?.[field]),
      changed: String(consented?.[field] ?? "") !== String(refreshed?.[field] ?? ""),
    };
  });
}

export function normalizeDesiredHbar(value) {
  const tinybar = parseUnits(value, 8);
  if (tinybar <= 0n) throw new Error("desired HBAR must be greater than zero");
  return { tinybar, decimal: formatUnits(tinybar, 8, 8) };
}

export function buildCombinedQuoteRequest({ routeMode = "bridge_plus_refuel", mode, account, network, provider, token, amount, desiredHbar, slippageBps, refuelProtectionPreset = "flexible", customRefuelCap = "", solveMaximumHbar = false }) {
  if (!account) throw new Error("connect MetaMask");
  if (!network) throw new Error("select an origin network");
  if (!provider) throw new Error("select a bridge provider");
  if (provider.id !== "auto" && token?.provider !== provider.id) {
    throw new Error("selected token does not belong to the selected provider");
  }
  if (!token || token.disabled || !token.address) {
    throw new Error("select a quote-ready origin token");
  }
  const amountBaseUnits = parseUnits(amount, token.decimals);
  if (amountBaseUnits <= 0n) throw new Error("bridge amount must be greater than zero");
  const desired = routeMode === "bridge_only"
    ? { tinybar: 0n, decimal: "0" }
    : normalizeDesiredHbar(desiredHbar);
  if (!["flexible", "balanced", "strict", "custom"].includes(refuelProtectionPreset)) {
    throw new Error("select a valid refuel price-protection preset");
  }
  const customMaxAmountIn = refuelProtectionPreset === "custom"
    ? parseUnits(customRefuelCap, token.asset?.destination?.decimals ?? token.decimals)
    : null;
  if (refuelProtectionPreset === "custom" && customMaxAmountIn <= 0n) {
    throw new Error("custom refuel cap must be greater than zero");
  }
  return {
    mode,
    routeMode,
    account,
    provider: provider.id,
    assetId: token.assetId,
    originChainId: String(network.chainId),
    originToken: token.address,
    amountBaseUnits: amountBaseUnits.toString(),
    desiredHbar: desired.decimal,
    slippageBps: Number(slippageBps),
    refuelProtection: {
      preset: refuelProtectionPreset,
      ...(customMaxAmountIn === null ? {} : { customMaxAmountIn: customMaxAmountIn.toString() }),
    },
    ...(solveMaximumHbar ? { solveMaximumHbar: true } : {}),
  };
}

export function quoteStillValid(quote, state, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!quote || quote.expiresAt <= nowSeconds) return false;
  const tokenGroup = state.token?.asset?.comparisonGroup ?? state.token?.assetId;
  const quoteGroup = quote.providerSelection?.comparisonGroup ?? quote.asset?.id;
  return (
    quote.mode === state.mode &&
    (quote.routeMode ?? "bridge_plus_refuel") === (state.routeMode ?? "bridge_plus_refuel") &&
    quote.account?.toLowerCase() === state.account?.toLowerCase() &&
    quote.providerSelection?.requested === state.provider?.id &&
    quoteGroup === tokenGroup &&
    quote.bridge?.originChainId === String(state.network?.chainId) &&
    ((state.routeMode ?? "bridge_plus_refuel") === "bridge_only" ||
      ((!state.desiredHbarTinybar || quote.destination?.desiredHbarTinybar === String(state.desiredHbarTinybar)) &&
       (!state.refuelProtectionPreset || (quote.refuelCap?.preset ?? "flexible") === state.refuelProtectionPreset)))
  );
}

const blockerLabels = {
  SAUCER_ROUTE_UNAVAILABLE: "No qualifying SaucerSwap route to HBAR",
  SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED: "Only mixed V1/V2 paths exist; no atomic sponsored route is available",
  SAUCER_LIQUIDITY_POLICY: "SaucerSwap liquidity is below the product floor",
  SAUCER_FAIR_VALUE_DEVIATION: "Route price deviates from market evidence; refuel paused",
  SAUCER_QUOTER_CURRENT_PROBE_FAILED: "The destination quote probe is not currently authoritative",
  PROVIDER_QUOTE_REQUIRED: "Bridge provider quote access is not configured",
  PROVIDER_CREDENTIAL_MISSING: "The selected provider credential is not configured",
  PROVIDER_API_AUTHORIZATION_REQUIRED: "Provider API authorization required",
  PROVIDER_NETWORK_UNCONFIGURED: "The selected provider network route is not configured",
  MIRROR_QUOTE_ENDPOINT_NOT_CONFIGURED: "A dedicated production Mirror quote endpoint is not configured",
  SAUCER_API_NOT_READY: "SaucerSwap complete-graph API access is not ready",
  PROVIDER_UNSUPPORTED_TOKEN_NETWORK: "The provider does not support this token/network pair",
  STALE_QUOTE: "The provider quote expired and must be refreshed",
  EXPECTED_ARRIVAL_INSUFFICIENT: "Minimum arrival cannot cover protocol, HBAR purchase, and retained balance",
  PRICE_IMPACT_CAP_EXCEEDED: "Destination price impact exceeds the policy cap",
  DESIRED_HBAR_EXCEEDS_MAXIMUM: "Desired HBAR exceeds the server-verified maximum for this route",
  DESIRED_HBAR_ROUTE_INFEASIBLE: "That exact HBAR output is unavailable on the current fresh route",
  SPONSOR_EXPOSURE_CAP_EXCEEDED: "Sponsor exposure required by this quote exceeds the per-request cap",
  ORIGIN_TOKEN_UNVERIFIED: "The origin token mapping is not verified",
  PROVIDER_EXECUTION_ADAPTER_NOT_PROVEN: "The route-specific provider execution adapter is not proven",
  PROVIDER_NOT_AVAILABLE_ON_ORIGIN_NETWORK: "Provider is not available on this origin network",
  PROVIDER_ASSET_DISCOVERY_EMPTY: "Provider has no evidenced asset on this origin network",
  AUTO_PROVIDER_NO_QUOTE_READY_ROUTE: "Auto found no quote-ready provider route",
  ORIGIN_TOKEN_DISCOVERY_REQUIRED: "Origin token needs a live provider discovery result",
  PERMIT2_NOT_DEPLOYED: "Permit2 is not deployed on this Hedera network",
  X402_PROXY_NOT_DEPLOYED: "The x402 exact proxy is not deployed",
  X402_PAYMENT_RECIPIENT_NOT_CONFIGURED: "The exact x402 payment recipient is not configured",
  X402_FACILITATOR_NOT_READY: "The Hedera EVM x402 facilitator is not ready",
  POLICY_RPC_NOT_LIVE_PROVEN: "Destination gas sponsorship is not available yet",
  WRAPPER_EXECUTION_NOT_LIVE_PROVEN: "This asset needs a wrapper that is not available yet",
  EXECUTION_MODE_DISABLED: "Transaction submission is disabled",
  MAINNET_EXECUTION_DISABLED: "Mainnet execution is disabled",
  ROUTE_MODE_UNAVAILABLE: "This route mode is unavailable for the selected asset",
};

export function blockerLabel(code) {
  // An unmapped code used to be printed as visible body text, so a server blocker
  // the table had not caught up with read as "saucer mixed venue execution
  // unsupported" in the asset picker and the route strip.
  return blockerLabels[code] ?? "This route is unavailable right now";
}

export function quoteFailureMessage(error) {
  const body = error?.body ?? {};
  const details = body.details ?? {};
  const boundedOutputFailure = ["DESIRED_HBAR_EXCEEDS_MAXIMUM", "DESIRED_HBAR_ROUTE_INFEASIBLE"].includes(body.code);
  if (!boundedOutputFailure || details.maximumTinybar === undefined) {
    return error?.message ?? "Quote failed";
  }
  const requested = details.desiredTinybar === undefined ? null : formatUnits(details.desiredTinybar, 8, 8);
  const maximum = formatUnits(details.maximumTinybar, 8, 8);
  const resolution = details.solverResolutionTinybar === undefined
    ? null
    : formatUnits(details.solverResolutionTinybar, 8, 8);
  const reason = {
    CONFIGURED_MAX_HBAR: "the configured output cap",
    DESTINATION_AFFORDABILITY: "the bridged amount cannot cover the swap, fee, and retained-asset minimum",
    PRICE_IMPACT_CAP: "the live Saucer route would exceed the price-impact limit",
    SPONSOR_EXPOSURE_CAP: "the quote would exceed current sponsor exposure or reserve headroom",
    ROUTE_UNAVAILABLE: "no fresh executable exact-output route reaches a higher amount",
  }[details.limitingConstraint] ?? "the current live quote constraint";
  if (body.code === "DESIRED_HBAR_ROUTE_INFEASIBLE") {
    return `${requested ? `${requested} HBAR requested; ` : ""}that exact output is unavailable because ${reason}. A separate bounded maximum search found ${maximum} HBAR; use Max or try another amount/provider.${resolution && resolution !== "0" ? ` Conservative unresolved interval: ${resolution} HBAR.` : ""}`;
  }
  return `${requested ? `${requested} HBAR requested; ` : ""}current maximum ${maximum} HBAR because ${reason}.${resolution && resolution !== "0" ? ` Conservative unresolved interval: ${resolution} HBAR.` : ""}`;
}
