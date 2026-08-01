import crypto from "node:crypto";
import { getAddress, type Address } from "viem";
import { encodeExactOutputPath } from "../../client/src/txbuilder.js";
import { NETWORKS } from "./config.js";
import { MirrorQuoteError } from "./mirror.js";
import type { ProductMode, SupportAsset, SupportCatalog } from "./support.js";

export type SaucerVenue = "v1" | "v2";

type ApiToken = {
  id: string;
  address: Address;
  symbol: string | null;
  decimals: number | null;
  priceUsd: number | null;
};

export type SaucerGraphEdge = {
  venue: SaucerVenue;
  poolId: string;
  contractId: string;
  fromToken: Address;
  toToken: Address;
  fromTokenId: string;
  toTokenId: string;
  fromSymbol: string | null;
  toSymbol: string | null;
  fee: number;
  liquidityUsd: number | null;
};

export type SaucerRouteCandidate = {
  venue: "v1" | "v2" | "mixed";
  tokens: Address[];
  route: {
    toToken: Address;
    fee: number;
    venue: SaucerVenue;
    poolId: string;
    contractId: string;
  }[];
  edges: SaucerGraphEdge[];
  hopCount: number;
  totalFee: number;
  minimumLiquidityUsd: number | null;
};

export type SaucerGraphProof = {
  schema: "refuel402.saucer-complete-graph.v1";
  source: string;
  mode: ProductMode;
  fetchedAt: string;
  graphHash: string;
  v1PoolCount: number;
  v2PoolCount: number;
  edgeCount: number;
  tokens: ApiToken[];
  edges: SaucerGraphEdge[];
};

export type SaucerApiEvidence = {
  source: string;
  tokenId: string;
  symbol: string | null;
  decimals: number | null;
  priceUsd?: number | null;
  associatedPoolCount: number;
  maximumLiquidityUsd: number | null;
  verifiedAt: string;
  graphHash: string;
  v1PoolCount: number;
  v2PoolCount: number;
  completeGraph: true;
  structuralCandidatePathCount: number;
  v1ExecutableCandidatePathCount: number;
  v2ExecutableCandidatePathCount: number;
  liquidityEligibleV2CandidatePathCount: number;
  quotedCandidatePathCount?: number;
  quotedV2CandidatePathCount?: number;
  belowDisclosureLiquidityPathCount?: number;
  liquidityDisclosureThresholdUsd?: number;
  liquidityFloorFallback?: boolean;
  selectedRoute?: {
    venue: SaucerVenue;
    executionScope: "venue_aware_exact_output";
    routeId: string;
    tokens: Address[];
    fees: number[];
    hopCount: number;
    minimumLiquidityUsd: number | null;
    amountIn: string;
    amountOutTinybar: string;
    gasEstimate: string;
    perHopAmountsAvailable: false;
    hops: {
      index: number;
      venue: SaucerVenue;
      version: SaucerVenue;
      input: { tokenId: string; address: Address; symbol: string | null };
      output: { tokenId: string; address: Address; symbol: string | null };
      pool: { id: string; contractId: string };
      feeTier: number;
      feeBps: number;
      liquidityUsd: number | null;
      amountContext: "route_level_exact_output";
    }[];
    discovery: {
      v1PoolCount: number;
      v2PoolCount: number;
      structuralCandidatePathCount: number;
      v1ExecutableCandidatePathCount: number;
      v2ExecutableCandidatePathCount: number;
      liquidityEligibleV2CandidatePathCount: number;
      quotedCandidatePathCount?: number;
      quotedV2CandidatePathCount?: number;
      belowDisclosureLiquidityPathCount?: number;
      liquidityDisclosureThresholdUsd?: number;
      liquidityFloorFallback?: boolean;
      v1DiscoveryOnly: boolean;
    };
    simulatedAt: string;
    expiresAt: string;
  };
};

export type SaucerBestRouteQuote = {
  route: SaucerRouteCandidate["route"];
  tokens: Address[];
  exact: { amountIn: bigint; gasEstimate: bigint };
  reference?: { amountOut: bigint; amountIn: bigint; gasEstimate: bigint };
  evidence: SaucerApiEvidence;
  simulatedAt: number;
  expiresAt: number;
};

export type SaucerQuoteTiming = {
  graphMs?: number;
  graphCache?: "hit" | "coalesced" | "miss";
  exactOutputSimulationMs?: number;
  quoteCache?: "hit" | "coalesced" | "miss";
  totalMs?: number;
};

export class SaucerApiError extends Error {
  constructor(
    readonly code:
      | "NOT_CONFIGURED"
      | "REQUEST_FAILED"
      | "CREDENTIAL_REJECTED"
      | "RESPONSE_INVALID"
      | "REPRESENTATION_MISMATCH"
      | "ROUTE_UNAVAILABLE"
      | "MIXED_VENUE_EXECUTION_UNSUPPORTED"
      | "CANDIDATE_BUDGET_EXCEEDED"
      | "STALE_QUOTE"
      | "ARCHITECTURE_HARD_STOP",
    message: string,
  ) {
    super(message);
  }
}

