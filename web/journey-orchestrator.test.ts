import { describe, expect, it, vi } from "vitest";
import { JourneyOrchestrator } from "./journey-orchestrator.js";

const SOURCE_LEG_CONSENT = `0x${"ab".repeat(65)}`;
const account = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}`;
const quote = {
  quoteId: "a".repeat(64),
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  asset: {
    destination: {
      arrival: "activation_required",
      standard: "HTS",
      address: "0x00000000000000000000000000000000009cf1ae",
    },
  },
  bridge: {
    originChainId: "1",
    originApproval: {
      token: "0x2222222222222222222222222222222222222222",
      spender: "0x3333333333333333333333333333333333333333",
      amount: "1000",
    },
    transaction: {
      to: "0x3333333333333333333333333333333333333333",
      data: "0x1234",
      value: "0",
    },
  },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("JourneyOrchestrator", () => {
  it("preserves the Window receiver when the browser fetch default is used", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function receiverSensitiveFetch(this: typeof globalThis, url: string | URL | Request) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(json({ ok: true, url: String(url) }));
    } as typeof globalThis.fetch;
    try {
      const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet: {} });
      await expect(orchestrator.request("/v1/product/journeys")).resolves.toEqual({
        ok: true,
        url: "https://api.example/v1/product/journeys",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["axelar", "layerzero"])(
    "uses the shared receiver-safe client and reaches the %s wallet-consent boundary",
    async (provider) => {
      const originalFetch = globalThis.fetch;
      const requests: { path: string; method: string }[] = [];
      globalThis.fetch = function receiverSensitiveFetch(
        this: typeof globalThis,
        input: string | URL | Request,
        init: RequestInit = {},
      ) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        const path = new URL(String(input)).pathname;
        const method = init.method ?? "GET";
        requests.push({ path, method });
        if (path === "/v1/product/journeys" && method === "POST") {
          return Promise.resolve(json({ journey: { id: `journey-${provider}` } }, 201));
        }
        if (path.endsWith("/activate") && method === "POST") {
          return Promise.resolve(json({ required: true, funded: false, associated: true }));
        }
        if (path.endsWith("/wallet-boundary") && method === "POST") {
          return Promise.resolve(json({ journey: { state: "ready" } }));
        }
        throw new Error(`unexpected ${method} ${path}`);
      } as typeof globalThis.fetch;
      const wallet = {
        switchChain: vi.fn(async () => undefined),
        chainId: 1,
        signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
        tokenAllowance: vi.fn(async () => 1000n),
        sendTransaction: vi.fn(async () => {
          throw new Error("WALLET_CONSENT_BOUNDARY");
        }),
      };
      try {
        const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet });
        await expect(orchestrator.run({
          quote: { ...quote, bridge: { ...quote.bridge, provider } },
          mode: "mainnet",
          account,
        })).rejects.toThrow("WALLET_CONSENT_BOUNDARY");
        expect(requests).toEqual([
          { path: "/v1/product/journeys", method: "POST" },
          { path: `/v1/product/journeys/journey-${provider}/activate`, method: "POST" },
          { path: `/v1/product/journeys/journey-${provider}/wallet-boundary`, method: "POST" },
        ]);
        expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
        expect(requests.some((request) => request.path.endsWith("/bridge"))).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("records one Hedera refuel witness before switching back for the origin bridge", async () => {
    const requests: { path: string; body: any }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, body });
      if (path === "/v1/product/journeys") return json({ journey: { id: "journey-preauthorized" } }, 201);
      if (path.endsWith("/activate")) return json({ associated: true, journey: { state: "bridge_ready" } });
      if (path.endsWith("/refuel-authorization")) return json({ authorization: { state: "recorded" } }, 201);
      if (path.endsWith("/wallet-boundary")) return json({ journey: { state: "bridge_ready" } });
      throw new Error(`unexpected ${path}`);
    });
    const wallet = {
      chainId: 1,
      switchChain: vi.fn(async () => undefined),
      switchToHedera: vi.fn(async () => undefined),
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
      signRefuelAuthorization: vi.fn(async () => ({
        signature: `0x${"cd".repeat(65)}`,
        deadline: String(Math.floor(Date.now() / 1000) + 7_200),
      })),
      tokenAllowance: vi.fn(async () => 1000n),
      sendTransaction: vi.fn(async () => { throw new Error("WALLET_CONSENT_BOUNDARY"); }),
    };
    const preauthorizedQuote = {
      ...quote,
      routeMode: "bridge_plus_refuel",
      refuelAuthorization: {
        schema: "refuel402.refuel-authorization-terms.v1",
        enabled: true,
        authorizationTtlSeconds: 7200,
      },
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    await expect(orchestrator.run({ quote: preauthorizedQuote, mode: "mainnet", account }))
      .rejects.toThrow("WALLET_CONSENT_BOUNDARY");
    expect(wallet.switchToHedera).toHaveBeenCalledTimes(1);
    expect(wallet.signRefuelAuthorization).toHaveBeenCalledTimes(1);
    const paths = requests.map((request) => request.path);
    expect(paths.indexOf("/v1/product/journeys/journey-preauthorized/refuel-authorization"))
      .toBeLessThan(paths.indexOf("/v1/product/journeys/journey-preauthorized/wallet-boundary"));
    expect(requests.find((request) => request.path.endsWith("/refuel-authorization"))?.body)
      .toMatchObject({ confirmation: SOURCE_LEG_CONSENT, signature: `0x${"cd".repeat(65)}` });
  });

  it("rebinds a live quote and resends the same journey without creating or re-sponsoring activation", async () => {
    const requests: { path: string; method: string }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      requests.push({ path, method });
      if (path.endsWith("/source-quote") && method === "POST") {
        return json({ journey: { id: "journey-existing" }, quote });
      }
      if (path.endsWith("/activate") && method === "POST") {
        return json({ required: true, funded: true, associated: true });
      }
      if (path.endsWith("/wallet-boundary") && method === "POST") return json({ journey: { state: "ready" } });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wallet = {
      switchChain: vi.fn(async () => undefined),
      chainId: 1,
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
      tokenAllowance: vi.fn(async () => 1000n),
      sendTransaction: vi.fn(async () => { throw new Error("WALLET_CONSENT_BOUNDARY"); }),
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    // The owner's EIP-712 consent must reach the server: without it the route
    // refuses, because a journey id alone may not re-bind somebody's journey.
    const confirmation = `0x${"ab".repeat(65)}`;
    await expect(orchestrator.refreshSourceQuote({
      journeyId: "journey-existing",
      quoteId: quote.quoteId,
      confirmation,
    })).resolves.toMatchObject({ journey: { id: "journey-existing" }, quote: { quoteId: quote.quoteId } });
    const rebind = fetcher.mock.calls.find(([url]) => String(url).endsWith("/source-quote"));
    expect(JSON.parse(String(rebind?.[1]?.body))).toEqual({ quoteId: quote.quoteId, confirmation });
    await expect(orchestrator.run({ quote, mode: "mainnet", account, journeyId: "journey-existing" }))
      .rejects.toThrow("WALLET_CONSENT_BOUNDARY");
    expect(requests.some((request) => request.path === "/v1/product/journeys" && request.method === "POST")).toBe(false);
    expect(requests.some((request) => request.path.includes("/intents/activation/authorize"))).toBe(false);
    expect(requests).toContainEqual({ path: "/v1/product/journeys/journey-existing/wallet-boundary", method: "POST" });
  });

  it("does not sponsor activation again while a prior confirmation is still indexing", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith("/activate") && (init.method ?? "GET") === "POST") {
        return json({
          required: true,
          funded: true,
          associated: false,
          journey: { events: [{ type: "intent_activation_confirmed" }] },
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    // The leg takes one consent before its first mutation, so even a path that
    // refuses needs a wallet able to sign; the assertion is that nothing was SENT.
    const wallet = {
      chainId: 1,
      switchChain: vi.fn(async () => undefined),
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    await expect(orchestrator.run({ quote, mode: "mainnet", account, journeyId: "journey-existing" }))
      .rejects.toThrow("Nothing was sent again");
    expect(requests.some((path) => path.includes("/intents/activation/authorize"))).toBe(false);
    expect(requests.some((path) => path.endsWith("/wallet-boundary"))).toBe(false);
  });

  it("runs activation, bridge tracking, fresh destination quote, custom x402, sponsored intents, and reconciliation", async () => {
    const phases: string[] = [];
    const requests: { url: string; method: string; body: any }[] = [];
    let bridgePoll = 0;
    let paymentCalls = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: path, method, body });
      if (path === "/v1/product/journeys" && method === "POST") {
        return json({ journey: { id: "journey-1" } }, 201);
      }
      if (path.endsWith("/activate")) return json({ required: true, funded: true, associated: false });
      if (path.endsWith("/wallet-boundary") && method === "POST") return json({ journey: { state: "ready" } });
      if (path.endsWith("/bridge") && method === "POST") return json({ journey: { state: "bridge_pending" } });
      if (path.endsWith("/bridge") && method === "GET") {
        bridgePoll += 1;
        return bridgePoll === 1
          ? json({ transfer: { state: "pending" }, arrival: { confirmed: false } })
          : json({ transfer: { state: "arrived" }, arrival: { confirmed: true } });
      }
      if (path.endsWith("/destination-quote")) return json({ quote: { ...quote, quoteId: "b".repeat(64) } });
      if (/\/intents\/.+\/authorize$/.test(path)) {
        return json({ transaction: { from: account, to: account, data: "0x", value: "0", gas: "100000" } });
      }
      if (path === "/v1/product/journeys/journey-1" && method === "GET") {
        const latestKind = [...requests].reverse().find((request) => /\/intents\/.+\/authorize$/.test(request.url))?.url.split("/").at(-2);
        return json({ journey: { authorizations: [{ intentKind: latestKind, ethereumHash: hash, state: "submitted" }] } });
      }
      if (/\/intents\/.+\/confirm$/.test(path)) return json({ journey: { state: "authorizing" } });
      if (path.endsWith("/payment")) {
        paymentCalls += 1;
        return paymentCalls === 1
          ? json({
              x402Version: 2,
              accepts: [],
              refuel402: { schema: "refuel402.exact-permit2-payment-required.v1" },
            }, 402, { "payment-required": "challenge" })
          : json({ payment: { state: "settled" } });
      }
      if (path.endsWith("/reconcile")) return json({ journey: { state: "completed" } });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wallet = {
      switchToHedera: vi.fn(async () => undefined),
      switchChain: vi.fn(async () => undefined),
      chainId: 1,
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
      tokenAllowance: vi.fn(async () => 0n),
      approveToken: vi.fn(async () => hash),
      sendTransaction: vi.fn(async () => hash),
      transactionReceipt: vi.fn(async () => ({ status: "0x1", transactionHash: hash })),
      createPaymentHeaders: vi.fn(async () => ({ "PAYMENT-SIGNATURE": "signed" })),
    };
    const orchestrator = new JourneyOrchestrator({
      apiBase: "https://api.example",
      wallet,
      fetcher,
      sleep: async () => undefined,
      onPhase: (phase: string) => phases.push(phase),
      maxReceiptPolls: 2,
      maxBridgePolls: 3,
    });

    const staged = await orchestrator.run({ quote, mode: "mainnet", account });
    expect(staged).toMatchObject({
      journeyId: "journey-1",
      status: "action_required",
      recovery: { nextAtomicStep: "destination_wallet_consent" },
      quote: { quoteId: "b".repeat(64) },
    });
    expect(phases).toEqual([
      "activating_destination",
      "submitting_bridge",
      "bridge_pending",
      "arrival_confirmed",
      "arrival_confirmed",
    ]);
    expect(requests.some((request) => request.url.endsWith("/payment"))).toBe(false);

    await expect(orchestrator.continueRefuel({
      journeyId: staged.journeyId,
      quote: staged.quote,
      mode: "mainnet",
      account,
    })).resolves.toMatchObject({
      journeyId: "journey-1",
      result: { journey: { state: "completed" } },
    });
    expect(phases.slice(-6)).toEqual([
      "approving_payment_asset",
      "authorizing_x402",
      "settling_x402",
      "executing_refuel",
      "reconciling",
      "completed",
    ]);
    expect(wallet.approveToken).toHaveBeenCalledWith(
      quote.bridge.originApproval.token,
      quote.bridge.originApproval.spender,
      quote.bridge.originApproval.amount,
      account,
    );
    expect(wallet.createPaymentHeaders).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.url.endsWith("/bridge") && request.method === "GET")).toHaveLength(2);
    expect(requests.some((request) => request.url.endsWith("/destination-quote"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/reconcile") && request.body.ethereumHash === hash)).toBe(true);
  });

  it("completes bridge-only mode after authoritative arrival without destination payment or swap", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      requests.push(`${init.method ?? "GET"} ${path}`);
      if (path === "/v1/product/journeys") return json({ journey: { id: "journey-bridge-only" } }, 201);
      if (path.endsWith("/activate")) return json({ required: false, funded: true, associated: true });
      if (path.endsWith("/wallet-boundary")) return json({ journey: { state: "ready" } });
      if (path.endsWith("/bridge") && init.method === "POST") return json({ journey: { state: "bridge_pending" } });
      if (path.endsWith("/bridge")) return json({
        transfer: { state: "arrived", providerStatus: "success" },
        arrival: { confirmed: true },
        journey: { state: "completed" },
      });
      throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
    });
    const wallet = {
      switchChain: vi.fn(async () => undefined),
      chainId: 1,
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
      tokenAllowance: vi.fn(async () => 1000n),
      sendTransaction: vi.fn(async () => hash),
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher, sleep: async () => undefined });
    await expect(orchestrator.run({ quote: { ...quote, routeMode: "bridge_only" }, mode: "mainnet", account }))
      .resolves.toMatchObject({ journeyId: "journey-bridge-only", result: { journey: { state: "completed" } } });
    expect(requests.some((request) => request.endsWith("/destination-quote"))).toBe(false);
    expect(requests.some((request) => request.endsWith("/payment"))).toBe(false);
  });

  it("recovers bridge polling without any wallet signing or resubmission", async () => {
    let journeyReads = 0;
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/bridge")) return json({
        transfer: { state: "arrived", providerStatus: "success" },
        arrival: { confirmed: true },
        journey: { state: "arrival_confirmed" },
      });
      if (path === "/v1/product/journeys/journey-recovery") {
        journeyReads += 1;
        return journeyReads === 1
          ? json({
              journey: { id: "journey-recovery", account, state: "bridge_pending" },
              quote: { ...quote, routeMode: "bridge_plus_refuel" },
              recovery: { disposition: "resume_safe", nextAtomicStep: "poll_bridge", replaySafe: true, routeMode: "bridge_plus_refuel" },
            })
          : json({
              journey: { id: "journey-recovery", account, state: "arrival_confirmed" },
              quote: { ...quote, routeMode: "bridge_plus_refuel" },
              recovery: { disposition: "action_required", nextAtomicStep: "destination_wallet_consent", replaySafe: false, routeMode: "bridge_plus_refuel" },
            });
      }
      throw new Error(`unexpected ${path}`);
    });
    const wallet = { sendTransaction: vi.fn(), approveToken: vi.fn(), createPaymentHeaders: vi.fn() };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher, sleep: async () => undefined });
    await expect(orchestrator.resume({ journeyId: "journey-recovery", account })).resolves.toMatchObject({
      status: "action_required",
      recovery: { nextAtomicStep: "destination_wallet_consent" },
    });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(wallet.approveToken).not.toHaveBeenCalled();
    expect(wallet.createPaymentHeaders).not.toHaveBeenCalled();
  });

  it("refreshes a recovery quote without authorization, wallet, payment, or submission", async () => {
    const refreshedQuote = { ...quote, quoteId: "c".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 120 };
    const requests: { path: string; method: string }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ path: new URL(url).pathname, method: init.method ?? "GET" });
      return json({ quote: refreshedQuote });
    });
    const wallet = {
      switchToHedera: vi.fn(),
      sendTransaction: vi.fn(),
      createPaymentHeaders: vi.fn(),
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    await expect(orchestrator.refreshDestinationQuote({ journeyId: "journey-recovery" })).resolves.toEqual(refreshedQuote);
    expect(requests).toEqual([{ path: "/v1/product/journeys/journey-recovery/destination-quote", method: "POST" }]);
    expect(wallet.switchToHedera).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(wallet.createPaymentHeaders).not.toHaveBeenCalled();
  });

  it("refuses expired recovery consent before any API or wallet mutation", async () => {
    const fetcher = vi.fn();
    const wallet = { switchToHedera: vi.fn(), sendTransaction: vi.fn() };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    await expect(orchestrator.continueRefuel({
      journeyId: "journey-recovery",
      quote: { ...quote, expiresAt: Math.floor(Date.now() / 1000) - 1 },
      mode: "mainnet",
      account,
    })).rejects.toThrow("destination quote expired");
    expect(fetcher).not.toHaveBeenCalled();
    expect(wallet.switchToHedera).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("tolerates transient bridge status fetch failures without abandoning the durable hash", async () => {
    let polls = 0;
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/bridge")) {
        polls += 1;
        if (polls <= 5) throw new TypeError("network flake");
        return json({ transfer: { state: "arrived", providerStatus: "success" }, arrival: { confirmed: true } });
      }
      throw new Error(`unexpected ${path}`);
    });
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet: {}, fetcher, sleep: async () => undefined });
    await expect(orchestrator.waitForBridge("journey-flaky")).resolves.toMatchObject({ transfer: { state: "arrived" } });
    expect(polls).toBe(6);
  });

  it("stops after more than five consecutive bridge status fetch failures", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("network down"); });
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet: {}, fetcher, sleep: async () => undefined });
    await expect(orchestrator.waitForBridge("journey-down")).rejects.toThrow("network down");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("keeps recovery polling through a 17-minute bridge with 5s-then-15s backoff", async () => {
    const delays: number[] = [];
    let elapsedMs = 0;
    const arrivalAtMs = 17 * 60 * 1000;
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/bridge")) {
        return elapsedMs >= arrivalAtMs
          ? json({ transfer: { state: "arrived", providerStatus: "success" }, arrival: { confirmed: true } })
          : json({ transfer: { state: "pending", providerStatus: "ongoing" }, arrival: { confirmed: false } });
      }
      if (path === "/v1/product/journeys/journey-long") {
        return elapsedMs >= arrivalAtMs
          ? json({
              journey: { id: "journey-long", account, state: "arrival_confirmed" },
              quote: { ...quote, routeMode: "bridge_plus_refuel" },
              recovery: { disposition: "action_required", nextAtomicStep: "destination_wallet_consent", replaySafe: false, routeMode: "bridge_plus_refuel" },
            })
          : json({
              journey: { id: "journey-long", account, state: "bridge_pending" },
              quote: { ...quote, routeMode: "bridge_plus_refuel" },
              recovery: { disposition: "resume_safe", nextAtomicStep: "poll_bridge", replaySafe: true, routeMode: "bridge_plus_refuel" },
            });
      }
      throw new Error(`unexpected ${path}`);
    });
    const orchestrator = new JourneyOrchestrator({
      apiBase: "https://api.example",
      wallet: {},
      fetcher,
      sleep: async (ms: number) => { delays.push(ms); elapsedMs += ms; },
    });
    await expect(orchestrator.resume({ journeyId: "journey-long", account })).resolves.toMatchObject({
      status: "action_required",
      recovery: { nextAtomicStep: "destination_wallet_consent" },
    });
    expect(delays.slice(0, 12)).toEqual(Array(12).fill(5_000));
    expect(delays.slice(12).every((ms) => ms === 15_000)).toBe(true);
    expect(delays.length).toBeGreaterThan(12);
    expect(delays.length).toBeLessThan(188);
  });

  it("keeps a v2 journey read pure when the server marks destination refresh as the next action", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      requests.push(`${init.method ?? "GET"} ${path}`);
      return json({
        journey: { id: "journey-read", account, state: "arrival_confirmed" },
        quote: { ...quote, expiresAt: 1 },
        recovery: { disposition: "action_required", nextAtomicStep: "destination_wallet_consent", replaySafe: false, routeMode: "bridge_plus_refuel" },
        continuation: { schema: "refuel402.arrival-continuation.v2", ready: false, nextAction: "refresh_destination_quote", error: null },
      });
    });
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet: {}, fetcher });
    const decision = await orchestrator.fetchJourneyDecision("journey-read");
    expect(requests).toEqual(["GET /v1/product/journeys/journey-read"]);
    expect(decision.continuation.nextAction).toBe("refresh_destination_quote");
    expect(decision.quote.expiresAt).toBe(1);
  });

  it("leaves v1 continuation reads untouched for backward compatibility", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      return json({
        journey: { id: "journey-v1", account, state: "arrival_confirmed" },
        quote,
        recovery: { disposition: "action_required", nextAtomicStep: "destination_wallet_consent", replaySafe: false, routeMode: "bridge_plus_refuel" },
        continuation: { schema: "refuel402.arrival-continuation.v1", attempted: true, ready: true, error: null, nextAction: "destination_wallet_consent" },
      });
    });
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet: {}, fetcher });
    await orchestrator.fetchJourneyDecision("journey-v1");
    expect(requests).toEqual(["GET /v1/product/journeys/journey-v1"]);
  });

  // Every sponsored leg needs 30s of authorization runway while a destination
  // quote never lives past ~60s, so the server answers a thin quote with 409
  // QUOTE_EXPIRES_TOO_SOON and the client is expected to refresh and retry.
  function refuelHarness({
    tooSoonFor = new Map<string, number>(),
    destinationQuote = () => json({ quote: { ...quote, quoteId: "e".repeat(64) } }),
    journeyEvents = [] as { type: string }[],
    payment = null as unknown,
  } = {}) {
    const requests: { path: string; method: string; body: any }[] = [];
    const authorizeAttempts = new Map<string, number>();
    let paymentCalls = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      const authorize = /\/intents\/(.+)\/authorize$/.exec(path);
      if (authorize) {
        const kind = authorize[1]!;
        const attempt = (authorizeAttempts.get(kind) ?? 0) + 1;
        authorizeAttempts.set(kind, attempt);
        if (attempt <= (tooSoonFor.get(kind) ?? 0)) {
          return json({
            error: "QUOTE_EXPIRES_TOO_SOON",
            code: "QUOTE_EXPIRES_TOO_SOON",
            message: "quote expiry leaves insufficient authorization runway",
            retriable: false,
          }, 409);
        }
        return json({ transaction: { from: account, to: account, data: "0x", value: "0", gas: "100000" } });
      }
      if (path.endsWith("/destination-quote")) return destinationQuote();
      if (path === "/v1/product/journeys/journey-retry" && method === "GET") {
        const latestKind = [...requests].reverse().find((request) => /\/intents\/.+\/authorize$/.test(request.path))?.path.split("/").at(-2);
        return json({
          journey: {
            events: journeyEvents,
            payment,
            authorizations: [{ intentKind: latestKind, ethereumHash: hash, state: "submitted" }],
          },
        });
      }
      if (/\/intents\/.+\/confirm$/.test(path)) return json({ journey: { state: "authorizing" } });
      if (path.endsWith("/payment")) {
        paymentCalls += 1;
        return paymentCalls === 1
          ? json({ x402Version: 2, accepts: [] }, 402, { "payment-required": "challenge" })
          : json({ payment: { state: "settled" } });
      }
      if (path.endsWith("/reconcile")) return json({ journey: { state: "completed" } });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wallet = {
      switchToHedera: vi.fn(async () => undefined),
      sendTransaction: vi.fn(async () => hash),
      transactionReceipt: vi.fn(async () => ({ status: "0x1", transactionHash: hash })),
      createPaymentHeaders: vi.fn(async () => ({ "PAYMENT-SIGNATURE": "signed" })),
    };
    const phases: string[] = [];
    const refreshes: any[] = [];
    const orchestrator = new JourneyOrchestrator({
      apiBase: "https://api.example",
      wallet,
      fetcher,
      sleep: async () => undefined,
      onPhase: (phase: string) => phases.push(phase),
      onQuoteRefresh: (event: any) => refreshes.push(event),
    });
    const continued = () => orchestrator.continueRefuel({ journeyId: "journey-retry", quote, mode: "mainnet", account });
    const of = (predicate: (request: { path: string; method: string; body: any }) => boolean) => requests.filter(predicate);
    return { orchestrator, wallet, phases, refreshes, requests, continued, of };
  }

  it("refreshes the destination quote once and retries the same leg with the new quote and no extra wallet prompt", async () => {
    const harness = refuelHarness({ tooSoonFor: new Map([["permit2_approval", 1], ["router_approval", 1]]) });
    const outcome = await harness.continued();

    const refreshRequests = harness.of((request) => request.path.endsWith("/destination-quote"));
    expect(refreshRequests).toHaveLength(2);
    const permit2 = harness.of((request) => request.path.endsWith("/intents/permit2_approval/authorize"));
    expect(permit2).toHaveLength(2);
    expect(permit2[0]!.body).toEqual({ quoteId: quote.quoteId });
    // The retry re-binds the leg to the quote the server just minted.
    expect(permit2[1]!.body).toEqual({ quoteId: "e".repeat(64) });
    // One wallet confirmation per leg: permit2, router_approval, router_execution.
    expect(harness.wallet.sendTransaction).toHaveBeenCalledTimes(3);
    expect(harness.wallet.createPaymentHeaders).toHaveBeenCalledTimes(1);
    expect(harness.wallet.switchToHedera).toHaveBeenCalledTimes(1);
    // Later legs execute against the refreshed quote, not the consented one.
    expect(outcome.quote.quoteId).toBe("e".repeat(64));
    expect(harness.refreshes.map((event) => [event.kind, event.attempt, event.active])).toEqual([
      ["permit2_approval", 1, true],
      ["permit2_approval", 1, false],
      ["router_approval", 1, true],
      ["router_approval", 1, false],
    ]);
  });

  it("mints exactly one refresh for one thin leg and leaves every other leg untouched", async () => {
    const harness = refuelHarness({ tooSoonFor: new Map([["router_approval", 1]]) });
    await harness.continued();
    expect(harness.of((request) => request.path.endsWith("/destination-quote"))).toHaveLength(1);
    expect(harness.of((request) => request.path.endsWith("/intents/router_approval/authorize"))).toHaveLength(2);
    expect(harness.of((request) => request.path.endsWith("/intents/permit2_approval/authorize"))).toHaveLength(1);
    expect(harness.wallet.sendTransaction).toHaveBeenCalledTimes(3);
    expect(harness.wallet.switchToHedera).toHaveBeenCalledTimes(1);
  });

  it("stops after two refresh-retries on one leg instead of looping", async () => {
    const harness = refuelHarness({ tooSoonFor: new Map([["router_approval", 9]]) });
    await expect(harness.continued()).rejects.toThrow(/after 2 destination-quote refreshes/);
    expect(harness.of((request) => request.path.endsWith("/destination-quote"))).toHaveLength(2);
    expect(harness.of((request) => request.path.endsWith("/intents/router_approval/authorize"))).toHaveLength(3);
    // The exhausted leg never reached a wallet: permit2 is the only signed leg.
    expect(harness.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("propagates a worsened post-consent re-quote untouched instead of continuing", async () => {
    const details = {
      consented: { swapInputMaximum: "3000000", minimumRetained: "2000000", desiredHbarTinybar: "100000000" },
      refreshed: { swapInputMaximum: "3400000", minimumRetained: "1600000", desiredHbarTinybar: "100000000" },
    };
    const harness = refuelHarness({
      tooSoonFor: new Map([["router_approval", 9]]),
      destinationQuote: () => json({
        error: "QUOTE_ECONOMICS_WORSENED",
        code: "QUOTE_ECONOMICS_WORSENED",
        message: "refreshed destination quote is worse than the consented quote",
        details,
      }, 409),
    });
    await expect(harness.continued()).rejects.toMatchObject({ body: { code: "QUOTE_ECONOMICS_WORSENED", details } });
    // One refusal stops the walk: no second refresh, no retry, no wallet prompt.
    expect(harness.of((request) => request.path.endsWith("/destination-quote"))).toHaveLength(1);
    expect(harness.of((request) => request.path.endsWith("/intents/router_approval/authorize"))).toHaveLength(1);
    expect(harness.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("resumes a settled journey without re-approving Permit2 or paying x402 twice", async () => {
    const harness = refuelHarness({
      journeyEvents: [{ type: "intent_permit2_approval_confirmed" }],
      payment: { state: "settled" },
    });
    await harness.continued();
    expect(harness.of((request) => request.path.endsWith("/intents/permit2_approval/authorize"))).toHaveLength(0);
    expect(harness.of((request) => request.path.endsWith("/payment"))).toHaveLength(0);
    expect(harness.wallet.createPaymentHeaders).not.toHaveBeenCalled();
    expect(harness.wallet.sendTransaction).toHaveBeenCalledTimes(2);
    expect(harness.wallet.switchToHedera).toHaveBeenCalledTimes(1);
    expect(harness.phases).toEqual([
      "approving_payment_asset",
      "authorizing_x402",
      "settling_x402",
      "executing_refuel",
      "reconciling",
      "completed",
    ]);
  });

  it("accepts an already-recorded journey payment instead of demanding a second signature", async () => {
    const fetcher = vi.fn(async () => json({ payment: { state: "settled", paymentIdentity: "0xfeed" } }));
    const wallet = { createPaymentHeaders: vi.fn() };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher });
    await expect(orchestrator.settlePayment("journey-paid")).resolves.toMatchObject({ payment: { state: "settled" } });
    expect(wallet.createPaymentHeaders).not.toHaveBeenCalled();
  });

  it("hard-stops an unknown bridge status instead of resubmitting", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/v1/product/journeys") return json({ journey: { id: "journey-2" } }, 201);
      if (path.endsWith("/activate")) return json({ required: true, funded: false, associated: true });
      if (path.endsWith("/wallet-boundary")) return json({ journey: { state: "ready" } });
      if (path.endsWith("/bridge") && init.method === "POST") return json({});
      if (path.endsWith("/bridge")) return json({ transfer: { state: "unknown", providerStatus: "unknown" }, arrival: { confirmed: false } });
      throw new Error("unexpected request");
    });
    const wallet = {
      switchChain: vi.fn(async () => undefined),
      chainId: 1,
      signJourneySourceLeg: vi.fn(async () => SOURCE_LEG_CONSENT),
      tokenAllowance: vi.fn(async () => 1000n),
      sendTransaction: vi.fn(async () => hash),
    };
    const orchestrator = new JourneyOrchestrator({ apiBase: "https://api.example", wallet, fetcher, sleep: async () => undefined });
    await expect(orchestrator.run({ quote, mode: "mainnet", account })).rejects.toThrow("bridge stopped with provider status unknown");
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
