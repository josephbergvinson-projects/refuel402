// Sponsorship pricing. The fee is denominated in the *same token the user is
// swapping*, converted from the sponsor's expected HBAR gas outlay using the
// swap's own QuoterV2 quote (WHBAR smallest-units == tinybar, both 8 decimals,
// 1:1 wrap). Using the user's own route makes the conversion conservative:
// price impact raises the implied token cost of HBAR, never lowers it.
import type { Mirror } from "./mirror.js";

export type PricingConfig = {
  /** Multiplier over raw estimated cost (covers estimate error + revert reserve) */
  margin: number;
  /** Flat service fee in USD added to every sponsorship */
  flatUsd: number;
  /** Multiplier over EXPECTED gas when setting maxGasAllowance (not gasLimit) */
  allowanceHeadroom: number;
  /** Quote validity in seconds */
  quoteTtlSec: number;
  /** Hard fee floor in tinybar-equivalent — must exceed worst-case abort loss */
  feeFloorTinybar: bigint;
};

export type Quote = {
  gasPriceTinybarPerGas: bigint;
  estimatedCostTinybar: bigint;
  maxGasAllowanceTinybar: bigint;
  /** Immutable per-leg gas allowances; their sum equals maxGasAllowanceTinybar. */
  perLegGasAllowanceTinybar: bigint[];
  /** Conservative non-gas/HAPI reserve aligned with each execution leg. */
  perLegHapiReserveTinybar: bigint[];
  /** Conservative non-gas/HAPI reserve included in the paid exposure cap. */
  hapiReserveTinybar: bigint;
  /** Total prepaid sponsor exposure authorization (gas allowances + HAPI reserve). */
  maxSponsorExposureTinybar: bigint;
  /** Dynamic decomposition; sums exactly to the HBAR-equivalent fee. */
  feeComponentsTinybar: {
    gasAllowance: bigint;
    hapiReserve: bigint;
    failedAttemptReserve: bigint;
    operatingMargin: bigint;
  };
  hbarUsd: number;
  feeUsd: number;
  /** Fee in the fee token's smallest units */
  feeAmount: bigint;
  feeTokenId: string;
  feeTokenSymbol: string;
  marketEvidence: {
    observedAt: string;
    gasPriceTinybarPerGas: string;
    hbarUsd: number;
  };
  expiresAt: number;
};

const TINYBAR_PER_HBAR = 100_000_000n;
const WEIBAR_PER_TINYBAR = 10_000_000_000n;

export type MarketSnapshot = {
  gasPriceTinybarPerGas: bigint;
  hbarUsd: number;
  observedAt: string;
};

/** One timestamped gas/HBAR market read, reusable as the fixed snapshot across candidates. */
export async function fetchMarketSnapshot(mirror: Mirror): Promise<MarketSnapshot> {
  const [gasPriceTinybarPerGas, hbarUsd] = await Promise.all([
    mirror.gasPriceWei().then((gasPriceWei) =>
      gasPriceWei / WEIBAR_PER_TINYBAR + (gasPriceWei % WEIBAR_PER_TINYBAR > 0n ? 1n : 0n)),
    mirror.hbarUsd(),
  ]);
  return { gasPriceTinybarPerGas, hbarUsd, observedAt: new Date().toISOString() };
}

