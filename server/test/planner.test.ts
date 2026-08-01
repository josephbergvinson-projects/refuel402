import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "../src/abi.js";
import { createRefuelPlan, refuelPlanLimits, type RefuelPlanLimits } from "../src/planner.js";
import type { SupportedToken } from "../src/types.js";

const user = "0x1111111111111111111111111111111111111111" as Address;
const sponsor = "0.0.9001";
const token: SupportedToken = {
  tokenId: "0.0.5449",
  evmAddress: "0x0000000000000000000000000000000000001549",
  symbol: "USDC",
  decimals: 6,
  maxAmountIn: 20_000_000n,
  poolFee: 3000,
};
const limits: RefuelPlanLimits = {
  recommendedHbarTinybar: 200_000_000n,
  maxHbarTinybar: 1_000_000_000n,
  minimumRetainedBps: 500,
  maxSlippageBps: 300,
  maxPriceImpactBps: 150,
  maxRequestExposureTinybar: 800_000_000n,
  sponsorMinReserveTinybar: 500_000_000n,
  dailySponsorCapTinybar: 10_000_000_000n,
};

function mirror(allowance: bigint, key: { _type: "ECDSA_SECP256K1"; key: string } | null = { _type: "ECDSA_SECP256K1", key: "02" }) {
  return {
    account: async (id: string) => id === sponsor
      ? { account: sponsor, evm_address: user, ethereum_nonce: 0, key: { _type: "ECDSA_SECP256K1", key: "03" }, balance: { balance: 5_000_000_000, tokens: [] } }
      : { account: "0.0.7001", evm_address: user, ethereum_nonce: 4, key, balance: { balance: 0, tokens: [{ token_id: token.tokenId, balance: 10_000_000 }] } },
    isAssociated: async () => true,
    quoteExactOutput: async () => ({ amountIn: 1_000_000n, gasEstimate: 300_000n }),
    ethCall: async () => encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: allowance }) as Hex,
    gasPriceWei: async () => 10_000_000_000n,
    hbarUsd: async () => 0.1,
  };
}

describe("value-bounded exact-output refuel planner", () => {
  it("models a source-level 50-HBAR maximum without activating any live environment cap", () => {
    expect(refuelPlanLimits().maxHbarTinybar).toBe(5_000_000_000n);
  });

  it("derives only the required approval + exact-output swap and preserves retained value", async () => {
    const plan = await createRefuelPlan(mirror(0n) as never, {
      network: "testnet",
      account: user,
      token,
      desiredHbarTinybar: 100_000_000n,
      slippageBps: 100,
      sponsorAccountId: sponsor,
      dailyCommittedTinybar: 0n,
      nowSec: 1_753_020_000,
    }, limits);
    expect(plan).toMatchObject({ ok: true, executable: true, accountState: "complete_zero_hbar" });
    if (!("transactionIntents" in plan) || !plan.transactionIntents || !plan.safety) throw new Error("missing intents");
    expect(plan.transactionIntents.map((intent) => intent.kind)).toEqual(["approve", "swap"]);
    expect(plan.route).toMatchObject({ mode: "exactOutput", amountInMaximum: "1010000" });
    expect(plan.safety.balanceSafe).toBe(true);
    expect(plan.safety.concurrentReservationModel).toMatch(/active maximum sponsor exposure reservations/);
    expect(BigInt(plan.safety.totalTokenMaximum)).toBeLessThanOrEqual(BigInt(plan.safety.spendableToken));

    const swap = decodeFunctionData({ abi: routerAbi, data: plan.transactionIntents[1]!.transaction.data });
    expect(swap.functionName).toBe("multicall");
    const calls = (swap.args as readonly [readonly Hex[]])[0];
    const exact = decodeFunctionData({ abi: routerAbi, data: calls[0]! });
    expect(exact.functionName).toBe("exactOutput");
  });

  it("omits approval when the Router allowance already covers the immutable maximum", async () => {
    const plan = await createRefuelPlan(mirror(2_000_000n) as never, {
      network: "testnet",
      account: user,
      token,
      desiredHbarTinybar: 100_000_000n,
      sponsorAccountId: sponsor,
    }, limits);
    if (!("transactionIntents" in plan) || !plan.transactionIntents || !plan.requirements) throw new Error("missing intents");
    expect(plan.transactionIntents.map((intent) => intent.kind)).toEqual(["swap"]);
    expect(plan.requirements.approval).toBe("satisfied");
  });

  it("fails ordinary execution closed on a hollow account", async () => {
    const plan = await createRefuelPlan(mirror(0n, null) as never, {
      network: "testnet",
      account: user,
      token,
      desiredHbarTinybar: 100_000_000n,
      sponsorAccountId: sponsor,
    }, limits);
    expect(plan).toMatchObject({ ok: false, accountState: "hollow", code: "HOLLOW_ACCOUNT_KILL_GATE_REQUIRED" });
  });
});
