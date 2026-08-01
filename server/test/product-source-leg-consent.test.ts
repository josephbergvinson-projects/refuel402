import express from "express";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createProductLifecycleRouter } from "../src/product-lifecycle.js";
import { ProductLifecycleConflictError } from "../src/product-lifecycle-store.js";
import { journeySourceLegTypedData } from "../src/journey-source-leg-witness.js";

/**
 * Every source-leg mutation used to act on a journey id alone, and the per-journey
 * reads are unauthenticated — so a stranger who could enumerate an id could:
 *   - permanently brick a journey via /wallet-boundary (append-only event, read as
 *     blocked by three predicates, removable by no route, with no escape hatch),
 *   - foreclose abandon AND adoption via /bridge by binding an arbitrary hash,
 *   - make the SPONSOR spend real HBAR via /activate.
 *
 * These prove each route now refuses before it mutates anything.
 */
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const account = getAddress(owner.address);
const journeyId = "74191800-9d5d-4ef2-b813-6b500b8e893e";
const quoteId = "b".repeat(64);
const sourceHash = `0x${"cd".repeat(32)}`;

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

function consent(signer: typeof owner, overrides: { quoteId?: string; originChainId?: string } = {}) {
  return signer.signTypedData(journeySourceLegTypedData({
    journeyId,
    quoteId: overrides.quoteId ?? quoteId,
    account,
    mode: "mainnet",
    originChainId: overrides.originChainId ?? journey.originChainId,
  }) as any);
}

function harness() {
  const store = {
    getJourney: vi.fn(async () => journey),
    recordWalletBoundary: vi.fn(async () => journey),
    getQuote: vi.fn(async () => ({ quoteId, record: { quoteId } })),
  };
  const destinationActivator = vi.fn(async () => ({ required: true, funded: true, associated: true }));
  const bridgeTracker = { submit: vi.fn(async () => journey), status: vi.fn() };
  const router = createProductLifecycleRouter({
    store: store as any,
    destinationActivator: destinationActivator as any,
    bridgeTracker: bridgeTracker as any,
  });
  return { store, destinationActivator, bridgeTracker, router };
}

async function listen(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.requestId = "request-fixture";
    next();
  });
  app.use("/v1/product", router);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

const ROUTES = [
  {
    name: "/activate",
    path: "activate",
    body: (confirmation?: string) => (confirmation ? { confirmation } : {}),
    mutated: (h: ReturnType<typeof harness>) => h.destinationActivator,
  },
  {
    name: "/wallet-boundary",
    path: "wallet-boundary",
    body: (confirmation?: string) => ({ kind: "bridge", ...(confirmation ? { confirmation } : {}) }),
    mutated: (h: ReturnType<typeof harness>) => h.store.recordWalletBoundary,
  },
  {
    name: "/bridge",
    path: "bridge",
    body: (confirmation?: string) => ({
      sourceTransactionHash: sourceHash,
      ...(confirmation ? { confirmation } : {}),
    }),
    mutated: (h: ReturnType<typeof harness>) => h.bridgeTracker.submit,
  },
] as const;

