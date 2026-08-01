import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { buildCombinedQuote } from "../src/combined-quote.js";
import { NETWORKS } from "../src/config.js";
import { clearSaucerGraphCacheForTests } from "../src/saucer-api.js";
import { intersectSupport, loadSupportCatalog } from "../src/support.js";

const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const token = (id: string, symbol: string, decimals: number, priceUsd: number) => ({
  id, symbol, name: symbol, decimals, priceUsd, dueDiligenceComplete: true, isFeeOnTransferToken: false,
});

describe("combined quote maximum solver integration", () => {
  beforeEach(() => {
    vi.stubEnv("SAUCERSWAP_API_KEY", "fixture-only");
    vi.stubEnv("SAUCERSWAP_GRAPH_CACHE_MS", "30000");
    vi.stubEnv("SAUCERSWAP_ROUTE_CACHE_MS", "15000");
    vi.stubEnv("SAUCERSWAP_QUOTE_CACHE_MS", "0");
    vi.stubEnv("SAUCERSWAP_CACHE_MAX_ENTRIES", "64");
    vi.stubEnv("SAUCERSWAP_QUOTE_SPACING_MS", "50");
    vi.stubEnv("SAUCERSWAP_QUOTE_MAX_AGE_MS", "60000");
    vi.stubEnv("MAX_SAUCER_QUOTE_CANDIDATES", "4");
    vi.stubEnv("MAX_HBAR_SOLVER_CANDIDATES", "6");
    vi.stubEnv("MAX_REFUEL_TINYBAR", "500000000");
    vi.stubEnv("MIN_SAUCER_ROUTE_LIQUIDITY_USD", "20000");
    vi.stubEnv("MIN_RETAINED_TOKEN_BPS", "500");
    vi.stubEnv("X402_PAYMENT_RECIPIENT", "0x3333333333333333333333333333333333333333");
    clearSaucerGraphCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearSaucerGraphCacheForTests();
  });

  it("uses the same direct-LayerZero quote, V2 route, sponsorship, conservation, and bounded maximum model", async () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "layerzero:mainnet:wbtc")!;
    const htsId = asset.destination.wrapper!.htsTokenId;
    const whbarId = "0.0.1456986";
    const pool = {
      id: 9001,
      contractId: "0.0.9001",
      tokenA: token(htsId, "HTS-WBTC", 8, 100_000),
      amountA: "10000000000",
      tokenB: token(whbarId, "WHBAR", 8, 0.07),
      amountB: "1000000000000000",
      fee: 1500,
    };
    const v1Pool = {
      id: 8001,
      contractId: "0.0.8001",
      tokenA: token("0.0.111", "OTHER", 8, 1),
      tokenReserveA: "1000000000000",
      tokenB: token("0.0.1062664", "HBAR", 8, 0.07),
      tokenReserveB: "1000000000000",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify([pool]), { status: 200 });
      if (url.endsWith("/pools/full")) return new Response(JSON.stringify([v1Pool]), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const quoteExactOutput = vi.fn(async (_quoter: string, _path: string, outputTinybar: bigint) => ({
      amountIn: outputTinybar / 1_000n,
      gasEstimate: 160_000n,
    }));
    const mirror = {
      quoteSimulationIdentity: () => "bounded-max-fixture",
      quoteExactOutput,
      gasPriceWei: async () => 10_000_000_000n,
      hbarUsd: async () => 0.07,
    } as any;
    const runtimeAsset = intersectSupport(asset, {
      providerQuoteReady: { layerzero: true },
      providerBlockers: { layerzero: [] },
      saucerGraphReady: true,
      quoteSimulationReady: true,
      permit2Ready: true,
      x402ProxyReady: true,
      paymentRecipientReady: true,
      facilitatorReady: true,
      policyRpcReady: true,
      wrapperReady: true,
      executionModeReady: true,
    });
    runtimeAsset.runtime.blockers = [];
    runtimeAsset.runtime.quoteReady = true;
    runtimeAsset.runtime.executable = true;
    const quote = await buildCombinedQuote({
      mode: "mainnet",
      requestedProvider: "layerzero",
      supportEvidenceAt: "2026-07-23T00:00:00Z",
      account,
      asset,
      runtimeAsset,
      bridge: {
        provider: "layerzero",
        providerLabel: "LayerZero",
        quoteId: "direct-oft-fixture",
        originChainId: "1",
        destinationChainId: 295,
        fromAddress: account,
        toAddress: account,
        originToken: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
        destinationToken: asset.destination.address,
        fromAmount: "300000",
        expectedDestinationAmount: "300000",
        minimumDestinationAmount: "300000",
        estimatedSeconds: null,
        fees: [],
        normalized: {
          sourceAmount: { amount: "300000", token: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"), decimals: 8, symbol: "WBTC" },
          destinationAsset: { address: asset.destination.address, tokenId: null, standard: "ERC20", decimals: 8, symbol: "WBTC" },
          slippage: { requestedBps: 100, expectedDestinationAmount: "300000", minimumDestinationAmount: "300000" },
          evidence: { source: "layerzero-oft-v2", quoteId: "direct-oft-fixture", routeId: "fixture", observedAt: "2026-07-23T00:00:00Z", responseHash: "fixture" },
        },
        originApproval: { token: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"), spender: getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c"), amount: "300000" },
        transaction: { to: getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c"), data: "0x1234", value: "75000000000000" },
        userSteps: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        source: "layerzero-oft-v2",
      },
      desiredHbarTinybar: 100_000_000n,
      slippageBps: 100,
      mirror,
      solveMaximumHbar: true,
    });

    expect(quote.capabilities.quote).toBe(true);
    expect(BigInt(quote.feasibility.maximumTinybar)).toBeGreaterThanOrEqual(100_000_000n);
    expect(BigInt(quote.feasibility.maximumTinybar)).toBeLessThan(500_000_000n);
    expect(quote.feasibility.candidatesEvaluated).toBeLessThanOrEqual(6);
    expect(quote.destination.routePresentation).toMatchObject({
      scope: "saucer_venue_aware_exact_output",
      summary: expect.stringMatching(/WBTC \(OFT ERC20\).*HTS-WBTC \[wrapper\].*Saucer V2 0\.15%.*HBAR/),
      discovery: { v1PoolCount: 1, v2PoolCount: 1, v1DiscoveryOnly: false },
    });
    expect(quote.amountLedger.allInvariantsHold).toBe(true);
    expect(quote.costLedger.summary.fiatTotal).toBeNull();
    expect(quote.costLedger.entries.filter((entry) => entry.fundingSource === "sponsor").length).toBeGreaterThan(0);
    expect(quote.costLedger.entries.find((entry) => entry.id === "sponsor_x402_settlement")?.payer).toBe("facilitator");
    expect(quote.costLedger.summary.facilitatorCovered).toEqual([
      expect.objectContaining({ symbol: "HBAR", decimals: 8 }),
    ]);
    expect(BigInt(quote.x402.maxSponsorExposureTinybar) + BigInt(quote.x402.maxFacilitatorExposureTinybar))
      .toBe(BigInt(quote.x402.maxExecutionExposureTinybar));
    expect(quoteExactOutput.mock.calls.length).toBeLessThanOrEqual(7);
    expect(NETWORKS.mainnet.whbarToken.toLowerCase()).toBe(quote.destination.routePresentation!.hops[0]!.output.address.toLowerCase());
  });

  it("uses the same desired-output, bounded maximum, V1 route, conservation, and cost model for Axelar LCX", async () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "axelar:mainnet:lcx")!;
    const whbarId = "0.0.1456986";
    const v1Pool = {
      id: 2772,
      contractId: "0.0.10493784",
      tokenA: token(asset.destination.tokenId!, "LCX.axl", 6, 0.07),
      tokenReserveA: "13065982787",
      tokenB: token(whbarId, "HBAR", 8, 0.07),
      tokenReserveB: "437889406171",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify([{
        id: 9101,
        contractId: "0.0.9101",
        tokenA: token("0.0.456858", "USDC", 6, 1),
        amountA: "1000000000000",
        tokenB: token(whbarId, "WHBAR", 8, 0.07),
        amountB: "1000000000000000",
        fee: 1500,
      }]), { status: 200 });
      if (url.endsWith("/pools/full")) return new Response(JSON.stringify([v1Pool]), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const quoteExactOutput = vi.fn(async () => { throw new Error("V2 must not be selected for LCX"); });
    const quoteV1ExactOutput = vi.fn(async (_router: string, _path: string[], outputTinybar: bigint) => ({
      amountIn: outputTinybar / 20n,
      gasEstimate: 500_000n,
    }));
    const mirror = {
      quoteSimulationIdentity: () => "bounded-axelar-lcx-v1-fixture",
      quoteExactOutput,
      quoteV1ExactOutput,
      gasPriceWei: async () => 10_000_000_000n,
      hbarUsd: async () => 0.07,
    } as any;
    const runtimeAsset = intersectSupport(asset, {
      providerQuoteReady: { axelar: true },
      providerBlockers: { axelar: [] },
      saucerGraphReady: true,
      quoteSimulationReady: true,
      permit2Ready: true,
      x402ProxyReady: true,
      paymentRecipientReady: true,
      facilitatorReady: true,
      policyRpcReady: true,
      wrapperReady: true,
      executionModeReady: true,
    });
    runtimeAsset.runtime.blockers = [];
    runtimeAsset.runtime.quoteReady = true;
    runtimeAsset.runtime.executable = true;
    const origin = asset.originTokens![0]!;
    const quote = await buildCombinedQuote({
      mode: "mainnet",
      requestedProvider: "axelar",
      supportEvidenceAt: "2026-07-23T00:00:00Z",
      account,
      asset,
      runtimeAsset,
      bridge: {
        provider: "axelar",
        providerLabel: "Axelar / Squid",
        quoteId: "squid-fixture",
        originChainId: origin.chainId,
        destinationChainId: 295,
        fromAddress: account,
        toAddress: account,
        originToken: origin.address,
        destinationToken: asset.destination.address,
        fromAmount: "500000000000000000000",
        expectedDestinationAmount: "500000000",
        minimumDestinationAmount: "490000000",
        estimatedSeconds: 180,
        fees: [{ name: "provider fee", category: "provider", amount: "100000", symbol: origin.symbol, usd: 0.1, payer: "user" }],
        normalized: {
          sourceAmount: { amount: "500000000000000000000", token: origin.address, decimals: origin.decimals, symbol: origin.symbol },
          destinationAsset: { address: asset.destination.address, tokenId: asset.destination.tokenId ?? null, standard: asset.destination.standard, decimals: asset.destination.decimals, symbol: asset.symbol },
          slippage: { requestedBps: 100, expectedDestinationAmount: "500000000", minimumDestinationAmount: "490000000" },
          evidence: { source: "squid-v2", quoteId: "squid-fixture", routeId: "route", observedAt: "2026-07-23T00:00:00Z", responseHash: "fixture" },
        },
        originApproval: { token: origin.address, spender: getAddress("0x2222222222222222222222222222222222222222"), amount: "500000000000000000000" },
        transaction: { to: getAddress("0x2222222222222222222222222222222222222222"), data: "0x1234", value: "0" },
        userSteps: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        source: "squid-v2",
      },
      desiredHbarTinybar: 125_000_000n,
      slippageBps: 100,
      mirror,
      solveMaximumHbar: true,
    });

    expect(quote.bridge.provider).toBe("axelar");
    expect(quote.destination.desiredHbarTinybar).toBe("125000000");
    expect(BigInt(quote.feasibility.maximumTinybar)).toBeGreaterThanOrEqual(125_000_000n);
    expect(quote.destination.routePresentation).toMatchObject({
      scope: "saucer_venue_aware_exact_output",
      wrapperBoundary: null,
      hops: [expect.objectContaining({ venue: "v1", pool: { id: "2772", contractId: "0.0.10493784" } })],
      discovery: { v1DiscoveryOnly: false, v1PoolCount: 1, v2PoolCount: 1 },
    });
    expect(quoteExactOutput).not.toHaveBeenCalled();
    expect(quoteV1ExactOutput).toHaveBeenCalled();
    expect(quote.amountLedger.allInvariantsHold).toBe(true);
    expect(quote.costLedger.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "origin_approval_gas", fundingSource: "user_origin" }),
      expect.objectContaining({ id: "x402_protocol_fee", fundingSource: "deducted_from_bridge" }),
      expect.objectContaining({ id: "sponsor_router_execution", fundingSource: "sponsor" }),
    ]));
  });
});
