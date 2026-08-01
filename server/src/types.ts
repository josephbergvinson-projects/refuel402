import type { Address, Hex } from "viem";

/** One hop of a vetted swap route: swap into `toToken` through the `fee` pool. */
export type RouteHop = { toToken: Address; fee: number };

export type SupportedToken = {
  /** Hedera token id, e.g. "0.0.5449" */
  tokenId: string;
  /** EVM facade address of the HTS token */
  evmAddress: Address;
  symbol: string;
  decimals: number;
  /** Max input amount we will sponsor a swap for, in smallest units */
  maxAmountIn: bigint;
  /** Whitelist-time route impact at the configured maximum fuel size. */
  impactBps?: number;
  /** Per-token exact HBAR output ceiling from liquidity vetting. */
  maxFuelHbar?: number;
  /** The single vetted WHBAR pool fee tier for this token (direct-route back-compat) */
  poolFee: number;
  /**
   * The vetted route from this token to WHBAR. Direct tokens have one hop
   * (`[{toToken: WHBAR, fee: poolFee}]`); multi-hop tokens route through a deep
   * hub (`[{toToken: USDC, feeA}, {toToken: WHBAR, feeB}]`). The policy requires
   * the swap's path to EQUAL this route, so intermediates are never
   * attacker-chosen. If absent, the direct WHBAR route is assumed.
   */
  route?: RouteHop[];
  /** Bridge this asset arrived through, if any (axelar | layerzero | hashport) */
  bridge?: string;
};

export type PolicyConfig = {
  chainId: number;
  /** SaucerSwap V2 SwapRouter EVM address */
  router: Address;
  /** WHBAR token EVM address (swap output must terminate here) */
  whbar: Address;
  /** Tokens accepted as swap input (and x402 fee assets) */
  tokens: SupportedToken[];
  /** Upper bound on the swap leg's inner tx gasLimit we will sponsor */
  maxGasLimit: bigint;
  /** Upper bound on an associate leg's gasLimit (~785k measured; cap ~1.0M) */
  associateGasLimit: bigint;
  /** Upper bound on an approve leg's gasLimit (~785k measured; cap ~1.0M) */
  approveGasLimit: bigint;
  /** Max seconds into the future a swap deadline may be */
  maxDeadlineSkewSec: number;
  /** Min seconds of deadline runway (x402 payment window + submission slack) */
  minDeadlineBufferSec: number;
  /** The pre-vetted route (hops to WHBAR) for a token — the swap path must equal it */
  routeFor: (token: SupportedToken) => RouteHop[];
};

export type DecodedCall =
  | { kind: "associate"; token: Address }
  | { kind: "approve"; token: Address; spender: Address; amount: bigint }
  | {
      kind: "exactInput";
      pathTokens: Address[];
      pathFees: number[];
      recipient: Address;
      deadline: bigint;
      amountIn: bigint;
      amountOutMinimum: bigint;
    }
  | {
      kind: "exactInputSingle";
      tokenIn: Address;
      tokenOut: Address;
      fee: number;
      recipient: Address;
      deadline: bigint;
      amountIn: bigint;
      amountOutMinimum: bigint;
      sqrtPriceLimitX96: bigint;
    }
  | {
      kind: "exactOutput";
      /** Exact-output paths are encoded output -> input by the V3 router. */
      pathTokens: Address[];
      pathFees: number[];
      recipient: Address;
      deadline: bigint;
      amountOut: bigint;
      amountInMaximum: bigint;
    }
  | { kind: "unwrap"; fn: string; amountMinimum: bigint; recipient: Address }
  | { kind: "refund"; fn: string }
  | { kind: "multicall"; calls: DecodedCall[] };

export type DecodedTx = {
  raw: Hex;
  hash: Hex;
  from: Address;
  to: Address;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  value: bigint;
  chainId: number;
  type: string;
  call: DecodedCall;
};

export type PolicyViolation = { code: string; message: string };

export type PolicyVerdict = {
  ok: boolean;
  violations: PolicyViolation[];
  decoded: DecodedTx[];
  /** Summary of what the bundle does, for quotes/receipts */
  summary: BundleSummary | null;
};

export type LegKind = "associate" | "approve" | "swap";

export type LegInfo = {
  kind: LegKind;
  /** The HTS token this leg targets (associate target, approve token, or swap input) */
  token: SupportedToken | null;
  /** Amount bound to the leg (approve amount, or swap amountIn); 0n for associate */
  amount: bigint;
  gasLimit: bigint;
  nonce: number;
};

/**
 * A sponsorable bundle: an ordered subset of [associate, approve, swap], same
 * signer, sequential nonces. Swap-centric fields are populated only when a swap
 * leg is present; standalone associate/approve bundles leave them null/zero.
 */
export type BundleSummary = {
  sender: Address;
  nonces: number[];
  totalGasLimit: bigint;
  legs: LegInfo[];
  kinds: LegKind[];
  hasSwap: boolean;
  /** Corrected product path is exactOutput; exactInput remains decode-compatible only. */
  swapMode: "exactOutput" | "exactInput" | null;
  /** Swap input token (fee is charged in this token when a swap is present) */
  swapInputToken: SupportedToken | null;
  /** Swap amountIn, or 0n for swap-less bundles */
  amountIn: bigint;
  /** Native-HBAR floor the user demanded (unwrap minimum), or 0n */
  amountOutMinimum: bigint;
  /** The swap call's own amountOutMinimum in WHBAR units, or 0n */
  quotedMinOut: bigint;
  /** Token the associate leg targets, if any */
  associateToken: SupportedToken | null;
  /** Approve leg, if any */
  approve: { token: SupportedToken; amount: bigint } | null;

  // --- Back-compat alias: existing swap-path code reads `inputToken`. It is the
  // swap input token when a swap is present, else null. New code should prefer
  // swapInputToken / hasSwap.
  inputToken: SupportedToken | null;
};
