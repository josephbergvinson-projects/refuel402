import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";
import { journeySourceLegTypedData } from "../src/journey-source-leg-witness.js";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const account = getAddress(owner.address);
const journeyId = "74191800-9d5d-4ef2-b813-6b500b8e893e";
const quoteId = "b".repeat(64);
const journey = {
  id: journeyId,
  quoteId,
  mode: "mainnet",
  account,
  requestedProvider: "auto",
  selectedProvider: "axelar",
  assetId: "axelar:mainnet:usdc",
  originChainId: "1",
  state: "ready",
  createdAt: 1000,
  updatedAt: 2000,
  payment: null,
  authorizations: [],
  submissions: [],
  events: [{ id: 1, type: "journey_created", record: {}, createdAt: 1000 }],
} as any;
const quote = {
  quoteId,
  mode: "mainnet",
  account,
  requestedProvider: "auto",
  selectedProvider: "axelar",
  assetId: "axelar:mainnet:usdc",
  originChainId: "1",
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  executable: true,
  record: { quoteId, routeMode: "bridge_plus_refuel", bridge: { transaction: { to: account } } },
} as any;

/** The owner's EIP-712 consent for one specific replacement quote. */
function consent(
  signer: typeof owner,
  overrides: { journeyId?: string; quoteId?: string; originChainId?: string | number } = {},
) {
  return signer.signTypedData(journeySourceLegTypedData({
    journeyId: overrides.journeyId ?? journeyId,
    quoteId: overrides.quoteId ?? quoteId,
    account,
    mode: "mainnet",
    originChainId: overrides.originChainId ?? journey.originChainId,
  }) as any);
}

function ownedStore() {
  return {
    getJourney: vi.fn(async () => journey),
    refreshSourceQuote: vi.fn(async () => journey),
    getQuote: vi.fn(async () => quote),
  };
}

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

async function post(base: string, body: unknown) {
  return fetch(`${base}/v1/product/journeys/${journeyId}/source-quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("source leg consent witness", () => {
  it("is byte-for-byte the definition the browser signs", async () => {
    const browser = await import("../../web/wallet.js" as string);
    const input = {
      journeyId,
      quoteId,
      account,
      mode: "mainnet" as const,
      originChainId: "1",
    };
    const server = journeySourceLegTypedData(input);
    const client = browser.journeySourceLegTypedData(input);
    expect(client.domain).toEqual(server.domain);
    expect(client.primaryType).toBe(server.primaryType);
    expect(client.types).toEqual(server.types);
    expect(client.message).toEqual(server.message);
  });

  // The domain follows the journey's origin chain, not Hedera, so the signature
  // can be taken where the resend has already put the wallet.
  it("binds the domain to the journey's origin chain", () => {
    expect(journeySourceLegTypedData({
      journeyId, quoteId, account, mode: "mainnet", originChainId: "42161",
    }).domain.chainId).toBe(42161);
    expect(() => journeySourceLegTypedData({
      journeyId, quoteId, account, mode: "mainnet", originChainId: "not-a-chain",
    })).toThrow(/origin chain/);
  });
});

describe("same-journey source quote HTTP contract", () => {
  it("binds only the named live quote and returns the server recovery predicate", async () => {
    const store = ownedStore();
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
    try {
      const response = await post(base, { quoteId, confirmation: await consent(owner) });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        schema: "refuel402.source-quote-refresh.v1",
        journey: { id: journeyId, quoteId },
        quote: { quoteId },
        recovery: {
          nextAtomicStep: "source_wallet_consent",
          sameJourneyResendAllowed: true,
          replaySafe: false,
        },
      });
      // The recovered signer is handed to the store so it can be re-checked
      // against the row it actually locks.
      expect(store.refreshSourceQuote).toHaveBeenCalledWith({
        journeyId,
        quoteId,
        consentedAccount: account,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a malformed quote id before any mutation", async () => {
    const store = ownedStore();
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
    try {
      const response = await post(base, { quoteId: "bad", confirmation: await consent(owner) });
      expect(response.status).toBe(400);
      expect(store.refreshSourceQuote).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * A journey id is not a secret: `GET /journeys?account=` and `GET /journeys/:id`
   * are both unauthenticated, so an id plus a fingerprint-matching quote used to be
   * enough to re-bind a stranger's journey — which retires their unbroadcast
   * activation authorization and makes their already-signed activation fail at the
   * policy RPC, repeatably. Each case below must refuse BEFORE any mutation.
   */
  describe("refuses to act on an id alone", () => {
    it.each([
      ["no consent at all", async () => ({ quoteId })],
      ["a malformed signature", async () => ({ quoteId, confirmation: "0xdeadbeef" })],
      ["a stranger's signature", async () => ({ quoteId, confirmation: await consent(stranger) })],
      // Consent is spent on one replacement quote, so a captured signature cannot
      // authorize the next re-bind of the same journey.
      ["consent for a different replacement quote", async () => ({
        quoteId,
        confirmation: await consent(owner, { quoteId: "c".repeat(64) }),
      })],
      ["consent for a different journey", async () => ({
        quoteId,
        confirmation: await consent(owner, { journeyId: "5196311e-50a5-4717-8d0e-a83f586f60a3" }),
      })],
      ["consent bound to a different origin chain", async () => ({
        quoteId,
        confirmation: await consent(owner, { originChainId: 42161 }),
      })],
    ])("refuses %s", async (_label, build) => {
      const store = ownedStore();
      const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
      try {
        const response = await post(base, await build());
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(store.refreshSourceQuote).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
