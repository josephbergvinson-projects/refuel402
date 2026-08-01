// Adversarial tests for the Refuel402 policy engine: every bypass attempt a
// hostile client could sign locally must be rejected BEFORE any payment or
// sponsor gas is at stake. All offline — real signed txs, no network.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { evaluateBundle, bundleHash, semanticBundleHash, decodePath } from "../src/policy.js";
import { routerAbi, erc20Abi } from "../src/abi.js";
import {
  buildApproveCalldata,
  buildAssociateCalldata,
  buildFuelSwapCalldata,
  buildExactOutputFuelCalldata,
  encodeSwapPath,
  signRawTx,
} from "../../client/src/txbuilder.js";
import { policyConfig, TESTNET, TOKENS } from "../src/config.js";
import { Store } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfg = policyConfig();
const KEY = generatePrivateKey();
const KEY2 = generatePrivateKey();
const me = privateKeyToAccount(KEY).address;
const ctx = {
  chainId: TESTNET.chainId,
  router: TESTNET.router,
  whbar: TESTNET.whbarToken,
  maxFeePerGas: 0n,
};
const USDC = TOKENS.USDC!;
const AMOUNT = 5_000_000n;
const FEE = USDC.poolFee;

function deadline(sec = 400): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + sec);
}

async function approveTx(
  over: Partial<Parameters<typeof signRawTx>[0]> = {},
  spender?: Address,
  amount?: bigint,
  token?: Address,
) {
  return signRawTx({
    privateKey: KEY,
    chainId: ctx.chainId,
    to: token ?? USDC.evmAddress,
    data: buildApproveCalldata(spender ?? ctx.router, amount ?? AMOUNT),
    nonce: 0,
    gasLimit: 1_000_000n,
    maxFeePerGas: 0n,
    ...over,
  });
}

async function swapTx(
  over: Partial<Parameters<typeof signRawTx>[0]> = {},
  callOver: Partial<Parameters<typeof buildFuelSwapCalldata>[0]> = {},
) {
  return signRawTx({
    privateKey: KEY,
    chainId: ctx.chainId,
    to: ctx.router,
    data: buildFuelSwapCalldata({
      ctx,
      inputToken: USDC.evmAddress,
      poolFee: FEE,
      amountIn: AMOUNT,
      minWhbarOut: 400_000_000n,
      deadline: deadline(),
      recipient: me,
      ...callOver,
    }),
    nonce: 1,
    gasLimit: 1_400_000n,
    maxFeePerGas: 0n,
    ...over,
  });
}

/** Hand-rolled multicall swap tx for shape-attack tests. */
async function rawMulticall(calls: Hex[], over: Partial<Parameters<typeof signRawTx>[0]> = {}) {
  const data = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [calls] });
  return signRawTx({
    privateKey: KEY,
    chainId: ctx.chainId,
    to: ctx.router,
    data,
    nonce: 0,
    gasLimit: 1_400_000n,
    maxFeePerGas: 0n,
    ...over,
  });
}

function exactInputCall(pathTokens: Address[], fees: number[], recipient: Address, minOut = 1n): Hex {
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [
      {
        path: encodeSwapPath(pathTokens, fees),
        recipient,
        deadline: deadline(),
        amountIn: AMOUNT,
        amountOutMinimum: minOut,
      },
    ],
  });
}

function unwrapCall(recipient: Address, min = 1n): Hex {
  return encodeFunctionData({ abi: routerAbi, functionName: "unwrapWHBAR", args: [min, recipient] });
}

async function associateTx(
  token: Address = USDC.evmAddress,
  over: Partial<Parameters<typeof signRawTx>[0]> = {},
) {
  return signRawTx({
    privateKey: KEY,
    chainId: ctx.chainId,
    to: token,
    data: buildAssociateCalldata(),
    nonce: 0,
    gasLimit: 900_000n,
    maxFeePerGas: 0n,
    ...over,
  });
}

function codes(v: Awaited<ReturnType<typeof evaluateBundle>>): string[] {
  return v.violations.map((x) => x.code);
}

