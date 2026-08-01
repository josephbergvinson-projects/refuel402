import { decodeFunctionResult, encodeFunctionData, type Address } from "viem";
import { erc20Abi } from "./abi.js";
import {
  NETWORKS,
  pricingConfig,
  SPONSOR,
  tokenRoute,
  type NetworkConfig,
  type NetworkName,
} from "./config.js";
import type { Mirror } from "./mirror.js";
import { priceSponsorship } from "./pricing.js";
import type { SupportedToken } from "./types.js";
import {
  buildApproveCalldata,
  buildExactOutputFuelCalldata,
  encodeExactOutputPath,
} from "../../client/src/txbuilder.js";

const TINYBAR_PER_HBAR = 100_000_000n;
const HTS_OP_GAS = 785_000n;
const SWAP_HTS_OVERHEAD = 550_000n;

export type RefuelAccountState = "nonexistent" | "hollow" | "complete_zero_hbar" | "complete_funded";

export type RefuelPlanLimits = {
  recommendedHbarTinybar: bigint;
  maxHbarTinybar: bigint;
  minimumRetainedBps: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxRequestExposureTinybar: bigint;
  sponsorMinReserveTinybar: bigint;
  dailySponsorCapTinybar: bigint;
};

export function refuelPlanLimits(): RefuelPlanLimits {
  return {
    recommendedHbarTinybar: BigInt(process.env.RECOMMENDED_REFUEL_TINYBAR ?? 1_000_000_000),
    maxHbarTinybar: BigInt(process.env.MAX_REFUEL_TINYBAR ?? 5_000_000_000),
    minimumRetainedBps: Number(process.env.MIN_RETAINED_TOKEN_BPS ?? 500),
    maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 300),
    maxPriceImpactBps: Number(process.env.MAX_PRICE_IMPACT_BPS ?? 150),
    maxRequestExposureTinybar: SPONSOR.perRequestExposureCapTinybar,
    sponsorMinReserveTinybar: BigInt(process.env.SPONSOR_MIN_RESERVE_TINYBAR ?? 500_000_000),
    dailySponsorCapTinybar: BigInt(process.env.DAILY_SPONSOR_CAP_TINYBAR ?? 10_000_000_000),
  };
}

export type RefuelPlanRequest = {
  network: NetworkName;
  account: Address;
  token: SupportedToken;
  desiredHbarTinybar: bigint;
  minimumRetainedToken?: bigint;
  slippageBps?: number;
  nowSec?: number;
  sponsorAccountId?: string;
  dailyCommittedTinybar?: bigint;
  allowHollowExperiment?: boolean;
};

export type RefuelTransactionIntent = {
  kind: "approve" | "swap";
  readable: string;
  transaction: {
    from: Address;
    to: Address;
    chainId: number;
    nonce: number;
    gas: `0x${string}`;
    maxFeePerGas: "0x0";
    maxPriorityFeePerGas: "0x0";
    value: "0x0";
    data: `0x${string}`;
    type: "0x2";
  };
};

function hexQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function accountState(account: Awaited<ReturnType<Mirror["account"]>>): RefuelAccountState {
  if (!account) return "nonexistent";
  if (!account.key) return "hollow";
  return BigInt(account.balance.balance) === 0n ? "complete_zero_hbar" : "complete_funded";
}

