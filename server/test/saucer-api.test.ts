import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
  clearSaucerGraphCacheForTests,
  fetchCompleteSaucerGraph,
  hydrateSaucerSupportCatalog,
  quoteBestSaucerRoute,
  saucerGraphProofRotationPending,
  verifySaucerApiAsset,
} from "../src/saucer-api.js";
import { MirrorQuoteError } from "../src/mirror.js";
import type { SupportAsset, SupportCatalog } from "../src/support.js";

const address = (num: number) => `0x${num.toString(16).padStart(40, "0")}` as `0x${string}`;
const startId = "0.0.100";
const midId = "0.0.200";
const whbarId = "0.0.1456986";
const v1HbarId = "0.0.1062664";
const token = (id: string, symbol: string, decimals = 6, priceUsd = 1) => ({
  id, symbol, name: symbol, decimals, priceUsd, dueDiligenceComplete: true, isFeeOnTransferToken: false,
});
const v1Pools = [{
  id: 1,
  contractId: "0.0.9001",
  tokenA: token(startId, "BRIDGE"),
  tokenReserveA: "100000000000",
  tokenB: token(v1HbarId, "HBAR", 8, 0.07),
  tokenReserveB: "100000000000000",
}];
const v2Pools = [
  {
    id: 2, contractId: "0.0.9002",
    tokenA: token(startId, "BRIDGE"), amountA: "100000000000",
    tokenB: token(midId, "USDC"), amountB: "100000000000", fee: 500,
  },
  {
    id: 3, contractId: "0.0.9003",
    tokenA: token(midId, "USDC"), amountA: "100000000000",
    tokenB: token(whbarId, "WHBAR", 8, 0.07), amountB: "100000000000000", fee: 1500,
  },
  {
    id: 4, contractId: "0.0.9004",
    tokenA: token(startId, "BRIDGE"), amountA: "100000000000",
    tokenB: token(whbarId, "WHBAR", 8, 0.07), amountB: "100000000000000", fee: 10000,
  },
];
const asset: SupportAsset = {
  id: "axelar:mainnet:bridge",
  provider: "axelar",
  providerLabel: "Axelar / Squid",
  symbol: "BRIDGE",
  name: "Bridge Asset",
  icon: "",
  originNetworks: ["1"],
  destination: {
    standard: "HTS", tokenId: startId, address: address(100), decimals: 6, arrival: "activation_required",
  },
  saucer: { status: "no_route", route: [] },
  x402: { transferMethod: "permit2", status: "permit2_and_proxy_missing" },
  sponsorship: { status: "policy_rpc_not_live_proven" },
  discovery: true,
  quote: false,
  execute: false,
  blockers: ["SAUCER_ROUTE_UNAVAILABLE"],
};
const catalog: SupportCatalog = {
  schema: "refuel402.support-catalog.v1",
  mode: "mainnet",
  evidenceAt: "2026-07-22T00:00:00.000Z",
  hedera: { chainId: 295, caip2: "eip155:295", name: "Hedera", icon: "" },
  originNetworks: [{ chainId: "1", name: "Ethereum", icon: "", providers: ["axelar"], discoveryStatus: "fixture" }],
  assets: [asset],
};

function graphFetch(pools = v2Pools) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify(pools), { status: 200 });
    if (url.endsWith("/pools/full")) return new Response(JSON.stringify(v1Pools), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  vi.stubEnv("SAUCERSWAP_API_KEY", "fixture-only");
  vi.stubEnv("SAUCERSWAP_GRAPH_CACHE_MS", "30000");
  vi.stubEnv("SAUCERSWAP_ROUTE_CACHE_MS", "15000");
  vi.stubEnv("SAUCERSWAP_QUOTE_CACHE_MS", "5000");
  vi.stubEnv("SAUCERSWAP_CACHE_MAX_ENTRIES", "64");
  vi.stubEnv("SAUCERSWAP_QUOTE_SPACING_MS", "50");
  vi.stubEnv("SAUCERSWAP_QUOTE_MAX_AGE_MS", "15000");
  vi.stubEnv("MAX_SAUCER_QUOTE_CANDIDATES", "16");
  // These pool fixtures were written to straddle a $20,000 floor, so the floor
  // they are read against is stated here rather than inherited from the product
  // default (now $100 — see DEFAULT_MIN_ROUTE_LIQUIDITY_USD in saucer-api.ts).
  vi.stubEnv("MIN_SAUCER_ROUTE_LIQUIDITY_USD", "20000");
  clearSaucerGraphCacheForTests();
  vi.stubGlobal("fetch", graphFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearSaucerGraphCacheForTests();
});