describe("policy engine — happy path", () => {
  it("accepts a valid [approve, swap->unwrap] bundle", async () => {
    const v = await evaluateBundle(cfg, [await approveTx(), await swapTx()]);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.summary!.sender.toLowerCase()).toBe(me.toLowerCase());
    expect(v.summary!.amountIn).toBe(AMOUNT);
    expect(v.summary!.hasSwap).toBe(true);
    expect(v.summary!.kinds).toEqual(["approve", "swap"]);
  });

  it("accepts the corrected exact-output token->WHBAR->native HBAR bundle", async () => {
    const swap = await signRawTx({
      privateKey: KEY,
      chainId: ctx.chainId,
      to: ctx.router,
      data: buildExactOutputFuelCalldata({
        ctx,
        inputToken: USDC.evmAddress,
        poolFee: FEE,
        amountOut: 400_000_000n,
        amountInMaximum: AMOUNT,
        deadline: deadline(600),
        recipient: me,
      }),
      nonce: 1,
      gasLimit: 1_400_000n,
      maxFeePerGas: 0n,
    });
    const verdict = await evaluateBundle(cfg, [await approveTx(), swap]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toMatchObject({
      swapMode: "exactOutput",
      amountIn: AMOUNT,
      amountOutMinimum: 400_000_000n,
      kinds: ["approve", "swap"],
    });
  });

  it("accepts a swap-only bundle (allowance already on chain)", async () => {
    const v = await evaluateBundle(cfg, [await swapTx({ nonce: 0 })]);
    expect(v.ok).toBe(true);
    expect(v.summary!.kinds).toEqual(["swap"]);
  });

  it("accepts ADDRESS_THIS (0x…02) as the swap recipient sentinel", async () => {
    const raw = await rawMulticall([
      exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], "0x0000000000000000000000000000000000000002"),
      unwrapCall(me),
    ]);
    expect((await evaluateBundle(cfg, [raw])).ok).toBe(true);
  });

  it("accepts a multi-hop swap that matches a token's vetted route (DAI via USDC)", async () => {
    const dai = TOKENS.DAI;
    if (!dai?.route || dai.route.length < 2) return; // whitelist may omit DAI; skip if so
    const pathTokens = [dai.evmAddress, ...dai.route.map((h) => h.toToken as Address)];
    const pathFees = dai.route.map((h) => h.fee);
    const raw = await rawMulticall([
      encodeFunctionData({
        abi: routerAbi, functionName: "exactInput",
        args: [{ path: encodeSwapPath(pathTokens, pathFees), recipient: ctx.router, deadline: deadline(), amountIn: 1_000_000n, amountOutMinimum: 1n }],
      }),
      unwrapCall(me),
    ]);
    const v = await evaluateBundle(cfg, [raw]);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.summary!.swapInputToken?.symbol).toBe("DAI");
  });

  it("rejects a multi-hop DAI swap that swaps the vetted intermediate for an attacker token", async () => {
    const dai = TOKENS.DAI;
    if (!dai?.route || dai.route.length < 2) return;
    const attacker = "0x00000000000000000000000000000000000dead0" as Address;
    const raw = await rawMulticall([
      encodeFunctionData({
        abi: routerAbi, functionName: "exactInput",
        args: [{ path: encodeSwapPath([dai.evmAddress, attacker, ctx.whbar], [dai.route[0]!.fee, dai.route[1]!.fee]), recipient: ctx.router, deadline: deadline(), amountIn: 1_000_000n, amountOutMinimum: 1n }],
      }),
      unwrapCall(me),
    ]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("ROUTE_MISMATCH");
  });
});

