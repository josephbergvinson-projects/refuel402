import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { AmountInvariantError } from "../src/amount-domain.js";
import { buildQuoteCostLedger } from "../src/quote-cost-ledger.js";
import { loadSupportCatalog } from "../src/support.js";

const account = getAddress("0x1111111111111111111111111111111111111111");

describe("typed quote cost ledger", () => {
  it("separates user-origin, bridge deductions, sponsor coverage, and included swap effects without double counting wrapper conversion", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "layerzero:mainnet:wbtc")!;
    const sourceToken = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
    const ledger = buildQuoteCostLedger({
      bridge: {
        provider: "layerzero",
        providerLabel: "LayerZero",
        quoteId: "direct-oft-test",
        originChainId: "1",
        destinationChainId: 295,
        fromAddress: account,
        toAddress: account,
        originToken: sourceToken,
        destinationToken: asset.destination.address,
        fromAmount: "1000",
        expectedDestinationAmount: "995",
        minimumDestinationAmount: "990",
        estimatedSeconds: null,
        fees: [
          { name: "provider fee", category: "provider", amount: "5", symbol: "WBTC", usd: null, payer: "user" },
          { name: "LayerZero messaging fee", category: "gas_relayer", amount: "75000000000000", symbol: "ETH", usd: null, payer: "user" },
        ],
        normalized: {
          sourceAmount: { amount: "1000", token: sourceToken, decimals: 8, symbol: "WBTC" },
          destinationAsset: { address: asset.destination.address, tokenId: null, standard: "ERC20", decimals: 8, symbol: "WBTC" },
          slippage: { requestedBps: 100, expectedDestinationAmount: "995", minimumDestinationAmount: "990" },
          evidence: { source: "layerzero-oft-v2", quoteId: "direct-oft-test", routeId: "route", observedAt: "2026-07-23T00:00:00Z", responseHash: "a".repeat(64) },
        },
        originApproval: { token: sourceToken, spender: getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c"), amount: "1000" },
        transaction: { to: getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c"), data: "0x1234", value: "75000000000000" },
        userSteps: [],
        expiresAt: 1_900_000_000,
        source: "layerzero-oft-v2",
      },
      asset,
      sourceAmount: { symbol: "WBTC", decimals: 8, address: sourceToken },
      minimumArrival: 990n,
      retainedAtMinimum: 670n,
      x402FeeAmount: 20n,
      x402FeeUsd: 0.01,
      marketEvidenceAt: "2026-07-23T00:00:00Z",
      swapInputExact: 290n,
      swapInputMaximum: 300n,
      paymentAssetSwapInputMaximum: 300n,
      slippageBufferPaymentAsset: 10n,
      priceImpactBps: 25,
      saucerRoute: {
        perHopAmountsAvailable: false,
        hops: [{ index: 0, feeBps: 15, pool: { id: "0.0.1" }, liquidityUsd: 25_000 }],
      },
      sponsoredLegs: [
        { id: "wrapper", label: "Wrapper", stage: "wrapper", maximumTinybar: 10n },
        { id: "swap", label: "Swap", stage: "saucer", maximumTinybar: 20n },
      ],
      maximumSponsorExposureTinybar: 35n,
      desiredHbarTinybar: 100_000_000n,
    });

    const destinationDeductions = ledger.entries
      .filter((entry) => entry.fundingSource === "deducted_from_bridge" && entry.asset.address?.toLowerCase() === asset.destination.address.toLowerCase())
      .reduce((sum, entry) => sum + BigInt(entry.quantity.baseUnits ?? 0), 0n);
    expect(destinationDeductions).toBe(320n);
    expect(ledger.entries.find((entry) => entry.id === "wrapper_conversion")?.fundingSource).toBe("included_in_swap");
    expect(ledger.entries.find((entry) => entry.id === "bridge_fee_1")).toMatchObject({
      fundingSource: "user_origin",
      aggregation: "excluded_overlap",
      quantity: { unit: "wei" },
      asset: { decimals: 18, kind: "native" },
    });
    expect(ledger.summary.userPaid).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "ETH", baseUnits: "75000000000000" }),
    ]));
    expect(ledger.summary.sponsorCovered).toEqual([
      expect.objectContaining({ symbol: "HBAR", decimals: 8, baseUnits: "35" }),
    ]);
    expect(ledger.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "origin_approval_gas", fundingSource: "user_origin", quantity: expect.objectContaining({ baseUnits: null }) }),
      expect.objectContaining({ id: "bridge_native_value", asset: expect.objectContaining({ symbol: "ETH" }) }),
      expect.objectContaining({ id: "bridge_fee_1", fundingSource: "user_origin", aggregation: "excluded_overlap", note: expect.stringMatching(/already represented/) }),
      expect.objectContaining({ id: "saucer_swap_input_estimate", fundingSource: "included_in_swap", quantity: expect.objectContaining({ baseUnits: "290", exactness: "estimated" }) }),
      expect.objectContaining({ id: "saucer_lp_fee_0", fundingSource: "included_in_swap", quantity: expect.objectContaining({ unit: "basis_points", baseUnits: "15" }) }),
      expect.objectContaining({ id: "sponsor_policy_reserve", quantity: expect.objectContaining({ baseUnits: "5" }) }),
    ]));
    expect(ledger.summary.fiatTotal).toBeNull();
    expect(ledger.summary.fiatTotalReason).toMatch(/No aggregate fiat total/);
  });

  it("raises a typed amount-invariant error when native transaction value is below the source principal", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "layerzero:mainnet:weth")!;
    const nativeMarker = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    const amount = 1_000_000_000_000_000n;
    let observed: unknown;
    try {
      buildQuoteCostLedger({
        bridge: {
          provider: "layerzero",
          providerLabel: "Stargate V2 Fast / LayerZero",
          quoteId: "direct-stargate-test",
          originChainId: "1",
          destinationChainId: 295,
          fromAddress: account,
          toAddress: account,
          originToken: nativeMarker,
          destinationToken: asset.destination.address,
          fromAmount: amount.toString(),
          expectedDestinationAmount: amount.toString(),
          minimumDestinationAmount: amount.toString(),
          estimatedSeconds: null,
          fees: [],
          normalized: {
            sourceAmount: { amount: amount.toString(), token: nativeMarker, decimals: 18, symbol: "ETH", native: true },
            destinationAsset: { address: asset.destination.address, tokenId: null, standard: "ERC20", decimals: 18, symbol: "WETH" },
            slippage: { requestedBps: 100, expectedDestinationAmount: amount.toString(), minimumDestinationAmount: amount.toString() },
            evidence: { source: "stargate-v2-taxi", quoteId: "direct-stargate-test", routeId: "native-route", observedAt: "2026-07-27T00:00:00Z", responseHash: "b".repeat(64) },
          },
          originApproval: null,
          transaction: { to: getAddress("0x77b2043768d28E9C9aB44E1aBfC95944bcE57931"), data: "0xc7c7f5b3", value: (amount - 1n).toString() },
          userSteps: [],
          expiresAt: 1_900_000_000,
          source: "stargate-v2-taxi",
        },
        asset,
        sourceAmount: { symbol: "ETH", decimals: 18, address: nativeMarker, native: true },
        minimumArrival: amount,
        retainedAtMinimum: amount,
        x402FeeAmount: 0n,
        x402FeeUsd: 0,
        marketEvidenceAt: null,
        swapInputExact: 0n,
        swapInputMaximum: 0n,
        paymentAssetSwapInputMaximum: 0n,
        slippageBufferPaymentAsset: 0n,
        priceImpactBps: 0,
        saucerRoute: null,
        sponsoredLegs: [],
        maximumSponsorExposureTinybar: 0n,
        desiredHbarTinybar: 0n,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AmountInvariantError);
    expect(observed).toMatchObject({ code: "BRIDGE_VALUE_BELOW_PRINCIPAL" });
  });

  it("separates native ETH principal from Stargate messaging fee even though both are carried in transaction value", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "layerzero:mainnet:weth")!;
    const nativeMarker = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    const amount = 1_000_000_000_000_000n;
    const messagingFee = 75_000_000_000_000n;
    const ledger = buildQuoteCostLedger({
      bridge: {
        provider: "layerzero",
        providerLabel: "Stargate V2 Fast / LayerZero",
        quoteId: "direct-stargate-test",
        originChainId: "1",
        destinationChainId: 295,
        fromAddress: account,
        toAddress: account,
        originToken: nativeMarker,
        destinationToken: asset.destination.address,
        fromAmount: amount.toString(),
        expectedDestinationAmount: amount.toString(),
        minimumDestinationAmount: amount.toString(),
        estimatedSeconds: null,
        fees: [{ name: "LayerZero messaging fee", category: "gas_relayer", amount: messagingFee.toString(), symbol: "ETH", usd: null, payer: "user" }],
        normalized: {
          sourceAmount: { amount: amount.toString(), token: nativeMarker, decimals: 18, symbol: "ETH", native: true },
          destinationAsset: { address: asset.destination.address, tokenId: null, standard: "ERC20", decimals: 18, symbol: "WETH" },
          slippage: { requestedBps: 100, expectedDestinationAmount: amount.toString(), minimumDestinationAmount: amount.toString() },
          evidence: { source: "stargate-v2-taxi", quoteId: "direct-stargate-test", routeId: "native-route", observedAt: "2026-07-27T00:00:00Z", responseHash: "b".repeat(64) },
        },
        originApproval: null,
        transaction: { to: getAddress("0x77b2043768d28E9C9aB44E1aBfC95944bcE57931"), data: "0xc7c7f5b3", value: (amount + messagingFee).toString() },
        userSteps: [],
        expiresAt: 1_900_000_000,
        source: "stargate-v2-taxi",
      },
      asset,
      sourceAmount: { symbol: "ETH", decimals: 18, address: nativeMarker, native: true },
      minimumArrival: amount,
      retainedAtMinimum: amount,
      x402FeeAmount: 0n,
      x402FeeUsd: 0,
      marketEvidenceAt: null,
      swapInputExact: 0n,
      swapInputMaximum: 0n,
      paymentAssetSwapInputMaximum: 0n,
      slippageBufferPaymentAsset: 0n,
      priceImpactBps: 0,
      saucerRoute: null,
      sponsoredLegs: [],
      maximumSponsorExposureTinybar: 0n,
      desiredHbarTinybar: 0n,
    });
    expect(ledger.entries.find((entry) => entry.id === "origin_principal")).toMatchObject({
      asset: { symbol: "ETH", address: null, kind: "native" },
      quantity: { baseUnits: amount.toString(), unit: "wei" },
    });
    expect(ledger.entries.find((entry) => entry.id === "bridge_native_value")).toMatchObject({
      label: "Bridge messaging fee",
      quantity: { baseUnits: messagingFee.toString(), unit: "wei" },
    });
    expect(ledger.entries.find((entry) => entry.id === "bridge_fee_0")?.aggregation).toBe("excluded_overlap");
    expect(ledger.entries.some((entry) => entry.id === "origin_approval_gas")).toBe(false);
    expect(ledger.summary.userPaid).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "ETH", baseUnits: (amount + messagingFee).toString() }),
    ]));
  });
});
