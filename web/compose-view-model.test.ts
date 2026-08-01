import { describe, expect, it } from "vitest";
import {
  amountText,
  deriveOriginGasCheck,
  constraintText,
  derivePickerGroups,
  derivePresets,
  derivePrimaryAction,
  derivePriceProtection,
  deriveQuoteBlockers,
  deriveQuoteFreshness,
  deriveReceiveRows,
  deriveRouteSummary,
  deriveSettingsSummary,
  deriveFeasibility,
  formatUsd,
  matchesPreset,
  quotePriceEvidence,
} from "./compose-view-model.js";

const refuelQuote = {
  routeMode: "bridge_plus_refuel",
  quoteId: "abc123",
  expiresAt: 1_800_000_000,
  asset: {
    id: "axelar-usdc",
    symbol: "USDC.axl",
    destination: { standard: "HTS", address: "0x0", decimals: 6 },
  },
  bridge: {
    provider: "axelar",
    providerLabel: "Axelar",
    originChainId: "1",
    estimatedSeconds: 1_080,
    fees: [{ name: "Axelar bridge fee", category: "provider", amount: "420000", symbol: "USDC", usd: 0.42, payer: "user" }],
    normalized: {
      sourceAmount: { amount: "25000000", token: "0xa0b", decimals: 6, symbol: "USDC" },
      destinationAsset: { address: "0x0", tokenId: "0.0.1", standard: "HTS", decimals: 6, symbol: "USDC.axl" },
    },
  },
  destination: {
    desiredHbarTinybar: "1000000000",
    slippageBps: 100,
    priceImpactBps: 12,
    fairValue: {
      status: "verified",
      deviationBps: 5,
      maximumDeviationBps: 300,
      quoteImpliedHbarPerToken: 14.7,
      marketImpliedHbarPerToken: 14.6,
      tokenPriceUsd: 1.0001,
      hbarUsd: 0.068,
    },
    routePresentation: {
      summary: "USDC.axl (HTS) → WHBAR [Saucer V2 0.05%]",
      minimumLiquidityUsd: 412_000,
      wrapperBoundary: null,
      hops: [
        {
          index: 0,
          venue: "v2",
          version: "v2",
          input: { tokenId: "0.0.1", address: "0x1", symbol: "USDC" },
          output: { tokenId: "0.0.2", address: "0x2", symbol: "WHBAR" },
          pool: { id: "42", contractId: "0.0.42" },
          feeTier: 500,
          feeBps: 5,
          liquidityUsd: 412_000,
        },
      ],
      unwrapBoundary: { kind: "whbar_to_hbar", input: null, output: { symbol: "HBAR", decimals: 8 } },
      disclosure: "Bounded single-venue candidates only.",
    },
  },
  x402: {
    feeAmount: "550000",
    feeUsd: 0.55,
    marketEvidence: { observedAt: "2026-07-28T00:00:00.000Z", gasPriceTinybarPerGas: "1", hbarUsd: 0.068 },
  },
  amountLedger: {
    source: { input: "25000000", effectiveCost: "10000" },
    destination: {
      grossArrival: "24990000",
      minimumArrival: "24940000",
      x402ProtocolFee: "550000",
      swapInputMaximum: "830000",
      swapInputExpected: "800000",
      consumedMaximum: "1380000",
      consumedExpected: "1350000",
      remainingAtMinimum: "23560000",
      remainingExpected: "23640000",
      minimumRetainedByPolicy: "0",
    },
    hbar: { exactOutputTinybar: "1000000000", minimumOutputTinybar: "1000000000" },
  },
  costLedger: {
    entries: [
      {
        id: "bridge_fee_0",
        label: "Axelar bridge fee",
        stage: "bridge",
        payer: "user",
        fundingSource: "deducted_from_bridge",
        asset: { symbol: "USDC", address: "0xa0b", decimals: 6, kind: "token" },
        quantity: { baseUnits: "420000", unit: "base_units", exactness: "estimated" },
        fiat: { currency: "USD", amount: 0.42, evidenceAt: "2026-07-28T00:00:00.000Z" },
        note: "Provider-returned fee estimate.",
      },
      {
        id: "x402_protocol_fee",
        label: "x402 / Permit2 / proxy / policy fee",
        stage: "x402",
        payer: "user",
        fundingSource: "deducted_from_bridge",
        asset: { symbol: "USDC.axl", address: "0x0", decimals: 6, kind: "token" },
        quantity: { baseUnits: "550000", unit: "base_units", exactness: "quote_bound" },
        fiat: { currency: "USD", amount: 0.55, evidenceAt: "2026-07-28T00:00:00.000Z" },
        note: null,
      },
    ],
    summary: { externalExecutionExposureMaximumTinybar: "250000000" },
  },
  feasibility: {
    maximumTinybar: "4380000000",
    desiredTinybar: "1000000000",
    headroomTinybar: "3380000000",
    limitingConstraint: "DESTINATION_AFFORDABILITY",
    resolutionTinybar: "10000000",
    solved: true,
  },
  capabilities: { quote: true, execute: true },
  blockers: [],
};