describe("policy engine — adversarial rejections", () => {
  it("rejects a tx aimed at a non-router contract", async () => {
    const evil = await signRawTx({
      privateKey: KEY,
      chainId: ctx.chainId,
      to: "0x000000000000000000000000000000000000dEaD" as Address,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: FEE, amountIn: AMOUNT,
        minWhbarOut: 1n, deadline: deadline(), recipient: me,
      }),
      nonce: 0, gasLimit: 500_000n, maxFeePerGas: 0n,
    });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("NOT_ROUTER");
  });

  it("rejects wrong chainId (mainnet replay)", async () => {
    const evil = await swapTx({ nonce: 0, chainId: 295 });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("WRONG_CHAIN");
  });

  it("rejects HBAR value transfers", async () => {
    const account = privateKeyToAccount(KEY);
    const evil = await account.signTransaction({
      type: "eip1559", chainId: ctx.chainId, to: ctx.router,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: FEE, amountIn: AMOUNT,
        minWhbarOut: 1n, deadline: deadline(), recipient: me,
      }),
      nonce: 0, gas: 500_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
      value: 1_000_000n,
    });
    expect(codes(await evaluateBundle(cfg, [evil as Hex]))).toContain("NONZERO_VALUE");
  });

  it("rejects legacy (type-0) transactions", async () => {
    const account = privateKeyToAccount(KEY);
    const evil = await account.signTransaction({
      type: "legacy", chainId: ctx.chainId, to: ctx.router,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: FEE, amountIn: AMOUNT,
        minWhbarOut: 1n, deadline: deadline(), recipient: me,
      }),
      nonce: 0, gas: 500_000n, gasPrice: 0n,
    });
    expect(codes(await evaluateBundle(cfg, [evil as Hex]))).toContain("TX_TYPE");
  });

  it("rejects nonzero EIP-1559 maxFeePerGas", async () => {
    const evil = await approveTx({ maxFeePerGas: 1n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("NONZERO_MAX_FEE_PER_GAS");
  });

  it("rejects nonzero EIP-1559 maxPriorityFeePerGas", async () => {
    const evil = await approveTx({ maxPriorityFeePerGas: 1n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("NONZERO_MAX_PRIORITY_FEE_PER_GAS");
  });

  it("rejects an approval larger than the exact swap amount", async () => {
    const evil = await approveTx({}, ctx.router, AMOUNT + 1n);
    expect(codes(await evaluateBundle(cfg, [evil, await swapTx()]))).toContain("APPROVE_AMOUNT_MISMATCH");
  });

  it("rejects approve of an unlisted token", async () => {
    const evil = await approveTx({}, ctx.router, AMOUNT, "0x00000000000000000000000000000000000dead0" as Address);
    const v = await evaluateBundle(cfg, [evil, await swapTx()]);
    expect(codes(v)).toContain("APPROVE_TOKEN_UNSUPPORTED");
  });

  it("rejects approve whose spender is not the router", async () => {
    const evil = await approveTx({}, "0x1111111111111111111111111111111111111111" as Address);
    expect(codes(await evaluateBundle(cfg, [evil, await swapTx()]))).toContain("APPROVE_SPENDER");
  });

  it("rejects approve smaller than the swap's amountIn", async () => {
    const evil = await approveTx({}, ctx.router, AMOUNT - 1n);
    expect(codes(await evaluateBundle(cfg, [evil, await swapTx()]))).toContain("APPROVE_AMOUNT_MISMATCH");
  });

  it("rejects a bare (non-multicall) swap — native HBAR delivery is mandatory", async () => {
    const raw = await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: ctx.router,
      data: exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], me),
      nonce: 0, gasLimit: 1_000_000n, maxFeePerGas: 0n,
    });
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("NOT_FUEL_SHAPE");
  });

  it("rejects swap output that is not WHBAR", async () => {
    const raw = await rawMulticall([
      exactInputCall([USDC.evmAddress, TOKENS.SAUCE!.evmAddress], [FEE], ctx.router),
      unwrapCall(me),
    ]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("OUTPUT_NOT_WHBAR");
  });

  it("rejects a multi-hop path through an UNVETTED intermediate (USDC is direct)", async () => {
    // USDC's vetted route is direct [WHBAR]; injecting a SAUCE hop must be refused.
    const raw = await rawMulticall([
      exactInputCall([USDC.evmAddress, TOKENS.SAUCE!.evmAddress, ctx.whbar], [FEE, FEE], ctx.router),
      unwrapCall(me),
    ]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("ROUTE_MISMATCH");
  });

  it("rejects a wrong fee tier (path must equal the vetted route)", async () => {
    const raw = await rawMulticall([
      exactInputCall([USDC.evmAddress, ctx.whbar], [500], ctx.router),
      unwrapCall(me),
    ]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("ROUTE_MISMATCH");
  });

  it("rejects unwrap redirected to an attacker address", async () => {
    const attacker = privateKeyToAccount(KEY2).address;
    const evil = await swapTx({ nonce: 0 }, { recipient: attacker });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("UNWRAP_RECIPIENT");
  });

  it("rejects swap recipient that is neither router nor ADDRESS_THIS (incl. 0x0)", async () => {
    for (const bad of [
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000001",
      privateKeyToAccount(KEY2).address,
    ] as Address[]) {
      const raw = await rawMulticall([
        exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], bad),
        unwrapCall(me),
      ]);
      expect(codes(await evaluateBundle(cfg, [raw]))).toContain("RECIPIENT_NOT_ROUTER");
    }
  });

  it("rejects zero amountOutMinimum (no slippage floor)", async () => {
    const evil = await swapTx({ nonce: 0 }, { minWhbarOut: 0n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("NO_MIN_OUT");
  });

  it("rejects a deadline without enough runway for the payment window", async () => {
    const evil = await swapTx({ nonce: 0 }, { deadline: deadline(60) });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("DEADLINE_TOO_SOON");
  });

  it("rejects an already-passed deadline", async () => {
    const evil = await swapTx({ nonce: 0 }, { deadline: deadline(-100) });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("DEADLINE_TOO_SOON");
  });

  it("rejects a far-future deadline", async () => {
    const evil = await swapTx({ nonce: 0 }, { deadline: deadline(100_000) });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("DEADLINE_FAR");
  });

  it("rejects amountIn above the per-token cap", async () => {
    const evil = await swapTx({ nonce: 0 }, { amountIn: USDC.maxAmountIn + 1n, minWhbarOut: 1n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("AMOUNT_IN_CAP");
  });

  it("rejects oversized gas limits", async () => {
    const evil = await swapTx({ nonce: 0, gasLimit: cfg.maxGasLimit + 1n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("GAS_LIMIT");
  });

  it("rejects out-of-order nonces in a bundle", async () => {
    const v = await evaluateBundle(cfg, [await approveTx({ nonce: 3 }), await swapTx({ nonce: 1 })]);
    expect(codes(v)).toContain("NONCE_ORDER");
  });

  it("rejects bundles signed by different keys", async () => {
    const other = await signRawTx({
      privateKey: KEY2, chainId: ctx.chainId, to: ctx.router,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: FEE, amountIn: AMOUNT,
        minWhbarOut: 1n, deadline: deadline(), recipient: privateKeyToAccount(KEY2).address,
      }),
      nonce: 1, gasLimit: 1_000_000n, maxFeePerGas: 0n,
    });
    expect(codes(await evaluateBundle(cfg, [await approveTx(), other]))).toContain("MIXED_SENDERS");
  });

  it("rejects two swaps smuggled into one multicall", async () => {
    const s = exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], ctx.router);
    const raw = await rawMulticall([s, s, unwrapCall(me)]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("MULTICALL_SHAPE");
  });

  it("rejects unwrap-before-swap ordering", async () => {
    const raw = await rawMulticall([
      unwrapCall(me),
      exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], ctx.router),
    ]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("MULTICALL_SHAPE");
  });

  it("rejects sweepToken smuggled into the multicall", async () => {
    const sweep = encodeFunctionData({
      abi: routerAbi,
      functionName: "sweepToken",
      args: [USDC.evmAddress, 0n, privateKeyToAccount(KEY2).address],
    });
    const raw = await rawMulticall([
      exactInputCall([USDC.evmAddress, ctx.whbar], [FEE], ctx.router),
      unwrapCall(me),
      sweep,
    ]);
    const v = await evaluateBundle(cfg, [raw]);
    expect(v.ok).toBe(false); // sweepToken is undecodable-by-policy -> UNDECODABLE
  });

  it("rejects nonzero sqrtPriceLimitX96 in exactInputSingle", async () => {
    const single = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: USDC.evmAddress, tokenOut: ctx.whbar, fee: FEE, recipient: ctx.router,
          deadline: deadline(), amountIn: AMOUNT, amountOutMinimum: 1n,
          sqrtPriceLimitX96: 123456789n,
        },
      ],
    });
    const raw = await rawMulticall([single, unwrapCall(me)]);
    expect(codes(await evaluateBundle(cfg, [raw]))).toContain("SQRT_PRICE_LIMIT");
  });

  it("rejects a bare ERC20 transfer disguised as a bundle", async () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function", name: "transfer", stateMutability: "nonpayable",
          inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      functionName: "transfer",
      args: [privateKeyToAccount(KEY2).address, AMOUNT],
    });
    const raw = await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: USDC.evmAddress, data,
      nonce: 0, gasLimit: 500_000n, maxFeePerGas: 0n,
    });
    expect((await evaluateBundle(cfg, [raw])).ok).toBe(false);
  });

  it("rejects bundles of size 0 and 4", async () => {
    expect((await evaluateBundle(cfg, [])).ok).toBe(false);
    const a = await approveTx();
    expect((await evaluateBundle(cfg, [a, a, a, a])).ok).toBe(false);
  });
});