export async function priceSponsorship(params: {
  mirror: Mirror;
  cfg: PricingConfig;
  /** Sum of user gas limits across the bundle (upper bound we may sponsor) */
  totalGasLimit: bigint;
  /** Gas units we realistically expect to be consumed */
  expectedGasUnits: bigint;
  /** Per-leg expected gas, aligned with the immutable ordered bundle. */
  perLegExpectedGas?: bigint[];
  /** Absolute per-leg maxGasAllowance cap applied at quote time. */
  perTxAllowanceCapTinybar?: bigint;
  /** Conservative fixed/HAPI reserve recorded per attempted leg. */
  hapiReservePerLegTinybar?: bigint;
  /** Optional explicit reserve vector; overrides the uniform per-leg reserve. */
  perLegHapiReserveTinybar?: bigint[];
  /** The user's swap: amountIn of the input token... */
  amountIn: bigint;
  /** ...currently quoted to this many WHBAR units (== tinybar) */
  expectedOutTinybar: bigint;
  feeTokenId: string;
  feeTokenSymbol: string;
  market?: {
    gasPriceTinybarPerGas: bigint;
    hbarUsd: number;
    observedAt: string;
  };
}): Promise<Quote> {
  const { mirror, cfg } = params;
  const observedAt = params.market?.observedAt ?? new Date().toISOString();
  const [gasPriceTinybar, hbarUsd] = params.market
    ? [params.market.gasPriceTinybarPerGas, params.market.hbarUsd]
    : await Promise.all([
        mirror.gasPriceWei().then((gasPriceWei) =>
          gasPriceWei / WEIBAR_PER_TINYBAR + (gasPriceWei % WEIBAR_PER_TINYBAR > 0n ? 1n : 0n)),
        mirror.hbarUsd(),
      ]);

  const estimatedCostTinybar = params.expectedGasUnits * gasPriceTinybar;
  // The allowance tracks PRICED gas (headroom over the estimate), never the raw
  // gasLimit: HIP-410 makes it a hard ceiling on sponsor exposure, so a tight
  // allowance turns "sponsor gas paid <= fee collected" into an invariant.
  // The user's gasLimit sum still bounds it from above.
  const headroomBps = BigInt(Math.round(cfg.allowanceHeadroom * 10_000));
  const allowanceFromEstimate = (estimatedCostTinybar * headroomBps) / 10_000n;
  const allowanceCeiling = params.totalGasLimit * gasPriceTinybar;
  const aggregateAllowance =
    allowanceFromEstimate < allowanceCeiling ? allowanceFromEstimate : allowanceCeiling;
  const perLegExpected = params.perLegExpectedGas?.length
    ? params.perLegExpectedGas
    : [params.expectedGasUnits];
  const perTxCap = params.perTxAllowanceCapTinybar ?? aggregateAllowance;
  const perLegGasAllowanceTinybar: bigint[] = [];
  let remaining = aggregateAllowance;
  for (const [index, expected] of perLegExpected.entries()) {
    const raw = (expected * gasPriceTinybar * headroomBps) / 10_000n;
    const fairShare = index === perLegExpected.length - 1 ? remaining : raw;
    const bounded = fairShare < perTxCap ? fairShare : perTxCap;
    const allowance = bounded < remaining ? bounded : remaining;
    perLegGasAllowanceTinybar.push(allowance);
    remaining -= allowance;
  }
  // Any aggregate remainder is intentionally unspendable: submission uses only
  // the stored per-leg values, never a freshly recomputed gas price.
  const maxGasAllowanceTinybar = perLegGasAllowanceTinybar.reduce((a, b) => a + b, 0n);
  const perLegHapiReserveTinybar = params.perLegHapiReserveTinybar ??
    perLegExpected.map(() => params.hapiReservePerLegTinybar ?? 0n);
  if (perLegHapiReserveTinybar.length !== perLegExpected.length || perLegHapiReserveTinybar.some((value) => value < 0n)) {
    throw new Error("per-leg HAPI reserve vector must align with execution legs");
  }
  const hapiReserveTinybar = perLegHapiReserveTinybar.reduce((sum, value) => sum + value, 0n);
  const maxSponsorExposureTinybar = maxGasAllowanceTinybar + hapiReserveTinybar;

  // Flat USD component -> tinybar via the network exchange rate.
  const flatTinybar = BigInt(
    Math.ceil((cfg.flatUsd / hbarUsd) * Number(TINYBAR_PER_HBAR)),
  );
  const marginBps = BigInt(Math.round(cfg.margin * 10_000));
  let feeTinybar = (estimatedCostTinybar * marginBps) / 10_000n + flatTinybar;
  // Hard floor: the fee must dominate the sponsor's worst-case loss (allowance
  // actually spendable on a revert, plus the measured abort penalty).
  if (feeTinybar < cfg.feeFloorTinybar) feeTinybar = cfg.feeFloorTinybar;
  if (feeTinybar < maxSponsorExposureTinybar) feeTinybar = maxSponsorExposureTinybar;

  // tinybar -> fee token using the user's own quoted route (ceil division).
  const feeAmount =
    (feeTinybar * params.amountIn + params.expectedOutTinybar - 1n) / params.expectedOutTinybar;
  const failedAttemptReserve = cfg.feeFloorTinybar > maxSponsorExposureTinybar
    ? cfg.feeFloorTinybar - maxSponsorExposureTinybar
    : 0n;
  const operatingMargin = feeTinybar - maxSponsorExposureTinybar - failedAttemptReserve;

  const feeUsd = (Number(feeTinybar) / Number(TINYBAR_PER_HBAR)) * hbarUsd;

  return {
    gasPriceTinybarPerGas: gasPriceTinybar,
    estimatedCostTinybar,
    maxGasAllowanceTinybar,
    perLegGasAllowanceTinybar,
    perLegHapiReserveTinybar,
    hapiReserveTinybar,
    maxSponsorExposureTinybar,
    feeComponentsTinybar: {
      gasAllowance: maxGasAllowanceTinybar,
      hapiReserve: hapiReserveTinybar,
      failedAttemptReserve,
      operatingMargin,
    },
    hbarUsd,
    feeUsd,
    feeAmount,
    feeTokenId: params.feeTokenId,
    feeTokenSymbol: params.feeTokenSymbol,
    marketEvidence: {
      observedAt,
      gasPriceTinybarPerGas: gasPriceTinybar.toString(),
      hbarUsd,
    },
    expiresAt: Math.floor(Date.now() / 1000) + cfg.quoteTtlSec,
  };
}