describe("SaucerSwap complete graph route evidence", () => {
  it("is optional when the server-side API route is not configured", async () => {
    vi.stubEnv("SAUCERSWAP_API_KEY", "");
    await expect(verifySaucerApiAsset(asset)).resolves.toBeNull();
  });

  it("classifies a rejected API credential as a non-route configuration failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(fetchCompleteSaucerGraph("mainnet")).rejects.toMatchObject({
      code: "CREDENTIAL_REJECTED",
    });
  });

  it("loads both complete pool families and verifies the exact representation", async () => {
    const graph = await fetchCompleteSaucerGraph("mainnet");
    expect(graph).toMatchObject({ v1PoolCount: 1, v2PoolCount: 3, edgeCount: 8 });
    await expect(verifySaucerApiAsset(asset, "mainnet")).resolves.toMatchObject({
      tokenId: startId,
      symbol: "BRIDGE",
      associatedPoolCount: 3,
      completeGraph: true,
      structuralCandidatePathCount: 3,
      v2ExecutableCandidatePathCount: 2,
    });
  });

  it("coalesces identical in-flight graph requests and reuses the bounded TTL snapshot", async () => {
    const fetchMock = graphFetch();
    vi.stubGlobal("fetch", fetchMock);
    const [left, right] = await Promise.all([
      fetchCompleteSaucerGraph("mainnet"),
      fetchCompleteSaucerGraph("mainnet"),
    ]);
    expect(left).toBe(right);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchCompleteSaucerGraph("mainnet");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hydrates quote readiness from the complete graph instead of a predefined route", async () => {
    const hydrated = await hydrateSaucerSupportCatalog(catalog);
    expect(hydrated.saucerEvidence).toMatchObject({ status: "verified_complete_graph", v1PoolCount: 1, v2PoolCount: 3 });
    expect(hydrated.assets[0]).toMatchObject({ quote: true, saucer: { status: "verified" }, blockers: [] });
  });

  it("does not let Saucer pool evidence erase an independent provider-route blocker", async () => {
    const blockedCatalog: SupportCatalog = {
      ...catalog,
      assets: [{ ...asset, blockers: ["SAUCER_ROUTE_UNAVAILABLE", "PROVIDER_ROUTE_UNAVAILABLE"] }],
    };
    const hydrated = await hydrateSaucerSupportCatalog(blockedCatalog);
    expect(hydrated.assets[0]).toMatchObject({
      quote: false,
      saucer: { status: "verified" },
      blockers: ["PROVIDER_ROUTE_UNAVAILABLE"],
    });
  });

  it("gates refuel with the liquidity floor at hydration while keeping the below-floor route disclosed", async () => {
    clearSaucerGraphCacheForTests();
    const allThin = v2Pools.map((pool) => ({ ...pool, amountA: "1000", amountB: "1000" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify(allThin), { status: 200 });
      if (url.endsWith("/pools/full")) {
        return new Response(JSON.stringify([{ ...v1Pools[0]!, tokenReserveA: "1000", tokenReserveB: "1000" }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const hydrated = await hydrateSaucerSupportCatalog(catalog);
    expect(hydrated.assets[0]).toMatchObject({
      quote: false,
      saucer: { status: "below_liquidity_policy" },
      blockers: ["SAUCER_LIQUIDITY_POLICY"],
    });
    expect(hydrated.assets[0]!.saucer.route.length).toBeGreaterThan(0);
  });

  it("serves a near-expiry cached graph while renewing it with one deduped background reload", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = graphFetch();
      vi.stubGlobal("fetch", fetchMock);
      await fetchCompleteSaucerGraph("mainnet");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(21_000);
      await fetchCompleteSaucerGraph("mainnet");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // The coalesced read below waits for the background refresh to store the
      // renewed entry; past the original expiry the cache must still hit.
      await fetchCompleteSaucerGraph("mainnet");
      vi.advanceTimersByTime(10_000);
      await fetchCompleteSaucerGraph("mainnet");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a pending rotation only while a still-valid proof is about to be replaced", async () => {
    vi.useFakeTimers();
    try {
      await fetchCompleteSaucerGraph("mainnet");
      expect(saucerGraphProofRotationPending("mainnet")).toBe(false);
      // 30s TTL, 10s refresh-ahead: the served proof is one background reload from rotating.
      vi.advanceTimersByTime(21_000);
      expect(saucerGraphProofRotationPending("mainnet")).toBe(true);
      // Past expiry nothing is being served, so the next read pins one proof for its callers.
      vi.advanceTimersByTime(10_000);
      expect(saucerGraphProofRotationPending("mainnet")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes a live V1-only exact-output HBAR path instead of reporting no route", async () => {
    clearSaucerGraphCacheForTests();
    const v1Direct = [{
      id: 2772,
      contractId: "0.0.10493784",
      tokenA: token(startId, "LCX.axl"),
      tokenReserveA: "13065982787",
      tokenB: token(whbarId, "HBAR", 8, 0.07),
      tokenReserveB: "437889406171",
    }];
    const unrelatedV2 = [{
      id: 99,
      contractId: "0.0.9999",
      tokenA: token(midId, "USDC"), amountA: "100000000000",
      tokenB: token(whbarId, "WHBAR", 8, 0.07), amountB: "100000000000000", fee: 1500,
    }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/pools/full")) return new Response(JSON.stringify(unrelatedV2), { status: 200 });
      if (url.endsWith("/pools/full")) return new Response(JSON.stringify(v1Direct), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const quoteV1ExactOutput = vi.fn(async () => ({ amountIn: 315_000_000n, gasEstimate: 500_000n }));
    const quoteExactOutput = vi.fn(async () => { throw new Error("V2 should not be called"); });
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1_000_000_000n,
      quoteExactOutput,
      quoteV1ExactOutput,
      simulationKey: "lcx-v1-only",
    });
    expect(quoteV1ExactOutput).toHaveBeenCalledWith(
      "0x00000000000000000000000000000000002e7a5d",
      [getAddress(address(100)), getAddress(address(1456986))],
      1_000_000_000n,
    );
    expect(quoteExactOutput).not.toHaveBeenCalled();
    expect(selected.route).toEqual([expect.objectContaining({ venue: "v1", poolId: "2772", contractId: "0.0.10493784" })]);
    expect(selected.evidence).toMatchObject({
      v1ExecutableCandidatePathCount: 1,
      v2ExecutableCandidatePathCount: 0,
      selectedRoute: {
        venue: "v1",
        executionScope: "venue_aware_exact_output",
        routeId: "v1:2772",
        discovery: { v1DiscoveryOnly: false },
      },
    });
  });

  it("prunes liquidity before simulation, enforces concurrency one and spaces every call", async () => {
    const active = { current: 0, maximum: 0 };
    const quoteExactOutput = vi.fn(async (_quoter: string, path: string) => {
      active.current += 1;
      active.maximum = Math.max(active.maximum, active.current);
      await Promise.resolve();
      active.current -= 1;
      return {
        amountIn: path.length > 100 ? 100n : 200n,
        gasEstimate: path.length > 100 ? 150_000n : 100_000n,
      };
    });
    const sleep = vi.fn(async () => {});
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 500_000_000n,
      quoteExactOutput,
      sleep,
      simulationKey: "serialized-fixture",
      includeReferenceQuote: true,
    });
    expect(quoteExactOutput).toHaveBeenCalledTimes(3);
    expect(active.maximum).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(selected.route.map((hop) => hop.fee)).toEqual([500, 1500]);
    expect(selected.exact.amountIn).toBe(100n);
    expect(selected.reference).toMatchObject({ amountOut: 50_000_000n });
    expect(selected.evidence.selectedRoute).toMatchObject({
      executionScope: "venue_aware_exact_output",
      hopCount: 2,
      amountIn: "100",
      amountOutTinybar: "500000000",
      perHopAmountsAvailable: false,
      discovery: { v1PoolCount: 1, v2PoolCount: 3, v1DiscoveryOnly: false },
      hops: [
        expect.objectContaining({ venue: "v2", feeTier: 500, feeBps: 5, pool: { id: "2", contractId: "0.0.9002" } }),
        expect.objectContaining({ venue: "v2", feeTier: 1500, feeBps: 15, pool: { id: "3", contractId: "0.0.9003" } }),
      ],
    });
  });

  it("simulates only liquidity-eligible candidates while keeping below-floor routes disclosed", async () => {
    clearSaucerGraphCacheForTests();
    const lowDirect = v2Pools.map((pool) => pool.id === 4
      ? { ...pool, amountA: "1000", amountB: "1000" }
      : pool);
    vi.stubGlobal("fetch", graphFetch(lowDirect));
    const quoteExactOutput = vi.fn(async () => ({ amountIn: 100n, gasEstimate: 100n }));
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput,
      simulationKey: "liquidity-pruned",
      sleep: async () => {},
    });
    expect(quoteExactOutput).toHaveBeenCalledTimes(1);
    expect(selected.route.map((hop) => hop.fee)).toEqual([500, 1500]);
    expect(selected.evidence).toMatchObject({
      v2ExecutableCandidatePathCount: 2,
      liquidityEligibleV2CandidatePathCount: 1,
      quotedCandidatePathCount: 1,
      quotedV2CandidatePathCount: 1,
      belowDisclosureLiquidityPathCount: 1,
      liquidityDisclosureThresholdUsd: 20_000,
      liquidityFloorFallback: false,
    });
  });

  it("defaults the floor to a dead-pool filter and leaves depth to the price-impact cap", async () => {
    // A single refuel is capped at 50 HBAR (MAX_REFUEL_TINYBAR), ~$3.31. Below
    // ~$450 of pool TVL, MAX_PRICE_IMPACT_BPS is the binding gate and it rejects
    // per amount; the floor only has to exclude pools too dead to fill anything.
    vi.stubEnv("MIN_SAUCER_ROUTE_LIQUIDITY_USD", undefined);
    clearSaucerGraphCacheForTests();
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput: vi.fn(async () => ({ amountIn: 100n, gasEstimate: 100n })),
      simulationKey: "default-floor",
      sleep: async () => {},
    });
    expect(selected.evidence.liquidityDisclosureThresholdUsd).toBe(100);
  });

  it("falls through to below-floor candidates only when no eligible candidate exists and records the fallback", async () => {
    clearSaucerGraphCacheForTests();
    const allThin = v2Pools.map((pool) => ({ ...pool, amountA: "1000", amountB: "1000" }));
    vi.stubGlobal("fetch", graphFetch(allThin));
    const quoteExactOutput = vi.fn(async () => ({ amountIn: 100n, gasEstimate: 100n }));
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput,
      simulationKey: "liquidity-fallback",
      sleep: async () => {},
    });
    expect(quoteExactOutput).toHaveBeenCalledTimes(2);
    expect(selected.evidence).toMatchObject({
      liquidityEligibleV2CandidatePathCount: 0,
      quotedV2CandidatePathCount: 2,
      liquidityFloorFallback: true,
      selectedRoute: { discovery: { liquidityFloorFallback: true } },
    });
  });

  it("bounds simulation work without erasing the complete structural route evidence", async () => {
    vi.stubEnv("MAX_SAUCER_QUOTE_CANDIDATES", "1");
    const quoteExactOutput = vi.fn(async () => ({ amountIn: 1n, gasEstimate: 1n }));
    await expect(quoteBestSaucerRoute({
      mode: "mainnet", asset, desiredHbarTinybar: 1n, quoteExactOutput,
    })).resolves.toMatchObject({
      evidence: {
        v2ExecutableCandidatePathCount: 2,
        quotedV2CandidatePathCount: 1,
      },
    });
    expect(quoteExactOutput).toHaveBeenCalledTimes(1);
  });

  it("coalesces identical quote requests and deduplicates a fresh cached result", async () => {
    const quoteExactOutput = vi.fn(async (_quoter: string, path: string) => ({
      amountIn: path.length > 100 ? 100n : 200n,
      gasEstimate: 100n,
    }));
    const request = () => quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 500_000_000n,
      quoteExactOutput,
      sleep: async () => {},
      simulationKey: "identical-request",
    });
    const [left, right] = await Promise.all([request(), request()]);
    expect(left).toBe(right);
    expect(quoteExactOutput).toHaveBeenCalledTimes(2);
    await expect(request()).resolves.toBe(left);
    expect(quoteExactOutput).toHaveBeenCalledTimes(2);
  });

  it("never lets the quote cache extend simulation freshness", async () => {
    vi.stubEnv("SAUCERSWAP_QUOTE_MAX_AGE_MS", "1000");
    vi.stubEnv("SAUCERSWAP_QUOTE_CACHE_MS", "30000");
    let clock = 0;
    const quoteExactOutput = vi.fn(async () => ({ amountIn: 1n, gasEstimate: 1n }));
    const request = () => quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput,
      simulationKey: "cache-does-not-refresh",
      now: () => clock,
      sleep: async () => undefined,
    });
    const first = await request();
    expect(quoteExactOutput).toHaveBeenCalledTimes(2);
    clock = first.expiresAt + 1;
    const refreshed = await request();
    expect(refreshed).not.toBe(first);
    expect(quoteExactOutput).toHaveBeenCalledTimes(4);
  });

  it("rejects a candidate set whose winning simulation goes stale before ranking completes", async () => {
    vi.stubEnv("SAUCERSWAP_QUOTE_MAX_AGE_MS", "1000");
    let clock = 0;
    const quoteExactOutput = vi.fn(async (_quoter: string, path: string) => ({
      amountIn: path.length > 100 ? 2n : 1n,
      gasEstimate: 1n,
    }));
    await expect(quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput,
      simulationKey: "stale-set",
      now: () => clock,
      sleep: async () => { clock += 1001; },
    })).rejects.toMatchObject({ code: "STALE_QUOTE" });
  });

  it("anchors freshness to the selected candidate and reference, not the oldest losing candidate", async () => {
    let clock = 0;
    // Ranked first (direct short path) loses; the later two-hop path wins.
    const quoteExactOutput = vi.fn(async (_quoter: string, path: string) => ({
      amountIn: path.length > 100 ? 100n : 200n,
      gasEstimate: 1n,
    }));
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 500_000_000n,
      quoteExactOutput,
      includeReferenceQuote: true,
      simulationKey: "anchor-selected",
      now: () => clock,
      sleep: async () => { clock += 1_000; },
    });
    // losing candidate at 0, winner at 1000, reference at 2000.
    expect(selected.exact.amountIn).toBe(100n);
    expect(selected.simulatedAt).toBe(1_000);
    expect(selected.expiresAt).toBe(16_000);
  });

  it("stops the serialized scan after two consecutive non-improving candidates and reports the true count", async () => {
    clearSaucerGraphCacheForTests();
    const directPool = (id: number, fee: number, amount: string) => ({
      id, contractId: `0.0.${9_100 + id}`,
      tokenA: token(startId, "BRIDGE"), amountA: amount,
      tokenB: token(whbarId, "WHBAR", 8, 0.07), amountB: "100000000000000", fee,
    });
    vi.stubGlobal("fetch", graphFetch([
      directPool(11, 500, "500000000000"),
      directPool(12, 1000, "400000000000"),
      directPool(13, 1500, "300000000000"),
      directPool(14, 2000, "200000000000"),
      directPool(15, 2500, "100000000000"),
    ]));
    const amounts = [100n, 150n, 160n, 170n, 180n];
    let call = 0;
    const quoteExactOutput = vi.fn(async () => ({ amountIn: amounts[call++]!, gasEstimate: 1n }));
    const selected = await quoteBestSaucerRoute({
      mode: "mainnet",
      asset,
      desiredHbarTinybar: 1n,
      quoteExactOutput,
      simulationKey: "early-exit",
      sleep: async () => {},
    });
    expect(quoteExactOutput).toHaveBeenCalledTimes(3);
    expect(selected.exact.amountIn).toBe(100n);
    expect(selected.evidence).toMatchObject({
      v2ExecutableCandidatePathCount: 5,
      liquidityEligibleV2CandidatePathCount: 5,
      quotedCandidatePathCount: 3,
      quotedV2CandidatePathCount: 3,
    });
  });

  it("stops the candidate loop immediately at the two-attempt Mirror architecture boundary", async () => {
    const quoteExactOutput = vi.fn(async () => {
      throw new MirrorQuoteError(
        "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
        "two attempts exhausted",
        429,
      );
    });
    await expect(quoteBestSaucerRoute({
      mode: "mainnet", asset, desiredHbarTinybar: 1n, quoteExactOutput, simulationKey: "hard-stop",
    })).rejects.toMatchObject({ code: "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP" });
    expect(quoteExactOutput).toHaveBeenCalledTimes(1);
  });
});
