import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductApiClient, ProductApiError, productRequestTimeout } from "./api-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ProductApiClient", () => {
  it("gives the live product quote wrapper enough time while keeping ordinary API calls bounded", () => {
    expect(productRequestTimeout("/v1/product/quote", "POST")).toBe(60_000);
    expect(productRequestTimeout("/v1/product/quote", "GET")).toBe(15_000);
    expect(productRequestTimeout("/v1/product/options?mode=mainnet", "GET")).toBe(15_000);
  });

  it("gives paged mirror-evidence endpoints the long timeout class, not the default", () => {
    expect(productRequestTimeout("/v1/product/journeys/j1/reconcile-submissions", "POST")).toBe(45_000);
    expect(productRequestTimeout("/v1/product/journeys/j1/bridge/adopt", "POST")).toBe(45_000);
    expect(productRequestTimeout("/v1/product/journeys/j1/reconcile-submissions", "GET")).toBe(15_000);
    expect(productRequestTimeout("/v1/product/journeys/j1/bridge", "POST")).toBe(15_000);
  });

  it("applies the evidence-scan timeout to the reconcile call itself", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn(async () => json({ journey: { id: "j1" } }));
    await new ProductApiClient({ apiBase: "https://api.example", fetcher }).reconcileSubmissions("j1");
    expect(timeout).toHaveBeenLastCalledWith(45_000);
    timeout.mockRestore();
  });

  it("uses the endpoint-specific quote timeout unless the caller explicitly overrides it", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn(async () => json({ ok: true }));
    const client = new ProductApiClient({ apiBase: "https://api.example", fetcher });

    await client.request("/v1/product/quote", { method: "POST", body: { assetId: "weth" } });
    expect(timeout).toHaveBeenLastCalledWith(60_000);

    await client.request("/v1/product/quote", { method: "POST", body: {}, timeoutMs: 25_000 });
    expect(timeout).toHaveBeenLastCalledWith(25_000);
    timeout.mockRestore();
  });

  it("preserves the Window receiver across options, quote, and journey requests", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = function receiverSensitiveFetch(
      this: typeof globalThis,
      input: string | URL | Request,
      init: RequestInit = {},
    ) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(json({ ok: true }));
    } as typeof globalThis.fetch;

    const client = new ProductApiClient({ apiBase: "https://api.example" });
    await client.request("/v1/product/options?mode=mainnet");
    await client.request("/v1/product/quote", { method: "POST", body: { provider: "axelar" } });
    await client.request("/v1/product/journeys", { method: "POST", body: { quoteId: "quote-1" } });

    expect(calls).toEqual([
      { url: "https://api.example/v1/product/options?mode=mainnet", method: "GET", body: null },
      { url: "https://api.example/v1/product/quote", method: "POST", body: { provider: "axelar" } },
      { url: "https://api.example/v1/product/journeys", method: "POST", body: { quoteId: "quote-1" } },
    ]);
  });

  it("maps HTTP 409 and malformed error fields to a typed lifecycle error", async () => {
    const client = new ProductApiClient({
      apiBase: "https://api.example",
      fetcher: async () => json({
        code: "QUOTE_EXPIRES_TOO_SOON",
        message: "quote expiry leaves insufficient authorization runway",
        retriable: false,
      }, 409),
    });
    await expect(client.request("/authorize", { method: "POST", body: {} })).rejects.toMatchObject({
      name: "ProductApiError",
      status: 409,
      code: "QUOTE_EXPIRES_TOO_SOON",
      retriable: false,
    });
    await client.request("/authorize", { method: "POST", body: {} }).catch((error) => {
      expect(error).toBeInstanceOf(ProductApiError);
      expect(error.body.code).toBe("QUOTE_EXPIRES_TOO_SOON");
    });

    const malformed = new ProductApiClient({
      fetcher: async () => json({ code: { startsWith: false }, message: { startsWith: false } }, 500),
    });
    await expect(malformed.request("/bad")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "request failed (500)",
    });
  });

  it("posts reconcile-submissions with a stable idempotency key and optional authorizationId", async () => {
    const calls: { url: string; method: string | undefined; headers: Record<string, string>; body: unknown }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return json({ journey: { id: "j1" }, resolutions: [], recovery: { disposition: "action_required" } });
    });
    const client = new ProductApiClient({ apiBase: "https://api.example", fetcher });
    await client.reconcileSubmissions("j1");
    await client.reconcileSubmissions("j1", { authorizationId: "auth-1" });
    expect(calls[0]).toMatchObject({
      url: "https://api.example/v1/product/journeys/j1/reconcile-submissions",
      method: "POST",
      body: {},
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("reconcile-j1");
    expect(calls[1]!.body).toEqual({ authorizationId: "auth-1" });
    expect(calls[1]!.headers["idempotency-key"]).toBe("reconcile-j1");
  });

  it("posts bridge adoption as an owner signature over the caller-supplied hash", async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return json({ schema: "refuel402.product-bridge-adoption.v1", journey: { id: "j1" } });
    });
    const client = new ProductApiClient({ apiBase: "https://api.example", fetcher });
    const sourceTransactionHash = `0x${"5d".repeat(32)}`;
    const confirmation = `0x${"12".repeat(65)}`;
    await client.adoptBridge("j1", { sourceTransactionHash, confirmation });
    expect(calls[0]!.url).toBe("https://api.example/v1/product/journeys/j1/bridge/adopt");
    expect(calls[0]!.headers["idempotency-key"]).toBe("adopt-j1");
    // The boolean confirm is gone: consent is the recoverable signature only.
    expect(calls[0]!.body).toEqual({ sourceTransactionHash, confirmation });
    expect(calls[0]!.body.confirm).toBeUndefined();
  });

  it("keeps an explicitly injected fetch function unchanged for Node tests", async () => {
    const fetcher = vi.fn(async () => json({ injected: true }));
    const client = new ProductApiClient({ apiBase: "https://api.example", fetcher });
    await expect(client.request("/v1/product/options?mode=mainnet")).resolves.toEqual({ injected: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
