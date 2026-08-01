// The policy engine is the non-custody boundary of Refuel402.
// It decodes raw user-signed EVM transactions and decides whether the sponsor
// is willing to pay Hedera gas for them. Nothing here mutates state.
//
// A sponsorable bundle is an ordered subset of three op kinds, same signer,
// sequential nonces, at most one of each, in this order:
//   associate  IHRC719(token).associate()            — bare 0x0a754de6 selector
//   approve    ERC20(token).approve(router, amount)  — allowlisted token
//   swap       router.multicall([ exactOutput(vetted reverse path -> input,
//              recipient=router), unwrapWHBAR(exact output, recipient=signer) ])
// Legacy exactInput shapes remain decode-compatible, but the product planner,
// live acceptance path and public UI emit exactOutput only.
// Standalone [associate], [approve], and the full [associate, approve, swap]
// are all valid. EIP-1559 only, chainId pinned, value 0, low-s signatures.
import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  getAddress,
  isAddressEqual,
  size,
  slice,
  hexToNumber,
  hexToBigInt,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, routerAbi, ASSOCIATE_SELECTOR } from "./abi.js";
import type {
  BundleSummary,
  DecodedCall,
  DecodedTx,
  LegInfo,
  LegKind,
  PolicyConfig,
  PolicyVerdict,
  PolicyViolation,
  SupportedToken,
} from "./types.js";

/** secp256k1 group order / 2 — signatures above this are malleable duplicates. */
const SECP256K1_HALF_N = hexToBigInt(
  "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
);

/** Uniswap-style ADDRESS_THIS sentinel meaning "the router itself". */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

export function decodePath(path: Hex): { tokens: Address[]; fees: number[] } {
  const len = size(path);
  if (len < 43 || (len - 20) % 23 !== 0) {
    throw new Error(`malformed swap path (length ${len})`);
  }
  const tokens: Address[] = [];
  const fees: number[] = [];
  let offset = 0;
  tokens.push(getAddress(slice(path, offset, offset + 20)));
  offset += 20;
  while (offset < len) {
    fees.push(hexToNumber(slice(path, offset, offset + 3)));
    offset += 3;
    tokens.push(getAddress(slice(path, offset, offset + 20)));
    offset += 20;
  }
  return { tokens, fees };
}

function decodeCall(data: Hex, depth = 0): DecodedCall {
  // IHRC719 associate() — the bare 4-byte selector with no arguments.
  if (size(data) === 4 && data.toLowerCase() === ASSOCIATE_SELECTOR) {
    return { kind: "associate", token: "0x" as Address };
  }
  try {
    const erc = decodeFunctionData({ abi: erc20Abi, data });
    if (erc.functionName === "approve") {
      const [spender, amount] = erc.args as readonly [Address, bigint];
      return { kind: "approve", token: "0x" as Address, spender, amount };
    }
  } catch {
    // fall through to router ABI
  }
  const dec = decodeFunctionData({ abi: routerAbi, data });
  switch (dec.functionName) {
    case "exactInput": {
      const [p] = dec.args as readonly [
        { path: Hex; recipient: Address; deadline: bigint; amountIn: bigint; amountOutMinimum: bigint },
      ];
      const { tokens, fees } = decodePath(p.path);
      return {
        kind: "exactInput",
        pathTokens: tokens,
        pathFees: fees,
        recipient: p.recipient,
        deadline: p.deadline,
        amountIn: p.amountIn,
        amountOutMinimum: p.amountOutMinimum,
      };
    }
    case "exactInputSingle": {
      const [p] = dec.args as readonly [
        {
          tokenIn: Address; tokenOut: Address; fee: number; recipient: Address;
          deadline: bigint; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint;
        },
      ];
      return {
        kind: "exactInputSingle",
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        fee: p.fee,
        recipient: p.recipient,
        deadline: p.deadline,
        amountIn: p.amountIn,
        amountOutMinimum: p.amountOutMinimum,
        sqrtPriceLimitX96: p.sqrtPriceLimitX96,
      };
    }
    case "exactOutput": {
      const [p] = dec.args as readonly [
        { path: Hex; recipient: Address; deadline: bigint; amountOut: bigint; amountInMaximum: bigint },
      ];
      const { tokens, fees } = decodePath(p.path);
      return {
        kind: "exactOutput",
        pathTokens: tokens,
        pathFees: fees,
        recipient: p.recipient,
        deadline: p.deadline,
        amountOut: p.amountOut,
        amountInMaximum: p.amountInMaximum,
      };
    }
    case "unwrapWHBAR":
    case "unwrapWETH9": {
      const [amountMinimum, recipient] = dec.args as readonly [bigint, Address];
      return { kind: "unwrap", fn: dec.functionName, amountMinimum, recipient };
    }
    case "refundETH":
    case "refundHBAR":
      return { kind: "refund", fn: dec.functionName };
    case "multicall": {
      if (depth > 0) throw new Error("nested multicall is not sponsorable");
      const [calls] = dec.args as readonly [readonly Hex[]];
      return { kind: "multicall", calls: calls.map((c) => decodeCall(c, depth + 1)) };
    }
    default:
      throw new Error(`function ${dec.functionName} is not sponsorable`);
  }
}

