import { blockerLabel, formatTokenAmount, formatUnits, normalizeDesiredHbar, parseUnits } from "./product-model.js";

/**
 * Pure derivation for the compose surface: server evidence + editable draft in,
 * render-ready text out. No DOM, no framework, no network. Every amount is
 * formatted through product-model.js so the no-ellipsis and sub-precision rules
 * hold everywhere, and nothing here invents a number the server did not state.
 */

export const HBAR_DECIMALS = 8;
export const HBAR_SYMBOL = "HBAR";
const HBAR_GLYPH = "ℏ";
/**
 * Self-hosted, because the CSP allows `img-src 'self'` and a destination-side
 * mark that fails to load falls back to a two-letter placeholder. Both rows on
 * the receive side land on Hedera, so both carry the chain badge — the same
 * treatment the send side already gives the origin network.
 */
const HBAR_ICON = "/tokens/hbar.svg";
const HEDERA_CHAIN = { label: "Hedera", icon: "/tokens/hbar.svg" };
const BASE_PRESET_HBAR = ["10", "25"];
const FRESHNESS_WARNING_SECONDS = 15;

const constraintLabels = {
  CONFIGURED_MAX_HBAR: "Server policy cap on HBAR output",
  DESTINATION_AFFORDABILITY: "Minimum arrival cannot cover fees, swap input, and the retained-asset reserve",
  PRICE_IMPACT_CAP: "SaucerSwap price-impact policy",
  SPONSOR_EXPOSURE_CAP: "Per-request sponsor exposure cap",
  ROUTE_UNAVAILABLE: "No fresh executable route reaches a higher amount",
};

/** The server's limiting-constraint code, rendered without ever hiding the code itself. */
export function constraintText(code) {
  if (!code) return null;
  return constraintLabels[code] ?? String(code).replaceAll("_", " ").toLowerCase();
}

function bigintOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** `display` for the surface, `full` for the title attribute. Never an ellipsis. */
export function amountText(value, decimals, symbol) {
  const amount = formatTokenAmount(value ?? 0, decimals, symbol);
  return {
    display: amount.display,
    full: amount.full,
    truncated: amount.truncated,
    text: `${amount.display} ${symbol}`,
    title: `${amount.full} ${symbol}`,
  };
}

