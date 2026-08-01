import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { AmountInvariantError } from "../src/amount-domain.js";
import { buildCombinedQuote, prewarmCombinedQuoteSaucerRoute } from "../src/combined-quote.js";
import { MirrorQuoteError } from "../src/mirror.js";
import { clearSaucerGraphCacheForTests, fetchCompleteSaucerGraph } from "../src/saucer-api.js";
import { intersectSupport, loadSupportCatalog, type SupportAsset } from "../src/support.js";

const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const desiredHbarTinybar = 100_000_000n;
const configuredMaximumTinybar = 500_000_000n;
const token = (id: string, symbol: string, decimals: number, priceUsd: number) => ({
  id, symbol, name: symbol, decimals, priceUsd, dueDiligenceComplete: true, isFeeOnTransferToken: false,
});

const asset: SupportAsset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:wbtc")!;

function graphFetch() {
  const whbarId = "0.0.1456986";
  const v2Pool = {
    id: 9001,
    contractId: "0.0.9001",
    tokenA: token(asset.destination.wrapper!.htsTokenId, "HTS-WBTC", 8, 100_000),
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
  return vi.fn(async (url: string) => {
    if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify([v2Pool]), { status: 200 });
    if (url.endsWith("/pools/full")) return new Response(JSON.stringify([v1Pool]), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

function mirrorDouble(quoteExactOutput: unknown, overrides: Record<string, unknown> = {}) {
  return {
    quoteSimulationIdentity: () => "combined-quote-hardening-fixture",
    quoteExactOutput,
    gasPriceWei: async () => 10_000_000_000n,
    hbarUsd: async () => 0.07,
    ...overrides,
  } as never;
}

function runtimeAssetFor(): ReturnType<typeof intersectSupport> {
  return intersectSupport(asset, {
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
}

const bridge = {
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
} as never;

beforeEach(() => {
  vi.stubEnv("SAUCERSWAP_API_KEY", "fixture-only");
  vi.stubEnv("SAUCERSWAP_GRAPH_CACHE_MS", "30000");
  vi.stubEnv("SAUCERSWAP_ROUTE_CACHE_MS", "15000");
  vi.stubEnv("SAUCERSWAP_QUOTE_CACHE_MS", "0");
  vi.stubEnv("SAUCERSWAP_QUOTE_SPACING_MS", "50");
  vi.stubEnv("SAUCERSWAP_QUOTE_MAX_AGE_MS", "60000");
  vi.stubEnv("MAX_SAUCER_QUOTE_CANDIDATES", "4");
  vi.stubEnv("MAX_HBAR_SOLVER_CANDIDATES", "6");
  vi.stubEnv("MAX_REFUEL_TINYBAR", configuredMaximumTinybar.toString());
  vi.stubEnv("MIN_SAUCER_ROUTE_LIQUIDITY_USD", "20000");
  vi.stubEnv("MIN_RETAINED_TOKEN_BPS", "500");
  vi.stubEnv("X402_PAYMENT_RECIPIENT", "0x3333333333333333333333333333333333333333");
  clearSaucerGraphCacheForTests();
  vi.stubGlobal("fetch", graphFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearSaucerGraphCacheForTests();
});

describe("combined quote Saucer prewarm", () => {
  it("starts the sweep best-effort and never surfaces a prewarm failure", async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", record);
    try {
      const quoteExactOutput = vi.fn(async () => {
        throw new MirrorQuoteError("QUOTE_MIRROR_REQUEST_FAILED", "simulated quote failure");
      });
      expect(() => prewarmCombinedQuoteSaucerRoute({
        mode: "mainnet",
        asset,
        desiredHbarTinybar,
        mirror: mirrorDouble(quoteExactOutput),
      })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(quoteExactOutput).toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("skips the sweep while the graph proof is about to rotate", async () => {
    vi.useFakeTimers();
    try {
      await fetchCompleteSaucerGraph("mainnet");
      const quoteExactOutput = vi.fn(async () => ({ amountIn: 100_000n, gasEstimate: 160_000n }));
      // 30s TTL with a 10s refresh-ahead window: warming here would be keyed to a
      // proof the authoritative call no longer sees, costing a second full sweep.
      vi.advanceTimersByTime(21_000);
      prewarmCombinedQuoteSaucerRoute({
        mode: "mainnet",
        asset,
        desiredHbarTinybar,
        mirror: mirrorDouble(quoteExactOutput),
      });
      await Promise.resolve();
      expect(quoteExactOutput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("combined quote solver and timing decomposition", () => {
  it("propagates an amount invariant failure raised while evaluating a solver probe", async () => {
    const quoteExactOutput = vi.fn(async (_quoter: string, _path: string, outputTinybar: bigint) => {
      // The solver's first probe is the configured cap; the sweep never quotes it.
      if (outputTinybar === configuredMaximumTinybar) {
        throw new AmountInvariantError("EXPOSURE_DECOMPOSITION_MISMATCH", "execution exposure decomposition does not reconcile");
      }
      return { amountIn: outputTinybar / 1_000n, gasEstimate: 160_000n };
    });
    await expect(buildCombinedQuote({
      mode: "mainnet",
      requestedProvider: "layerzero",
      supportEvidenceAt: "2026-07-23T00:00:00Z",
      account,
      asset,
      runtimeAsset: runtimeAssetFor(),
      bridge,
      desiredHbarTinybar,
      slippageBps: 100,
      mirror: mirrorDouble(quoteExactOutput),
      solveMaximumHbar: true,
    })).rejects.toBeInstanceOf(AmountInvariantError);
  });

  it("keeps the concurrent sponsor/market span out of the serial policy timing", async () => {
    const quoteExactOutput = vi.fn(async (_quoter: string, _path: string, outputTinybar: bigint) => ({
      amountIn: outputTinybar / 1_000n,
      gasEstimate: 160_000n,
    }));
    const quote = await buildCombinedQuote({
      mode: "mainnet",
      requestedProvider: "layerzero",
      supportEvidenceAt: "2026-07-23T00:00:00Z",
      account,
      asset,
      runtimeAsset: runtimeAssetFor(),
      bridge,
      desiredHbarTinybar,
      slippageBps: 100,
      mirror: mirrorDouble(quoteExactOutput, {
        gasPriceWei: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return 10_000_000_000n;
        },
      }),
      solveMaximumHbar: false,
    });
    expect(quote.timing.concurrentSponsorMarketMs).toBeGreaterThanOrEqual(100);
    // Pricing reuses the fixed market snapshot, so the serial policy leg does no I/O.
    expect(quote.timing.sponsorSnapshotPolicyMs).toBeLessThan(100);
  });
});