const bridgeOnlyQuote = {
  ...refuelQuote,
  routeMode: "bridge_only",
  destination: { desiredHbarTinybar: "0", slippageBps: 100, routePresentation: null, fairValue: null },
  x402: { enabled: false, feeAmount: "0", feeUsd: 0, sponsorPolicy: null },
  amountLedger: {
    source: { input: "25000000", effectiveCost: "10000" },
    destination: {
      grossArrival: "24990000",
      minimumArrival: "24940000",
      x402ProtocolFee: "0",
      swapInputMaximum: "0",
      swapInputExpected: "0",
      consumedMaximum: "0",
      consumedExpected: "0",
      remainingAtMinimum: "24940000",
      remainingExpected: "24990000",
    },
    hbar: { exactOutputTinybar: "0" },
  },
  costLedger: { entries: [], summary: {} },
  feasibility: { maximumTinybar: "0", desiredTinybar: "0", limitingConstraint: "ROUTE_UNAVAILABLE", solved: false },
};

describe("amountText", () => {
  it("keeps the full-precision value beside the display value and never ellipsizes", () => {
    const value = amountText("23560000", 6, "USDC.axl");
    expect(value.display).toBe("23.56");
    expect(value.title).toBe("23.56 USDC.axl");
    expect(value.text).not.toContain("…");
  });

  it("renders a sub-precision non-zero amount as a bounded value, never 0", () => {
    const value = amountText("1", 18, "WETH");
    expect(value.display).toBe("<0.00000001");
    expect(value.full).toBe("0.000000000000000001");
    expect(value.truncated).toBe(true);
  });
});

