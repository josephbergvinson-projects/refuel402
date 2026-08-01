// Safety demo: three hostile bundles, all rejected BEFORE any payment exists.
//   1. unwrap recipient redirected to an attacker
//   2. swap aimed at a fake "router" contract
//   3. sweepToken smuggled into the multicall
// Run against a live server: npx tsx scripts/tamper-demo.ts
import { encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildFuelSwapCalldata,
  encodeSwapPath,
  signRawTx,
} from "../client/src/txbuilder.js";
import { routerAbi } from "../server/src/abi.js";
import { TESTNET, TOKENS } from "../server/src/config.js";

const SERVER = process.env.REFUEL_URL ?? "http://localhost:4020";
const KEY = generatePrivateKey();
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const ctx = { chainId: TESTNET.chainId, router: TESTNET.router, whbar: TESTNET.whbarToken, maxFeePerGas: 0n };
const USDC = TOKENS.USDC!;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 400);

async function post(name: string, transactions: Hex[]) {
  const res = await fetch(`${SERVER}/v1/fuel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions }),
  });
  const body = (await res.json()) as { violations?: { code: string }[]; error?: string };
  const codes = body.violations?.map((v) => v.code).join(", ") ?? body.error;
  console.log(`${name}\n  -> HTTP ${res.status}: ${codes}\n`);
}

console.log(`=== Refuel402 tamper demo (server: ${SERVER}) ===\n`);

// 1. Redirect the unwrapped HBAR to an attacker.
await post(
  "1) unwrap recipient = attacker (theft attempt)",
  [
    await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: ctx.router,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: USDC.poolFee,
        amountIn: 1_000_000n, minWhbarOut: 1_000_000n, deadline, recipient: ATTACKER,
      }),
      nonce: 0, gasLimit: 1_400_000n, maxFeePerGas: 0n,
    }),
  ],
);

// 2. Point the "swap" at a non-router contract.
await post(
  "2) target contract is not the SaucerSwap router",
  [
    await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: ATTACKER,
      data: buildFuelSwapCalldata({
        ctx, inputToken: USDC.evmAddress, poolFee: USDC.poolFee,
        amountIn: 1_000_000n, minWhbarOut: 1_000_000n, deadline,
        recipient: privateKeyToAccount(KEY).address,
      }),
      nonce: 0, gasLimit: 1_400_000n, maxFeePerGas: 0n,
    }),
  ],
);

// 3. Smuggle sweepToken into the multicall.
const swapCall = encodeFunctionData({
  abi: routerAbi,
  functionName: "exactInput",
  args: [{
    path: encodeSwapPath([USDC.evmAddress, ctx.whbar], [USDC.poolFee]),
    recipient: ctx.router, deadline, amountIn: 1_000_000n, amountOutMinimum: 1_000_000n,
  }],
});
const unwrapCall = encodeFunctionData({
  abi: routerAbi, functionName: "unwrapWHBAR",
  args: [1_000_000n, privateKeyToAccount(KEY).address],
});
const sweep = encodeFunctionData({
  abi: routerAbi, functionName: "sweepToken", args: [USDC.evmAddress, 0n, ATTACKER],
});
await post(
  "3) sweepToken smuggled into the multicall",
  [
    await signRawTx({
      privateKey: KEY, chainId: ctx.chainId, to: ctx.router,
      data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [[swapCall, unwrapCall, sweep]] }),
      nonce: 0, gasLimit: 1_400_000n, maxFeePerGas: 0n,
    }),
  ],
);

console.log("All three rejected pre-payment. The policy engine is the paywall's bouncer.");