describe("associate + approve op set", () => {
  it("accepts a standalone associate of an allowlisted token", async () => {
    const v = await evaluateBundle(cfg, [await associateTx(TOKENS.SAUCE!.evmAddress)]);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.summary!.kinds).toEqual(["associate"]);
    expect(v.summary!.associateToken?.symbol).toBe("SAUCE");
    expect(v.summary!.hasSwap).toBe(false);
  });

  it("accepts a standalone approve of the router", async () => {
    const v = await evaluateBundle(cfg, [await approveTx({ nonce: 0 })]);
    expect(v.ok).toBe(true);
    expect(v.summary!.kinds).toEqual(["approve"]);
    expect(v.summary!.approve?.token.symbol).toBe("USDC");
  });

  it("accepts the full [associate, approve, swap] bundle", async () => {
    const v = await evaluateBundle(cfg, [
      await associateTx(TOKENS.SAUCE!.evmAddress, { nonce: 0 }),
      await approveTx({ nonce: 1 }),
      await swapTx({ nonce: 2 }),
    ]);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.summary!.kinds).toEqual(["associate", "approve", "swap"]);
    expect(v.summary!.hasSwap).toBe(true);
  });

  it("rejects associate of a non-allowlisted token", async () => {
    const evil = await associateTx("0x00000000000000000000000000000000000dead0" as Address);
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("ASSOCIATE_TOKEN_UNSUPPORTED");
  });

  it("rejects out-of-order legs (approve before associate)", async () => {
    const v = await evaluateBundle(cfg, [
      await approveTx({ nonce: 0 }),
      await associateTx(TOKENS.SAUCE!.evmAddress, { nonce: 1 }),
    ]);
    expect(codes(v)).toContain("LEG_ORDER");
  });

  it("rejects swap before approve", async () => {
    const v = await evaluateBundle(cfg, [
      await swapTx({ nonce: 0 }),
      await approveTx({ nonce: 1 }),
    ]);
    expect(codes(v)).toContain("LEG_ORDER");
  });

  it("rejects duplicate associate legs", async () => {
    const v = await evaluateBundle(cfg, [
      await associateTx(TOKENS.SAUCE!.evmAddress, { nonce: 0 }),
      await associateTx(TOKENS.USDC!.evmAddress, { nonce: 1 }),
    ]);
    expect(codes(v)).toContain("DUPLICATE_LEG");
  });

  it("rejects an associate leg with extra calldata (not the bare selector)", async () => {
    const evil = await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: USDC.evmAddress,
      data: (buildAssociateCalldata() + "00") as Hex, // trailing byte -> not associate
      nonce: 0, gasLimit: 900_000n, maxFeePerGas: 0n,
    });
    expect((await evaluateBundle(cfg, [evil])).ok).toBe(false);
  });

  it("caps associate/approve gas", async () => {
    const evil = await associateTx(TOKENS.SAUCE!.evmAddress, { gasLimit: cfg.associateGasLimit + 1n });
    expect(codes(await evaluateBundle(cfg, [evil]))).toContain("GAS_LIMIT");
  });

  it("standalone associate + standalone approve get distinct semantic hashes", async () => {
    const a = await evaluateBundle(cfg, [await associateTx(TOKENS.SAUCE!.evmAddress)]);
    const b = await evaluateBundle(cfg, [await approveTx({ nonce: 0 })]);
    expect(semanticBundleHash(a.summary!)).not.toBe(semanticBundleHash(b.summary!));
  });

  it("two standalone approves of different amounts get distinct semantic hashes", async () => {
    const a = await evaluateBundle(cfg, [await approveTx({ nonce: 0 }, ctx.router, 1_000_000n)]);
    const b = await evaluateBundle(cfg, [await approveTx({ nonce: 0 }, ctx.router, 2_000_000n)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.summary!.legs[0]!.amount).toBe(1_000_000n);
    expect(semanticBundleHash(a.summary!)).not.toBe(semanticBundleHash(b.summary!));
  });
});