type DiscoveryResult = {
  start: Address;
  structural: SaucerRouteCandidate[];
  v1: SaucerRouteCandidate[];
  v2: SaucerRouteCandidate[];
};
const graphCache = new Map<string, { expiresAt: number; proof: SaucerGraphProof }>();
const graphInflight = new Map<string, Promise<SaucerGraphProof>>();
const routeCache = new Map<string, { expiresAt: number; result: DiscoveryResult }>();
const quoteCache = new Map<string, { expiresAt: number; result: SaucerBestRouteQuote }>();
const quoteInflight = new Map<string, Promise<SaucerBestRouteQuote>>();
const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 1;

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SaucerApiError("NOT_CONFIGURED", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  const maximum = boundedInteger("SAUCERSWAP_CACHE_MAX_ENTRIES", 64, 4, 256);
  if (!map.has(key) && map.size >= maximum) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function functionIdentity(fn: Function): number {
  const existing = functionIds.get(fn);
  if (existing) return existing;
  const id = nextFunctionId++;
  functionIds.set(fn, id);
  return id;
}

export function clearSaucerGraphCacheForTests(): void {
  graphCache.clear();
  graphInflight.clear();
  routeCache.clear();
  quoteCache.clear();
  quoteInflight.clear();
}

function apiBase(mode: ProductMode): string {
  const raw = mode === "testnet"
    ? process.env.SAUCERSWAP_TESTNET_API_BASE_URL ?? "https://test-api.saucerswap.finance"
    : process.env.SAUCERSWAP_API_BASE_URL ?? "https://api.saucerswap.finance";
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !["api.saucerswap.finance", "server.saucerswap.finance", "test-api.saucerswap.finance"].includes(url.hostname)
  ) {
    throw new SaucerApiError("NOT_CONFIGURED", "SaucerSwap API base URL is not allowlisted");
  }
  return url.toString().replace(/\/$/, "");
}

function apiKey(): string {
  const key = process.env.SAUCERSWAP_API_KEY?.trim();
  if (!key) throw new SaucerApiError("NOT_CONFIGURED", "SaucerSwap API key is not configured");
  return key;
}