describe("formatUsd", () => {
  it("returns null without a finite number rather than a fabricated zero", () => {
    expect(formatUsd(null as unknown as number)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });

  it("bounds sub-cent amounts instead of rounding them away", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("quotePriceEvidence", () => {
  it("reads verified fair-value evidence", () => {
    const evidence = quotePriceEvidence(refuelQuote);
    expect(evidence.verified).toBe(true);
    expect(evidence.hbarUsd).toBe(0.068);
    expect(evidence.tokenUsd).toBe(1.0001);
    expect(evidence.observedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("reports no price when the server published none", () => {
    const evidence = quotePriceEvidence({ ...refuelQuote, destination: { fairValue: null }, x402: {} });
    expect(evidence.hbarUsd).toBeNull();
    expect(evidence.tokenUsd).toBeNull();
  });
});

describe("deriveReceiveRows", () => {
  it("renders one exact HBAR row and one derived kept-asset row for bridge_plus_refuel", () => {
    const rows = deriveReceiveRows(refuelQuote, "bridge_plus_refuel");
    expect(rows.rows).toHaveLength(2);
    expect(rows.hbar?.badge).toBe("EXACT");
    expect(rows.hbar?.editable).toBe(true);
    expect(rows.hbar?.amount?.display).toBe("10");
    // The headline is the expected amount at the quoted rate — no inequality.
    // The slippage floor is a row inside the route disclosure instead.
    expect(rows.kept.prefix).toBeNull();
    expect(rows.kept.amount?.display).toBe("23.64");
  });

  it("marks both receive rows as landing on Hedera and gives HBAR its own mark", () => {
    const rows = deriveReceiveRows(refuelQuote, "bridge_plus_refuel");
    expect(rows.hbar?.icon).toBe("/tokens/hbar.svg");
    expect(rows.hbar?.chain).toEqual({ label: "Hedera", icon: "/tokens/hbar.svg" });
    expect(rows.kept.chain).toEqual({ label: "Hedera", icon: "/tokens/hbar.svg" });
    expect(rows.hbar?.caption).toBe("gas to receive on arrival");
    // "USD — · delivered exactly" was the unpriced rendering of this pair. The
    // EXACT pill carries the promise; the meta line carries only the price.
    expect(rows.hbar?.detail).toBeNull();
  });

  it("falls back to the server's floor, inequality and all, when no expected figure is published", () => {
    const legacy = {
      ...refuelQuote,
      amountLedger: {
        ...refuelQuote.amountLedger,
        destination: (({ remainingExpected, ...rest }) => rest)(refuelQuote.amountLedger.destination),
      },
    };
    const rows = deriveReceiveRows(legacy, "bridge_plus_refuel");
    expect(rows.kept.prefix).toBe("≥");
    expect(rows.kept.amount?.display).toBe("23.56");
  });

  it("drops the HBAR row entirely in bridge_only", () => {
    const rows = deriveReceiveRows(bridgeOnlyQuote, "bridge_only");
    expect(rows.refuel).toBe(false);
    expect(rows.hbar).toBeNull();
    expect(rows.rows).toHaveLength(1);
    expect(rows.kept.caption).toBe("arrives in your wallet");
  });

  it("attaches fiat only where the server published price evidence", () => {
    const withPrice = deriveReceiveRows(refuelQuote, "bridge_plus_refuel");
    expect(withPrice.hbar?.fiat?.text).toBe("≈ $0.68");
    expect(withPrice.kept.fiat?.text).toBe("≈ $23.64");

    const noPrice = deriveReceiveRows({ ...refuelQuote, destination: { ...refuelQuote.destination, fairValue: null }, x402: {} }, "bridge_plus_refuel");
    expect(noPrice.hbar?.fiat).toBeNull();
    expect(noPrice.kept.fiat).toBeNull();
    expect(noPrice.kept.fiatPlaceholder).toBe("USD —");
    expect(noPrice.kept.fiatPlaceholderTitle).toContain("No price evidence");
  });

  it("renders placeholders instead of numbers before a quote exists", () => {
    const rows = deriveReceiveRows(null, "bridge_plus_refuel");
    expect(rows.kept.amount).toBeNull();
    expect(rows.hbar?.amount).toBeNull();
    expect(rows.kept.placeholder).toBe("—");
  });
});

describe("deriveFeasibility", () => {
  it("measures the request against the server-solved maximum", () => {
    const feasibility = deriveFeasibility({ quote: refuelQuote, desiredHbarTinybar: 1_000_000_000n, maximum: refuelQuote.feasibility });
    expect(feasibility.known).toBe(true);
    expect(feasibility.overflow).toBe(false);
    expect(Math.round(feasibility.percent)).toBe(23);
    expect(feasibility.maximum?.display).toBe("43.8");
    expect(feasibility.consumed?.display).toBe("1.38");
    expect(feasibility.caption).toContain("1.38");
  });

  it("overflows with the server's limiting constraint rather than a raw code", () => {
    const feasibility = deriveFeasibility({
      quote: refuelQuote,
      desiredHbarTinybar: 9_000_000_000n,
      maximum: { maximumTinybar: "4380000000", limitingConstraint: "SPONSOR_EXPOSURE_CAP", solverResolutionTinybar: "10000000" },
    });
    expect(feasibility.overflow).toBe(true);
    expect(feasibility.percent).toBe(100);
    expect(feasibility.limitingConstraint).toBe("SPONSOR_EXPOSURE_CAP");
    expect(feasibility.overflowNote).toContain("Per-request sponsor exposure cap");
    expect(feasibility.overflowNote).not.toContain("SPONSOR_EXPOSURE_CAP");
    expect(feasibility.resolution?.display).toBe("0.1");
  });

  it("says nothing at all rather than reporting an unsolved solver", () => {
    const feasibility = deriveFeasibility({ quote: null, desiredHbarTinybar: 100_000_000n, maximum: null });
    expect(feasibility.known).toBe(false);
    expect(feasibility.overflow).toBe(false);
    // Only a verified figure earns a caption. "Max not solved yet" reported the
    // state of the server's solver, which is not a fact the owner can act on.
    expect(feasibility.limitCaption).toBeNull();
  });

  it("does not restate the configured cap on the meter, and never measures against it", () => {
    const feasibility = deriveFeasibility({
      quote: null,
      desiredHbarTinybar: 100_000_000n,
      maximum: null,
      policyMaximum: "5000000000",
    });
    expect(feasibility.known).toBe(false);
    // The cap is the last preset chip and is enforced on the field itself.
    expect(feasibility.limitCaption).toBeNull();
    expect(feasibility.max).toBe("0");
    expect(feasibility.percent).toBe(0);
    expect(feasibility.overflow).toBe(false);
  });

  it("captions a solved or verified maximum, distinguishing the two", () => {
    expect(deriveFeasibility({
      quote: null,
      desiredHbarTinybar: 100_000_000n,
      maximum: { maximumTinybar: "1000000000", solved: true },
    }).limitCaption).toBe("Server maximum 10 ℏ");
    expect(deriveFeasibility({
      quote: null,
      desiredHbarTinybar: 100_000_000n,
      maximum: { maximumTinybar: "1000000000" },
    }).limitCaption).toBe("Verified up to 10 ℏ");
  });

  it("is not applicable in bridge_only", () => {
    expect(deriveFeasibility({ quote: bridgeOnlyQuote }).applicable).toBe(false);
  });
});

describe("derivePresets", () => {
  it("offers two fixed amounts plus the configured ceiling, labelled as plain amounts", () => {
    const presets = derivePresets({ policyMaximum: "5000000000" });
    expect(presets.chips.map((chip) => chip.label)).toEqual(["10 ℏ", "25 ℏ", "50 ℏ"]);
    // "Max 50 ℏ" made the third chip look like a different kind of control.
    expect(presets.chips.some((chip) => /Max/.test(chip.label))).toBe(false);
    expect(presets.bound.kind).toBe("bound");
    expect(presets.bound.source).toBe("configured_policy_cap");
    expect(presets.bound.hbar).toBe("50");
  });

  it("takes the ceiling from the solved route maximum once the server has one", () => {
    const presets = derivePresets({ maximum: refuelQuote.feasibility, policyMaximum: "5000000000" });
    expect(presets.bound.known).toBe(true);
    expect(presets.bound.source).toBe("solved_route_maximum");
    expect(presets.bound.label).toBe("43.8 ℏ");
    expect(presets.bound.hbar).toBe("43.8");
    expect(presets.chips.at(-1)).toBe(presets.bound);
  });

  it("never invents a ceiling the server did not publish", () => {
    const presets = derivePresets({});
    expect(presets.bound).toBeNull();
    expect(presets.chips.map((chip) => chip.hbar)).toEqual(["10", "25"]);
  });

  it("lists a ceiling that equals a preset exactly once", () => {
    const presets = derivePresets({ policyMaximum: "2500000000" });
    expect(presets.chips.map((chip) => chip.label)).toEqual(["10 ℏ", "25 ℏ"]);
    expect(presets.chips.filter((chip) => chip.hbar === "25")).toHaveLength(1);
    expect(presets.chips.at(-1)).toBe(presets.bound);
  });

  it("ignores an unsolved feasibility record, which is a verified lower bound", () => {
    // Production, ETH→WETH for 10 ℏ: the server answers
    // { maximumTinybar: 10 ℏ, solved: false, boundKind: "verified_feasible_lower_bound",
    //   solveReason: "deferred_for_latency" } — it checked the amount asked about,
    // it did not solve the route maximum. Reading it as a ceiling collapsed the
    // ceiling onto the requested amount and the 50 ℏ chip disappeared.
    const presets = derivePresets({
      maximum: { maximumTinybar: "1000000000", solved: false, boundKind: "verified_feasible_lower_bound" },
      policyMaximum: "5000000000",
    });
    expect(presets.chips.map((chip) => chip.label)).toEqual(["10 ℏ", "25 ℏ", "50 ℏ"]);
    expect(presets.bound.source).toBe("configured_policy_cap");
  });

  it("keeps presets above a low solved maximum listed, flagged and clickable, in order", () => {
    // A 5 ℏ maximum does not delete the 10 and 25 chips: the meter and the server's
    // limiting constraint explain the limit better than a missing control does.
    const presets = derivePresets({ maximum: { maximumTinybar: "500000000", solved: true } });
    expect(presets.chips.map((chip) => chip.hbar)).toEqual(["5", "10", "25"]);
    const above = presets.chips.filter((chip) => chip.exceedsMaximum);
    expect(above.map((chip) => chip.hbar)).toEqual(["10", "25"]);
    expect(above.every((chip) => chip.disabled === false)).toBe(true);
    expect(presets.bound.exceedsMaximum).toBe(false);
  });
});

describe("derivePriceProtection", () => {
  it("separates today's price from the authorization cap and preserves the manual-fallback copy", () => {
    const protection = derivePriceProtection({
      ...refuelQuote,
      refuelAuthorization: { enabled: true },
      refuelCap: {
        preset: "flexible",
        bufferBps: 1880,
        etaMinutes: 18,
        etaSource: "provider",
        todayAmountIn: "2000000",
        maxAmountIn: "2350000",
        todayUsd: 2,
        capUsd: 2.35,
        warningBelowBps: 400,
      },
    });
    expect(protection).toMatchObject({
      preset: "flexible",
      bufferBps: 1880,
      // The fiat already rides inside `amount`; a separate `usd` here printed it
      // twice ("1.256762 USDC.axl · $1.26 · $1.26").
      today: { usd: null },
      cap: { usd: null },
      warning: null,
    });
    expect(protection.explanation).toContain("anything unused stays in your wallet");
    expect(protection.explanation).not.toContain("confirm fresh terms");
    expect(protection.explanation).toMatch(/nothing is spent\.$/);
    // The two-hour authorization window is a bound, not a forecast: real transit
    // is minutes, so quoting the worst case up front read as the expected wait.
    expect(protection.deadline).toBe("Converts when your funds land.");
  });

  it("does not present a future-spend cap while preauthorization is dormant", () => {
    expect(derivePriceProtection({ ...refuelQuote, refuelCap: { preset: "flexible" }, refuelAuthorization: { enabled: false } })).toBeNull();
  });
});

describe("deriveRouteSummary", () => {
  it("headlines the refuel cost in both denominations, and names which cost it is", () => {
    const route = deriveRouteSummary(refuelQuote);
    expect(route.available).toBe(true);
    // The legs are separate so the surface can lay them out; the joined string
    // stays available for the accessible one-liner.
    expect(route.legs).toEqual(["Axelar", "SaucerSwap V2"]);
    expect(route.summaryLine).toBe("Axelar → SaucerSwap V2");
    expect(route.eta).toBe("~18 min");
    // The refuel cost outranks the USD fee total: it is the figure the owner is
    // deciding on, and the label says which quantity it is either way.
    expect(route.total.kind).toBe("asset");
    expect(route.total.label).toBe("Refuel cost");
    expect(route.total.text).toBe("≤ 1.38 USDC.axl · $1.38");
    expect(route.total.title).toContain("Origin-side bridge fees add $0.97");
  });

  it("still pairs the token figure with USD when the bridge fees are not fully priced", () => {
    const route = deriveRouteSummary({
      ...refuelQuote,
      bridge: { ...refuelQuote.bridge, fees: [{ name: "Axelar bridge fee", amount: "420000", symbol: "USDC", usd: null }] },
    });
    expect(route.total.kind).toBe("asset");
    expect(route.total.text).toBe("≤ 1.38 USDC.axl · $1.38");
    expect(route.total.title).toContain("itemized separately");
  });

  it("headlines priced fees with no refuel leg, and the bridge cost when they are not priced", () => {
    // No refuel cost exists in bridge_only, so a complete USD fee set is the total.
    expect(deriveRouteSummary(bridgeOnlyQuote).total).toMatchObject({ kind: "usd", label: "Fees" });
    const unpriced = deriveRouteSummary({
      ...bridgeOnlyQuote,
      bridge: { ...bridgeOnlyQuote.bridge, fees: [{ name: "Axelar bridge fee", amount: "420000", symbol: "USDC", usd: null }] },
      amountLedger: { ...bridgeOnlyQuote.amountLedger, source: { input: "25000000", effectiveCost: "420000" } },
    });
    expect(unpriced.total.label).toBe("Bridge cost");
    expect(unpriced.total.text).toContain("USDC");
  });

  it("carries the sponsored-gas line, max slippage and the fair-value verdict", () => {
    const route = deriveRouteSummary(refuelQuote);
    // Sponsored gas is not money the owner spends, is not deducted from the
    // bridged amount, and is not a number they can act on. It has no row.
    expect(route.sponsoredGas).toBeNull();
    expect(route.rows.some((row: { id: string }) => row.id === "sponsored-gas")).toBe(false);
    expect(route.maxSlippage?.value).toBe("1.00%");
    expect(route.fairValue?.value).toBe("Within 0.05%");
    expect(route.fairValue?.tone).toBe("brand");
    expect(route.rows.map((row) => row.id)).toContain("x402_protocol_fee");
  });

  it("puts the slippage floor in the disclosure, next to the slippage that causes it", () => {
    const route = deriveRouteSummary(refuelQuote);
    const ids = route.rows.map((row) => row.id);
    const minimum = route.rows.find((row) => row.id === "minimum-received");
    expect(minimum?.label).toBe("Minimum received");
    expect(minimum?.value).toBe("23.56 USDC.axl · $23.56");
    expect(ids.indexOf("minimum-received")).toBe(ids.indexOf("max-slippage") + 1);
  });

  it("lists an overlapping ledger entry once, not twice with one marked already counted", () => {
    // Production: "Bridge messaging fee 0.00007721 ETH" sat directly above
    // "LayerZero messaging fee (already counted) 0.00007721 ETH" — the same money,
    // printed twice. The server excludes it from the totals for that reason.
    const route = deriveRouteSummary({
      ...refuelQuote,
      costLedger: {
        ...refuelQuote.costLedger,
        entries: [
          ...refuelQuote.costLedger.entries,
          {
            id: "bridge_effective_provider_difference",
            label: "LayerZero messaging fee",
            aggregation: "excluded_overlap",
            asset: { symbol: "USDC", decimals: 6 },
            quantity: { baseUnits: "420000", unit: "base_units" },
          },
        ],
      },
    });
    expect(route.rows.map((row) => row.label).join(" ")).not.toContain("already counted");
    expect(route.rows.filter((row) => row.id === "bridge_effective_provider_difference")).toHaveLength(0);
  });

  it("prices an origin fee only when it is denominated in the asset being bridged", () => {
    const withNativeFee = (symbol: string, decimals: number) => deriveRouteSummary({
      ...refuelQuote,
      costLedger: {
        ...refuelQuote.costLedger,
        entries: [{
          id: "bridge_fee_native",
          label: "Bridge messaging fee",
          asset: { symbol, decimals },
          quantity: { baseUnits: symbol === "USDC" ? "420000" : "77210000000000", unit: "base_units" },
        }],
      },
    });
    // Same asset as the source amount (USDC in this fixture): the published price
    // evidence describes it, so it is paired.
    expect(withNativeFee("USDC", 6).rows.find((row) => row.id === "bridge_fee_native")?.value)
      .toBe("0.42 USDC · $0.42");
    // A different asset — the origin chain's gas token — is left unpriced rather
    // than valued at the bridged asset's rate.
    expect(withNativeFee("ETH", 18).rows.find((row) => row.id === "bridge_fee_native")?.value)
      .toBe("0.00007721 ETH");
  });

  it("writes every asset cost the same way: token amount, then the USD it is worth", () => {
    const route = deriveRouteSummary(refuelQuote);
    const paired = ["x402_protocol_fee", "swap-input", "minimum-received"]
      .map((id) => route.rows.find((row) => row.id === id));
    expect(paired.every((row) => row !== undefined)).toBe(true);
    // Inconsistency was the complaint: one row priced, the next one not.
    for (const row of paired) expect(row?.value).toMatch(/USDC\.axl · \$\d/);
  });

  it("reports an unverified fair-value check as unverified, never as a pass", () => {
    const route = deriveRouteSummary({
      ...refuelQuote,
      destination: { ...refuelQuote.destination, fairValue: { status: "fair_value_unverified", reason: "token or HBAR market price is unavailable" } },
    });
    expect(route.fairValue?.value).toBe("Not verified");
    expect(route.fairValue?.tone).toBe("warning");
    expect(route.fairValue?.title).toContain("market price is unavailable");
  });

  it("builds hop pills ending at HBAR", () => {
    const route = deriveRouteSummary(refuelQuote);
    expect(route.hops.map((hop) => hop.label)).toEqual(["USDC", "USDC.axl", "WHBAR", "HBAR"]);
    expect(route.hops[2].note).toBe("0.05%");
  });

  it("drops refuel-only rows in bridge_only", () => {
    const route = deriveRouteSummary(bridgeOnlyQuote);
    expect(route.refuel).toBe(false);
    expect(route.sponsoredGas).toBeNull();
    expect(route.fairValue).toBeNull();
    expect(route.rows.map((row) => row.id)).not.toContain("x402_protocol_fee");
  });

  it("is unavailable without a quote", () => {
    expect(deriveRouteSummary(null).available).toBe(false);
  });
});

describe("deriveQuoteBlockers", () => {
  it("renders human text and never offers the code to the reader", () => {
    const blockers = deriveQuoteBlockers({ blockers: ["POLICY_RPC_NOT_LIVE_PROVEN", "POLICY_RPC_NOT_LIVE_PROVEN", "STALE_QUOTE"] });
    expect(blockers).toHaveLength(2);
    expect(blockers[0].text).toBe("Destination gas sponsorship is not available yet");
    // The code stays on the object as a stable React key and is never rendered.
    // It used to be handed straight to the reader as the row's `title` tooltip,
    // while this module's own docstring claimed codes never surfaced.
    expect(blockers[0].title).toBeUndefined();
    expect(blockers[0].code).toBe("POLICY_RPC_NOT_LIVE_PROVEN");
    expect(blockers.every((blocker) => blocker.text !== blocker.code)).toBe(true);
  });

  it("names an unmapped blocker in plain words instead of echoing the code", () => {
    const [blocker] = deriveQuoteBlockers({ blockers: ["SOME_FUTURE_SERVER_BLOCKER"] });
    expect(blocker.text).toBe("This route is unavailable right now");
    expect(blocker.text).not.toContain("SOME_FUTURE");
  });
});

describe("deriveQuoteFreshness", () => {
  it("warns in the final seconds", () => {
    const fresh = deriveQuoteFreshness({ secondsRemaining: 42, total: 60 });
    expect(fresh.warning).toBe(false);
    expect(fresh.tone).toBe("brand");
    const warning = deriveQuoteFreshness({ secondsRemaining: 9, total: 60 });
    expect(warning.warning).toBe(true);
    expect(warning.tone).toBe("warning");
    expect(warning.text).toBe("Quote expires in 9s");
  });

  it("offers a refresh with explicit no-wallet-action copy on expiry", () => {
    const expired = deriveQuoteFreshness({ secondsRemaining: 0, total: 60 });
    expect(expired.expired).toBe(true);
    expect(expired.text).toContain("No wallet action");
  });

  it("treats a stale quote as expired even with seconds on the clock", () => {
    expect(deriveQuoteFreshness({ secondsRemaining: 30, total: 60, stale: true }).expired).toBe(true);
  });
});

describe("derivePrimaryAction", () => {
  const intent = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, disabled: false, busy: false, detail: null, ...extra });
  const token = { symbol: "USDC", decimals: 6 };

  it("asks for a wallet before anything else", () => {
    const action = derivePrimaryAction({ intent: intent("connect_wallet") });
    expect(action.label).toBe("Connect MetaMask");
    expect(action.disabled).toBe(false);
  });

  it("blocks an empty amount with a specific reason", () => {
    const action = derivePrimaryAction({ intent: intent("request_quote"), token, sourceAmount: "" });
    expect(action.disabled).toBe(true);
    expect(action.reason).toBe("Enter an amount to bridge");
  });

  it("blocks an amount above a known balance", () => {
    const action = derivePrimaryAction({
      intent: intent("request_quote"),
      token,
      sourceAmount: "500",
      balance: "25000000",
      balanceStatus: "ready",
    });
    expect(action.disabled).toBe(true);
    expect(action.reason).toBe("Amount exceeds your USDC balance");
  });

  it("does not block on a balance the wallet never reported", () => {
    const action = derivePrimaryAction({ intent: intent("request_quote"), token, sourceAmount: "500", balance: null, balanceStatus: "idle" });
    expect(action.disabled).toBe(false);
  });

  it("never enables an action the store disabled", () => {
    const action = derivePrimaryAction({ intent: intent("select_token", { disabled: true }), token, sourceAmount: "25" });
    expect(action.disabled).toBe(true);
    expect(action.reason).toBe("Choose the token you are bridging.");
  });

  it("names the blocker behind a paused launch", () => {
    const action = derivePrimaryAction({
      intent: intent("launch_paused", { disabled: true }),
      token,
      sourceAmount: "25",
      quote: { blockers: ["MAINNET_EXECUTION_DISABLED"] },
    });
    expect(action.reason).toBe("Mainnet execution is disabled");
  });

  it("turns an expired quote into a refresh with no-wallet-action copy", () => {
    const action = derivePrimaryAction({ intent: intent("refresh_quote"), token, sourceAmount: "25" });
    expect(action.label).toBe("Refresh quote");
    expect(action.note).toContain("No wallet action");
  });

  it("blocks an invalid desired HBAR in refuel mode only", () => {
    const refuel = derivePrimaryAction({ intent: intent("request_quote"), token, sourceAmount: "25", desiredHbarError: "desired HBAR must be greater than zero" });
    expect(refuel.disabled).toBe(true);
    const bridgeOnly = derivePrimaryAction({ intent: intent("request_quote"), routeMode: "bridge_only", token, sourceAmount: "25", desiredHbarError: "ignored" });
    expect(bridgeOnly.disabled).toBe(false);
  });

  it("keeps a busy intent busy and labelled", () => {
    const action = derivePrimaryAction({ intent: intent("busy", { disabled: true, busy: true, detail: "quote_refresh" }) });
    expect(action.busy).toBe(true);
    expect(action.label).toBe("Refreshing quote…");
  });
});

describe("deriveSettingsSummary", () => {
  it("states provider, network, slippage, route mode and destination in one line", () => {
    expect(deriveSettingsSummary({
      provider: { id: "auto", label: "Auto" },
      network: { name: "Ethereum" },
      slippagePercent: "1.00",
      routeMode: "bridge_plus_refuel",
      mode: "mainnet",
    })).toBe("Auto-best provider · Ethereum · 1.00% max slippage · Bridge + refuel · Hedera mainnet");
  });

  it("keeps slippage in bridge_only, where it still bounds the provider minimum", () => {
    expect(deriveSettingsSummary({
      provider: { id: "axelar", label: "Axelar" },
      network: { name: "Base" },
      slippagePercent: "0.50",
      routeMode: "bridge_only",
      mode: "testnet",
    })).toBe("Axelar · Base · 0.50% max slippage · Bridge only · Hedera testnet");
  });

  it("names what is missing instead of rendering an empty segment", () => {
    expect(deriveSettingsSummary({ slippagePercent: "1" })).toContain("No provider · No origin network");
  });
});

describe("matchesPreset", () => {
  it("compares amounts, not strings", () => {
    expect(matchesPreset("10", "10.0")).toBe(true);
    expect(matchesPreset("10", "10.00000001")).toBe(false);
    expect(matchesPreset("10", "")).toBe(false);
    expect(matchesPreset("10", "not a number")).toBe(false);
  });
});

describe("derivePickerGroups", () => {
  const networks = [
    { chainId: "1", name: "Ethereum" },
    { chainId: "8453", name: "Base" },
  ];
  const catalog: Record<string, any[]> = {
    "1": [
      { id: "usdc:1:0xa", symbol: "USDC", name: "USD Coin", decimals: 6, disabled: false, blockers: [] },
      { id: "weth:1:0xb", symbol: "WETH", name: "Wrapped Ether", decimals: 18, disabled: true, blockers: ["SAUCER_ROUTE_UNAVAILABLE"] },
    ],
    "8453": [{ id: "usdc:8453:0xc", symbol: "USDC", name: "USD Coin", decimals: 6, disabled: false, blockers: [] }],
  };
  const tokensFor = (network: any, search: string) =>
    catalog[network.chainId].filter((token) => !search || token.symbol.toLowerCase().includes(search));

  it("groups by chain and keeps disabled candidates visible with their reason", () => {
    const groups = derivePickerGroups({ networks, tokensFor, selectedTokenId: "usdc:1:0xa", balances: { "usdc:1:0xa": "142200000" } });
    expect(groups.map((group) => group.network.name)).toEqual(["Ethereum", "Base"]);
    const disabled = groups[0].rows.find((row) => row.disabled);
    expect(disabled?.symbol).toBe("WETH");
    expect(disabled?.reasons[0].text).toBe("No qualifying SaucerSwap route to HBAR");
    expect(groups[0].rows[0].selected).toBe(true);
    expect(groups[0].rows[0].balance?.display).toBe("142.2");
  });

  it("shows a whole chain when the search matches the chain name", () => {
    const groups = derivePickerGroups({ networks, tokensFor, search: "base" });
    expect(groups).toHaveLength(1);
    expect(groups[0].networkMatch).toBe(true);
    expect(groups[0].rows).toHaveLength(1);
  });

  it("filters tokens by symbol and drops empty chains", () => {
    const groups = derivePickerGroups({ networks, tokensFor, search: "weth" });
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((row) => row.symbol)).toEqual(["WETH"]);
  });

  it("reports no balance rather than a zero the wallet never returned", () => {
    const groups = derivePickerGroups({ networks, tokensFor });
    expect(groups[0].rows[0].balance).toBeNull();
  });
});

describe("constraintText", () => {
  it("humanizes known and unknown constraint codes", () => {
    expect(constraintText("CONFIGURED_MAX_HBAR")).toBe("Server policy cap on HBAR output");
    expect(constraintText("SOMETHING_NEW")).toBe("something new");
    expect(constraintText(null)).toBeNull();
  });
});

describe("origin gas pre-check", () => {
  // The real failure: 0.00081 ETH refused for a 561,800-gas bridge whose actual
  // cost was ~0.0001 ETH, because a node checks the RESERVED ceiling
  // (value + gasLimit x maxFeePerGas), not the expected spend.
  const quote = { bridge: { transaction: { gas: "561800", value: "69537351605144" } } };

  it("warns when the reserved ceiling exceeds the native balance", () => {
    const check = deriveOriginGasCheck({ quote, nativeBalance: "810370000000000" });
    expect(check).not.toBeNull();
    expect(check.text).toContain("reserves up to");
    expect(check.reserved).toBe(String(69537351605144n + 561800n * 2000000000n));
  });

  it("stays silent when the balance covers the ceiling", () => {
    expect(deriveOriginGasCheck({ quote, nativeBalance: "5000000000000000" })).toBeNull();
  });

  it("says nothing at all without a balance or a bridge transaction", () => {
    expect(deriveOriginGasCheck({ quote, nativeBalance: null })).toBeNull();
    expect(deriveOriginGasCheck({ quote: {}, nativeBalance: "1" })).toBeNull();
  });
});