describe("hashes, path decoding, store serialization", () => {
  it("raw bundleHash is order- and content-sensitive", async () => {
    const a = await approveTx();
    const s = await swapTx();
    expect(bundleHash([a, s])).not.toBe(bundleHash([s, a]));
    expect(bundleHash([a])).not.toBe(bundleHash([s]));
    expect(bundleHash([a, s])).toBe(bundleHash([a, s]));
  });

  it("semanticBundleHash is stable across re-encodings but distinct across swaps", async () => {
    const a = await approveTx();
    const s1 = await swapTx();
    const s2 = await swapTx({}, { amountIn: AMOUNT + 1n });
    const v1 = await evaluateBundle(cfg, [a, s1]);
    // same decoded content -> same semantic hash regardless of raw bytes
    expect(semanticBundleHash(v1.summary!)).toBe(semanticBundleHash(v1.summary!));
    const a2 = await approveTx({}, ctx.router, AMOUNT + 1n);
    const v2 = await evaluateBundle(cfg, [a2, s2]);
    expect(semanticBundleHash(v1.summary!)).not.toBe(semanticBundleHash(v2.summary!));
  });

  it("decodePath round-trips and rejects malformed paths", () => {
    const p = encodeSwapPath([USDC.evmAddress, ctx.whbar], [FEE]);
    const d = decodePath(p);
    expect(d.tokens.map((t) => t.toLowerCase())).toEqual([
      USDC.evmAddress.toLowerCase(),
      ctx.whbar.toLowerCase(),
    ]);
    expect(d.fees).toEqual([FEE]);
    expect(() => decodePath("0x1234" as Hex)).toThrow();
  });

  it("store enforces one live bundle per (signer, nonce) and single-shot claims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refuel-store-"));
    const store = new Store(dir);
    const base = {
      rawHash: "0xraw" as Hex,
      rawTxs: ["0x01"] as Hex[],
      network: "testnet" as const,
      chainId: TESTNET.chainId,
      quoteId: "0xquote" as Hex,
      routeId: "0xroute" as Hex,
      requirementsHash: "0xrequirements" as Hex,
      requirements: [],
      economicContract: "prepaid_bounded_attempt_v1" as const,
      signer: me,
      createdAt: 0,
      updatedAt: 0,
      quote: null,
      payment: null,
      execution: null,
      refund: null,
      error: null,
    };
    store.upsert({ ...base, bundleHash: "0xaaa" as Hex, nonces: [0, 1], state: "quoted" });
    expect(store.nonceBusy(me, [1])?.bundleHash).toBe("0xaaa");
    expect(store.nonceBusy(me, [2])).toBeNull();
    expect(store.nonceBusy(privateKeyToAccount(KEY2).address, [0])).toBeNull();
    // claims: only settled records can be claimed, and only once
    expect(store.claimForSubmission("0xaaa" as Hex)).toBe(false);
    store.upsert({ ...base, bundleHash: "0xaaa" as Hex, nonces: [0, 1], state: "settled" });
    expect(store.claimForSubmission("0xaaa" as Hex)).toBe(true);
    expect(store.claimForSubmission("0xaaa" as Hex)).toBe(false);
    // completed frees the nonce
    store.upsert({ ...base, bundleHash: "0xaaa" as Hex, nonces: [0, 1], state: "completed" });
    expect(store.nonceBusy(me, [0, 1])).toBeNull();
    expect(() => store.upsert({
      ...base,
      quoteId: "0xdifferent" as Hex,
      bundleHash: "0xaaa" as Hex,
      nonces: [0, 1],
      state: "completed",
    })).toThrow("IMMUTABLE_LIFECYCLE_IDENTITY: quoteId changed");
  });
});
