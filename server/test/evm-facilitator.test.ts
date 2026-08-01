import express from "express";
import { describe, expect, it, vi } from "vitest";
import { LocalEvmFacilitator, type ExactEvmPayment, type ExactEvmPaymentRequirements } from "../src/evm-facilitator.js";

const payer = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const recipient = "0x3333333333333333333333333333333333333333" as const;
const proxy = "0x4444444444444444444444444444444444444444" as const;
const now = 1_800_000_000_000;
const payment: ExactEvmPayment = {
  payer,
  token,
  amount: "125000",
  recipient,
  chainId: 296,
  nonce: "7",
  deadline: Math.floor(now / 1000) + 120,
  spender: proxy,
  contextHash: `0x${"55".repeat(32)}`,
  signature: `0x${"66".repeat(65)}`,
};
const requirements: ExactEvmPaymentRequirements = {
  scheme: "exact",
  network: "eip155:296",
  token,
  amount: "125000",
  recipient,
  chainId: 296,
  spender: proxy,
  contextHash: `0x${"55".repeat(32)}`,
  maxTimeoutSeconds: 180,
};

function facilitator() {
  return new LocalEvmFacilitator({
    chains: [296],
    proxies: { 295: proxy, 296: proxy },
    now: () => now,
    verifier: vi.fn(async () => true),
    settlement: { settle: vi.fn(async (_payment, id) => ({ transactionHash: id })) },
  });
}

describe("local EVM facilitator", () => {
  it("verifies and idempotently settles one exact Permit2 witness", async () => {
    const service = facilitator();
    expect(service.readiness()).toMatchObject({ ok: true, verificationReady: true, settlementReady: true });
    expect(service.supported().kinds).toContainEqual(expect.objectContaining({ network: "eip155:296", scheme: "exact", proxy }));
    const verified = await service.verify(payment, requirements);
    const settled = await service.settle(payment, requirements, "settlement-idem-0001");
    const replay = await service.settle(payment, requirements, "settlement-idem-0001");
    expect(verified.state).toBe("verified");
    expect(settled.state).toBe("settled");
    expect(replay).toEqual(settled);
  });

  it("rejects chain, amount, deadline, signature, and replay drift", async () => {
    const service = facilitator();
    await expect(service.verify({ ...payment, chainId: 295 }, requirements)).rejects.toMatchObject({ code: "PAYMENT_REQUIREMENTS_MISMATCH" });
    await expect(service.verify({ ...payment, amount: "124999" }, requirements)).rejects.toMatchObject({ code: "PAYMENT_REQUIREMENTS_MISMATCH" });
    await expect(service.verify({ ...payment, deadline: Math.floor(now / 1000) - 1 }, requirements)).rejects.toMatchObject({ code: "PAYMENT_EXPIRED" });
    await expect(service.verify({ ...payment, signature: "0x12" }, requirements)).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
    await service.settle(payment, requirements, "settlement-idem-0002");
    await expect(service.settle(payment, requirements, "settlement-idem-0003")).rejects.toMatchObject({ code: "PAYMENT_REPLAY" });
  });

  it("persists an unknown settlement boundary and refuses a blind retry", async () => {
    const service = new LocalEvmFacilitator({
      chains: [296],
      proxies: { 295: proxy, 296: proxy },
      now: () => now,
      verifier: async () => true,
      settlement: { settle: async () => { throw new Error("transport lost"); } },
    });
    await expect(service.settle(payment, requirements, "settlement-unknown-0001"))
      .rejects.toMatchObject({ code: "PAYMENT_SETTLEMENT_UNKNOWN" });
    await expect(service.settle(payment, requirements, "settlement-unknown-0001"))
      .rejects.toMatchObject({ code: "PAYMENT_SETTLEMENT_UNKNOWN" });
  });

  it("fails closed when verifier or settlement wiring is missing", async () => {
    const service = new LocalEvmFacilitator({
      chains: [296],
      proxies: { 295: proxy, 296: proxy },
      now: () => now,
    });
    expect(service.readiness().ok).toBe(false);
    await expect(service.verify(payment, requirements)).rejects.toMatchObject({ code: "FACILITATOR_NOT_READY" });
  });

  it("separates process liveness from disabled execution readiness", async () => {
    const service = new LocalEvmFacilitator({
      chains: [296],
      proxies: { 295: proxy, 296: proxy },
      now: () => now,
    });
    const app = express();
    app.use(service.router());
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      const [live, health] = await Promise.all([
        fetch(`http://127.0.0.1:${address.port}/live`),
        fetch(`http://127.0.0.1:${address.port}/health`),
      ]);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ ok: true });
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, verificationReady: false, settlementReady: false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
