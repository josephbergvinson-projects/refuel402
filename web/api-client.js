function receiverSafeDefaultFetch(input, init) {
  return globalThis.fetch(input, init);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PRODUCT_QUOTE_TIMEOUT_MS = 60_000;
// Endpoints backed by paged mirror-evidence scans, matching the destination-quote class.
const EVIDENCE_SCAN_TIMEOUT_MS = 45_000;

export function productRequestTimeout(path, method = "GET") {
  if (method !== "POST") return DEFAULT_REQUEST_TIMEOUT_MS;
  if (path === "/v1/product/quote") return PRODUCT_QUOTE_TIMEOUT_MS;
  if (/\/(reconcile-submissions|bridge\/adopt)$/.test(path)) return EVIDENCE_SCAN_TIMEOUT_MS;
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export class ProductApiError extends Error {
  constructor(response, body) {
    const code = typeof body?.code === "string" ? body.code : "HTTP_ERROR";
    const message = typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : `request failed (${response.status})`;
    super(message);
    this.name = "ProductApiError";
    this.response = response;
    this.status = response.status;
    this.code = code;
    this.body = body && typeof body === "object" ? body : {};
    this.retriable = this.body.retriable === true;
  }
}

export class ProductApiClient {
  constructor({ apiBase = "", fetcher } = {}) {
    this.apiBase = String(apiBase).replace(/\/$/, "");
    this.fetcher = fetcher ?? receiverSafeDefaultFetch;
  }

  endpoint(path) {
    return this.apiBase ? `${this.apiBase}${path}` : path;
  }

  async request(path, { method = "GET", body, headers = {}, signal, timeoutMs } = {}) {
    const effectiveTimeoutMs = timeoutMs ?? productRequestTimeout(path, method);
    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetcher(this.endpoint(path), {
        method,
        signal: requestSignal,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (requestSignal.aborted) throw new Error(signal?.aborted ? "request cancelled" : `request timed out after ${effectiveTimeoutMs}ms`);
      throw error;
    }
    const parsed = await response.clone().json().catch(() => ({}));
    if (!response.ok) throw new ProductApiError(response, parsed);
    return parsed;
  }

  reconcileSubmissions(journeyId, { authorizationId } = {}) {
    return this.request(`/v1/product/journeys/${journeyId}/reconcile-submissions`, {
      method: "POST",
      headers: { "idempotency-key": `reconcile-${journeyId}` },
      body: authorizationId ? { authorizationId } : {},
    });
  }

  // `confirmation` is the owner's EIP-712 BridgeAdoption signature over the exact
  // hash below; the server recovers it against the journey account.
  abandonJourney(journeyId, { confirmation }) {
    return this.request(`/v1/product/journeys/${journeyId}/abandon`, {
      method: "POST",
      headers: { "idempotency-key": `abandon-${journeyId}` },
      body: { confirmation },
    });
  }

  adoptBridge(journeyId, { sourceTransactionHash, confirmation }) {
    return this.request(`/v1/product/journeys/${journeyId}/bridge/adopt`, {
      method: "POST",
      headers: { "idempotency-key": `adopt-${journeyId}` },
      body: { sourceTransactionHash, confirmation },
    });
  }
}
