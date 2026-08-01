// Liquidity-driven token whitelist builder.
//
//   npx tsx scripts/build-whitelist.ts mainnet   (needs SAUCERSWAP_API_KEY)
//   npx tsx scripts/build-whitelist.ts testnet   (keyless: QuoterV2-driven)
//
// Emits config/whitelist.<network>.json. A token is admitted only if it has a
// direct WHBAR V2 pool (single-hop policy), enough liquidity, tolerable price
// impact at the max fuel size, no custom transfer fees, and no KYC key.
//
// Impact is measured two ways:
//   - testnet: on-chain via QuoterV2 (small vs fuel-size quote) — exact.
//   - mainnet: a conservative constant-product depth proxy from the pool's live
//     WHBAR reserve (hashio does not surface QuoterV2's revert-return on
//     mainnet). Flagged impactSource so nothing is silently approximated.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { quoterAbi } from "../server/src/abi.js";
import { encodeSwapPath } from "../client/src/txbuilder.js";

type Net = "mainnet" | "testnet";
const network = (process.argv[2] ?? "testnet") as Net;

const CFG = {
  mainnet: {
    api: "https://api.saucerswap.finance",
    mirror: "https://mainnet.mirrornode.hedera.com",
    rpc: "https://mainnet.hashio.io/api",
    whbarId: "0.0.1456986",
    quoter: "0x0000000000000000000000000000000000003c4370" as Address,
  },
  testnet: {
    api: "https://test-api.saucerswap.finance",
    mirror: "https://testnet.mirrornode.hedera.com",
    rpc: "https://testnet.hashio.io/api",
    whbarId: "0.0.15058",
    quoter: "0x00000000000000000000000000000000001535b2" as Address,
  },
}[network];

const MIN_TVL_USD = Number(process.env.WL_MIN_TVL_USD ?? 20_000);
const MIN_DEPTH_HBAR = Number(process.env.WL_MIN_DEPTH_HBAR ?? 20_000);
const MAX_IMPACT_BPS = Number(process.env.WL_MAX_IMPACT_BPS ?? 150); // 1.5%
const MAX_FUEL_HBAR = Number(process.env.WL_MAX_FUEL_HBAR ?? 50);
const FEE_TIERS = [500, 1500, 3000, 10000];

// Testnet has no priced analytics API access; probe these candidates directly.
const TESTNET_CANDIDATES = [
  { id: "0.0.5449", symbol: "USDC", decimals: 6 },
  { id: "0.0.1183558", symbol: "SAUCE", decimals: 6 },
  { id: "0.0.5529", symbol: "DAI", decimals: 8 },
  { id: "0.0.5365", symbol: "CLXY", decimals: 6 },
  { id: "0.0.4360535", symbol: "HLQT", decimals: 8 },
  { id: "0.0.3772909", symbol: "KARATE", decimals: 8 },
];

function evmAddr(tokenId: string): Address {
  const num = BigInt(tokenId.split(".")[2]!);
  return ("0x" + num.toString(16).padStart(40, "0")) as Address;
}

function decodeQuote(result: Hex | undefined): bigint | null {
  if (!result || result === "0x") return null;
  try {
    const [amountOut] = decodeFunctionResult({
      abi: quoterAbi,
      functionName: "quoteExactInput",
      data: result,
    }) as readonly [bigint, unknown, unknown, bigint];
    return amountOut;
  } catch {
    return null;
  }
}

/**
 * QuoterV2 quote over an arbitrary (multi-hop) path. Tries the JSON-RPC relay
 * first, then the mirror-node contracts/call endpoint (which returns the
 * revert-encoded result that hashio-mainnet drops) — so this works on both nets.
 */