describe("source leg consent gate", () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it("accepts the owner's consent", async () => {
        const h = harness();
        const { server, base } = await listen(h.router);
        try {
          const response = await fetch(`${base}/v1/product/journeys/${journeyId}/${route.path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(route.body(await consent(owner))),
          });
          expect(response.status).toBe(200);
          expect(route.mutated(h)).toHaveBeenCalled();
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });

      it.each([
        ["no consent", async () => undefined],
        ["a malformed signature", async () => "0xdeadbeef"],
        ["a stranger's signature", async () => await consent(stranger)],
        // Consent is spent on the quote the journey is on, so one taken for a
        // re-priced quote cannot be replayed onto this leg.
        ["consent for a different quote", async () => await consent(owner, { quoteId: "c".repeat(64) })],
        ["consent bound to another origin chain", async () => await consent(owner, { originChainId: "42161" })],
      ])("refuses %s without mutating anything", async (_label, build) => {
        const h = harness();
        const { server, base } = await listen(h.router);
        try {
          const response = await fetch(`${base}/v1/product/journeys/${journeyId}/${route.path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(route.body(await build() as string | undefined)),
          });
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(route.mutated(h)).not.toHaveBeenCalled();
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    });
  }

  /**
   * The activation intent is the source leg's sponsored step: it reserves sponsor
   * exposure and retires the owner's live activation authorization. Destination-leg
   * kinds run after arrival with the wallet on Hedera, so an origin-chain consent
   * cannot cover them and they are deliberately not gated here.
   */
  describe("/intents/:kind/authorize", () => {
    function intentHarness() {
      const intentBuilder = vi.fn(async () => ({ transaction: {}, authorization: {} }));
      const store = { getJourney: vi.fn(async () => journey) };
      return {
        intentBuilder,
        router: createProductLifecycleRouter({ store: store as any, intentBuilder: intentBuilder as any }),
      };
    }

    async function authorize(base: string, kind: string, body: unknown) {
      return fetch(`${base}/v1/product/journeys/${journeyId}/intents/${kind}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "authorize-fixture-0001" },
        body: JSON.stringify(body),
      });
    }

    it("refuses an activation authorization with no consent, before building anything", async () => {
      const h = intentHarness();
      const { server, base } = await listen(h.router);
      try {
        const response = await authorize(base, "activation", {});
        expect(response.status).toBe(400);
        expect(h.intentBuilder).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("refuses an activation authorization signed by a stranger", async () => {
      const h = intentHarness();
      const { server, base } = await listen(h.router);
      try {
        const response = await authorize(base, "activation", { confirmation: await consent(stranger) });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(h.intentBuilder).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    /**
     * Past the gate is the claim. This harness stops short of the full
     * quote/sponsor wiring, so the request still fails afterwards — what matters
     * is that it is no longer the CONSENT that refuses it.
     */
    it("lets the owner's consent past the gate", async () => {
      const h = intentHarness();
      const { server, base } = await listen(h.router);
      try {
        const response = await authorize(base, "activation", { confirmation: await consent(owner) });
        expect(JSON.stringify(await response.json())).not.toMatch(/consent/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("leaves destination-leg kinds ungated, since an origin-chain consent cannot cover them", async () => {
      const h = intentHarness();
      const { server, base } = await listen(h.router);
      try {
        const response = await authorize(base, "permit2_approval", {});
        expect(JSON.stringify(await response.json())).not.toMatch(/consent/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  /**
   * An `eth_estimateGas` failure while preparing the activation intent used to
   * reach the owner as "product lifecycle request failed" — the server knew the
   * cause, logged it, and told the owner a sentence they could do nothing with.
   * That is the same silent-failure class the client-side guards were written to
   * remove, on the other side of the wire.
   */
  it("names an upstream Hedera read failure instead of answering with a generic error", async () => {
    const store = { getJourney: vi.fn(async () => journey) };
    const intentBuilder = {
      build: vi.fn(async () => {
        throw new Error("rpc eth_estimateGas: [Request ID: abc] Error occurred during transaction simulation: Sender account not found.");
      }),
    };
    const router = createProductLifecycleRouter({ store: store as any, intentBuilder: intentBuilder as any });
    const { server, base } = await listen(router);
    try {
      const response = await fetch(`${base}/v1/product/journeys/${journeyId}/intents/activation/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "upstream-failure-0001" },
        body: JSON.stringify({ quoteId, confirmation: await consent(owner) }),
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { code: string; message: string; retriable: boolean };
      expect(body.code).toBe("UPSTREAM_READ_UNAVAILABLE");
      expect(body.retriable).toBe(true);
      expect(body.message).toContain("Nothing was sent or spent");
      // The relay's own words are logged, never handed to the owner.
      expect(body.message).not.toContain("eth_estimateGas");
      expect(body.message).not.toContain("Request ID");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // arrivalContinuation is a SECOND, independent answer to "what happens next"
  // and it never asked whether a refuel was already running. So while the
  // executor converted, recovery correctly said poll_refuel and this still said
  // destination_wallet_consent — which is what put a manual "Approve conversion"
  // panel in front of an owner whose refuel was already authorized.
  it.each(["recorded", "executing", "retry_scheduled"])(
    "never offers manual destination consent while a refuel authorization is %s",
    async (authState) => {
      const arrived = {
        ...journey,
        state: "arrival_confirmed",
        refuelAuthorization: { state: authState },
        events: [{ type: "bridge_arrived", record: {}, createdAt: Date.now() }],
      };
      const store = {
        getJourney: vi.fn(async () => arrived),
        getEffectiveQuote: vi.fn(async () => ({
          quoteId,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          executable: true,
          record: { quoteId, routeMode: "bridge_plus_refuel" },
        })),
      };
      const { server, base } = await listen(createProductLifecycleRouter({ store: store as any }));
      try {
        const body = await (await fetch(`${base}/v1/product/journeys/${journeyId}`)).json();
        expect(body.continuation.nextAction).not.toBe("destination_wallet_consent");
        expect(body.continuation.ready).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  // A revert is not a failed read. Classified as one, this told the owner to wait
  // out a Hedera outage that did not exist while the association was simply still
  // landing — and association is part of the flow, not a chore.
  it("names a still-landing token association instead of reporting a network outage", async () => {
    const store = { getJourney: vi.fn(async () => journey), createAuthorization: vi.fn() };
    const intentBuilder = {
      build: vi.fn(async () => {
        throw new Error("rpc eth_estimateGas: [Request ID: abc] execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
      }),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, base } = await listen(createProductLifecycleRouter({ store: store as any, intentBuilder: intentBuilder as any }));
    try {
      const response = await fetch(`${base}/v1/product/journeys/${journeyId}/intents/permit2_approval/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "association-lag-fixture" },
        body: JSON.stringify({ quoteId }),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "DESTINATION_TOKEN_NOT_ASSOCIATED", retriable: true });
      expect(body.message).not.toContain("network read failed");
      expect(store.createAuthorization).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns and logs a correlated non-retriable code for malformed stored quote intent data", async () => {
    const createAuthorization = vi.fn();
    const store = {
      getJourney: vi.fn(async () => journey),
      createAuthorization,
    };
    const intentBuilder = {
      build: vi.fn(async () => {
        throw new ProductLifecycleConflictError(
          "STORED_QUOTE_INVALID",
          "stored quote refuelCap.maxAmountIn is invalid",
          { field: "refuelCap.maxAmountIn" },
        );
      }),
    };
    const originalDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
    process.env.RAILWAY_DEPLOYMENT_ID = "deployment-fixture";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createProductLifecycleRouter({ store: store as any, intentBuilder: intentBuilder as any });
    const { server, base } = await listen(router);
    try {
      const response = await fetch(`${base}/v1/product/journeys/${journeyId}/intents/permit2_approval/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "malformed-quote-fixture" },
        body: JSON.stringify({ quoteId }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: "STORED_QUOTE_INVALID",
        retriable: false,
        details: { field: "refuelCap.maxAmountIn" },
      });
      expect(createAuthorization).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[product-lifecycle] stored quote rejected", expect.objectContaining({
        requestId: "request-fixture",
        journeyId,
        quoteId,
        intentKind: "permit2_approval",
        deploymentId: "deployment-fixture",
        code: "STORED_QUOTE_INVALID",
      }));
    } finally {
      log.mockRestore();
      if (originalDeploymentId === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
      else process.env.RAILWAY_DEPLOYMENT_ID = originalDeploymentId;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The recovered signer is threaded into the store so it can be re-asserted
  // against the row the store actually locks; verifying only at the route trusts
  // a pre-lock snapshot another transaction could move.
  it("hands the recovered account to recordWalletBoundary for the locked-row re-check", async () => {
    const h = harness();
    const { server, base } = await listen(h.router);
    try {
      await fetch(`${base}/v1/product/journeys/${journeyId}/wallet-boundary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bridge", confirmation: await consent(owner) }),
      });
      expect(h.store.recordWalletBoundary).toHaveBeenCalledWith({
        journeyId,
        kind: "bridge",
        consentedAccount: account,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
