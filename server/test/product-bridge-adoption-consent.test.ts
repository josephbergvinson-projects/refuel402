import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { hashTypedData, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createProductLifecycleRouter, type ProductBridgeTracker } from "../src/product-lifecycle.js";
import type { ProductJourneyRecord, ProductLifecycleStore } from "../src/product-lifecycle-store.js";

const owner = privateKeyToAccount(`0x${"21".repeat(32)}`);
const journeyId = "journey-adoption-fixture";
const sourceTransactionHash = `0x${"12".repeat(32)}` as Hex;

// Shared off-chain adoption consent. No verifyingContract: this proves owner
// intent, it is not a contract call. Server verifier, browser signer, and this
// pin must agree byte-for-byte.
const adoptionTypes = {
  BridgeAdoption: [
    { name: "journeyId", type: "string" },
    { name: "account", type: "address" },
    { name: "sourceTransactionHash", type: "bytes32" },
    { name: "mode", type: "string" },
  ],
} as const;

function adoptionTypedData(mode: "testnet" | "mainnet") {
  return {
    domain: { name: "Refuel402", version: "1", chainId: mode === "mainnet" ? 295 : 296 },
    types: adoptionTypes,
    primaryType: "BridgeAdoption",
    message: { journeyId, account: owner.address, sourceTransactionHash, mode },
  } as const;
}

function journey(): ProductJourneyRecord {
  return {
    id: journeyId,
    quoteId: "a".repeat(64),
    mode: "testnet",
    account: owner.address,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:testnet:usdc",
    originChainId: "11155111",
    state: "arrival_confirmed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payment: null,
    authorizations: [],
    submissions: [],
    events: [],
  };
}

async function listen(tracker?: Partial<ProductBridgeTracker>): Promise<{
  server: Server;
  base: string;
  adopt: ReturnType<typeof vi.fn>;
}> {
  const adopt = vi.fn(async () => journey());
  const app = express();
  app.use(express.json());
  app.use("/v1/product", createProductLifecycleRouter({
    store: {} as ProductLifecycleStore,
    bridgeTracker: {
      submit: async () => journey(),
      status: async () => ({}),
      adopt,
      ...tracker,
    } as ProductBridgeTracker,
  }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}`, adopt };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/product/journeys/${journeyId}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("bridge adoption owner consent", () => {
  it("pins the shared EIP-712 adoption digest for both networks", () => {
    expect(hashTypedData(adoptionTypedData("testnet")))
      .toBe("0xc8589bf2a276fb83e57f23e328eee4658c9620c5ab076a8994c7ddda77a210fe");
    expect(hashTypedData(adoptionTypedData("mainnet")))
      .toBe("0xa2a8136d65dca066b352f7b922541117caa3bb1ad0a7fd6439c322c041fe980e");
  });

  it("produces a 65-byte signature that recovers to the connected account", async () => {
    const signature = await owner.signTypedData(adoptionTypedData("testnet"));
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    await expect(verifyTypedData({ ...adoptionTypedData("testnet"), address: owner.address, signature }))
      .resolves.toBe(true);
    await expect(verifyTypedData({ ...adoptionTypedData("mainnet"), address: owner.address, signature }))
      .resolves.toBe(false);
  });

  it("passes the owner signature through to the tracker without an idempotency key", async () => {
    const { server, base, adopt } = await listen();
    try {
      const signature = await owner.signTypedData(adoptionTypedData("testnet"));
      const response = await post(base, { sourceTransactionHash, confirmation: signature });
      expect(response.status).toBe(200);
      expect(adopt).toHaveBeenCalledWith(journeyId, sourceTransactionHash, signature);
    } finally {
      server.close();
    }
  });

  it.each([
    ["a boolean confirm flag", { sourceTransactionHash, confirm: true }],
    ["a missing confirmation", { sourceTransactionHash }],
    ["a truncated signature", { sourceTransactionHash, confirmation: `0x${"ab".repeat(32)}` }],
    ["a non-hex confirmation", { sourceTransactionHash, confirmation: `0xzz${"ab".repeat(64)}` }],
  ])("rejects %s without calling the tracker", async (_label, body) => {
    const { server, base, adopt } = await listen();
    try {
      const response = await post(base, body);
      expect(response.status).toBe(400);
      expect(adopt).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("stays 503 when the tracker cannot adopt", async () => {
    const { server, base } = await listen({ adopt: undefined });
    try {
      const signature = await owner.signTypedData(adoptionTypedData("testnet"));
      const response = await post(base, { sourceTransactionHash, confirmation: signature });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "PRODUCT_BRIDGE_TRACKER_NOT_READY" });
    } finally {
      server.close();
    }
  });
});
