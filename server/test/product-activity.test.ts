import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const journey = {
  id: "74191800-9d5d-4ef2-b813-6b500b8e893e",
  quoteId: "a".repeat(64),
  mode: "mainnet",
  account,
  requestedProvider: "auto",
  selectedProvider: "layerzero",
  assetId: "layerzero:mainnet:wbtc",
  originChainId: "1",
  state: "ready",
  createdAt: 1000,
  updatedAt: 2000,
  payment: null,
  authorizations: [{ intentKind: "activation", state: "expired", rawTransactionHash: null }],
  submissions: [],
  events: [{ type: "destination_activation_funded" }],
} as any;
const quote = {
  quoteId: "a".repeat(64),
  mode: "mainnet",
  account,
  requestedProvider: "auto",
  selectedProvider: "layerzero",
  assetId: "layerzero:mainnet:wbtc",
  originChainId: "1",
  expiresAt: 1,
  executable: true,
  record: {
    routeMode: "bridge_plus_refuel",
    asset: { symbol: "WBTC", destination: { decimals: 8 } },
    bridge: { normalized: { sourceAmount: { amount: "6000", decimals: 8, symbol: "WBTC" } } },
    amountLedger: {
      destination: { remainingAtMinimum: "4664" },
      hbar: { exactOutputTinybar: "300000000" },
    },
  },
} as any;

async function listen(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/v1/product", router);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe("product Activity HTTP contract", () => {
  it("returns minimal bounded summaries and never invokes a mutation method", async () => {
    const store = {
      listJourneysForAccount: vi.fn(async () => ({
        journeys: [journey],
        nextCursor: { active: false, updatedAt: 2000, journeyId: journey.id },
      })),
      getEffectiveQuote: vi.fn(async () => quote),
      createJourney: vi.fn(),
      recordPayment: vi.fn(),
      createAuthorization: vi.fn(),
    };
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
    try {
      const response = await fetch(`${base}/v1/product/journeys?account=${account}&limit=8`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        schema: "refuel402.product-activity.v2",
        account,
        nextBefore: { active: false, updatedAt: 2000, journeyId: journey.id },
        items: [{
          journeyId: journey.id,
          state: "ready",
          action: "resume",
          assetSymbol: "WBTC",
          sourceAmount: { amount: "6000", decimals: 8, symbol: "WBTC" },
          minimumRetained: "4664",
          exactHbarTinybar: "300000000",
          recovery: { nextAtomicStep: "source_wallet_consent" },
          // Sponsor-funded activation alone does not make a draft history: the
          // HBAR is already in the owner's own account.
          abandonable: true,
        }],
      });
      expect(store.listJourneysForAccount).toHaveBeenCalledWith(account, { limit: 8, cursor: null, includeAbandoned: false });
      expect(store.createJourney).not.toHaveBeenCalled();
      expect(store.recordPayment).not.toHaveBeenCalled();
      expect(store.createAuthorization).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects malformed account, limit, and cursor before a store read", async () => {
    const store = { listJourneysForAccount: vi.fn() };
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
    try {
      for (const query of [
        "account=bad",
        `account=${account}&limit=21`,
        `account=${account}&before=0`,
        `account=${account}&before=2000`,
        `account=${account}&before=2000&beforeJourneyId=${journey.id}`,
        `account=${account}&before=2000&beforeActive=false`,
      ]) {
        const response = await fetch(`${base}/v1/product/journeys?${query}`);
        expect(response.status).toBe(400);
      }
      expect(store.listJourneysForAccount).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("threads the complete composite cursor into the store", async () => {
    const store = {
      listJourneysForAccount: vi.fn(async () => ({ journeys: [], nextCursor: null })),
    };
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
    try {
      const response = await fetch(
        `${base}/v1/product/journeys?account=${account}&limit=8&before=2000&beforeJourneyId=${journey.id}&beforeActive=true`,
      );
      expect(response.status).toBe(200);
      expect(store.listJourneysForAccount).toHaveBeenCalledWith(account, {
        limit: 8,
        cursor: { active: true, updatedAt: 2000, journeyId: journey.id },
        includeAbandoned: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