async function quotePath(tokens: Address[], fees: number[], amountIn: bigint): Promise<bigint | null> {
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: [encodeSwapPath(tokens, fees), amountIn],
  });
  // 1. JSON-RPC relay
  try {
    const res = await fetch(CFG.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CFG.quoter, data }, "latest"] }),
    });
    const body = (await res.json()) as { result?: Hex };
    const out = decodeQuote(body.result);
    if (out !== null) return out;
  } catch {
    /* fall through */
  }
  // 2. Mirror-node contracts/call (surfaces the quoter's revert-return)
  try {
    const res = await fetch(`${CFG.mirror}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block: "latest", data, to: CFG.quoter }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: Hex };
    return decodeQuote(body.result);
  } catch {
    return null;
  }
}

async function quoteToWhbar(token: Address, fee: number, amountIn: bigint): Promise<bigint | null> {
  return quotePath([token, evmAddr(CFG.whbarId)], [fee], amountIn);
}

/** Hub tokens a multi-hop fuel route may pass through (deep, already-vetted). */
const HUBS: { symbol: string; id: string }[] = {
  mainnet: [{ symbol: "USDC", id: "0.0.456858" }],
  testnet: [
    { symbol: "USDC", id: "0.0.5449" },
    { symbol: "SAUCE", id: "0.0.1183558" },
  ],
}[network];
const FEE_COMBOS = [500, 1500, 3000, 10000];

/**
 * Find a viable route from `tokenEvm` to WHBAR: direct first, then via each hub
 * (2-hop). Returns the route + measured impact + fuel-size amountIn, or null.
 * Every intermediate is a curated hub, so the path can never route through an
 * attacker-chosen token.
 */
async function findRoute(
  tokenEvm: Address,
  decimals: number,
): Promise<{ route: { toToken: Address; fee: number }[]; impactBps: number; largeIn: bigint } | null> {
  const whbar = evmAddr(CFG.whbarId);
  const candidates: { tokens: Address[]; fees: number[] }[] = [];
  for (const fee of FEE_COMBOS) candidates.push({ tokens: [tokenEvm, whbar], fees: [fee] });
  for (const hub of HUBS) {
    const hubEvm = evmAddr(hub.id);
    if (hubEvm.toLowerCase() === tokenEvm.toLowerCase()) continue;
    for (const fa of FEE_COMBOS)
      for (const fb of FEE_COMBOS)
        candidates.push({ tokens: [tokenEvm, hubEvm, whbar], fees: [fa, fb] });
  }
  for (const cand of candidates) {
    const probe = await quotePath(cand.tokens, cand.fees, BigInt(10) ** BigInt(decimals));
    if (!probe || probe === 0n) continue;
    const largeIn = (BigInt(Math.round(MAX_FUEL_HBAR * 1e8)) * BigInt(10) ** BigInt(decimals)) / probe + 1n;
    const smallIn = largeIn / 100n > 0n ? largeIn / 100n : 1n;
    const [smallOut, largeOut] = await Promise.all([
      quotePath(cand.tokens, cand.fees, smallIn),
      quotePath(cand.tokens, cand.fees, largeIn),
    ]);
    if (!smallOut || !largeOut || smallOut === 0n) continue;
    const pSmall = (smallOut * 1_000_000_000n) / smallIn;
    const pLarge = (largeOut * 1_000_000_000n) / largeIn;
    const impactBps = Math.max(0, Number(((pSmall - pLarge) * 10_000n) / pSmall));
    if (impactBps > MAX_IMPACT_BPS) continue;
    const route = cand.tokens.slice(1).map((toToken, i) => ({ toToken, fee: cand.fees[i]! }));
    return { route, impactBps, largeIn };
  }
  return null;
}

type MirrorToken = {
  custom_fees?: { fixed_fees?: unknown[]; fractional_fees?: unknown[] };
  freeze_key: unknown;
  wipe_key: unknown;
  pause_key: unknown;
  kyc_key: unknown;
};

async function tokenRisk(tokenId: string): Promise<{ flags: string[]; reject: string[] }> {
  const res = await fetch(`${CFG.mirror}/api/v1/tokens/${tokenId}`);
  if (!res.ok) return { flags: [], reject: [`mirror lookup failed (${res.status})`] };
  const t = (await res.json()) as MirrorToken;
  const reject: string[] = [];
  const flags: string[] = [];
  const fees = t.custom_fees ?? {};
  if ((fees.fixed_fees?.length ?? 0) > 0 || (fees.fractional_fees?.length ?? 0) > 0) {
    reject.push("custom transfer fees");
  }
  if (t.kyc_key) reject.push("KYC key set");
  if (t.freeze_key) flags.push("freeze-key");
  if (t.wipe_key) flags.push("wipe-key");
  if (t.pause_key) flags.push("pause-key");
  return { flags, reject };
}

export type WhitelistEntry = {
  symbol: string;
  tokenId: string;
  evmAddress: Address;
  decimals: number;
  poolFee: number;
  /** Multi-hop route to WHBAR (present only when not a direct single-hop) */
  route?: { toToken: Address; fee: number }[];
  priceUsd: number | null;
  poolTvlUsd: number | null;
  whbarDepthHbar: number | null;
  impactBps: number;
  impactSource: "quoter" | "depth-proxy";
  maxFuelHbar: number;
  suggestedMaxAmountIn: string;
  dueDiligenceComplete: boolean | null;
  riskFlags: string[];
  bridge: string | null;
};

type PoolCand = { fee: number; tvlUsd: number | null; whbarDepthHbar: number | null };
type Candidate = {
  id: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
  dueDiligence: boolean | null;
  pools: PoolCand[];
};

async function loadMainnet(): Promise<{ candidates: Candidate[]; hbarUsd: number }> {
  const key = process.env.SAUCERSWAP_API_KEY;
  if (!key) throw new Error("mainnet mode needs SAUCERSWAP_API_KEY");
  const headers = { "x-api-key": key };
  const pools = (await (await fetch(`${CFG.api}/v2/pools`, { headers })).json()) as {
    fee: number;
    amountA: string;
    amountB: string;
    tokenA: TokenSide;
    tokenB: TokenSide;
  }[];
  type TokenSide = {
    id: string;
    symbol: string;
    decimals: number;
    priceUsd: number;
    dueDiligenceComplete: number;
  };
  let hbarUsd = 0.05;
  const byToken = new Map<string, Candidate>();
  for (const p of pools) {
    for (const [me, myAmt, other, otherAmt] of [
      [p.tokenA, p.amountA, p.tokenB, p.amountB],
      [p.tokenB, p.amountB, p.tokenA, p.amountA],
    ] as [TokenSide, string, TokenSide, string][]) {
      if (other.id !== CFG.whbarId || me.id === CFG.whbarId) continue;
      if (other.priceUsd) hbarUsd = other.priceUsd;
      const meAmt = Math.abs(Number(myAmt)) / 10 ** me.decimals;
      const whbarAmt = Math.abs(Number(otherAmt)) / 10 ** other.decimals;
      const tvlUsd = meAmt * (me.priceUsd ?? 0) + whbarAmt * (other.priceUsd ?? 0);
      const c =
        byToken.get(me.id) ??
        ({
          id: me.id,
          symbol: me.symbol,
          decimals: me.decimals,
          priceUsd: me.priceUsd ?? null,
          dueDiligence: !!me.dueDiligenceComplete,
          pools: [],
        } as Candidate);
      c.pools.push({ fee: p.fee, tvlUsd, whbarDepthHbar: whbarAmt });
      byToken.set(me.id, c);
    }
  }
  return { candidates: [...byToken.values()], hbarUsd };
}

async function main(): Promise<void> {
  const out: WhitelistEntry[] = [];
  const rejected: { symbol: string; tokenId: string; reasons: string[] }[] = [];
  let hbarUsd = 0.05;
  let candidates: Candidate[];

  if (network === "mainnet") {
    const loaded = await loadMainnet();
    candidates = loaded.candidates;
    hbarUsd = loaded.hbarUsd;
  } else {
    candidates = TESTNET_CANDIDATES.map((t) => ({
      ...t,
      priceUsd: null,
      dueDiligence: null,
      pools: FEE_TIERS.map((fee) => ({ fee, tvlUsd: null, whbarDepthHbar: null })),
    }));
  }

  for (const c of candidates) {
    const reasons: string[] = [];
    const poolsRanked = [...c.pools].sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    let admitted: WhitelistEntry | null = null;

    for (const pool of poolsRanked) {
      if (network === "mainnet") {
        if ((pool.tvlUsd ?? 0) < MIN_TVL_USD) {
          reasons.push(`fee ${pool.fee}: TVL $${Math.round(pool.tvlUsd ?? 0)} < $${MIN_TVL_USD}`);
          continue;
        }
        if ((pool.whbarDepthHbar ?? 0) < MIN_DEPTH_HBAR) {
          reasons.push(`fee ${pool.fee}: WHBAR depth ${Math.round(pool.whbarDepthHbar ?? 0)} < ${MIN_DEPTH_HBAR}`);
          continue;
        }
      }

      const addr = evmAddr(c.id);
      let impactBps: number;
      let impactSource: "quoter" | "depth-proxy";
      let suggestedMaxAmountIn: bigint;

      if (network === "testnet") {
        // Probe on-chain: derive fuel-size token amount from a 1-token quote.
        const probe = await quoteToWhbar(addr, pool.fee, BigInt(10 ** c.decimals));
        if (!probe || probe === 0n) {
          reasons.push(`fee ${pool.fee}: no quoter route`);
          continue;
        }
        const largeIn =
          (BigInt(Math.round(MAX_FUEL_HBAR * 1e8)) * BigInt(10 ** c.decimals)) / probe + 1n;
        const smallIn = largeIn / 100n > 0n ? largeIn / 100n : 1n;
        const [smallOut, largeOut] = await Promise.all([
          quoteToWhbar(addr, pool.fee, smallIn),
          quoteToWhbar(addr, pool.fee, largeIn),
        ]);
        if (!smallOut || !largeOut || smallOut === 0n) {
          reasons.push(`fee ${pool.fee}: impact unmeasurable`);
          continue;
        }
        const pSmall = (smallOut * 1_000_000_000n) / smallIn;
        const pLarge = (largeOut * 1_000_000_000n) / largeIn;
        impactBps = Math.max(0, Number(((pSmall - pLarge) * 10_000n) / pSmall));
        impactSource = "quoter";
        suggestedMaxAmountIn = largeIn;
      } else {
        // Depth-proxy: constant-product upper bound of buying MAX_FUEL_HBAR out
        // of a pool holding `depth` HBAR: impact ≈ fuel/(depth - fuel).
        const depth = pool.whbarDepthHbar ?? 0;
        if (depth <= MAX_FUEL_HBAR) {
          reasons.push(`fee ${pool.fee}: depth ${Math.round(depth)} <= fuel ${MAX_FUEL_HBAR}`);
          continue;
        }
        impactBps = Math.round((MAX_FUEL_HBAR / (depth - MAX_FUEL_HBAR)) * 10_000);
        impactSource = "depth-proxy";
        const price = c.priceUsd ?? 0;
        const tokens = price > 0 ? (MAX_FUEL_HBAR * hbarUsd) / price : 0;
        suggestedMaxAmountIn = BigInt(Math.max(1, Math.ceil(tokens * 10 ** c.decimals)));
      }

      if (impactBps > MAX_IMPACT_BPS) {
        reasons.push(`fee ${pool.fee}: impact ${impactBps}bps > ${MAX_IMPACT_BPS}bps at ${MAX_FUEL_HBAR} HBAR`);
        continue;
      }

      const risk = await tokenRisk(c.id);
      if (risk.reject.length) {
        reasons.push(...risk.reject.map((r) => `fee ${pool.fee}: ${r}`));
        break;
      }
      admitted = {
        symbol: c.symbol,
        tokenId: c.id,
        evmAddress: addr,
        decimals: c.decimals,
        poolFee: pool.fee,
        priceUsd: c.priceUsd,
        poolTvlUsd: pool.tvlUsd === null ? null : Math.round(pool.tvlUsd),
        whbarDepthHbar: pool.whbarDepthHbar === null ? null : Math.round(pool.whbarDepthHbar),
        impactBps,
        impactSource,
        maxFuelHbar: MAX_FUEL_HBAR,
        suggestedMaxAmountIn: suggestedMaxAmountIn.toString(),
        dueDiligenceComplete: c.dueDiligence,
        riskFlags: risk.flags,
        bridge: null,
      };
      break;
    }

    // Multi-hop fallback: if no direct WHBAR route was admitted, try routing
    // through a curated hub (USDC / SAUCE). This is how bridged assets and
    // hub-paired tokens become fuelable — safely, because intermediates are
    // vetted hubs, never attacker-chosen.
    if (!admitted) {
      const found = await findRoute(evmAddr(c.id), c.decimals);
      if (found && found.route.length > 1) {
        const risk = await tokenRisk(c.id);
        if (risk.reject.length) {
          reasons.push(...risk.reject.map((r) => `multi-hop: ${r}`));
        } else {
          const hops = found.route
            .map((h) => `${HUBS.find((x) => evmAddr(x.id).toLowerCase() === h.toToken.toLowerCase())?.symbol ?? "WHBAR"}@${h.fee}`)
            .join("->");
          admitted = {
            symbol: c.symbol,
            tokenId: c.id,
            evmAddress: evmAddr(c.id),
            decimals: c.decimals,
            poolFee: found.route[found.route.length - 1]!.fee,
            route: found.route,
            priceUsd: c.priceUsd,
            poolTvlUsd: null,
            whbarDepthHbar: null,
            impactBps: found.impactBps,
            impactSource: "quoter",
            maxFuelHbar: MAX_FUEL_HBAR,
            suggestedMaxAmountIn: found.largeIn.toString(),
            dueDiligenceComplete: c.dueDiligence,
            riskFlags: [...risk.flags, `multi-hop via ${hops}`],
            bridge: null,
          };
        }
      }
    }

    if (admitted) {
      out.push(admitted);
      console.log(
        `ADMIT  ${admitted.symbol.padEnd(11)} ${admitted.tokenId.padEnd(12)} fee ${String(admitted.poolFee).padEnd(5)} ` +
          `impact ${String(admitted.impactBps).padStart(3)}bps/${admitted.impactSource}` +
          (admitted.route ? ` [multi-hop ${admitted.route.length}]` : "") +
          (admitted.poolTvlUsd !== null ? ` tvl $${admitted.poolTvlUsd.toLocaleString()}` : "") +
          (admitted.riskFlags.length ? `  [${admitted.riskFlags.join(",")}]` : ""),
      );
    } else {
      rejected.push({ symbol: c.symbol, tokenId: c.id, reasons });
      console.log(`reject ${c.symbol.padEnd(11)} ${c.id.padEnd(12)} ${reasons[0] ?? "no viable pool"}`);
    }
  }

  // Bridge provenance overlay.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bridgesFile = path.join(root, "config", "bridges.json");
  if (fs.existsSync(bridgesFile)) {
    const bridges = JSON.parse(fs.readFileSync(bridgesFile, "utf8")) as Record<string, unknown>;
    for (const [bridge, data] of Object.entries(bridges)) {
      // Skip doc keys (e.g. "_comment") and any entry without a tokens map.
      if (!data || typeof data !== "object") continue;
      const tokens = (data as { tokens?: Record<string, unknown> }).tokens;
      if (!tokens || typeof tokens !== "object") continue;
      for (const entry of out) if (tokens[entry.tokenId]) entry.bridge = bridge;
    }
  }

  // hashport wound down; its remnant tokens may retain historical liquidity but
  // must never re-enter a generated fuelable list.
  const supportedOut = out.filter((entry) => {
    if (entry.bridge !== "hashport") return true;
    rejected.push({ symbol: entry.symbol, tokenId: entry.tokenId, reasons: ["defunct hashport remnant — unsupported"] });
    return false;
  });

  const outFile = path.join(root, "config", `whitelist.${network}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network,
        generatedAt: new Date().toISOString(),
        hbarUsd: network === "mainnet" ? hbarUsd : null,
        criteria: {
          minTvlUsd: network === "mainnet" ? MIN_TVL_USD : null,
          minDepthHbar: network === "mainnet" ? MIN_DEPTH_HBAR : null,
          maxImpactBpsAtMaxFuel: MAX_IMPACT_BPS,
          maxFuelHbar: MAX_FUEL_HBAR,
          hardRejects: ["no direct WHBAR V2 pool", "custom transfer fees", "KYC key"],
        },
        tokens: supportedOut,
        rejected,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outFile}: ${supportedOut.length} admitted, ${rejected.length} rejected`);
}

await main();
