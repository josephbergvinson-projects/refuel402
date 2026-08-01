import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";
import { journeySourceLegTypedData } from "../src/journey-source-leg-witness.js";
import {
  journeyNonce,
  refuelAuthorizationTypedData,
  refuelRouteHash,
} from "../src/refuel-authorization-witness.js";

const owner = privateKeyToAccount(`0x${"12".repeat(32)}`);
const journeyId = "74191800-9d5d-4ef2-b813-6b500b8e893e";
const quoteId = "a".repeat(64);
const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const spender = "0x6666666666666666666666666666666666666666" as const;
const token = "0x5555555555555555555555555555555555555555" as const;
const route = {
  wrapper: "0x1111111111111111111111111111111111111111" as const,
  htsToken: "0x2222222222222222222222222222222222222222" as const,
  router: "0x3333333333333333333333333333333333333333" as const,
  whbar: "0x4444444444444444444444444444444444444444" as const,
  wrapperRate: 10_000_000_000n,
  swapPath: "0x44444444444444444444444444444444444444440005dc2222222222222222222222222222222222222222" as `0x${string}`,
};

function journey() {
  return {
    id: journeyId,
    quoteId,
    mode: "testnet",
    account: owner.address,
    requestedProvider: "auto",
    selectedProvider: "layerzero",
    assetId: "layerzero:testnet:weth",
    originChainId: "11155111",
    state: "bridge_ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payment: null,
    refuelAuthorization: null,
    authorizations: [],
    submissions: [],
    events: [],
  } as any;
}

function quote() {
  return {
    quoteId,
    mode: "testnet",
    account: owner.address,
    requestedProvider: "auto",
    selectedProvider: "layerzero",
    assetId: "layerzero:testnet:weth",
    originChainId: "11155111",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    executable: true,
    record: {
      refuelAuthorization: {
        schema: "refuel402.refuel-authorization-terms.v1",
        enabled: true,
        permit2,
        spender,
        token,
        owner: owner.address,
        recipient: owner.address,
        maxAmountIn: "1000000000000000",
        exactHbarTinybar: "100000000",
        serviceFeeAmount: "10000000000000",
        maxSponsorExposureTinybar: "800000000",
        authorizationTtlSeconds: 7200,
        route: { ...route, wrapperRate: route.wrapperRate.toString() },
        routeHash: refuelRouteHash(route),
      },
    },
  } as any;
}

async function listen(store: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use("/v1/product", createProductLifecycleRouter({ store: store as any }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function signedBody(deadline: number) {
  const confirmation = await owner.signTypedData(journeySourceLegTypedData({
    journeyId,
    quoteId,
    account: owner.address,
    mode: "testnet",
    originChainId: "11155111",
  }));
  const terms = quote().record.refuelAuthorization;
  const authorization = {
    owner: owner.address,
    token,
    maxAmountIn: BigInt(terms.maxAmountIn),
    exactHbarTinybar: BigInt(terms.exactHbarTinybar),
    serviceFeeAmount: BigInt(terms.serviceFeeAmount),
    recipient: owner.address,
    journeyNonce: journeyNonce(journeyId),
    deadline: BigInt(deadline),
    routeHash: terms.routeHash,
  };
  const signature = await owner.signTypedData(refuelAuthorizationTypedData({
    chainId: 296,
    permit2,
    spender,
    authorization,
  }));
  return { confirmation, deadline: String(deadline), signature };
}

describe("POST refuel authorization", () => {
  it("verifies both owner signatures and persists only the server-derived terms", async () => {
    const recordRefuelAuthorization = vi.fn(async (input) => ({
      ...journey(),
      refuelAuthorization: { ...input, state: "recorded" },
    }));
    const store = {
      getJourney: vi.fn(async () => journey()),
      getEffectiveQuote: vi.fn(async () => quote()),
      recordRefuelAuthorization,
    };
    const { server, base } = await listen(store);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 7_000;
      const response = await fetch(`${base}/v1/product/journeys/${journeyId}/refuel-authorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await signedBody(deadline)),
      });
      expect(response.status).toBe(201);
      expect(recordRefuelAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        journeyId,
        owner: owner.address,
        maxAmountIn: "1000000000000000",
        exactHbarTinybar: "100000000",
        serviceFeeAmount: "10000000000000",
        maxSponsorExposureTinybar: "800000000",
        journeyNonce: journeyNonce(journeyId).toString(),
        routeHash: refuelRouteHash(route),
      }));
      const body = await response.json();
      expect(body.journey.refuelAuthorization.signature).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a witness signed for a different cap before persistence", async () => {
    const store = {
      getJourney: vi.fn(async () => journey()),
      getEffectiveQuote: vi.fn(async () => quote()),
      recordRefuelAuthorization: vi.fn(),
    };
    const { server, base } = await listen(store);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 7_000;
      const signed = await signedBody(deadline);
      const wrongAuthorization = {
        owner: owner.address,
        token,
        maxAmountIn: 999n,
        exactHbarTinybar: 100_000_000n,
        serviceFeeAmount: 100n,
        recipient: owner.address,
        journeyNonce: journeyNonce(journeyId),
        deadline: BigInt(deadline),
        routeHash: refuelRouteHash(route),
      };
      signed.signature = await owner.signTypedData(refuelAuthorizationTypedData({ chainId: 296, permit2, spender, authorization: wrongAuthorization }));
      const response = await fetch(`${base}/v1/product/journeys/${journeyId}/refuel-authorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).toBe(409);
      expect(store.recordRefuelAuthorization).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