export async function decodeRawTx(raw: Hex): Promise<DecodedTx> {
  const parsed = parseTransaction(raw);
  if (!parsed.to) throw new Error("contract-creation transactions are not sponsorable");
  if (parsed.s !== undefined && hexToBigInt(parsed.s) > SECP256K1_HALF_N) {
    throw new Error("high-s signature rejected (malleable encoding)");
  }
  const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  const call = decodeCall(parsed.data ?? "0x");
  if (call.kind === "approve" || call.kind === "associate") {
    call.token = getAddress(parsed.to);
  }
  return {
    raw,
    hash: keccak256(raw),
    from: getAddress(from),
    to: getAddress(parsed.to),
    nonce: parsed.nonce ?? -1,
    gasLimit: parsed.gas ?? 0n,
    maxFeePerGas: parsed.maxFeePerGas ?? null,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? null,
    gasPrice: parsed.gasPrice ?? null,
    value: parsed.value ?? 0n,
    chainId: parsed.chainId ?? -1,
    type: parsed.type ?? "unknown",
    call,
  };
}

function findToken(cfg: PolicyConfig, addr: Address): SupportedToken | undefined {
  return cfg.tokens.find((t) => isAddressEqual(t.evmAddress, addr));
}

/** Which of the three op kinds is this decoded tx? null if not sponsorable. */
function legKindOf(call: DecodedCall): LegKind | null {
  if (call.kind === "associate") return "associate";
  if (call.kind === "approve") return "approve";
  if (call.kind === "multicall" || call.kind === "exactInput" || call.kind === "exactInputSingle")
    return "swap";
  return null;
}

type SwapDetails = {
  inputToken: SupportedToken;
  swapMode: "exactOutput" | "exactInput";
  amountIn: bigint;
  amountOutMinimum: bigint; // native-HBAR floor (unwrap minimum)
  quotedMinOut: bigint; // swap call amountOutMinimum (WHBAR units)
};