export function formatUsd(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The only fiat evidence the server ever publishes: a verified fair-value check
 * (token and HBAR spot) and the x402 market observation. Absent either one there
 * is no price and the surface says so rather than inventing one.
 */
export function quotePriceEvidence(quote) {
  const fair = quote?.destination?.fairValue ?? null;
  const market = quote?.x402?.marketEvidence ?? null;
  const verified = fair?.status === "verified";
  const number = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return {
    verified,
    hbarUsd: number(verified ? fair.hbarUsd : market?.hbarUsd),
    tokenUsd: number(verified ? fair.tokenPriceUsd : null),
    observedAt: market?.observedAt ?? null,
  };
}

function fiatFor(baseUnits, decimals, unitUsd, observedAt) {
  if (unitUsd === null || unitUsd === undefined) return null;
  const amount = bigintOrNull(baseUnits);
  if (amount === null) return null;
  const value = Number(formatUnits(amount, decimals, decimals)) * unitUsd;
  const text = formatUsd(value);
  if (!text) return null;
  return {
    text: `≈ ${text}`,
    title: observedAt
      ? `Server price evidence observed ${observedAt}`
      : "Derived from the server's published price evidence",
  };
}

const NO_PRICE = "USD —";
const NO_PRICE_TITLE = "No price evidence is published with this quote for this asset.";

/**
 * The two Hedera outputs. HBAR is the exact, user-named output; the kept asset
 * is the expected amount at the quoted rate, after the protocol fee and the HBAR
 * purchase — the convention every AMM and bridge uses. The slippage-derived
 * floor is not headline copy; it is the "Minimum received" row inside the route
 * disclosure (see deriveRouteSummary).
 */
export function deriveReceiveRows(quote, routeMode = quote?.routeMode ?? "bridge_plus_refuel", fallback = null) {
  const refuel = routeMode !== "bridge_only";
  // Before a quote exists the selected asset still names the destination token;
  // that is catalog evidence, not an invented number.
  const symbol = quote?.asset?.symbol ?? fallback?.symbol ?? null;
  const decimals = Number(quote?.asset?.destination?.decimals ?? fallback?.decimals ?? 0);
  const ledger = quote?.amountLedger?.destination ?? null;
  const price = quotePriceEvidence(quote);

  // A server that does not publish the expected figure yet is answered with its
  // own floor and the inequality that makes the floor honest, never with a
  // minimum silently relabelled as an expectation.
  const expected = ledger?.remainingExpected ?? null;
  const retained = expected ?? ledger?.remainingAtMinimum ?? null;
  const kept = {
    id: "kept",
    kind: "kept_asset",
    symbol: symbol ?? "Bridged asset",
    icon: null,
    chain: HEDERA_CHAIN,
    label: symbol ?? "Bridged asset",
    caption: refuel ? "kept in your wallet" : "arrives in your wallet",
    prefix: retained === null || expected !== null ? null : "≥",
    exact: false,
    amount: retained === null ? null : amountText(retained, decimals, symbol),
    fiat: retained === null ? null : fiatFor(retained, decimals, price.tokenUsd, price.observedAt),
    fiatPlaceholder: NO_PRICE,
    fiatPlaceholderTitle: NO_PRICE_TITLE,
    detail: null,
    placeholder: "—",
  };
  if (ledger) {
    const gross = amountText(ledger.grossArrival, decimals, symbol);
    const minimum = amountText(ledger.minimumArrival, decimals, symbol);
    // The gross/minimum pair is evidence, not headline copy: it lives in the
    // title so the row stays one line and the numbers stay reachable.
    kept.detail = {
      text: refuel ? "after fees and refuel" : "after provider fees",
      title: `Gross arrival ${gross.title} · minimum arrival ${minimum.title}`,
    };
  }

  if (!refuel) return { refuel: false, hbar: null, kept, rows: [kept] };

  const exactTinybar = quote?.amountLedger?.hbar?.exactOutputTinybar ?? quote?.destination?.desiredHbarTinybar ?? null;
  const hbar = {
    id: "hbar",
    kind: "exact_hbar",
    symbol: HBAR_SYMBOL,
    glyph: HBAR_GLYPH,
    icon: HBAR_ICON,
    chain: HEDERA_CHAIN,
    label: HBAR_SYMBOL,
    caption: "gas to receive on arrival",
    badge: "EXACT",
    exact: true,
    editable: true,
    prefix: null,
    amount: exactTinybar === null ? null : amountText(exactTinybar, HBAR_DECIMALS, HBAR_SYMBOL),
    fiat: exactTinybar === null ? null : fiatFor(exactTinybar, HBAR_DECIMALS, price.hbarUsd, price.observedAt),
    fiatPlaceholder: NO_PRICE,
    fiatPlaceholderTitle: NO_PRICE_TITLE,
    // No trailing "· delivered exactly". The EXACT pill beside the label already
    // makes that promise and carries the explanation in its hint; repeating it in
    // the meta line produced "USD — · delivered exactly" whenever no price was
    // published, which reads as a fragment rather than a fact.
    detail: null,
    placeholder: "—",
  };
  return { refuel: true, hbar, kept, rows: [hbar, kept] };
}

/**
 * Fiat beside the send amount, computed from the QUOTE's own source input rather
 * than the draft: editing the amount invalidates the quote, so this figure is
 * never a stale price attached to a fresh number.
 */
export function deriveSendFiat(quote) {
  const source = quote?.bridge?.normalized?.sourceAmount ?? null;
  const input = quote?.amountLedger?.source?.input ?? source?.amount ?? null;
  if (!source || input === null) return null;
  const price = quotePriceEvidence(quote);
  return fiatFor(input, source.decimals, price.tokenUsd, price.observedAt);
}

/**
 * How much of the bridged amount the refuel consumes, measured against the
 * server-solved maximum. Overflow is a first-class state: the meter reports the
 * server's own limiting constraint instead of a raw 422.
 */
export function deriveFeasibility({ quote, desiredHbarTinybar, maximum, routeMode, policyMaximum } = {}) {
  const mode = routeMode ?? quote?.routeMode ?? "bridge_plus_refuel";
  const record = maximum ?? quote?.feasibility ?? null;
  const desired = bigintOrNull(desiredHbarTinybar)
    ?? bigintOrNull(record?.desiredTinybar)
    ?? bigintOrNull(quote?.destination?.desiredHbarTinybar);
  const maximumTinybar = bigintOrNull(record?.maximumTinybar);
  const resolutionTinybar = bigintOrNull(record?.resolutionTinybar ?? record?.solverResolutionTinybar);
  const limitingConstraint = record?.limitingConstraint ?? null;
  const known = maximumTinybar !== null && maximumTinybar > 0n;
  const solved = record?.solved === true;

  const desiredAmount = desired === null ? null : amountText(desired, HBAR_DECIMALS, HBAR_SYMBOL);
  const maximumAmount = known ? amountText(maximumTinybar, HBAR_DECIMALS, HBAR_SYMBOL) : null;
  const overflow = Boolean(known && desired !== null && desired > maximumTinybar);
  const ratio = known && desired !== null ? Number(desired) / Number(maximumTinybar) : 0;

  const symbol = quote?.asset?.symbol ?? null;
  const decimals = Number(quote?.asset?.destination?.decimals ?? 0);
  const ledger = quote?.amountLedger?.destination ?? null;
  const consumed = ledger ? amountText(ledger.consumedMaximum, decimals, symbol) : null;
  const arriving = ledger ? amountText(ledger.minimumArrival, decimals, symbol) : null;

  const caption = mode === "bridge_only"
    ? "No refuel requested"
    : consumed && arriving
      ? `Refuel uses up to ${consumed.display} of the ${arriving.display} ${symbol} arriving`
      : "Refuel cost is priced when you get a quote";
  // Only a figure the server actually verified earns a caption. The configured cap
  // is already the last preset chip and is enforced on the field itself, so
  // restating it here as "Policy cap 50 ℏ · route max not solved yet" spent a line
  // of the meter on an internal solver status the owner cannot act on.
  const limitCaption = maximumAmount
    ? `${solved ? "Server maximum" : "Verified up to"} ${maximumAmount.display} ${HBAR_GLYPH}`
    : null;

  return {
    applicable: mode !== "bridge_only",
    known,
    solved,
    overflow,
    ratio,
    percent: Math.max(0, Math.min(100, ratio * 100)),
    // With no server-solved maximum there is nothing to measure against: an
    // unsolved bound must read as an empty track, never as an overflow.
    value: known && desired !== null ? desired.toString() : "0",
    max: known ? maximumTinybar.toString() : "0",
    desired: desiredAmount,
    maximum: maximumAmount,
    consumed,
    arriving,
    caption,
    limitCaption,
    limitingConstraint,
    constraintText: constraintText(limitingConstraint),
    resolution: resolutionTinybar === null || resolutionTinybar === 0n
      ? null
      : amountText(resolutionTinybar, HBAR_DECIMALS, HBAR_SYMBOL),
    overflowNote: overflow && maximumAmount
      ? `Server maximum for this bridge is ${maximumAmount.display} ${HBAR_GLYPH} — ${constraintText(limitingConstraint) ?? "the current live quote constraint"}.`
      : null,
    valueText: maximumAmount && desiredAmount
      ? `${desiredAmount.display} of ${maximumAmount.display} HBAR the server can deliver`
      : desiredAmount
        ? `${desiredAmount.display} HBAR requested; server maximum not solved yet`
        : "No HBAR amount entered",
  };
}

/**
 * Preset chips: two fixed amounts plus the ceiling, which is never a client
 * computation — it is whichever figure the SERVER has already published (the
 * solved route maximum once a quote has been priced, the configured policy cap
 * before that). The ceiling chip is labelled as the plain amount it is rather
 * than as "Max": a row reading `10 ℏ  25 ℏ  Max 50 ℏ` made the third chip look
 * like a different kind of control than the two beside it. Clicking it still asks
 * the server to re-solve the exact bound — that is behaviour, not a label.
 */
export function derivePresets({ maximum, policyMaximum } = {}) {
  // ONLY a solved record is a maximum. An unsolved one is a
  // `verified_feasible_lower_bound` — "10 ℏ was checked and works" — which the
  // server returns for the amount you asked about, deferred from a full solve for
  // latency. Treating it as a ceiling silently removed the 50 ℏ chip the moment a
  // 10 ℏ quote landed, because the ceiling collapsed onto the amount requested.
  const record = maximum?.maximumTinybar === undefined ? { maximumTinybar: maximum, solved: true } : maximum;
  const maximumTinybar = record?.solved === true ? bigintOrNull(record.maximumTinybar) : null;
  const known = maximumTinybar !== null && maximumTinybar > 0n;
  const policyTinybar = bigintOrNull(policyMaximum);
  const policyKnown = policyTinybar !== null && policyTinybar > 0n;
  const maximumAmount = known ? amountText(maximumTinybar, HBAR_DECIMALS, HBAR_SYMBOL) : null;
  const policyAmount = policyKnown ? amountText(policyTinybar, HBAR_DECIMALS, HBAR_SYMBOL) : null;
  const boundTinybar = known ? maximumTinybar : policyKnown ? policyTinybar : null;
  const boundDecimal = boundTinybar === null ? null : formatUnits(boundTinybar, HBAR_DECIMALS, HBAR_DECIMALS);

  const presetChip = (hbar) => {
    const tinybar = parseUnits(hbar, HBAR_DECIMALS);
    const exceedsMaximum = known && tinybar > maximumTinybar;
    return {
      id: `preset-${hbar}`,
      kind: "preset",
      hbar,
      label: `${formatTokenAmount(tinybar, HBAR_DECIMALS, HBAR_SYMBOL).display} ${HBAR_GLYPH}`,
      exceedsMaximum,
      // Above the solved maximum a chip stays clickable: the meter and the
      // server's constraint explain it far better than a dead control does.
      disabled: false,
      hint: exceedsMaximum
        ? `Above the server-solved maximum of ${maximumAmount.display} HBAR`
        : `Receive exactly ${hbar} HBAR on Hedera`,
    };
  };

  const bound = boundDecimal === null
    ? null
    : {
        ...presetChip(boundDecimal),
        id: "preset-bound",
        kind: "bound",
        known,
        source: known ? "solved_route_maximum" : "configured_policy_cap",
        exceedsMaximum: false,
        hint: maximumAmount
          ? `The most this route can deliver: ${maximumAmount.full} HBAR. Choosing it re-checks the live route.`
          : `The most one refuel may request: ${policyAmount.full} HBAR. The live route maximum is solved once there is an amount to price.`,
      };

  // Amounts ascending, deduplicated so a ceiling equal to a preset appears once.
  // The fixed presets are never dropped for being above a low solved maximum: they
  // stay listed and flagged, because the meter and the server's own constraint
  // explain the limit better than a missing or dead control does.
  const amounts = [...new Set([...BASE_PRESET_HBAR, ...(boundDecimal === null ? [] : [boundDecimal])])]
    .sort((left, right) => Number(left) - Number(right));
  const chips = amounts.map((hbar) => (bound && hbar === boundDecimal ? bound : presetChip(hbar)));
  return { chips, bound };
}

/** Preset selection is an amount comparison, not a string comparison: 10 === 10.0. */
export function matchesPreset(hbar, desiredHbar) {
  if (!hbar || !desiredHbar) return false;
  try {
    return normalizeDesiredHbar(hbar).tinybar === normalizeDesiredHbar(desiredHbar).tinybar;
  } catch {
    return false;
  }
}

function feeUsdTotal(quote) {
  const bridgeFees = quote?.bridge?.fees ?? [];
  const priced = bridgeFees.every((fee) => typeof fee.usd === "number" && Number.isFinite(fee.usd));
  const refuel = (quote?.routeMode ?? "bridge_plus_refuel") !== "bridge_only";
  const marketPriced = Boolean(quote?.x402?.marketEvidence);
  if (!priced || (refuel && !marketPriced)) return { complete: false, amount: null };
  const bridgeTotal = bridgeFees.reduce((sum, fee) => sum + fee.usd, 0);
  const protocolFee = refuel && typeof quote?.x402?.feeUsd === "number" ? quote.x402.feeUsd : 0;
  return { complete: true, amount: bridgeTotal + protocolFee };
}

// The server's own itemization is the fee list; the strip shows the entries a
// person is actually deciding on and leaves the full ledger to Details.
// x402_protocol_fee is deliberately absent: it is re-stated below in plain
// language ("Refuel service fee") rather than by its internal ledger label.
const FEE_ENTRY_IDS = new Set([
  "bridge_native_value",
  "bridge_effective_provider_difference",
]);

/**
 * One cost, written the same way everywhere: the token amount, then the USD it is
 * worth. Rows used to be inconsistent — the x402 fee carried a dollar figure while
 * the swap input and minimum received did not — which made two numbers in the same
 * list look like two different kinds of number. USD is appended only where the
 * server published the price evidence to derive it, never estimated.
 */
function pairedAmount(baseUnits, decimals, symbol, unitUsd, observedAt) {
  const amount = amountText(baseUnits, decimals, symbol);
  const fiat = fiatFor(baseUnits, decimals, unitUsd, observedAt);
  return {
    value: fiat ? `${amount.text} · ${fiat.text.replace(/^≈\s*/, "")}` : amount.text,
    title: [amount.title, fiat?.title].filter(Boolean).join(" · "),
  };
}

function costEntryText(entry, { unitUsd = null, observedAt = null, pairableSymbol = null } = {}) {
  const { baseUnits, unit, exactness } = entry.quantity ?? {};
  const serverFiat = entry.fiat ? ` · ${formatUsd(entry.fiat.amount) ?? ""}` : "";
  if (baseUnits === null || baseUnits === undefined) {
    return { value: `${exactness === "included" ? "Included" : "Estimated at signing"}${serverFiat}`, title: null };
  }
  if (unit === "basis_points") return { value: `${(Number(baseUnits) / 100).toFixed(2)}%`, title: null };
  if (unit === "gas_units") return { value: `${baseUnits} gas max`, title: null };
  const decimals = entry.asset?.decimals ?? (unit === "tinybar" ? HBAR_DECIMALS : unit === "wei" ? 18 : 0);
  const symbol = entry.asset?.symbol ?? "";
  const amount = amountText(baseUnits, decimals, symbol);
  if (serverFiat) return { value: `${amount.text}${serverFiat}`, title: amount.title };
  // No server price for this entry. It can still be paired, but ONLY when it is
  // denominated in the asset the published price evidence actually describes — the
  // asset being bridged. On an ETH→WETH route the origin messaging fee is that
  // asset; on a USDC route the same fee is in ETH while the evidence prices USDC,
  // and pairing them would print an invented number.
  if (pairableSymbol && symbol && symbol.toUpperCase() === String(pairableSymbol).toUpperCase()) {
    const paired = pairedAmount(baseUnits, decimals, symbol, unitUsd, observedAt);
    return { value: paired.value, title: paired.title };
  }
  return { value: amount.text, title: amount.title };
}

function hopPills(quote) {
  const route = quote?.destination?.routePresentation ?? null;
  if (!route) return [];
  const pills = [];
  const sourceSymbol = quote?.bridge?.normalized?.sourceAmount?.symbol;
  if (sourceSymbol) {
    pills.push({
      id: "origin",
      label: sourceSymbol,
      note: null,
      title: `Origin token on chain ${quote.bridge.originChainId}`,
    });
  }
  const assetSymbol = quote?.asset?.symbol;
  if (assetSymbol) {
    pills.push({
      id: "arrival",
      label: assetSymbol,
      note: quote?.asset?.destination?.standard ?? null,
      title: `Bridged asset on Hedera (${quote?.asset?.destination?.standard ?? "unknown standard"})`,
    });
  }
  if (route.wrapperBoundary) {
    pills.push({
      id: "wrapper",
      label: route.wrapperBoundary.output?.symbol ?? "HTS",
      note: "wrapper",
      title: `ERC20 → HTS wrapper at rate ${route.wrapperBoundary.rate}`,
    });
  }
  for (const hop of route.hops ?? []) {
    pills.push({
      id: `hop-${hop.index}`,
      label: hop.output?.symbol ?? hop.output?.tokenId ?? "?",
      note: `${(hop.feeBps / 100).toFixed(2)}%`,
      title: `Saucer ${String(hop.venue ?? hop.version ?? "").toUpperCase()} pool ${hop.pool?.id ?? "?"}${
        hop.liquidityUsd === null || hop.liquidityUsd === undefined
          ? " · liquidity not priced"
          : ` · $${hop.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} liquidity`
      }`,
    });
  }
  const last = (route.hops ?? []).at(-1);
  if (last && route.unwrapBoundary) {
    pills.push({ id: "hbar", label: HBAR_SYMBOL, note: "unwrapped", title: "WHBAR is unwrapped to native HBAR in the same atomic route" });
  }
  return pills;
}

/**
 * The ONE quote disclosure: a collapsed strip plus every fee, the sponsored-gas
 * line, max slippage, and the fair-value verdict behind it.
 */
export function derivePriceProtection(quote) {
  const cap = quote?.refuelCap;
  if (!cap || quote?.refuelAuthorization?.enabled !== true || (quote.routeMode ?? "bridge_plus_refuel") === "bridge_only") return null;
  const symbol = quote.asset?.symbol ?? "asset";
  const decimals = Number(quote.asset?.destination?.decimals ?? 0);
  const price = quotePriceEvidence(quote);
  const pair = (amount, usd) => {
    const displayed = pairedAmount(amount, decimals, symbol, price.tokenUsd, price.observedAt);
    return {
      amount: displayed.value,
      usd: typeof usd === "number" && Number.isFinite(usd) ? formatUsd(usd) : null,
      title: displayed.title,
    };
  };
  const labels = { flexible: "Flexible", balanced: "Balanced", strict: "Strict" };
  return {
    preset: cap.preset,
    bufferBps: Number(cap.bufferBps),
    etaMinutes: cap.etaMinutes,
    etaSource: cap.etaSource,
    today: pair(cap.todayAmountIn, cap.todayUsd),
    cap: pair(cap.maxAmountIn, cap.capUsd),
    options: (cap.presetOptions ?? []).map((option) => ({
      id: option.preset,
      label: labels[option.preset] ?? option.preset,
      bufferBps: Number(option.bufferBps),
      maximum: pair(option.maxAmountIn, null),
    })),
    warning: Number(cap.bufferBps) < Number(cap.warningBelowBps ?? 400)
      ? "Tight caps often need a manual re-quote when your funds land."
      : null,
    explanation: "If the price is better you spend less — anything unused stays in your wallet. If it moves past your cap nothing is spent.",
    deadline: "Converts when your funds land.",
  };
}

export function deriveRouteSummary(quote) {
  if (!quote) return { available: false, rows: [], hops: [] };
  const refuel = (quote.routeMode ?? "bridge_plus_refuel") !== "bridge_only";
  const route = quote.destination?.routePresentation ?? null;
  const symbol = quote.asset?.symbol ?? null;
  const decimals = Number(quote.asset?.destination?.decimals ?? 0);
  const source = quote.bridge?.normalized?.sourceAmount ?? null;
  const ledger = quote.amountLedger ?? null;

  const venue = route?.hops?.length
    ? `SaucerSwap ${String(route.hops[0].venue ?? route.hops[0].version ?? "v2").toUpperCase()}`
    : null;
  const seconds = quote.bridge?.estimatedSeconds ?? null;
  const eta = seconds ? `~${Math.max(1, Math.round(seconds / 60))} min` : "ETA pending";

  const price = quotePriceEvidence(quote);
  const usd = feeUsdTotal(quote);
  const consumed = refuel && ledger?.destination
    ? amountText(ledger.destination.consumedMaximum, decimals, symbol)
    : null;
  const providerCost = source && ledger?.source?.effectiveCost !== undefined
    ? amountText(ledger.source.effectiveCost, source.decimals, source.symbol)
    : null;
  // The headline total is one figure in both denominations wherever the server
  // published enough to state both. "≤ 0.00066596 WETH refuel cost" on its own is
  // unreadable as money; "≤ 0.00066596 WETH · $2.41" is the same fact, priced.
  const consumedPair = refuel && ledger?.destination
    ? pairedAmount(ledger.destination.consumedMaximum, decimals, symbol, price.tokenUsd, price.observedAt)
    : null;
  const providerCostPair = source && ledger?.source?.effectiveCost !== undefined
    ? pairedAmount(ledger.source.effectiveCost, source.decimals, source.symbol, price.tokenUsd, price.observedAt)
    : null;
  const total = consumedPair
    ? {
        kind: "asset",
        label: "Refuel cost",
        text: `≤ ${consumedPair.value}`,
        title: `Maximum debited on Hedera: ${consumedPair.title}.${usd.complete ? ` Origin-side bridge fees add ${formatUsd(usd.amount)}.` : " Origin-side bridge fees are itemized separately because they are not all priced in USD."}`,
      }
    : usd.complete
      ? { kind: "usd", label: "Fees", text: formatUsd(usd.amount), title: "Provider-priced bridge fees plus the quote-bound x402 protocol fee." }
      : providerCostPair
        ? { kind: "asset", label: "Bridge cost", text: `≈ ${providerCostPair.value}`, title: `Source input minus destination arrival: ${providerCostPair.title}.` }
        : { kind: "unpriced", label: "Fees", text: "itemized below", title: "No complete USD price set is published for this route; fees are shown in their own denominations." };

  const rows = [];
  for (const entry of quote.costLedger?.entries ?? []) {
    if (!FEE_ENTRY_IDS.has(entry.id) && !entry.id.startsWith("bridge_fee_")) continue;
    // An entry the server marks as an excluded overlap is the SAME money as another
    // row. Listing it printed one figure twice — "Bridge messaging fee 0.00007721
    // ETH" immediately above "LayerZero messaging fee (already counted) 0.00007721
    // ETH" — which reads as two fees however the second one is labelled. It is
    // excluded from the totals for exactly this reason.
    if (entry.aggregation === "excluded_overlap") continue;
    const cost = costEntryText(entry, {
      unitUsd: price.tokenUsd,
      observedAt: price.observedAt,
      pairableSymbol: source?.symbol ?? null,
    });
    rows.push({
      id: entry.id,
      label: entry.label,
      value: cost.value,
      title: [cost.title, entry.note].filter(Boolean).join(" · "),
      tone: "neutral",
    });
  }
  if (!rows.length && providerCostPair) {
    rows.push({
      id: "bridge-effective",
      label: `Bridge cost · ${quote.bridge?.providerLabel ?? "provider"}`,
      value: providerCostPair.value,
      title: `Source input minus destination arrival: ${providerCostPair.title}`,
      tone: "neutral",
    });
  }
  if (refuel && ledger?.destination) {
    const protocolFee = pairedAmount(ledger.destination.x402ProtocolFee, decimals, symbol, price.tokenUsd, price.observedAt);
    const swapInput = pairedAmount(ledger.destination.swapInputMaximum, decimals, symbol, price.tokenUsd, price.observedAt);
    rows.push({
      id: "x402_protocol_fee",
      label: "Refuel service fee (x402)",
      // The quote's own fee price wins where it exists; otherwise the same
      // token-plus-USD pairing as every other row, so the list stays uniform.
      value: typeof quote.x402?.feeUsd === "number" && quote.x402?.marketEvidence
        ? `${amountText(ledger.destination.x402ProtocolFee, decimals, symbol).text} · ${formatUsd(quote.x402.feeUsd)}`
        : protocolFee.value,
      title: protocolFee.title,
      tone: "neutral",
    });
    rows.push({
      id: "swap-input",
      label: "HBAR purchase, at most",
      value: `≤ ${swapInput.value}`,
      title: `Router may pull at most ${swapInput.title}; anything unused stays with you.`,
      tone: "neutral",
    });
  }

  const sponsoredTinybar = bigintOrNull(quote.costLedger?.summary?.externalExecutionExposureMaximumTinybar);
  const sponsoredGas = refuel && sponsoredTinybar !== null
    ? {
        id: "sponsored-gas",
        label: "Hedera gas",
        value: "Sponsored · $0",
        tone: "brand",
        title: `Refuel402 authorizes up to ${amountText(sponsoredTinybar, HBAR_DECIMALS, HBAR_SYMBOL).full} HBAR of destination gas. It is never deducted from your bridged amount.`,
      }
    : null;
  if (sponsoredGas) rows.push(sponsoredGas);

  const slippageBps = quote.destination?.slippageBps ?? quote.consent?.maxSlippageBps ?? null;
  const maxSlippage = slippageBps === null
    ? null
    : {
        id: "max-slippage",
        label: "Max slippage",
        value: `${(slippageBps / 100).toFixed(2)}%`,
        tone: "neutral",
        title: "A hard cap on the destination swap; the route reverts rather than exceed it.",
      };
  if (maxSlippage) rows.push(maxSlippage);

  // The floor that the headline output is measured against. It belongs beside
  // max slippage, because slippage is the only reason the two numbers differ.
  const minimumReceivedUnits = ledger?.destination?.remainingAtMinimum ?? null;
  const minimumReceived = minimumReceivedUnits === null
    ? null
    : {
        id: "minimum-received",
        label: "Minimum received",
        value: pairedAmount(minimumReceivedUnits, decimals, symbol, price.tokenUsd, price.observedAt).value,
        tone: "neutral",
        title: refuel
          ? `Worst case: the provider delivers only its minimum arrival and the router pulls its full slippage-bounded input. Exactly ${amountText(minimumReceivedUnits, decimals, symbol).title}.`
          : `Worst case: the provider delivers only its minimum arrival. Exactly ${amountText(minimumReceivedUnits, decimals, symbol).title}.`,
      };
  if (minimumReceived) rows.push(minimumReceived);

  const fair = quote.destination?.fairValue ?? null;
  const fairValue = !refuel || !fair
    ? null
    : fair.status === "verified"
      ? {
          id: "fair-value",
          label: "Price vs market",
          value: fair.deviationBps <= fair.maximumDeviationBps
            ? `Within ${(fair.deviationBps / 100).toFixed(2)}%`
            : `Off market by ${(fair.deviationBps / 100).toFixed(2)}%`,
          tone: fair.deviationBps <= fair.maximumDeviationBps ? "brand" : "danger",
          title: `Quote-implied ${fair.quoteImpliedHbarPerToken} HBAR per token vs market ${fair.marketImpliedHbarPerToken}; policy cap ${(fair.maximumDeviationBps / 100).toFixed(2)}%.`,
        }
      : {
          id: "fair-value",
          label: "Price vs market",
          value: "Not verified",
          tone: "warning",
          title: fair.reason ?? "Independent market evidence is unavailable for this route.",
        };
  if (fairValue) rows.push(fairValue);

  const priceImpactBps = refuel ? quote.destination?.priceImpactBps ?? null : null;
  if (priceImpactBps !== null) {
    rows.push({
      id: "price-impact",
      label: "Price impact",
      value: `${(priceImpactBps / 100).toFixed(2)}%`,
      tone: "neutral",
      title: "Already reflected in the exact-output input; never charged again as a fee.",
    });
  }

  return {
    available: true,
    refuel,
    provider: quote.bridge?.providerLabel ?? "Bridge",
    venue,
    eta,
    etaSeconds: seconds,
    summaryLine: [quote.bridge?.providerLabel, venue].filter(Boolean).join(" → "),
    // The two legs, split so the surface can lay them out rather than render one
    // long slash-and-arrow string that wrapped mid-name.
    legs: [quote.bridge?.providerLabel, venue].filter(Boolean),
    total,
    hops: hopPills(quote),
    rows,
    sponsoredGas,
    maxSlippage,
    fairValue,
    routeSummary: route?.summary ?? null,
    disclosure: route?.disclosure ?? null,
    liquidityUsd: route?.minimumLiquidityUsd ?? null,
    // quoteId and expiresAt used to ride along here. No component read either, and
    // freshness is owned by deriveQuoteFreshness — carrying a quote id into a
    // presentational summary only invited a surface to render it.
  };
}

/**
 * Blocker codes never reach the surface as codes. The code is kept on the object
 * because it is a stable React key, but it is no longer offered as a tooltip: the
 * docstring here used to claim codes never surfaced while `title` handed
 * SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED straight to the reader.
 */
export function deriveQuoteBlockers(quote) {
  return [...new Set(quote?.blockers ?? [])].map((code) => ({
    code,
    text: blockerLabel(code),
  }));
}

/** Quote freshness. Expiry is presentation only: it never signs or re-quotes. */
export function deriveQuoteFreshness({ secondsRemaining = 0, total = 0, stale = false } = {}) {
  const remaining = Math.max(0, Math.floor(Number(secondsRemaining) || 0));
  const span = Math.max(remaining, Math.floor(Number(total) || 0), 1);
  const expired = stale || remaining <= 0;
  const warning = !expired && remaining <= FRESHNESS_WARNING_SECONDS;
  return {
    remaining,
    total: span,
    expired,
    warning,
    tone: warning ? "warning" : "brand",
    caption: expired ? "0" : String(remaining),
    text: expired
      ? "Quote expired — refresh to re-price. No wallet action."
      : warning
        ? `Quote expires in ${remaining}s`
        : `Quote fresh for ${remaining}s`,
    label: "Quote freshness",
  };
}

function draftAmountProblem({ sourceAmount, token, balance, balanceStatus }) {
  if (!token) return null;
  const text = String(sourceAmount ?? "").trim();
  if (!text || Number(text) === 0) return "Enter an amount to bridge";
  let amount;
  try {
    amount = parseUnits(text, token.decimals);
  } catch (error) {
    return error.message;
  }
  if (amount <= 0n) return "Enter an amount to bridge";
  if (balanceStatus === "ready" && balance !== null && balance !== undefined && amount > BigInt(balance)) {
    return `Amount exceeds your ${token.symbol} balance`;
  }
  return null;
}

const intentCopy = {
  // No note: the button says what it does, and reassurance nobody asked for reads
  // as a reason to be suspicious.
  connect_wallet: { label: "Connect MetaMask" },
  busy: { label: "Working…" },
  quoting: { label: "Getting quote…" },
  select_provider: { label: "Select a bridge provider", reason: "No quote-ready provider is selected." },
  select_network: { label: "Select an origin network", reason: "No origin network is selected." },
  select_token: { label: "Select an asset", reason: "Choose the token you are bridging." },
  route_unavailable: { label: "Route unavailable" },
  invalid_desired_hbar: { label: "Check the HBAR amount" },
  request_quote: { label: "Get quote", note: "A quote is a read. No wallet action." },
  refresh_quote: { label: "Refresh quote", note: "Re-prices at the live rate. No wallet action." },
  launch_paused: { label: "Launch paused" },
  start_journey: { label: "Review & start journey", note: "You approve every step in MetaMask." },
  accept_new_terms: { label: "Review updated terms" },
  new_transfer: { label: "Start new transfer" },
  resend_journey: { label: "Send this journey again", note: "Re-quotes first, then asks for fresh wallet consent." },
  rechecking: { label: "Re-checking with the server…" },
  wait_bridge: { label: "Waiting for arrival" },
  wait_refuel: { label: "Converting automatically…" },
  continue_destination: { label: "Approve HBAR conversion" },
  refresh_destination: { label: "Refresh the arrival quote", note: "No wallet action." },
  adopt_bridge: { label: "Link my bridge transaction" },
  reconcile: { label: "Reconcile submissions" },
  blocked: { label: "Paused — see details" },
  complete: { label: "Completed" },
};

/**
 * CTA copy for the one primary action. It may only ADD a disabled reason to the
 * store's intent (an empty amount is a draft problem the intent table does not
 * model); it can never enable something the store disabled.
 */
export function derivePrimaryAction({
  intent,
  routeMode = "bridge_plus_refuel",
  sourceAmount = "",
  token = null,
  desiredHbarError = null,
  quote = null,
  quoteExpired = false,
  balance = null,
  balanceStatus = "idle",
} = {}) {
  // An unmapped intent reads as "Continue" rather than printing the store's own
  // intent vocabulary onto the compose button.
  const base = intentCopy[intent?.kind] ?? { label: "Continue" };
  const busy = Boolean(intent?.busy);
  let label = base.label;
  let reason = base.reason ?? null;
  let disabled = Boolean(intent?.disabled);

  if (intent?.kind === "route_unavailable" && intent.detail) reason = blockerLabel(intent.detail);
  if (intent?.kind === "invalid_desired_hbar") reason = intent.detail ?? desiredHbarError;
  if (intent?.kind === "launch_paused") {
    reason = deriveQuoteBlockers(quote)[0]?.text ?? "The server has not cleared this route for execution.";
  }
  if (intent?.kind === "busy") {
    label = intent.detail === "quote_refresh"
      ? "Refreshing quote…"
      : intent.detail === "recovering" ? "Checking your journey…" : "Loading routes…";
  }
  if (intent?.kind === "refresh_quote" || (intent?.kind === "start_journey" && quoteExpired)) {
    label = intentCopy.refresh_quote.label;
  }

  const drafting = ["request_quote", "refresh_quote", "start_journey"].includes(intent?.kind);
  if (drafting && !disabled) {
    const problem = draftAmountProblem({ sourceAmount, token, balance, balanceStatus });
    if (problem) {
      disabled = true;
      reason = problem;
      label = intentCopy.request_quote.label;
    } else if (routeMode !== "bridge_only" && desiredHbarError) {
      disabled = true;
      reason = desiredHbarError;
    }
  }

  return {
    kind: intent?.kind ?? "unknown",
    label,
    reason,
    disabled,
    busy,
    note: disabled ? null : base.note ?? null,
  };
}

/** One line under the settings trigger: the whole non-amount policy at a glance. */
export function deriveSettingsSummary({ provider, network, slippagePercent, routeMode, mode } = {}) {
  // Slippage is sent on both route modes (bridge_only spends it on the provider's
  // minimum-received tolerance), so it is never dropped from the summary.
  const parts = [
    provider?.id === "auto" ? "Auto-best provider" : provider?.label ?? "No provider",
    network?.name ?? "No origin network",
    `${Number(slippagePercent || 0).toFixed(2)}% max slippage`,
    routeMode === "bridge_only" ? "Bridge only" : "Bridge + refuel",
    mode === "mainnet" ? "Hedera mainnet" : "Hedera testnet",
  ];
  return parts.join(" · ");
}

/**
 * Picker rows grouped by origin chain. Disabled candidates stay visible with the
 * server's own reason: hiding an unavailable route hides why it is unavailable.
 */
export function derivePickerGroups({ networks = [], tokensFor, search = "", selectedTokenId = null, balances = {} } = {}) {
  const query = String(search ?? "").trim().toLowerCase();
  return networks
    .map((network) => {
      // Searching a chain name shows that chain whole, so a user who types
      // "Base" is not left guessing which of its assets matched the string.
      const networkMatch = Boolean(query) && String(network.name ?? "").toLowerCase().includes(query);
      const rows = (tokensFor?.(network, networkMatch ? "" : query) ?? []).map((token) => {
        const balance = balances?.[token.id];
        return {
          ...token,
          selected: token.id === selectedTokenId,
          balance: balance === undefined || balance === null
            ? null
            : amountText(balance, token.decimals, token.symbol),
          reasons: [...new Set(token.blockers ?? [])].map((code) => ({ code, text: blockerLabel(code) })),
        };
      });
      return {
        id: String(network.chainId),
        network,
        networkMatch,
        rows,
        available: rows.some((row) => !row.disabled),
      };
    })
    .filter((group) => group.rows.length > 0);
}
