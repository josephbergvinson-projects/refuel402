import { describe, expect, it, vi } from "vitest";
import { productFacilitatorReady } from "../src/product-readiness.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("product facilitator operational readiness", () => {
  it("accepts the exact ready private Railway mainnet facilitator", async () => {
    const fetcher = vi.fn(async () => response({
      ok: true,
      chains: ["eip155:295"],
      verificationReady: true,
      settlementReady: true,
    }));
    await expect(productFacilitatorReady({
      url: "http://refuel402-facilitator-testnet.railway.internal:4402",
      mode: "mainnet",
      fetcher,
    })).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://refuel402-facilitator-testnet.railway.internal:4402/health"),
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("fails closed on chain mismatch, partial readiness, public HTTP, or request failure", async () => {
    await expect(productFacilitatorReady({
      url: "https://facilitator.example",
      mode: "mainnet",
      fetcher: async () => response({ ok: true, chains: ["eip155:296"], verificationReady: true, settlementReady: true }),
    })).resolves.toBe(false);
    await expect(productFacilitatorReady({
      url: "https://facilitator.example",
      mode: "mainnet",
      fetcher: async () => response({ ok: true, chains: ["eip155:295"], verificationReady: true, settlementReady: false }),
    })).resolves.toBe(false);
    await expect(productFacilitatorReady({
      url: "http://facilitator.example",
      mode: "mainnet",
      fetcher: async () => response({ ok: true }),
    })).resolves.toBe(false);
    await expect(productFacilitatorReady({
      url: "https://facilitator.example",
      mode: "mainnet",
      fetcher: async () => { throw new Error("offline"); },
    })).resolves.toBe(false);
  });
});