/** Validate the swap leg (multicall shape) — preserves all legacy violation codes. */
function validateSwapLeg(
  cfg: PolicyConfig,
  swapTx: DecodedTx,
  now: bigint,
  violations: PolicyViolation[],
): SwapDetails | null {
  if (!isAddressEqual(swapTx.to, cfg.router)) {
    violations.push({ code: "NOT_ROUTER", message: `swap transaction target ${swapTx.to} is not the SaucerSwap router ${cfg.router}` });
  }
  const call = swapTx.call;
  if (call.kind !== "multicall") {
    violations.push({
      code: "NOT_FUEL_SHAPE",
      message: "fuel swaps must be router.multicall([swap, unwrapWHBAR, refundETH?]) ending in native HBAR",
    });
    return null;
  }
  const members = call.calls;
  const shapeOk =
    (members.length === 2 || members.length === 3) &&
    (members[0]!.kind === "exactInput" || members[0]!.kind === "exactInputSingle" || members[0]!.kind === "exactOutput") &&
    members[1]!.kind === "unwrap" &&
    (members.length === 2 || members[2]!.kind === "refund");
  if (!shapeOk) {
    violations.push({
      code: "MULTICALL_SHAPE",
      message: "multicall must be exactly [exactOutput|exactInput|exactInputSingle, unwrapWHBAR, refundETH?] in that order",
    });
    return null;
  }
  const swap = members[0]!;
  const unwrap = members[1]! as Extract<DecodedCall, { kind: "unwrap" }>;

  // path tokens (input..WHBAR) and per-hop fees, normalized across the two swap shapes.
  let pathTokens: Address[];
  let pathFees: number[];
  let recipient: Address;
  let deadline: bigint;
  let amountIn: bigint;
  let amountOutMinimum: bigint;
  let swapMode: "exactOutput" | "exactInput";

  if (swap.kind === "exactInput") {
    pathTokens = swap.pathTokens;
    pathFees = swap.pathFees;
    recipient = swap.recipient;
    deadline = swap.deadline;
    amountIn = swap.amountIn;
    amountOutMinimum = swap.amountOutMinimum;
    swapMode = "exactInput";
  } else if (swap.kind === "exactInputSingle") {
    const s = swap as Extract<DecodedCall, { kind: "exactInputSingle" }>;
    if (s.sqrtPriceLimitX96 !== 0n) {
      violations.push({ code: "SQRT_PRICE_LIMIT", message: "sqrtPriceLimitX96 must be 0 (no partial fills)" });
    }
    pathTokens = [s.tokenIn, s.tokenOut];
    pathFees = [s.fee];
    recipient = s.recipient;
    deadline = s.deadline;
    amountIn = s.amountIn;
    amountOutMinimum = s.amountOutMinimum;
    swapMode = "exactInput";
  } else {
    // V3 exact-output paths are output -> input on the wire. Normalize to
    // input -> output so the same vetted-route comparison applies.
    const output = swap as Extract<DecodedCall, { kind: "exactOutput" }>;
    pathTokens = [...output.pathTokens].reverse();
    pathFees = [...output.pathFees].reverse();
    recipient = output.recipient;
    deadline = output.deadline;
    amountIn = output.amountInMaximum;
    amountOutMinimum = output.amountOut;
    swapMode = "exactOutput";
  }

  const inputTokenAddr = pathTokens[0]!;
  const outputTokenAddr = pathTokens[pathTokens.length - 1]!;
  const inputToken = findToken(cfg, inputTokenAddr);
  if (!inputToken) {
    violations.push({ code: "INPUT_TOKEN_UNSUPPORTED", message: `input token ${inputTokenAddr} is not allowlisted` });
  } else {
    if (amountIn > inputToken.maxAmountIn) {
      violations.push({ code: "AMOUNT_IN_CAP", message: `amountIn ${amountIn} exceeds cap ${inputToken.maxAmountIn} for ${inputToken.symbol}` });
    }
    // The path must EQUAL the token's pre-vetted route (build-whitelist measured
    // its liquidity + price impact). Multi-hop is allowed, but ONLY through the
    // vetted intermediates — never attacker-chosen tokens (security review F13).
    const route = cfg.routeFor(inputToken);
    const expectedTokens = [inputToken.evmAddress, ...route.map((h) => h.toToken)];
    const expectedFees = route.map((h) => h.fee);
    const tokensMatch =
      pathTokens.length === expectedTokens.length &&
      pathTokens.every((t, i) => isAddressEqual(t, expectedTokens[i]!));
    const feesMatch =
      pathFees.length === expectedFees.length && pathFees.every((f, i) => f === expectedFees[i]);
    if (!tokensMatch || !feesMatch) {
      violations.push({
        code: "ROUTE_MISMATCH",
        message: `swap path does not match the vetted route for ${inputToken.symbol}: expected [${expectedTokens.join(",")}] fees [${expectedFees.join(",")}]`,
      });
    }
  }
  if (!isAddressEqual(outputTokenAddr, cfg.whbar)) {
    violations.push({ code: "OUTPUT_NOT_WHBAR", message: "fuel swaps must terminate in WHBAR (unwrapped to native HBAR)" });
  }
  if (!(isAddressEqual(recipient, cfg.router) || isAddressEqual(recipient, ADDRESS_THIS as Address))) {
    violations.push({
      code: "RECIPIENT_NOT_ROUTER",
      message: "swap recipient must be the router (or ADDRESS_THIS 0x…02) so unwrapWHBAR can deliver native HBAR",
    });
  }
  if (!isAddressEqual(unwrap.recipient, swapTx.from)) {
    violations.push({ code: "UNWRAP_RECIPIENT", message: `unwrap recipient ${unwrap.recipient} must be the signer ${swapTx.from}` });
  }
  if (unwrap.amountMinimum <= 0n || amountOutMinimum <= 0n) {
    violations.push({ code: "NO_MIN_OUT", message: "swap output and unwrap minimum must be positive" });
  }
  if (swapMode === "exactOutput" && unwrap.amountMinimum !== amountOutMinimum) {
    violations.push({
      code: "EXACT_OUTPUT_UNWRAP_MISMATCH",
      message: `unwrap minimum ${unwrap.amountMinimum} must equal exact HBAR output ${amountOutMinimum}`,
    });
  }
  if (deadline <= now + BigInt(cfg.minDeadlineBufferSec)) {
    violations.push({
      code: "DEADLINE_TOO_SOON",
      message: `deadline must be at least ${cfg.minDeadlineBufferSec}s out (payment window + submission slack)`,
    });
  } else if (deadline > now + BigInt(cfg.maxDeadlineSkewSec)) {
    violations.push({ code: "DEADLINE_FAR", message: `deadline more than ${cfg.maxDeadlineSkewSec}s in the future` });
  }

  if (!inputToken) return null;
  return { inputToken, swapMode, amountIn, amountOutMinimum: unwrap.amountMinimum, quotedMinOut: amountOutMinimum };
}