async function apiJson(mode: ProductMode, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiBase(mode)}${path}`, {
      headers: {
        "x-api-key": apiKey(),
        "user-agent": "Refuel402/0.1 (+https://refuel402.pages.dev)",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SaucerApiError("REQUEST_FAILED", "SaucerSwap API request failed");
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SaucerApiError("CREDENTIAL_REJECTED", `SaucerSwap API credential was rejected (${response.status})`);
    }
    throw new SaucerApiError("REQUEST_FAILED", `SaucerSwap API request failed (${response.status})`);
  }
  if (text.length > 20_000_000) {
    throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap API response exceeded the size limit");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap API returned invalid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const candidate of [record.data, record.rows, record.tokens, record.pools]) {
    if (Array.isArray(candidate)) return candidate.map(asRecord);
  }
  throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap full-pool response is not an array");
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenAddress(tokenId: string): Address {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(tokenId);
  if (!match) throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap pool contains an invalid Hedera token id");
  const numeric = BigInt(match[3]!);
  if (numeric < 0n || numeric >= 2n ** 160n) {
    throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap token id exceeds the EVM address range");
  }
  return getAddress(`0x${numeric.toString(16).padStart(40, "0")}`);
}

function parseToken(value: unknown): ApiToken {
  const token = asRecord(value);
  const id = String(token.id ?? token.tokenId ?? token.token_id ?? "");
  if (!id) throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap pool token identity is missing");
  return {
    id,
    address: tokenAddress(id),
    symbol: typeof token.symbol === "string" ? token.symbol : null,
    decimals: numberValue(token.decimals),
    priceUsd: numberValue(token.priceUsd ?? token.priceUSD),
  };
}

function liquidityUsd(
  tokenA: ApiToken,
  amountA: unknown,
  tokenB: ApiToken,
  amountB: unknown,
): number | null {
  if (tokenA.decimals === null || tokenB.decimals === null || tokenA.priceUsd === null || tokenB.priceUsd === null) {
    return null;
  }
  const rawA = numberValue(amountA);
  const rawB = numberValue(amountB);
  if (rawA === null || rawB === null) return null;
  return Math.abs(rawA) / 10 ** tokenA.decimals * tokenA.priceUsd +
    Math.abs(rawB) / 10 ** tokenB.decimals * tokenB.priceUsd;
}

function poolEdges(pool: Record<string, unknown>, venue: SaucerVenue): { tokens: ApiToken[]; edges: SaucerGraphEdge[] } {
  const tokenA = parseToken(pool.tokenA);
  const tokenB = parseToken(pool.tokenB);
  const poolId = String(pool.id ?? pool.contractId ?? "");
  const contractId = String(pool.contractId ?? "");
  if (!poolId || !contractId) throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap pool identity is missing");
  const fee = venue === "v2" ? numberValue(pool.fee) : 3_000;
  if (fee === null || !Number.isInteger(fee) || fee < 0) {
    throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap pool fee is invalid");
  }
  const tvl = venue === "v2"
    ? liquidityUsd(tokenA, pool.amountA, tokenB, pool.amountB)
    : liquidityUsd(tokenA, pool.tokenReserveA, tokenB, pool.tokenReserveB);
  const edge = (from: ApiToken, to: ApiToken): SaucerGraphEdge => ({
    venue,
    poolId,
    contractId,
    fromToken: from.address,
    toToken: to.address,
    fromTokenId: from.id,
    toTokenId: to.id,
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    fee,
    liquidityUsd: tvl,
  });
  return { tokens: [tokenA, tokenB], edges: [edge(tokenA, tokenB), edge(tokenB, tokenA)] };
}

async function loadCompleteSaucerGraph(mode: ProductMode): Promise<SaucerGraphProof> {
  const [v1Body, v2Body] = await Promise.all([
    apiJson(mode, "/pools/full"),
    apiJson(mode, "/v2/pools/full"),
  ]);
  const v1Pools = rows(v1Body);
  const v2Pools = rows(v2Body);
  if (v1Pools.length === 0 || v2Pools.length === 0) {
    throw new SaucerApiError("RESPONSE_INVALID", "SaucerSwap full V1/V2 graph is unexpectedly empty");
  }
  const tokenMap = new Map<string, ApiToken>();
  const edges: SaucerGraphEdge[] = [];
  for (const [venue, pools] of [["v1", v1Pools], ["v2", v2Pools]] as const) {
    for (const pool of pools) {
      const parsed = poolEdges(pool, venue);
      parsed.tokens.forEach((token) => tokenMap.set(token.address.toLowerCase(), token));
      edges.push(...parsed.edges);
    }
  }
  const canonicalEdges = edges
    .map((edge) => JSON.stringify({
      venue: edge.venue,
      poolId: edge.poolId,
      contractId: edge.contractId,
      fromToken: edge.fromToken.toLowerCase(),
      toToken: edge.toToken.toLowerCase(),
      fee: edge.fee,
      liquidityUsd: edge.liquidityUsd,
    }))
    .sort((left, right) => left.localeCompare(right));
  return {
    schema: "refuel402.saucer-complete-graph.v1",
    source: apiBase(mode),
    mode,
    fetchedAt: new Date().toISOString(),
    graphHash: crypto.createHash("sha256").update(`[${canonicalEdges.join(",")}]`).digest("hex"),
    v1PoolCount: v1Pools.length,
    v2PoolCount: v2Pools.length,
    edgeCount: edges.length,
    tokens: [...tokenMap.values()],
    edges,
  };
}

function startGraphLoad(mode: ProductMode, cacheKey: string): Promise<SaucerGraphProof> {
  const request = loadCompleteSaucerGraph(mode)
    .then((proof) => {
      const ttl = boundedInteger("SAUCERSWAP_GRAPH_CACHE_MS", 30_000, 1_000, 300_000);
      setBounded(graphCache, cacheKey, { expiresAt: Date.now() + ttl, proof });
      return proof;
    })
    .finally(() => graphInflight.delete(cacheKey));
  graphInflight.set(cacheKey, request);
  return request;
}

function graphCacheKey(mode: ProductMode): string {
  return `${mode}:${apiBase(mode)}:${crypto.createHash("sha256").update(apiKey()).digest("hex")}`;
}

function graphRefreshAheadMs(): number {
  const ttl = boundedInteger("SAUCERSWAP_GRAPH_CACHE_MS", 30_000, 1_000, 300_000);
  return Math.min(10_000, Math.floor(ttl / 2));
}

/**
 * True when the currently served proof is about to be replaced by a background
 * reload. Quote cache keys embed the graph hash, so work started across a
 * rotation cannot coalesce with the authoritative call that follows it.
 */
export function saucerGraphProofRotationPending(mode: ProductMode, now = Date.now()): boolean {
  const cacheKey = graphCacheKey(mode);
  const cached = graphCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now) return false;
  return graphInflight.has(cacheKey) || cached.expiresAt - now < graphRefreshAheadMs();
}

export async function fetchCompleteSaucerGraph(mode: ProductMode, timing?: SaucerQuoteTiming): Promise<SaucerGraphProof> {
  const startedAt = Date.now();
  const cacheKey = graphCacheKey(mode);
  const now = Date.now();
  const cached = graphCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Refresh-ahead: near expiry the valid proof is still served while one
    // deduped background reload renews the cache so no quote pays the miss.
    if (cached.expiresAt - now < graphRefreshAheadMs() && !graphInflight.has(cacheKey)) {
      startGraphLoad(mode, cacheKey).catch(() => {});
    }
    if (timing) {
      timing.graphCache = "hit";
      timing.graphMs = Date.now() - startedAt;
    }
    return cached.proof;
  }
  const active = graphInflight.get(cacheKey);
  if (active) {
    const proof = await active;
    if (timing) {
      timing.graphCache = "coalesced";
      timing.graphMs = Date.now() - startedAt;
    }
    return proof;
  }
  const proof = await startGraphLoad(mode, cacheKey);
  if (timing) {
    timing.graphCache = "miss";
    timing.graphMs = Date.now() - startedAt;
  }
  return proof;
}

function routeVenue(edges: SaucerGraphEdge[]): SaucerRouteCandidate["venue"] {
  const venues = new Set(edges.map((edge) => edge.venue));
  return venues.size === 1 ? edges[0]!.venue : "mixed";
}

function candidate(edges: SaucerGraphEdge[]): SaucerRouteCandidate {
  const liquidities = edges.map((edge) => edge.liquidityUsd).filter((value): value is number => value !== null);
  const tokens = [edges[0]!.fromToken, ...edges.map((edge) => edge.toToken)];
  return {
    venue: routeVenue(edges),
    tokens,
    route: edges.map((edge) => ({
      toToken: edge.toToken,
      fee: edge.fee,
      venue: edge.venue,
      poolId: edge.poolId,
      contractId: edge.contractId,
    })),
    edges,
    hopCount: edges.length,
    totalFee: edges.reduce((sum, edge) => sum + edge.fee, 0),
    minimumLiquidityUsd: liquidities.length === edges.length ? Math.min(...liquidities) : null,
  };
}

function enumeratePaths(
  graph: SaucerGraphProof,
  start: Address,
  targets: Set<string>,
  maxHops: number,
): SaucerRouteCandidate[] {
  const adjacency = new Map<string, SaucerGraphEdge[]>();
  for (const edge of graph.edges) {
    const key = edge.fromToken.toLowerCase();
    const list = adjacency.get(key) ?? [];
    list.push(edge);
    adjacency.set(key, list);
  }
  const out: SaucerRouteCandidate[] = [];
  const visited = new Set<string>([start.toLowerCase()]);
  const walk = (current: Address, path: SaucerGraphEdge[]) => {
    if (path.length >= maxHops) return;
    for (const edge of adjacency.get(current.toLowerCase()) ?? []) {
      const next = edge.toToken.toLowerCase();
      if (visited.has(next)) continue;
      const nextPath = [...path, edge];
      if (targets.has(next)) out.push(candidate(nextPath));
      visited.add(next);
      walk(edge.toToken, nextPath);
      visited.delete(next);
      if (out.length > 5_000) {
        throw new SaucerApiError("CANDIDATE_BUDGET_EXCEEDED", "SaucerSwap structural path count exceeded the safety budget");
      }
    }
  };
  walk(start, []);
  return out;
}

function maximumSaucerHops(): number {
  return boundedInteger("MAX_SAUCER_HOPS", 3, 1, 4);
}

function rankCandidate(left: SaucerRouteCandidate, right: SaucerRouteCandidate): number {
  const leftLiquidity = left.minimumLiquidityUsd ?? -1;
  const rightLiquidity = right.minimumLiquidityUsd ?? -1;
  if (leftLiquidity !== rightLiquidity) return rightLiquidity - leftLiquidity;
  if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
  return left.totalFee - right.totalFee;
}

function discoverFromGraph(graph: SaucerGraphProof, mode: ProductMode, asset: SupportAsset): DiscoveryResult {
  const start = getAddress(asset.destination.wrapper?.htsAddress ?? asset.destination.address);
  const maxHops = maximumSaucerHops();
  const cacheKey = `${graph.graphHash}:${mode}:${asset.id}:${start.toLowerCase()}:${maxHops}`;
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const network = NETWORKS[mode];
  const targetSymbols = new Set(["HBAR", "WHBAR"]);
  const structuralTargets = new Set(
    graph.tokens
      .filter((token) => targetSymbols.has((token.symbol ?? "").toUpperCase()) || token.address === network.whbarToken)
      .map((token) => token.address.toLowerCase()),
  );
  structuralTargets.add(network.whbarToken.toLowerCase());
  const structural = enumeratePaths(graph, start, structuralTargets, maxHops);
  const v1 = network.v1Router
    ? structural.filter((path) =>
        path.venue === "v1" && path.tokens[path.tokens.length - 1]!.toLowerCase() === network.whbarToken.toLowerCase(),
      )
    : [];
  const v2 = structural.filter((path) =>
    path.venue === "v2" && path.tokens[path.tokens.length - 1]!.toLowerCase() === network.whbarToken.toLowerCase(),
  );
  const result = {
    start,
    structural: structural.sort(rankCandidate),
    v1: v1.sort(rankCandidate),
    v2: v2.sort(rankCandidate),
  };
  const ttl = boundedInteger("SAUCERSWAP_ROUTE_CACHE_MS", 15_000, 1_000, 60_000);
  setBounded(routeCache, cacheKey, { expiresAt: Date.now() + ttl, result });
  return result;
}

/**
 * Floor for the thinnest hop of a selected route.
 *
 * The refuel swap is tiny by construction: MAX_REFUEL_TINYBAR caps a single
 * refuel at 50 HBAR, worth roughly $3.31 at the HBAR/USD rate this repo records
 * (config/whitelist.mainnet.json). Sizing a pool floor for that trade is a
 * different question from sizing one for a whale, and the old $20,000 default
 * answered the second question — it gated assets whose pools are ten times
 * deeper than the trade could ever need.
 *
 * 100 keeps the floor as a dead-pool filter and nothing more. For scale: the
 * constant-product bound in scripts/build-whitelist.ts puts 150 bps of impact at
 * 50 HBAR out at about 3,383 HBAR (~$224) of one-sided depth, i.e. ~$450 of
 * balanced-pool TVL — so between $100 and ~$450 the floor now admits routes that
 * MAX_PRICE_IMPACT_BPS will reject at or near the maximum refuel, and reject
 * them per amount rather than per asset. That is the intended trade: a thin pool
 * stays quotable for the small refuels it can actually fill, and the gates that
 * scale with the trade decide the rest.
 *
 * Those gates — the venue-specific exact-output simulation, the price-impact
 * cap, the fair-value deviation check and the consented max slippage — are the
 * real protection and are evaluated per quote, not per catalog entry.
 */
const DEFAULT_MIN_ROUTE_LIQUIDITY_USD = 100;

function minimumRouteLiquidityUsd(): number {
  const value = Number(process.env.MIN_SAUCER_ROUTE_LIQUIDITY_USD ?? DEFAULT_MIN_ROUTE_LIQUIDITY_USD);
  if (!Number.isFinite(value) || value < 0) {
    throw new SaucerApiError("NOT_CONFIGURED", "MIN_SAUCER_ROUTE_LIQUIDITY_USD must be a non-negative number");
  }
  return value;
}

function liquidityEligible(paths: SaucerRouteCandidate[]): SaucerRouteCandidate[] {
  const disclosureThreshold = minimumRouteLiquidityUsd();
  return paths.filter((path) => path.minimumLiquidityUsd !== null && path.minimumLiquidityUsd >= disclosureThreshold);
}

export async function hydrateSaucerSupportCatalog(catalog: SupportCatalog): Promise<SupportCatalog> {
  const graph = await fetchCompleteSaucerGraph(catalog.mode);
  const assets = catalog.assets.map((asset) => {
    const found = discoverFromGraph(graph, catalog.mode, asset);
    const liquid = liquidityEligible(found.v2);
    const liquidV1 = liquidityEligible(found.v1);
    // Below-floor routes stay disclosed but never re-enable refuel: the
    // liquidity floor is a runtime execution gate, not a disclosure threshold.
    const selected = liquid[0] ?? liquidV1[0] ?? found.v2[0] ?? found.v1[0] ?? null;
    const mixedOnly = !selected && found.structural.some((path) => path.venue === "mixed");
    const status: SupportAsset["saucer"]["status"] = !selected
      ? "no_route"
      : liquid.length + liquidV1.length > 0 ? "verified" : "below_liquidity_policy";
    const saucerBlockers = new Set(["SAUCER_ROUTE_UNAVAILABLE", "SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED", "SAUCER_LIQUIDITY_POLICY", "SAUCER_QUOTER_CURRENT_PROBE_FAILED"]);
    const blockers = asset.blockers.filter((code) => !saucerBlockers.has(code));
    if (status === "no_route") blockers.push(mixedOnly ? "SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED" : "SAUCER_ROUTE_UNAVAILABLE");
    if (status === "below_liquidity_policy") blockers.push("SAUCER_LIQUIDITY_POLICY");
    const providerRouteReady = !blockers.some((code) => code.startsWith("PROVIDER_"));
    return {
      ...asset,
      saucer: {
        ...asset.saucer,
        status,
        route: selected?.route ?? [],
        evidence: selected
          ? `Complete SaucerSwap API graph ${graph.graphHash}: ${graph.v1PoolCount} V1 + ${graph.v2PoolCount} V2 pools; ${found.structural.length} bounded structural paths, ${found.v1.length} executable V1 paths, ${found.v2.length} executable V2 paths, ${liquid.length + liquidV1.length} paths above the liquidity execution floor. Refuel execution additionally requires venue-specific exact-output simulation, the liquidity floor, price-impact limits, and explicit slippage consent.`
          : `Complete SaucerSwap API graph ${graph.graphHash}: no bounded route from the exact destination representation to HBAR/WHBAR.`,
      },
      quote: status === "verified" && providerRouteReady,
      blockers: [...new Set(blockers)],
    };
  });
  return {
    ...catalog,
    evidenceAt: graph.fetchedAt,
    assets,
    saucerEvidence: {
      status: "verified_complete_graph",
      source: graph.source,
      graphHash: graph.graphHash,
      fetchedAt: graph.fetchedAt,
      v1PoolCount: graph.v1PoolCount,
      v2PoolCount: graph.v2PoolCount,
    },
  };
}

export async function verifySaucerApiAsset(asset: SupportAsset, mode?: ProductMode): Promise<SaucerApiEvidence | null> {
  if (!process.env.SAUCERSWAP_API_KEY) return null;
  const resolvedMode = mode ?? (asset.id.includes(":testnet:") ? "testnet" : "mainnet");
  const graph = await fetchCompleteSaucerGraph(resolvedMode);
  const tokenId = asset.destination.wrapper?.htsTokenId ?? asset.destination.tokenId;
  if (!tokenId) {
    throw new SaucerApiError("REPRESENTATION_MISMATCH", "destination asset has no HTS representation for SaucerSwap API verification");
  }
  const address = tokenAddress(tokenId);
  const token = graph.tokens.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase());
  if (!token) {
    throw new SaucerApiError("REPRESENTATION_MISMATCH", "destination representation is absent from the complete SaucerSwap graph");
  }
  const incident = graph.edges.filter((edge) => edge.fromToken.toLowerCase() === address.toLowerCase());
  if (incident.length === 0) {
    throw new SaucerApiError("REPRESENTATION_MISMATCH", "destination representation has no SaucerSwap pool edge");
  }
  const found = discoverFromGraph(graph, resolvedMode, asset);
  const liquidities = incident.map((edge) => edge.liquidityUsd).filter((value): value is number => value !== null);
  return {
    source: graph.source,
    tokenId,
    symbol: token.symbol,
    decimals: token.decimals,
    priceUsd: token.priceUsd,
    associatedPoolCount: new Set(incident.map((edge) => `${edge.venue}:${edge.poolId}`)).size,
    maximumLiquidityUsd: liquidities.length > 0 ? Math.max(...liquidities) : null,
    verifiedAt: graph.fetchedAt,
    graphHash: graph.graphHash,
    v1PoolCount: graph.v1PoolCount,
    v2PoolCount: graph.v2PoolCount,
    completeGraph: true,
    structuralCandidatePathCount: found.structural.length,
    v1ExecutableCandidatePathCount: found.v1.length,
    v2ExecutableCandidatePathCount: found.v2.length,
    liquidityEligibleV2CandidatePathCount: liquidityEligible(found.v2).length,
  };
}

type QuoteRouteInput = {
  mode: ProductMode;
  asset: SupportAsset;
  desiredHbarTinybar: bigint;
  simulationKey?: string;
  includeReferenceQuote?: boolean;
  simulationSchedulerEnforcesSpacing?: boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  quoteExactOutput: (quoter: Address, path: `0x${string}`, amountOut: bigint) => Promise<{ amountIn: bigint; gasEstimate: bigint }>;
  quoteV1ExactOutput?: (router: Address, path: Address[], amountOut: bigint) => Promise<{ amountIn: bigint; gasEstimate: bigint }>;
  timing?: SaucerQuoteTiming;
};

async function quoteBestSaucerRouteOnce(
  input: QuoteRouteInput,
  graph: SaucerGraphProof,
): Promise<SaucerBestRouteQuote> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const found = discoverFromGraph(graph, input.mode, input.asset);
  const budget = boundedInteger("MAX_SAUCER_QUOTE_CANDIDATES", 8, 1, 32);
  const executableCandidates = [...found.v1, ...found.v2]
    .filter((path) => path.venue === "v2" || !!input.quoteV1ExactOutput)
    .sort(rankCandidate);
  const eligibleCandidates = liquidityEligible(executableCandidates);
  // Liquidity-eligible candidates are preferred; below-floor paths are simulated
  // only when no eligible path exists so the route stays disclosed for
  // bridge-only/introspection while combined-quote gates refuel execution.
  const liquidityFloorFallback = eligibleCandidates.length === 0 && executableCandidates.length > 0;
  const quoteCandidates = (liquidityFloorFallback ? executableCandidates : eligibleCandidates).slice(0, budget);
  if (quoteCandidates.length === 0) {
    const mixedOnly = found.structural.some((path) => path.venue === "mixed");
    throw new SaucerApiError(
      mixedOnly ? "MIXED_VENUE_EXECUTION_UNSUPPORTED" : "ROUTE_UNAVAILABLE",
      mixedOnly
        ? "the complete SaucerSwap graph has only mixed V1/V2 paths; no atomic single-venue sponsored execution bundle exists"
        : "complete SaucerSwap graph has no executable exact-output path for the destination representation",
    );
  }
  const quoter = NETWORKS[input.mode].quoter;
  const valid: {
    path: SaucerRouteCandidate;
    exact: { amountIn: bigint; gasEstimate: bigint };
    completedAt: number;
  }[] = [];
  const rejectedReasons: string[] = [];
  const spacingMs = boundedInteger("SAUCERSWAP_QUOTE_SPACING_MS", 500, 50, 5_000);
  let simulatedCandidateCount = 0;
  let simulatedV2CandidateCount = 0;
  let bestAmountIn: bigint | null = null;
  let candidatesSinceImprovement = 0;
  for (let index = 0; index < quoteCandidates.length; index += 1) {
    const path = quoteCandidates[index]!;
    simulatedCandidateCount += 1;
    if (path.venue === "v2") simulatedV2CandidateCount += 1;
    try {
      const exact = path.venue === "v1"
        ? await input.quoteV1ExactOutput!(NETWORKS[input.mode].v1Router!, path.tokens, input.desiredHbarTinybar)
        : await input.quoteExactOutput(
            quoter,
            encodeExactOutputPath(path.tokens, path.edges.map((edge) => edge.fee)),
            input.desiredHbarTinybar,
          );
      valid.push({ path, exact, completedAt: now() });
      if (bestAmountIn === null || exact.amountIn < bestAmountIn) {
        bestAmountIn = exact.amountIn;
        candidatesSinceImprovement = 0;
      } else {
        candidatesSinceImprovement += 1;
      }
    } catch (error) {
      if (error instanceof MirrorQuoteError && error.code === "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP") {
        throw error;
      }
      rejectedReasons.push(error instanceof Error ? error.message : "unknown quote failure");
      if (bestAmountIn !== null) candidatesSinceImprovement += 1;
    }
    // Candidates are pre-ranked liquidity-desc/hops/fee, so the cheapest input
    // is nearly always early; two consecutive non-improving serialized
    // simulations end the scan instead of burning ~1s of validity each.
    if (candidatesSinceImprovement >= 2) break;
    if (!input.simulationSchedulerEnforcesSpacing && index < quoteCandidates.length - 1) await sleep(spacingMs);
  }
  valid.sort((left, right) => {
    if (left.exact.amountIn !== right.exact.amountIn) return left.exact.amountIn < right.exact.amountIn ? -1 : 1;
    if (left.path.totalFee !== right.path.totalFee) return left.path.totalFee - right.path.totalFee;
    if (left.exact.gasEstimate !== right.exact.gasEstimate) return left.exact.gasEstimate < right.exact.gasEstimate ? -1 : 1;
    return left.path.hopCount - right.path.hopCount;
  });
  const selected = valid[0];
  if (!selected) {
    const reasons = [...new Set(rejectedReasons)].slice(0, 3);
    throw new SaucerApiError(
      "ROUTE_UNAVAILABLE",
      `all complete-graph SaucerSwap exact-output candidates failed to quote${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
    );
  }
  let reference: SaucerBestRouteQuote["reference"];
  let referenceCompletedAt: number | null = null;
  if (input.includeReferenceQuote) {
    const referenceOut = input.desiredHbarTinybar > 10n ? input.desiredHbarTinybar / 10n : input.desiredHbarTinybar;
    if (referenceOut === input.desiredHbarTinybar) {
      reference = { amountOut: referenceOut, ...selected.exact };
    } else {
      if (!input.simulationSchedulerEnforcesSpacing) await sleep(spacingMs);
      const exactReference = selected.path.venue === "v1"
        ? await input.quoteV1ExactOutput!(NETWORKS[input.mode].v1Router!, selected.path.tokens, referenceOut)
        : await input.quoteExactOutput(
            quoter,
            encodeExactOutputPath(selected.path.tokens, selected.path.edges.map((edge) => edge.fee)),
            referenceOut,
          );
      referenceCompletedAt = now();
      reference = { amountOut: referenceOut, ...exactReference };
    }
  }
  const maximumAgeMs = boundedInteger("SAUCERSWAP_QUOTE_MAX_AGE_MS", 15_000, 1_000, 60_000);
  // Freshness anchors to the winning simulation and its reference; a losing
  // candidate's age must not burn the quote's validity window.
  const simulatedAt = referenceCompletedAt === null
    ? selected.completedAt
    : Math.min(selected.completedAt, referenceCompletedAt);
  const expiresAt = simulatedAt + maximumAgeMs;
  if (now() >= expiresAt) {
    throw new SaucerApiError("STALE_QUOTE", "SaucerSwap exact-output candidate set expired before ranking completed");
  }
  const tokenId = input.asset.destination.wrapper?.htsTokenId ?? input.asset.destination.tokenId ?? "";
  const token = graph.tokens.find((candidate) => candidate.address.toLowerCase() === found.start.toLowerCase());
  const incident = graph.edges.filter((edge) => edge.fromToken.toLowerCase() === found.start.toLowerCase());
  const liquidities = incident.map((edge) => edge.liquidityUsd).filter((value): value is number => value !== null);
  const evidence: SaucerApiEvidence = {
    source: graph.source,
    tokenId,
    symbol: token?.symbol ?? null,
    decimals: token?.decimals ?? null,
    priceUsd: token?.priceUsd ?? null,
    associatedPoolCount: new Set(incident.map((edge) => `${edge.venue}:${edge.poolId}`)).size,
    maximumLiquidityUsd: liquidities.length > 0 ? Math.max(...liquidities) : null,
    verifiedAt: graph.fetchedAt,
    graphHash: graph.graphHash,
    v1PoolCount: graph.v1PoolCount,
    v2PoolCount: graph.v2PoolCount,
    completeGraph: true,
    structuralCandidatePathCount: found.structural.length,
    v1ExecutableCandidatePathCount: found.v1.length,
    v2ExecutableCandidatePathCount: found.v2.length,
    liquidityEligibleV2CandidatePathCount: liquidityEligible(found.v2).length,
    quotedCandidatePathCount: simulatedCandidateCount,
    quotedV2CandidatePathCount: simulatedV2CandidateCount,
    belowDisclosureLiquidityPathCount: found.v2.length - liquidityEligible(found.v2).length,
    liquidityDisclosureThresholdUsd: minimumRouteLiquidityUsd(),
    liquidityFloorFallback,
    selectedRoute: {
      venue: selected.path.venue as SaucerVenue,
      executionScope: "venue_aware_exact_output",
      routeId: selected.path.edges.map((edge) => `${edge.venue}:${edge.poolId}`).join("->"),
      tokens: selected.path.tokens,
      fees: selected.path.edges.map((edge) => edge.fee),
      hopCount: selected.path.hopCount,
      minimumLiquidityUsd: selected.path.minimumLiquidityUsd,
      amountIn: selected.exact.amountIn.toString(),
      amountOutTinybar: input.desiredHbarTinybar.toString(),
      gasEstimate: selected.exact.gasEstimate.toString(),
      perHopAmountsAvailable: false,
      hops: selected.path.edges.map((edge, index) => ({
        index,
        venue: edge.venue,
        version: edge.venue,
        input: { tokenId: edge.fromTokenId, address: edge.fromToken, symbol: edge.fromSymbol },
        output: { tokenId: edge.toTokenId, address: edge.toToken, symbol: edge.toSymbol },
        pool: { id: edge.poolId, contractId: edge.contractId },
        feeTier: edge.fee,
        feeBps: edge.fee / 100,
        liquidityUsd: edge.liquidityUsd,
        amountContext: "route_level_exact_output" as const,
      })),
      discovery: {
        v1PoolCount: graph.v1PoolCount,
        v2PoolCount: graph.v2PoolCount,
        structuralCandidatePathCount: found.structural.length,
        v1ExecutableCandidatePathCount: found.v1.length,
        v2ExecutableCandidatePathCount: found.v2.length,
        liquidityEligibleV2CandidatePathCount: liquidityEligible(found.v2).length,
        quotedCandidatePathCount: simulatedCandidateCount,
        quotedV2CandidatePathCount: simulatedV2CandidateCount,
        belowDisclosureLiquidityPathCount: found.v2.length - liquidityEligible(found.v2).length,
        liquidityDisclosureThresholdUsd: minimumRouteLiquidityUsd(),
        liquidityFloorFallback,
        v1DiscoveryOnly: !NETWORKS[input.mode].v1Router,
      },
      simulatedAt: new Date(simulatedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
  return {
    route: selected.path.route,
    tokens: selected.path.tokens,
    exact: selected.exact,
    reference,
    evidence,
    simulatedAt,
    expiresAt,
  };
}

export async function quoteBestSaucerRoute(input: QuoteRouteInput): Promise<SaucerBestRouteQuote> {
  const startedAt = Date.now();
  const graph = await fetchCompleteSaucerGraph(input.mode, input.timing);
  const now = input.now ?? Date.now;
  const namespace = input.simulationKey ?? `callback:${functionIdentity(input.quoteExactOutput)}:${input.quoteV1ExactOutput ? functionIdentity(input.quoteV1ExactOutput) : "no-v1"}`;
  const key = [
    input.mode,
    input.asset.id,
    input.desiredHbarTinybar.toString(),
    graph.graphHash,
    namespace,
    minimumRouteLiquidityUsd(),
    maximumSaucerHops(),
    boundedInteger("MAX_SAUCER_QUOTE_CANDIDATES", 8, 1, 32),
    input.includeReferenceQuote ? "reference" : "no-reference",
    input.simulationSchedulerEnforcesSpacing ? "scheduled" : "local-spacing",
  ].join(":");
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now() && cached.result.expiresAt > now()) {
    if (input.timing) {
      input.timing.quoteCache = "hit";
      input.timing.exactOutputSimulationMs = 0;
      input.timing.totalMs = Date.now() - startedAt;
    }
    return cached.result;
  }
  const active = quoteInflight.get(key);
  if (active) {
    const result = await active;
    if (input.timing) {
      input.timing.quoteCache = "coalesced";
      input.timing.exactOutputSimulationMs = Date.now() - startedAt - (input.timing.graphMs ?? 0);
      input.timing.totalMs = Date.now() - startedAt;
    }
    return result;
  }
  const simulationStartedAt = Date.now();
  const request = quoteBestSaucerRouteOnce(input, graph)
    .then((result) => {
      const cacheTtl = boundedInteger("SAUCERSWAP_QUOTE_CACHE_MS", 5_000, 0, 30_000);
      if (cacheTtl > 0) {
        setBounded(quoteCache, key, {
          expiresAt: Math.min(result.expiresAt, now() + cacheTtl),
          result,
        });
      }
      return result;
    })
    .finally(() => quoteInflight.delete(key));
  quoteInflight.set(key, request);
  const result = await request;
  if (input.timing) {
    input.timing.quoteCache = "miss";
    input.timing.exactOutputSimulationMs = Date.now() - simulationStartedAt;
    input.timing.totalMs = Date.now() - startedAt;
  }
  return result;
}
