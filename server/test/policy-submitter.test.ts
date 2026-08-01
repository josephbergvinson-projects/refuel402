import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createBoundedPolicyRpcSubmitter,
  PolicyRpcSubmissionRejectedError,
} from "../src/policy-rpc.js";

const target = "0x2222222222222222222222222222222222222222" as const;
const selector = "0x095ea7b3" as const;
const account = privateKeyToAccount(`0x${"12".repeat(32)}`);

async function signed(chainId: number, nonce = 0) {
  return account.signTransaction({
    chainId,
    type: "eip1559",
    nonce,
    to: target,
    data: `${selector}${"00".repeat(64)}`,
    value: 0n,
    gas: 120_000n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
  });
}

function submitter(chainId: 295 | 296, submit = vi.fn(async (raw: `0x${string}`) => ({ ethereumHash: keccak256(raw) }))) {
  return {
    submit,
    value: createBoundedPolicyRpcSubmitter({
      policy: {
        chainId,
        allowedTargets: [target],
        allowedSelectors: [selector],
        perTransactionCapTinybar: 1_000_000n,
        dailyCapTinybar: 5_000_000n,
        minimumReserveTinybar: 1_000_000n,
      },
      sponsor: { submitSponsored: submit },
      estimateGas: async () => 120_000n,
      reserveTinybar: async () => 10_000_000n,
      exposureSince: async () => 0n,
    }),
  };
}

describe("bounded policy-RPC submitter", () => {
  for (const chainId of [296, 295] as const) {
    it(`enforces the ${chainId} policy and idempotently returns a submitted hash`, async () => {
      const raw = await signed(chainId);
      const adapter = submitter(chainId);
      const first = await adapter.value.submit(raw, 500_000n);
      const replay = await adapter.value.submit(raw, 500_000n);
      expect(first.ethereumHash).toBe(keccak256(raw));
      expect(replay).toEqual(first);
      expect(adapter.submit).toHaveBeenCalledTimes(1);
    });
  }

  it("rejects chain, target/selector, allowance, reserve, and daily-cap violations", async () => {
    const raw = await signed(296);
    await expect(submitter(295).value.submit(raw, 500_000n)).rejects.toThrow("chain");
    await expect(submitter(296).value.submit(raw, 1_000_001n)).rejects.toThrow("per-transaction cap");
    const reserve = createBoundedPolicyRpcSubmitter({
      policy: { chainId: 296, allowedTargets: [target], allowedSelectors: [selector], perTransactionCapTinybar: 1_000_000n, dailyCapTinybar: 5_000_000n, minimumReserveTinybar: 1_000_000n },
      sponsor: { submitSponsored: async () => ({ ethereumHash: keccak256(raw) }) },
      estimateGas: async () => 1n,
      reserveTinybar: async () => 1_100_000n,
      exposureSince: async () => 0n,
    });
    await expect(reserve.submit(raw, 500_000n)).rejects.toThrow("reserve");
    const daily = createBoundedPolicyRpcSubmitter({
      policy: { chainId: 296, allowedTargets: [target], allowedSelectors: [selector], perTransactionCapTinybar: 1_000_000n, dailyCapTinybar: 5_000_000n, minimumReserveTinybar: 1_000_000n },
      sponsor: { submitSponsored: async () => ({ ethereumHash: keccak256(raw) }) },
      estimateGas: async () => 1n,
      reserveTinybar: async () => 10_000_000n,
      exposureSince: async () => 4_900_000n,
    });
    await expect(daily.submit(raw, 500_000n)).rejects.toThrow("daily sponsor exposure");
  });

  it("excludes the authorization under decision from its own daily-cap check", async () => {
    const raw = await signed(296, 2);
    const rawHash = keccak256(raw);
    // consume() commits state='consumed' before submit() runs, so the ledger
    // already holds this transaction's 500_000 allowance. Counting it again
    // would refuse a spend that fits the cap after the payment settled.
    const exposureSince = vi.fn(async (_cutoff: number, options?: { excludeRawTransactionHash?: string }) =>
      options?.excludeRawTransactionHash === rawHash ? 4_500_000n : 5_000_000n);
    const adapter = createBoundedPolicyRpcSubmitter({
      policy: { chainId: 296, allowedTargets: [target], allowedSelectors: [selector], perTransactionCapTinybar: 1_000_000n, dailyCapTinybar: 5_000_000n, minimumReserveTinybar: 1_000_000n },
      sponsor: { submitSponsored: async () => ({ ethereumHash: keccak256(raw) }) },
      estimateGas: async () => 1n,
      reserveTinybar: async () => 10_000_000n,
      exposureSince,
    });
    await expect(adapter.submit(raw, 500_000n)).resolves.toEqual({ ethereumHash: keccak256(raw) });
    expect(exposureSince).toHaveBeenCalledWith(expect.any(Number), { excludeRawTransactionHash: rawHash });
  });

  it("still refuses once the rest of the day's spend fills the cap", async () => {
    const raw = await signed(296, 3);
    const adapter = createBoundedPolicyRpcSubmitter({
      policy: { chainId: 296, allowedTargets: [target], allowedSelectors: [selector], perTransactionCapTinybar: 1_000_000n, dailyCapTinybar: 5_000_000n, minimumReserveTinybar: 1_000_000n },
      sponsor: { submitSponsored: async () => ({ ethereumHash: keccak256(raw) }) },
      estimateGas: async () => 1n,
      reserveTinybar: async () => 10_000_000n,
      exposureSince: async () => 4_600_000n,
    });
    await expect(adapter.submit(raw, 500_000n)).rejects.toThrow("daily sponsor exposure");
  });

  it("refuses rather than strands the journey when a pre-flight read fails", async () => {
    const raw = await signed(296, 4);
    const submit = vi.fn(async () => ({ ethereumHash: keccak256(raw) }));
    for (const failing of ["estimateGas", "reserveTinybar", "exposureSince"] as const) {
      const reads = {
        estimateGas: async () => 1n,
        reserveTinybar: async () => 10_000_000n,
        exposureSince: async () => 0n,
        [failing]: async () => { throw new Error("connection terminated unexpectedly"); },
      };
      const adapter = createBoundedPolicyRpcSubmitter({
        policy: { chainId: 296, allowedTargets: [target], allowedSelectors: [selector], perTransactionCapTinybar: 1_000_000n, dailyCapTinybar: 5_000_000n, minimumReserveTinybar: 1_000_000n },
        sponsor: { submitSponsored: submit },
        ...reads,
      } as Parameters<typeof createBoundedPolicyRpcSubmitter>[0]);
      // Nothing was broadcast, so this must be a rejection, not the unknown that
      // pushes the journey to review.
      await expect(adapter.submit(raw, 500_000n)).rejects.toBeInstanceOf(PolicyRpcSubmissionRejectedError);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("marks an unknown sponsor result and refuses a blind retry", async () => {
    const raw = await signed(296, 1);
    const adapter = submitter(296, vi.fn(async () => { throw new Error("transport lost"); }));
    await expect(adapter.value.submit(raw, 500_000n)).rejects.toThrow("unknown");
    await expect(adapter.value.submit(raw, 500_000n)).rejects.toThrow("reconcile before retry");
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });
});
