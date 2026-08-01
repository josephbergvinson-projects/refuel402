import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RefuelPriceProtectionPreset = "flexible" | "balanced" | "strict" | "custom";

type RefuelPriceProtectionConfig = {
  schema: "refuel402.refuel-price-protection-config.v1";
  baseBufferBps: number;
  volatilityBpsPerMinute: number;
  minBufferBps: number;
  maxBufferBps: number;
  strictBufferBps: number;
  customWarningBelowBps: number;
  authorizationTtlSeconds: number;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REFUEL_PRICE_PROTECTION = JSON.parse(
  fs.readFileSync(path.join(root, "config", "refuel-price-protection.json"), "utf8"),
) as RefuelPriceProtectionConfig;

/**
 * A cap the owner typed that cannot work, as opposed to a service that is down.
 * These used to be plain Errors, so they fell through every typed handler in the
 * quote route into the catch-all 503 "combined quote is temporarily unavailable,
 * retriable: true" — telling the owner to wait out an outage that did not exist
 * while their own input was the thing that needed changing.
 */
export class RefuelCapError extends Error {
  constructor(
    readonly code: "REFUEL_CAP_BELOW_SERVICE_FEE" | "REFUEL_CAP_BELOW_TODAY_PRICE" | "REFUEL_CAP_INPUTS_INVALID",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RefuelCapError";
  }
}

/** Base units → a readable decimal, so an error can name the number to type. */
function displayUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error("refuel protection value must be finite");
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function flexibleRefuelBufferBps(providerEtaSeconds: number | null | undefined): {
  bufferBps: number;
  etaMinutes: number | null;
  etaSource: "provider" | "conservative_unknown";
} {
  const cfg = REFUEL_PRICE_PROTECTION;
  if (providerEtaSeconds === null || providerEtaSeconds === undefined || !Number.isFinite(providerEtaSeconds) || providerEtaSeconds <= 0) {
    return { bufferBps: cfg.maxBufferBps, etaMinutes: null, etaSource: "conservative_unknown" };
  }
  const etaMinutes = Math.max(1, Math.ceil(providerEtaSeconds / 60));
  return {
    bufferBps: boundedInteger(
      cfg.baseBufferBps + cfg.volatilityBpsPerMinute * etaMinutes,
      cfg.minBufferBps,
      cfg.maxBufferBps,
    ),
    etaMinutes,
    etaSource: "provider",
  };
}

export function refuelPresetBufferBps(input: {
  preset: RefuelPriceProtectionPreset;
  providerEtaSeconds?: number | null;
  customBufferBps?: number | null;
}) {
  const flexible = flexibleRefuelBufferBps(input.providerEtaSeconds);
  const cfg = REFUEL_PRICE_PROTECTION;
  switch (input.preset) {
    case "flexible":
      return flexible;
    case "balanced":
      return {
        ...flexible,
        bufferBps: boundedInteger(Math.ceil(flexible.bufferBps / 2), cfg.strictBufferBps, cfg.maxBufferBps),
      };
    case "strict":
      return { ...flexible, bufferBps: cfg.strictBufferBps };
    case "custom":
      if (input.customBufferBps === null || input.customBufferBps === undefined) {
        throw new Error("custom refuel protection requires an exact buffer");
      }
      return {
        ...flexible,
        bufferBps: boundedInteger(input.customBufferBps, 0, cfg.maxBufferBps),
      };
  }
}

function ceilMulBps(value: bigint, bufferBps: number): bigint {
  return (value * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
}

export function buildRefuelCap(input: {
  preset: RefuelPriceProtectionPreset;
  providerEtaSeconds?: number | null;
  customBufferBps?: number | null;
  customMaxAmountIn?: bigint | null;
  serviceFeeAmount: bigint;
  swapInputExpected: bigint;
  tokenPriceUsd?: number | null;
  tokenDecimals: number;
}) {
  if (input.serviceFeeAmount < 0n || input.swapInputExpected <= 0n) {
    throw new RefuelCapError("REFUEL_CAP_INPUTS_INVALID", "refuel cap inputs are invalid");
  }
  const flexible = flexibleRefuelBufferBps(input.providerEtaSeconds);
  const selected = input.preset === "custom" && input.customMaxAmountIn !== null && input.customMaxAmountIn !== undefined
    ? flexible
    : refuelPresetBufferBps(input);
  const todayAmountIn = input.serviceFeeAmount + input.swapInputExpected;
  const custom = input.preset === "custom" && input.customMaxAmountIn !== null && input.customMaxAmountIn !== undefined;
  // Both refusals name the number to type. A cap at or under the service fee
  // cannot even pay the fee; a cap under today's total buys nothing at a price
  // that already exists, so it would sit for the full two hours and expire by
  // construction — a silent guaranteed no-refuel, which is the one outcome this
  // product exists to avoid.
  if (custom && input.customMaxAmountIn! <= input.serviceFeeAmount) {
    throw new RefuelCapError(
      "REFUEL_CAP_BELOW_SERVICE_FEE",
      `Your maximum must be more than the ${displayUnits(input.serviceFeeAmount, input.tokenDecimals)} service fee. Raise it to at least ${displayUnits(todayAmountIn, input.tokenDecimals)} to cover today's price.`,
      {
        serviceFeeAmount: input.serviceFeeAmount.toString(),
        todayAmountIn: todayAmountIn.toString(),
        minimumMaxAmountIn: todayAmountIn.toString(),
        tokenDecimals: input.tokenDecimals,
      },
    );
  }
  if (custom && input.customMaxAmountIn! < todayAmountIn) {
    throw new RefuelCapError(
      "REFUEL_CAP_BELOW_TODAY_PRICE",
      `Your maximum of ${displayUnits(input.customMaxAmountIn!, input.tokenDecimals)} is below today's price of ${displayUnits(todayAmountIn, input.tokenDecimals)}, so the refuel could never run and nothing would be spent. Raise it to at least ${displayUnits(todayAmountIn, input.tokenDecimals)}.`,
      {
        serviceFeeAmount: input.serviceFeeAmount.toString(),
        todayAmountIn: todayAmountIn.toString(),
        minimumMaxAmountIn: todayAmountIn.toString(),
        tokenDecimals: input.tokenDecimals,
      },
    );
  }
  const maxAmountIn = custom
    ? input.customMaxAmountIn!
    : input.serviceFeeAmount + ceilMulBps(input.swapInputExpected, selected.bufferBps);
  const swapInputCap = maxAmountIn - input.serviceFeeAmount;
  const bufferBps = custom
    ? Number((swapInputCap - input.swapInputExpected) * 10_000n / input.swapInputExpected)
    : selected.bufferBps;
  const presetOptions = (["flexible", "balanced", "strict"] as const).map((preset) => {
    const option = refuelPresetBufferBps({ preset, providerEtaSeconds: input.providerEtaSeconds });
    const optionMax = input.serviceFeeAmount + ceilMulBps(input.swapInputExpected, option.bufferBps);
    return { preset, bufferBps: option.bufferBps, maxAmountIn: optionMax.toString() };
  });
  const usd = (amount: bigint) => input.tokenPriceUsd && input.tokenPriceUsd > 0
    ? Number(amount) / (10 ** input.tokenDecimals) * input.tokenPriceUsd
    : null;
  return {
    schema: "refuel402.refuel-cap.v1",
    preset: input.preset,
    bufferBps,
    etaMinutes: flexible.etaMinutes,
    etaSource: flexible.etaSource,
    todayAmountIn: todayAmountIn.toString(),
    maxAmountIn: maxAmountIn.toString(),
    swapInputExpected: input.swapInputExpected.toString(),
    swapInputCap: swapInputCap.toString(),
    serviceFeeAmount: input.serviceFeeAmount.toString(),
    todayUsd: usd(todayAmountIn),
    capUsd: usd(maxAmountIn),
    authorizationTtlSeconds: REFUEL_PRICE_PROTECTION.authorizationTtlSeconds,
    warningBelowBps: REFUEL_PRICE_PROTECTION.customWarningBelowBps,
    presetOptions,
  };
}
