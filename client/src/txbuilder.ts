// Client-side builder: creates and signs the raw EVM transactions a zero-HBAR
// account sends to Refuel402. The user's key never leaves this process.
import {
  encodeFunctionData,
  concatHex,
  numberToHex,
  pad,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, erc20WrapperAbi, routerAbi, v1RouterAbi } from "../../server/src/abi.js";

export type BuildContext = {
  chainId: number;
  router: Address;
  whbar: Address;
  /** Inner tx gas price. 0 = sponsor pays everything (the Refuel402 default). */
  maxFeePerGas: bigint;
};

export function encodeSwapPath(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1) throw new Error("path/fee length mismatch");
  let out: Hex = tokens[0]!;
  for (let i = 0; i < fees.length; i++) {
    out = concatHex([out, pad(numberToHex(fees[i]!), { size: 3 }), tokens[i + 1]!]);
  }
  return out;
}

/** V3 exact-output paths are encoded in reverse: output -> ... -> input. */
export function encodeExactOutputPath(tokens: Address[], fees: number[]): Hex {
  return encodeSwapPath([...tokens].reverse(), [...fees].reverse());
}

export function buildApproveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
}

export function buildV1ExactOutputHbarCalldata(params: {
  amountOut: bigint;
  amountInMaximum: bigint;
  path: Address[];
  recipient: Address;
  deadline: bigint;
}): Hex {
  if (params.path.length < 2) throw new Error("Saucer V1 path is too short");
  return encodeFunctionData({
    abi: v1RouterAbi,
    functionName: "swapTokensForExactETH",
    args: [params.amountOut, params.amountInMaximum, params.path, params.recipient, params.deadline],
  });
}

export function buildWrapCalldata(erc20Token: Address, to: Address, erc20Amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20WrapperAbi,
    functionName: "wrap",
    args: [erc20Token, to, erc20Amount],
  });
}

/** IHRC719 associate() — bare 4-byte selector, sent to the token's own facade. */
export function buildAssociateCalldata(): Hex {
  return "0x0a754de6";
}

/**
 * A "fuel swap": exact-input swap of `inputToken` for WHBAR (direct or multi-hop
 * through a vetted route), unwrapped to native HBAR, delivered to the signer.
 * Encoded as router.multicall([exactInput, unwrapWHBAR]). Pass `route` for a
 * multi-hop path (e.g. token -> USDC -> WHBAR); omit for a direct `poolFee` hop.
 */
export function buildFuelSwapCalldata(params: {
  ctx: BuildContext;
  inputToken: Address;
  poolFee: number;
  amountIn: bigint;
  minWhbarOut: bigint;
  deadline: bigint;
  recipient: Address;
  route?: { toToken: Address; fee: number }[];
  unwrapFn?: "unwrapWHBAR" | "unwrapWETH9";
}): Hex {
  const { ctx } = params;
  const hops = params.route && params.route.length > 0
    ? params.route
    : [{ toToken: ctx.whbar, fee: params.poolFee }];
  const path = encodeSwapPath(
    [params.inputToken, ...hops.map((h) => h.toToken)],
    hops.map((h) => h.fee),
  );
  const swapCall = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [
      {
        path,
        recipient: ctx.router, // WHBAR stays with the router, then gets unwrapped
        deadline: params.deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.minWhbarOut,
      },
    ],
  });
  const unwrapCall = encodeFunctionData({
    abi: routerAbi,
    functionName: params.unwrapFn ?? "unwrapWHBAR",
    args: [params.minWhbarOut, params.recipient],
  });
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [[swapCall, unwrapCall]],
  });
}

/**
 * Correct Refuel402 product swap: spend no more than `amountInMaximum` to
 * receive exactly `amountOut` WHBAR, then atomically unwrap it to native HBAR
 * for the user. The router only pulls the actual input used.
 */
export function buildExactOutputFuelCalldata(params: {
  ctx: BuildContext;
  inputToken: Address;
  poolFee: number;
  amountOut: bigint;
  amountInMaximum: bigint;
  deadline: bigint;
  recipient: Address;
  route?: { toToken: Address; fee: number }[];
  unwrapFn?: "unwrapWHBAR" | "unwrapWETH9";
}): Hex {
  const { ctx } = params;
  const hops = params.route && params.route.length > 0
    ? params.route
    : [{ toToken: ctx.whbar, fee: params.poolFee }];
  const path = encodeExactOutputPath(
    [params.inputToken, ...hops.map((hop) => hop.toToken)],
    hops.map((hop) => hop.fee),
  );
  const swapCall = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactOutput",
    args: [{
      path,
      recipient: ctx.router,
      deadline: params.deadline,
      amountOut: params.amountOut,
      amountInMaximum: params.amountInMaximum,
    }],
  });
  const unwrapCall = encodeFunctionData({
    abi: routerAbi,
    functionName: params.unwrapFn ?? "unwrapWHBAR",
    args: [params.amountOut, params.recipient],
  });
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [[swapCall, unwrapCall]],
  });
}

export async function signRawTx(params: {
  privateKey: Hex;
  chainId: number;
  to: Address;
  data: Hex;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
}): Promise<Hex> {
  const account = privateKeyToAccount(params.privateKey);
  return account.signTransaction({
    type: "eip1559",
    chainId: params.chainId,
    to: params.to,
    data: params.data,
    nonce: params.nonce,
    gas: params.gasLimit,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas ?? params.maxFeePerGas,
    value: 0n,
  });
}

export function userAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