export type EvaluateOptions = { nowSec?: number };

export async function evaluateBundle(
  cfg: PolicyConfig,
  rawTxs: Hex[],
  opts: EvaluateOptions = {},
): Promise<PolicyVerdict> {
  const violations: PolicyViolation[] = [];
  const now = BigInt(opts.nowSec ?? Math.floor(Date.now() / 1000));

  if (rawTxs.length < 1 || rawTxs.length > 3) {
    return {
      ok: false,
      violations: [{ code: "BUNDLE_SIZE", message: "bundle must contain 1-3 transactions (associate?, approve?, swap?)" }],
      decoded: [],
      summary: null,
    };
  }

  let decoded: DecodedTx[];
  try {
    decoded = await Promise.all(rawTxs.map((r) => decodeRawTx(r)));
  } catch (e) {
    return { ok: false, violations: [{ code: "UNDECODABLE", message: "signed transaction could not be decoded" }], decoded: [], summary: null };
  }

  const sender = decoded[0]!.from;
  const kinds: (LegKind | null)[] = decoded.map((t) => legKindOf(t.call));

  // Per-tx invariants + sequential nonces + per-leg gas caps.
  for (const [i, tx] of decoded.entries()) {
    if (!isAddressEqual(tx.from, sender)) {
      violations.push({ code: "MIXED_SENDERS", message: "all transactions must be signed by the same account" });
    }
    if (tx.chainId !== cfg.chainId) {
      violations.push({ code: "WRONG_CHAIN", message: `chainId ${tx.chainId} != required ${cfg.chainId}` });
    }
    if (tx.value !== 0n) {
      violations.push({ code: "NONZERO_VALUE", message: "sponsored transactions must not transfer HBAR value" });
    }
    if (tx.type !== "eip1559") {
      violations.push({ code: "TX_TYPE", message: `only EIP-1559 transactions are sponsorable (got ${tx.type})` });
    }
    // viem omits zero-valued EIP-1559 fee fields when parsing serialized bytes;
    // null therefore represents the encoded zero, while every nonzero value is rejected.
    if ((tx.maxFeePerGas ?? 0n) !== 0n) {
      violations.push({
        code: "NONZERO_MAX_FEE_PER_GAS",
        message: `leg ${i} maxFeePerGas must be exactly 0 (got ${tx.maxFeePerGas ?? "missing"})`,
      });
    }
    if ((tx.maxPriorityFeePerGas ?? 0n) !== 0n) {
      violations.push({
        code: "NONZERO_MAX_PRIORITY_FEE_PER_GAS",
        message: `leg ${i} maxPriorityFeePerGas must be exactly 0 (got ${tx.maxPriorityFeePerGas ?? "missing"})`,
      });
    }
    if (i > 0 && tx.nonce !== decoded[0]!.nonce + i) {
      violations.push({ code: "NONCE_ORDER", message: `leg ${i} nonce ${tx.nonce} must equal first nonce + ${i}` });
    }
    const k = kinds[i];
    if (k === null) {
      violations.push({ code: "NOT_SPONSORABLE", message: `leg ${i} (${tx.call.kind}) is not a sponsorable operation` });
    } else {
      const cap = k === "swap" ? cfg.maxGasLimit : k === "associate" ? cfg.associateGasLimit : cfg.approveGasLimit;
      if (tx.gasLimit > cap) {
        violations.push({ code: "GAS_LIMIT", message: `leg ${i} (${k}) gasLimit ${tx.gasLimit} exceeds cap ${cap}` });
      }
    }
  }

  // Ordering: kinds must be a strictly increasing subsequence of associate<approve<swap.
  const rank: Record<LegKind, number> = { associate: 0, approve: 1, swap: 2 };
  const present = new Set<LegKind>();
  let prevRank = -1;
  for (const k of kinds) {
    if (k === null) continue;
    if (present.has(k)) {
      violations.push({ code: "DUPLICATE_LEG", message: `duplicate ${k} leg — at most one of each` });
    }
    present.add(k);
    if (rank[k] <= prevRank) {
      violations.push({ code: "LEG_ORDER", message: `legs must be ordered associate -> approve -> swap` });
    }
    prevRank = rank[k];
  }

  // Validate each present leg.
  const associateTx = decoded.find((t) => t.call.kind === "associate");
  const approveTx = decoded.find((t) => t.call.kind === "approve");
  const swapTx = decoded.find((t) => legKindOf(t.call) === "swap");

  let associateToken: SupportedToken | null = null;
  if (associateTx && associateTx.call.kind === "associate") {
    associateToken = findToken(cfg, associateTx.call.token) ?? null;
    if (!associateToken) {
      violations.push({ code: "ASSOCIATE_TOKEN_UNSUPPORTED", message: `associate target ${associateTx.call.token} is not an allowlisted token` });
    }
  }

  let approve: { token: SupportedToken; amount: bigint } | null = null;
  if (approveTx && approveTx.call.kind === "approve") {
    const ap = approveTx.call;
    const token = findToken(cfg, ap.token);
    if (!token) {
      violations.push({ code: "APPROVE_TOKEN_UNSUPPORTED", message: `approve target ${ap.token} is not an allowlisted token` });
    }
    if (!isAddressEqual(ap.spender, cfg.router)) {
      violations.push({ code: "APPROVE_SPENDER", message: `approve spender must be the SaucerSwap router ${cfg.router}` });
    }
    if (token && ap.amount > token.maxAmountIn) {
      violations.push({ code: "APPROVE_AMOUNT", message: `approve amount ${ap.amount} exceeds per-tx cap ${token.maxAmountIn}` });
    }
    if (token) approve = { token, amount: ap.amount };
  }

  let swap: SwapDetails | null = null;
  if (swapTx) {
    swap = validateSwapLeg(cfg, swapTx, now, violations);
  }

  // Cross-leg: approve must cover the swap it accompanies.
  if (approve && swap) {
    if (!isAddressEqual(approve.token.evmAddress, swap.inputToken.evmAddress)) {
      violations.push({ code: "APPROVE_TOKEN_MISMATCH", message: "approve token must equal the swap input token" });
    }
    if (approve.amount !== swap.amountIn) {
      violations.push({
        code: "APPROVE_AMOUNT_MISMATCH",
        message: `approve amount ${approve.amount} must equal swap amountIn ${swap.amountIn}`,
      });
    }
  }

  const legs: LegInfo[] = decoded.map((t, i) => ({
    kind: kinds[i] ?? "swap",
    token:
      kinds[i] === "associate" ? associateToken
      : kinds[i] === "approve" ? (approve?.token ?? null)
      : kinds[i] === "swap" ? (swap?.inputToken ?? null)
      : null,
    amount:
      kinds[i] === "approve" ? (approve?.amount ?? 0n)
      : kinds[i] === "swap" ? (swap?.amountIn ?? 0n)
      : 0n,
    gasLimit: t.gasLimit,
    nonce: t.nonce,
  }));

  const summary: BundleSummary | null =
    violations.length === 0
      ? {
          sender,
          nonces: decoded.map((t) => t.nonce),
          totalGasLimit: decoded.reduce((a, t) => a + t.gasLimit, 0n),
          legs,
          kinds: legs.map((l) => l.kind),
          hasSwap: !!swap,
          swapMode: swap?.swapMode ?? null,
          swapInputToken: swap?.inputToken ?? null,
          inputToken: swap?.inputToken ?? null,
          amountIn: swap?.amountIn ?? 0n,
          amountOutMinimum: swap?.amountOutMinimum ?? 0n,
          quotedMinOut: swap?.quotedMinOut ?? 0n,
          associateToken,
          approve,
        }
      : null;

  return { ok: violations.length === 0, violations, decoded, summary };
}

/** Byte-exact hash of the bundle (what the sponsor will submit verbatim). */
export function bundleHash(rawTxs: Hex[]): Hex {
  return keccak256(("0x" + rawTxs.map((r) => r.slice(2)).join("")) as Hex);
}

/**
 * Semantic identity of a bundle: immune to signature/RLP re-encoding games.
 * Includes every leg's kind + target token + AMOUNT + nonce so distinct ops
 * (e.g. two standalone approves of different amounts) never collide and one
 * (signer, op-set) can't be quoted/charged twice.
 *
 * NOTE: this does NOT include the fee token — for swap-less bundles the fee
 * token is a request-level choice, so the server binds it into the STORE key
 * separately (see index.ts). Swap bundles bill in the swap input token, which
 * is already in the leg descriptors.
 */
export function semanticBundleHash(summary: BundleSummary): Hex {
  const legDescriptors = summary.legs
    .map((l) => `${l.kind}:${l.token?.tokenId ?? "-"}:${l.amount}:${l.nonce}`)
    .join("|");
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
      [summary.sender, legDescriptors, summary.amountIn, summary.amountOutMinimum],
    ),
  );
}
