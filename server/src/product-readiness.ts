import type { ProductMode } from "./support.js";

function boundedFacilitatorUrl(value: string): URL {
  const url = new URL(value);
  const privateRailway = url.hostname.endsWith(".railway.internal");
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (privateRailway || local))) {
    throw new Error("product facilitator health URL must use HTTPS or a private/local HTTP route");
  }
  return url;
}

export async function productFacilitatorReady(input: {
  url: string | undefined;
  mode: ProductMode;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  if (!input.url) return false;
  let base: URL;
  try {
    base = boundedFacilitatorUrl(input.url);
  } catch {
    return false;
  }
  const health = new URL(base.toString().replace(/\/$/, "") + "/health");
  try {
    const response = await (input.fetcher ?? fetch)(health, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; chains?: string[]; verificationReady?: boolean; settlementReady?: boolean };
    const expected = `eip155:${input.mode === "mainnet" ? 295 : 296}`;
    return body.ok === true &&
      body.verificationReady === true &&
      body.settlementReady === true &&
      Array.isArray(body.chains) &&
      body.chains.includes(expected);
  } catch {
    return false;
  }
}