export async function createRefuelPlan(
  mirror: Mirror,
  request: RefuelPlanRequest,
  limits: RefuelPlanLimits = refuelPlanLimits(),
) {
  const network: NetworkConfig = NETWORKS[request.network];
  const slippageBps = request.slippageBps ?? 100;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > limits.maxSlippageBps) {
    throw new Error(`slippageBps must be an integer from 0 to ${limits.maxSlippageBps}`);
  }
  if (request.desiredHbarTinybar <= 0n || request.desiredHbarTinybar > limits.maxHbarTinybar) {
    throw new Error(`desired HBAR must be above 0 and at most ${limits.maxHbarTinybar} tinybar`);
  }
  const tokenOutputCapTinybar = request.token.maxFuelHbar === undefined
    ? limits.maxHbarTinybar
    : BigInt(Math.floor(request.token.maxFuelHbar * Number(TINYBAR_PER_HBAR)));
  if (request.desiredHbarTinybar > tokenOutputCapTinybar) {
    throw new Error(`desired HBAR exceeds the token liquidity ceiling of ${tokenOutputCapTinybar} tinybar`);
  }

  const account = await mirror.account(request.account);
  const state = accountState(account);
  if (!account) {
    return {
      ok: false,
      accountState: state,
      code: "ASSETS_NOT_ARRIVED",
      message: "Receive HBAR or a supported HTS token at this EVM alias before refueling.",
      network: network.name,
      chainId: network.chainId,
    };
  }

  const tokenBalance = BigInt(
    account.balance.tokens.find((entry) => entry.token_id === request.token.tokenId)?.balance ?? 0,
  );
  const associated = tokenBalance > 0n || (await mirror.isAssociated(request.account, request.token.tokenId)) === true;
  if (!associated || tokenBalance === 0n) {
    return {
      ok: false,
      accountState: state,
      code: "TOKEN_NOT_ARRIVED",
      message: `${request.token.symbol} is not held by this account. Arrival must happen before quote/payment.`,
      network: network.name,
      chainId: network.chainId,
    };
  }
  if (!account.key && !request.allowHollowExperiment) {
    return {
      ok: false,
      accountState: state,
      code: "HOLLOW_ACCOUNT_KILL_GATE_REQUIRED",
      message: "This alias is hollow. It is excluded from ordinary execution until the separate completion proof passes.",
      network: network.name,
      chainId: network.chainId,
      associated,
      tokenBalance: tokenBalance.toString(),
    };
  }
  if (account.key && account.key._type !== "ECDSA_SECP256K1") {
    return {
      ok: false,
      accountState: state,
      code: "ECDSA_ACCOUNT_REQUIRED",
      message: "Sponsored raw Hedera EVM transactions require a complete ECDSA account.",
      network: network.name,
      chainId: network.chainId,
    };
  }

  const route = tokenRoute(request.token, network.whbarToken);
  const forwardTokens = [request.token.evmAddress, ...route.map((hop) => hop.toToken)];
  const forwardFees = route.map((hop) => hop.fee);
  const reversePath = encodeExactOutputPath(forwardTokens, forwardFees);
  const exact = await mirror.quoteExactOutput(network.quoter, reversePath, request.desiredHbarTinybar);
  const referenceOut = request.desiredHbarTinybar > 10n ? request.desiredHbarTinybar / 10n : request.desiredHbarTinybar;
  const reference = referenceOut === request.desiredHbarTinybar
    ? exact
    : await mirror.quoteExactOutput(network.quoter, reversePath, referenceOut);
  const linearInput = reference.amountIn * request.desiredHbarTinybar / referenceOut;
  const priceImpactBps = exact.amountIn > linearInput && linearInput > 0n
    ? Number((exact.amountIn - linearInput) * 10_000n / linearInput)
    : 0;
  if (priceImpactBps > limits.maxPriceImpactBps) {
    return {
      ok: false,
      accountState: state,
      code: "PRICE_IMPACT_CAP_EXCEEDED",
      message: `Live route impact ${priceImpactBps}bps exceeds the ${limits.maxPriceImpactBps}bps cap.`,
      network: network.name,
      chainId: network.chainId,
    };
  }
  const amountInMaximum = (exact.amountIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  if (amountInMaximum > request.token.maxAmountIn) {
    return {
      ok: false,
      accountState: state,
      code: "TOKEN_VALUE_CAP_EXCEEDED",
      message: `Safe maximum ${amountInMaximum} exceeds the vetted ${request.token.symbol} cap ${request.token.maxAmountIn}.`,
      network: network.name,
      chainId: network.chainId,
    };
  }

  const allowanceData = await mirror.ethCall(
    request.token.evmAddress,
    encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [request.account, network.router] }),
  );
  const allowance = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceData }) as bigint;
  const approvalRequired = allowance < amountInMaximum;
  const perLegExpectedGas = approvalRequired
    ? [HTS_OP_GAS, exact.gasEstimate + SWAP_HTS_OVERHEAD]
    : [exact.gasEstimate + SWAP_HTS_OVERHEAD];
  const totalGasLimit = approvalRequired ? 2_500_000n : 1_500_000n;
  const quote = await priceSponsorship({
    mirror,
    cfg: pricingConfig(),
    totalGasLimit,
    expectedGasUnits: perLegExpectedGas.reduce((sum, gas) => sum + gas, 0n),
    perLegExpectedGas,
    perTxAllowanceCapTinybar: SPONSOR.perTxAllowanceCapTinybar,
    hapiReservePerLegTinybar: SPONSOR.hapiReservePerLegTinybar,
    amountIn: exact.amountIn,
    expectedOutTinybar: request.desiredHbarTinybar,
    feeTokenId: request.token.tokenId,
    feeTokenSymbol: request.token.symbol,
  });

  const defaultRetained = (tokenBalance * BigInt(limits.minimumRetainedBps)) / 10_000n;
  const minimumRetainedToken = request.minimumRetainedToken ?? defaultRetained;
  const spendable = tokenBalance > minimumRetainedToken ? tokenBalance - minimumRetainedToken : 0n;
  const totalTokenMaximum = amountInMaximum + quote.feeAmount;
  const balanceSafe = totalTokenMaximum <= spendable;
  const requestCapSafe = quote.maxSponsorExposureTinybar <= limits.maxRequestExposureTinybar;
  const dailyCommitted = request.dailyCommittedTinybar ?? 0n;
  const dailyCapSafe = dailyCommitted + quote.maxSponsorExposureTinybar <= limits.dailySponsorCapTinybar;

  let sponsorBalanceTinybar: bigint | null = null;
  if (request.sponsorAccountId) {
    sponsorBalanceTinybar = BigInt((await mirror.account(request.sponsorAccountId))?.balance.balance ?? 0);
  }
  const sponsorReserveSafe = sponsorBalanceTinybar === null
    ? false
    : sponsorBalanceTinybar >= limits.sponsorMinReserveTinybar + quote.maxSponsorExposureTinybar;

  const now = request.nowSec ?? Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 600);
  let nonce = account.ethereum_nonce ?? 0;
  const intents: RefuelTransactionIntent[] = [];
  if (approvalRequired) {
    intents.push({
      kind: "approve",
      readable: `Allow SaucerSwap Router to spend at most ${amountInMaximum} ${request.token.symbol} base units for this quote.`,
      transaction: {
        from: request.account,
        to: request.token.evmAddress,
        chainId: network.chainId,
        nonce: nonce++,
        gas: hexQuantity(1_000_000n),
        maxFeePerGas: "0x0",
        maxPriorityFeePerGas: "0x0",
        value: "0x0",
        data: buildApproveCalldata(network.router, amountInMaximum),
        type: "0x2",
      },
    });
  }
  intents.push({
    kind: "swap",
    readable: `Spend at most ${amountInMaximum} ${request.token.symbol} base units for exactly ${request.desiredHbarTinybar} tinybar, then unwrap WHBAR to ${request.account}.`,
    transaction: {
      from: request.account,
      to: network.router,
      chainId: network.chainId,
      nonce,
      gas: hexQuantity(1_500_000n),
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
      value: "0x0",
      data: buildExactOutputFuelCalldata({
        ctx: { chainId: network.chainId, router: network.router, whbar: network.whbarToken, maxFeePerGas: 0n },
        inputToken: request.token.evmAddress,
        poolFee: request.token.poolFee,
        route: request.token.route,
        amountOut: request.desiredHbarTinybar,
        amountInMaximum,
        deadline,
        recipient: request.account,
      }),
      type: "0x2",
    },
  });

  const hbarAlreadyAdequate = BigInt(account.balance.balance) >= request.desiredHbarTinybar;
  const blockers = [
    ...(!balanceSafe ? ["VALUE_BOUND_EXCEEDED"] : []),
    ...(!requestCapSafe ? ["REQUEST_SPONSOR_CAP"] : []),
    ...(!dailyCapSafe ? ["DAILY_SPONSOR_CAP"] : []),
    ...(!sponsorReserveSafe ? ["SPONSOR_RESERVE_UNVERIFIED_OR_LOW"] : []),
    ...(hbarAlreadyAdequate ? ["SPONSORSHIP_OPTIONAL_ACCOUNT_ALREADY_FUNDED"] : []),
  ];

  return {
    ok: balanceSafe && requestCapSafe && dailyCapSafe,
    executable: balanceSafe && requestCapSafe && dailyCapSafe && sponsorReserveSafe && !hbarAlreadyAdequate,
    accountState: state,
    account: account.account,
    evmAddress: request.account,
    network: network.name,
    chainId: network.chainId,
    token: {
      symbol: request.token.symbol,
      tokenId: request.token.tokenId,
      decimals: request.token.decimals,
      representation: "HTS",
      balance: tokenBalance.toString(),
      associated,
      allowance: allowance.toString(),
    },
    desiredHbarTinybar: request.desiredHbarTinybar.toString(),
    recommendedHbarTinybar: limits.recommendedHbarTinybar.toString(),
    maxHbarTinybar: limits.maxHbarTinybar.toString(),
    route: {
      mode: "exactOutput",
      tokens: forwardTokens,
      fees: forwardFees,
      quotedTokenIn: exact.amountIn.toString(),
      amountInMaximum: amountInMaximum.toString(),
      slippageBps,
      priceImpactBps,
      maxPriceImpactBps: limits.maxPriceImpactBps,
      whitelistImpactBps: request.token.impactBps ?? null,
      tokenOutputCapTinybar: tokenOutputCapTinybar.toString(),
      gasEstimate: exact.gasEstimate.toString(),
      estimateSources: { swap: "live_quoter_v2", approval: approvalRequired ? "measured_hts_upper_bound" : "not_required" },
      deadline: deadline.toString(),
    },
    requirements: {
      association: "satisfied_by_held_hts",
      approval: approvalRequired ? "required" : "satisfied",
      swap: "exact_output_token_to_whbar_then_unwrap",
      x402PaymentAsset: request.token.tokenId,
    },
    fee: {
      tokenId: quote.feeTokenId,
      tokenSymbol: quote.feeTokenSymbol,
      tokenAmount: quote.feeAmount.toString(),
      estimatedGasTinybar: quote.estimatedCostTinybar.toString(),
      perLegGasAllowanceTinybar: quote.perLegGasAllowanceTinybar.map(String),
      hapiReserveTinybar: quote.hapiReserveTinybar.toString(),
      maxSponsorExposureTinybar: quote.maxSponsorExposureTinybar.toString(),
      componentsTinybar: Object.fromEntries(
        Object.entries(quote.feeComponentsTinybar).map(([key, value]) => [key, value.toString()]),
      ),
      expiresAt: quote.expiresAt,
    },
    safety: {
      minimumRetainedToken: minimumRetainedToken.toString(),
      spendableToken: spendable.toString(),
      swapTokenMaximum: amountInMaximum.toString(),
      x402FeeToken: quote.feeAmount.toString(),
      totalTokenMaximum: totalTokenMaximum.toString(),
      balanceSafe,
      requestExposureTinybar: quote.maxSponsorExposureTinybar.toString(),
      maxRequestExposureTinybar: limits.maxRequestExposureTinybar.toString(),
      requestCapSafe,
      sponsorBalanceTinybar: sponsorBalanceTinybar?.toString() ?? null,
      sponsorMinReserveTinybar: limits.sponsorMinReserveTinybar.toString(),
      sponsorReserveSafe,
      dailyCommittedTinybar: dailyCommitted.toString(),
      dailySponsorCapTinybar: limits.dailySponsorCapTinybar.toString(),
      dailyCapSafe,
      concurrentReservationModel: "active maximum sponsor exposure reservations are included in exposureSince before submission",
    },
    transactionIntents: intents,
    blockers,
    paymentCapability: {
      legacyTechnicalApi: true,
      mechanism: "hedera-native-x402-hts",
      stockMetaMaskProductCompatible: false,
      productPath: "/v1/product/quote",
      note: "The core product uses standard EVM exact/Permit2 plus the policy RPC; this plan response is destination-only compatibility output.",
    },
  };
}

export function parseDecimalUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("amount must be a positive decimal string");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`amount supports at most ${decimals} decimals`);
  return BigInt(whole ?? "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
}

export function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = (tinybar % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
