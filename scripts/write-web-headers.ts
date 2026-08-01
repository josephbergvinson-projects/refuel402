import fs from "node:fs";
import path from "node:path";

const api = process.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
let apiOrigin = "";
if (api) {
  const parsed = new URL(api);
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("VITE_API_BASE_URL must use HTTPS outside local development");
  }
  apiOrigin = parsed.origin;
}

const connectSources = ["'self'", apiOrigin].filter(Boolean).join(" ");

// Cache-Control is deliberately absent from `/*`: Cloudflare Pages applies every
// matching rule, so leaving the wildcard silent means no rule can ever conflict
// with another on that one header. The entry documents are never stored — a
// redeploy must reach an open tab on its next navigation — while everything under
// /assets is content-hashed by Vite and therefore safe to pin forever.
const headers = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'none'; img-src 'self' data: https:; connect-src ${connectSources}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/icon.svg
  Cache-Control: public, max-age=600

/tokens/*
  Cache-Control: public, max-age=600

/
  Cache-Control: no-store

/index.html
  Cache-Control: no-store

/developer*
  Cache-Control: no-store
`;

const output = path.resolve("dist", "web", "_headers");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, headers);
console.log(JSON.stringify({ output, apiOrigin: apiOrigin || "same-origin-only" }));
