import { loadSaucerApiCredential } from "./lib/load-saucer-secret.js";

const credentialSource = loadSaucerApiCredential();
const runtimeKey = process.env.SAUCERSWAP_API_KEY?.trim();
const rawBase = process.env.SAUCERSWAP_API_BASE_URL ?? "https://api.saucerswap.finance";
const base = new URL(rawBase);
if (base.protocol !== "https:" || !["api.saucerswap.finance", "server.saucerswap.finance"].includes(base.hostname)) {
  throw new Error("SaucerSwap public API base URL is not allowlisted");
}
if (!runtimeKey) throw new Error("canonical SaucerSwap public API credential is unavailable");
const checkedAt = new Date().toISOString();
let response: Response;
try {
  response = await fetch(`${base.toString().replace(/\/$/, "")}/tokens`, {
    headers: {
      "x-api-key": runtimeKey,
      "user-agent": "Refuel402/0.1 (+https://refuel402.pages.dev)",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
} catch {
  console.log(JSON.stringify({
    schema: "refuel402.saucer-credential-probe.v1",
    checkedAt,
    endpointClass: "saucerswap-public-api",
    host: base.hostname,
    path: "/tokens",
    authHeader: "x-api-key",
    credentialSource,
    status: null,
    pass: false,
    error: "request_failed",
  }, null, 2));
  process.exit(1);
}
const text = await response.text();
let parsed: unknown = null;
try { parsed = JSON.parse(text); } catch {}
const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
  ? parsed as Record<string, unknown>
  : null;
const array = Array.isArray(parsed)
  ? parsed
  : Array.isArray(record?.data) ? record.data
    : Array.isArray(record?.tokens) ? record.tokens
      : null;
const sample = array?.find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
const pass = response.ok && !!array;
console.log(JSON.stringify({
  schema: "refuel402.saucer-credential-probe.v1",
  checkedAt,
  endpointClass: "saucerswap-public-api",
  host: base.hostname,
  path: "/tokens",
  authHeader: "x-api-key",
  credentialSource,
  httpStatus: response.status,
  responseSchema: array ? "array" : record ? "object" : "invalid_json",
  responseVersion: response.headers.get("x-api-version") ?? response.headers.get("api-version") ?? null,
  responseTimestamp: response.headers.get("date") ?? null,
  itemCount: array?.length ?? null,
  itemKeys: sample ? Object.keys(sample).sort() : [],
  pass,
  error: pass ? null : response.status === 401 || response.status === 403 ? "credential_rejected" : "schema_or_http_failure",
}, null, 2));
if (!pass) process.exitCode = 1;
