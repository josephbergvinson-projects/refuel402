// Refuel402 server.
// Product authority: docs/PRODUCT.md.
// Core same-wallet reads: /v1/product/options, /v1/product/quote, /rpc/:mode.
// Core writes remain fail-closed below live proof.
// /v1/refuel/plan, /v1/quote and /v1/fuel are retained legacy technical APIs;
// they do not define the stock-MetaMask product acceptance path.
import express from "express";
import { z } from "zod";
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, stringToHex, type Hex, type TransactionSerialized } from "viem";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  type HTTPRequestContext,
} from "@x402/core/http";
import type { Network, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_TOKENS,
  loadBridges,
  MAINNET,
  NETWORKS,
  policyConfig,
  pricingConfig,
  SPONSOR,
  TESTNET,
  TOKENS,
  tokensFor,
  type NetworkName,
} from "./config.js";
import type { BundleSummary, SupportedToken } from "./types.js";
import { evaluateBundle, semanticBundleHash, bundleHash as rawBundleHash } from "./policy.js";
import { preflightBundle, recheckBalance } from "./preflight.js";
import { priceSponsorship, type Quote } from "./pricing.js";
import { Mirror } from "./mirror.js";
import { SponsorClient } from "./hedera.js";
import { Store, type SponsorshipRecord } from "./store.js";
import { RateLimiter } from "./ratelimit.js";
import {
  createLifecycleStore,
  LifecycleConflictError,
  PostgresStore,
} from "./postgres-store.js";
import {
  installHttpBoundary,
  registerOperationalRoutes,
  requestClientIp,
} from "./http-boundary.js";
import { createRefuelPlan, parseDecimalUnits, refuelPlanLimits } from "./planner.js";
import {
  loadSupportCatalog,
  probeRuntimeGates,
  productOptions,
  type ProductMode,
} from "./support.js";
import { createProductQuoteHandler } from "./product-quote.js";
import { hydrateSaucerSupportCatalog, SaucerApiError } from "./saucer-api.js";
import { createBoundedPolicyRpcSubmitter, createPolicyRpcProcessor, policyRpcReadMethods } from "./policy-rpc.js";
import { createProductLifecycleRouter, mirrorSubmissionEvidence } from "./product-lifecycle.js";
import { ProductLifecycleStore } from "./product-lifecycle-store.js";
import { createProductBridgeTracker, readProductDestinationBalance } from "./product-bridge.js";
import { createProductBridgeSweeper } from "./product-bridge-sweeper.js";
import { createProductDestinationQuoteRefresher } from "./product-destination-quote.js";
import { createProductRefuelExecutor } from "./product-refuel-executor.js";
import { createProductDestinationActivator } from "./product-activation.js";
import { createSponsorExposureReader, type ProductSponsorLedger } from "./sponsor-exposure.js";
import { createFacilitatorProductPaymentVerifier } from "./product-payment.js";
import { createProductIntentBuilder } from "./product-intents.js";
import { createRpcReceiptReconciler } from "./product-receipts.js";
import { runtimeExecutionEnabled } from "./execution-gate.js";
import { productFacilitatorReady } from "./product-readiness.js";

const EXECUTION = NETWORKS[SPONSOR.network];
const NETWORK = EXECUTION.caip2 as Network;
const FACILITATOR_URL = process.env.FACILITATOR_URL ??
  (SPONSOR.network === "mainnet" ? "https://api.blocky402.com" : "https://api.testnet.blocky402.com");
const runtimeExecutable = runtimeExecutionEnabled(process.env, SPONSOR.network);

const mirror = new Mirror(EXECUTION.mirrorBase, EXECUTION.rpcUrl, EXECUTION.quoteMirrorBase);
// Per-network mirrors for read/inspect endpoints (both networks are queryable).
const mirrors: Record<NetworkName, Mirror> = {
  testnet: mirror,
  mainnet: new Mirror(MAINNET.mirrorBase, MAINNET.rpcUrl, MAINNET.quoteMirrorBase),
};
/** Resolve the network for a read request from ?network=, default testnet. */
function reqNet(req: express.Request): NetworkName {
  return req.query.network === "mainnet" ? "mainnet" : "testnet";
}
const store = await createLifecycleStore(SPONSOR.dataDir, () => new Store(SPONSOR.dataDir));
const productLifecycleStore = store instanceof PostgresStore
  ? new ProductLifecycleStore(store.pool)
  : null;
// Product authorization recovery is local PostgreSQL work and must complete
// before the service starts accepting policy-RPC or journey requests.
const productRecoverySummary = productLifecycleStore
  ? await productLifecycleStore.recoverInterrupted()
  : null;
const limiter = store instanceof PostgresStore
  ? store.rateLimiter({ windowSec: 3600, max: 30, namespace: "fuel" })
  : new RateLimiter({ windowSec: 3600, max: 30 });
// Read endpoints (/v1/quote, /v1/account) fan out to mirror/RPC — throttle per IP.
const readLimiter = store instanceof PostgresStore
  ? store.rateLimiter({ windowSec: 60, max: 60, namespace: "read" })
  : new RateLimiter({ windowSec: 60, max: 60 });
const productLifecycleLimiter = store instanceof PostgresStore
  ? store.rateLimiter({
      windowSec: 60,
      max: Number(process.env.PRODUCT_LIFECYCLE_RATE_LIMIT_MAX ?? 60),
      namespace: "product-lifecycle",
    })
  : new RateLimiter({
      windowSec: 60,
      max: Number(process.env.PRODUCT_LIFECYCLE_RATE_LIMIT_MAX ?? 60),
    });
// Treasury-spending demo mutations require an operator bearer token and have a
// separate low cap. DEMO_ENABLE alone never authorizes public spend.
const demoLimiter = store instanceof PostgresStore
  ? store.rateLimiter({ windowSec: 3600, max: 5, namespace: "demo" })
  : new RateLimiter({ windowSec: 3600, max: 5 });
const policy = policyConfig(SPONSOR.network);
const pricing = pricingConfig();

// Both networks use the same explicit contract. Execution remains fail-closed:
// both networks require SAME_WALLET_EXECUTION_ENABLED=1 and sponsor credentials;
// mainnet additionally requires MAINNET_EXECUTION_ENABLED=1.
const sponsor = runtimeExecutable
  ? new SponsorClient(SPONSOR.network, SPONSOR.operatorId, SPONSOR.operatorKey)
  : null;
if (!runtimeExecutable) {
  const reason = process.env.SAME_WALLET_EXECUTION_ENABLED !== "1"
    ? "SAME_WALLET_EXECUTION_ENABLED is not set"
    : !SPONSOR.operatorId || !SPONSOR.operatorKey
      ? "sponsor credentials are not configured"
      : "MAINNET_EXECUTION_ENABLED is not set";
  console.log(`Refuel402 starting read-only: execution unavailable on ${SPONSOR.network} (${reason})`);
}

let x402ServerPromise: Promise<x402ResourceServer> | null = null;
function getX402Server(): Promise<x402ResourceServer> {
  if (!x402ServerPromise) {
    x402ServerPromise = (async () => {
      const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
      const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactHederaScheme());
      await server.initialize();
      return server;
    })().catch((e) => {
      x402ServerPromise = null;
      throw e;
    });
  }
  return x402ServerPromise;
}

function makeContext(req: express.Request): HTTPRequestContext {
  return {
    adapter: {
      getHeader: (name) => req.header(name) ?? undefined,
      getMethod: () => req.method,
      getPath: () => req.path,
      getUrl: () => `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      getAcceptHeader: () => req.header("accept") ?? "",
      getUserAgent: () => req.header("user-agent") ?? "",
      getQueryParam: (name) => (req.query[name] as string | undefined) ?? undefined,
    },
    path: req.path,
    method: req.method,
    paymentHeader: req.header("payment-signature") ?? req.header("x-payment") ?? undefined,
  };
}

const FuelBody = z.object({
  transactions: z
    .array(z.string().regex(/^0x[0-9a-fA-F]+$/))
    .min(1)
    .max(3),
  // Required only for swap-less bundles (standalone associate/approve): the
  // whitelisted token the x402 fee is charged in (a token the account holds).
  feeTokenId: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});

/**
 * Resolve which token the x402 fee is charged in, and the conversion basis
 * (amountIn -> WHBAR rate) used to price it. Swap bundles bill in the swap
 * input token; swap-less bundles bill in an explicit / approve-inferred token.
 */
async function resolveFeeContext(
  summary: BundleSummary,
  pre: { expectedOut: bigint | null; expectedAmountIn?: bigint | null },
  feeTokenIdOverride?: string,
): Promise<
  | { ok: true; feeToken: SupportedToken; amountInForConv: bigint; expectedOutTinybar: bigint }
  | { ok: false; status: number; code: string; message: string }
> {
  if (summary.hasSwap && summary.swapInputToken) {
    if (pre.expectedOut === null) {
      return { ok: false, status: 422, code: "NO_ROUTE", message: "swap route could not be priced" };
    }
    return {
      ok: true,
      feeToken: summary.swapInputToken,
      amountInForConv: pre.expectedAmountIn ?? summary.amountIn,
      expectedOutTinybar: pre.expectedOut,
    };
  }
  const ftId = feeTokenIdOverride ?? summary.approve?.token.tokenId;
  if (!ftId) {
    return {
      ok: false,
      status: 400,
      code: "FEE_TOKEN_REQUIRED",
      message: "swap-less bundles must specify feeTokenId (a whitelisted token the account holds)",
    };
  }
  const feeToken = ALL_TOKENS.find((t) => t.tokenId === ftId);
  if (!feeToken) {
    return { ok: false, status: 400, code: "FEE_TOKEN_UNSUPPORTED", message: `${ftId} is not a whitelisted fee token` };
  }
  const probe = BigInt(10) ** BigInt(feeToken.decimals);
  const out = await mirror.quoteToWhbar(
    EXECUTION.quoter,
    feeToken.evmAddress,
    EXECUTION.whbarToken,
    feeToken.poolFee,
    probe,
  );
  if (!out || out === 0n) {
    return { ok: false, status: 422, code: "NO_FEE_ROUTE", message: `cannot price ${feeToken.symbol} -> HBAR for the fee` };
  }
  return { ok: true, feeToken, amountInForConv: probe, expectedOutTinybar: out };
}

function hashscanTx(id: string): string {
  return `${EXECUTION.hashscanBase}/transaction/${id}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function checkSponsorReserve(maxExposureTinybar: bigint): Promise<{
  ok: boolean;
  balanceTinybar: bigint | null;
  requiredTinybar: bigint;
}> {
  const requiredTinybar = SPONSOR.minReserveTinybar + maxExposureTinybar;
  if (!SPONSOR.operatorId) return { ok: false, balanceTinybar: null, requiredTinybar };
  const account = await mirror.account(SPONSOR.operatorId);
  const balanceTinybar = account ? BigInt(account.balance.balance) : null;
  return {
    ok: balanceTinybar !== null && balanceTinybar >= requiredTinybar,
    balanceTinybar,
    requiredTinybar,
  };
}

async function buildRequirements(
  server: x402ResourceServer,
  context: HTTPRequestContext,
  feeTokenId: string,
  feeAmount: string,
): Promise<PaymentRequirements[]> {
  return server.buildPaymentRequirementsFromOptions(
    [
      {
        scheme: "exact",
        network: NETWORK,
        payTo: SPONSOR.operatorId,
        price: { asset: feeTokenId, amount: feeAmount },
        maxTimeoutSeconds: 180,
      },
    ],
    context,
  );
}

async function refundPayment(rec: SponsorshipRecord, reason: string): Promise<void> {
  if (!rec.payment) return;
  if (!sponsor) throw new Error("sponsor execution is disabled");
  // Refund exactly what was PAID (recorded at settle), never the quote — a
  // stale quote token/amount could return the sponsor's own treasury in a token
  // the payer never paid (audit HIGH, secondary).
  const tokenId = rec.payment.paidTokenId ?? rec.quote?.feeTokenId;
  const amount = rec.payment.paidAmount ?? rec.quote?.feeAmount;
  if (!tokenId || !amount) return;
  try {
    const payer = rec.payment.payer ?? (await mirror.account(rec.signer))?.account ?? null;
    if (!payer) throw new Error("payer account unknown");
    const r = await sponsor.refundToken(tokenId, payer, BigInt(amount));
    rec.refund = {
      transactionId: r.transactionId,
      amount,
      tokenId,
      reason,
      status: r.status,
    };
    console.log(`[refund] ${rec.bundleHash}: ${r.transactionId} (${reason})`);
  } catch {
    rec.error = `${rec.error ?? reason}; REFUND FAILED — operator action required`;
    console.error(`[refund] FAILED for ${rec.bundleHash}`);
  }
}

const BRIDGES = loadBridges();
const sourceWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const builtWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");
const webDir = fs.existsSync(path.join(builtWebDir, "index.html")) ? builtWebDir : sourceWebDir;

/** Structured, machine-readable error envelope for agents. */
function fail(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  retriable = false,
  details?: unknown,
): void {
  res.status(status).json({
    error: code,
    code,
    message,
    retriable,
    requestId: res.locals.requestId ?? null,
    ...(details ? { details } : {}),
  });
}

/** The facilitator's fee-payer account (it pays the fee transfer's network cost). Cached. */
let cachedFeePayer: string | null = null;
async function discoverFeePayer(): Promise<string | null> {
  if (cachedFeePayer) return cachedFeePayer;
  try {
    const r = (await (await fetch(`${FACILITATOR_URL}/supported`)).json()) as {
      kinds?: { network?: string; extra?: { feePayer?: string } }[];
    };
    const k = (r.kinds ?? []).find((x) => x.network === NETWORK);
    cachedFeePayer = k?.extra?.feePayer ?? null;
  } catch {
    cachedFeePayer = null;
  }
  return cachedFeePayer;
}

/** OpenAPI 3.1 description of the agent-facing surface. */
function openApiSpec(base: string): Record<string, unknown> {
  const paymentRequirements = {
    type: "object",
    properties: {
      scheme: { type: "string", example: "exact" },
      network: { type: "string", example: NETWORK },
      asset: { type: "string", description: "HTS token id the fee is charged in", example: "0.0.5449" },
      amount: { type: "string", description: "fee in the asset's smallest units" },
      payTo: { type: "string", example: SPONSOR.operatorId },
      maxTimeoutSeconds: { type: "integer", example: 180 },
      extra: { type: "object", properties: { feePayer: { type: "string" } } },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Refuel402 API",
      version: "0.5.0",
      description:
        "One-MetaMask bridge-and-refuel API. PostgreSQL lifecycle writes are durable; chain/payment/provider execution remains fail-closed below live proof. Legacy destination-only endpoints are retained separately.",
    },
    servers: [{ url: base }],
    paths: {
      "/.well-known/x402": { get: { summary: "x402 discovery manifest", responses: { "200": { description: "manifest" } } } },
      "/v1/product/options": {
        get: {
          summary: "Same-wallet networks, explicit provider options, assets, support states, and blockers",
          parameters: [{ name: "mode", in: "query", schema: { type: "string", enum: ["testnet", "mainnet"] } }],
          responses: { "200": { description: "product options" } },
        },
      },
      "/v1/product/quote": {
        post: {
          summary: "Provider-bound bridge-only or bridge-plus-refuel quote with explicit route-mode semantics",
          description: "Unsigned quote creation is inert price discovery: it cannot activate an account, create chain authority, sign, submit, swap, or move funds. Any planted quote/journey remains owner-retirable until the owner reaches a separately signed source boundary.",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["mode", "routeMode", "account", "provider", "assetId", "originChainId", "originToken", "amountBaseUnits"], properties: { routeMode: { type: "string", enum: ["bridge_only", "bridge_plus_refuel"] }, provider: { type: "string", enum: ["auto", "axelar", "layerzero"] }, desiredHbar: { type: "string", description: "Required for bridge_plus_refuel; omitted or zero for bridge_only" }, slippageBps: { type: "integer", minimum: 1, maximum: 300 }, refuelProtection: { type: "object", properties: { preset: { type: "string", enum: ["flexible", "balanced", "strict", "custom"] }, customMaxAmountIn: { type: "string", pattern: "^[1-9][0-9]{0,77}$", description: "Exact destination-token cap in base units; required only for Custom" } } } } } } } },
          responses: { "200": { description: "combined quote" }, "400": { description: "provider/asset/network mismatch" }, "409": { description: "provider scope not quote-ready" } },
        },
      },
      "/v1/product/quotes/{id}": {
        get: { summary: "Read immutable persisted quote/provider/support identity", responses: { "200": { description: "stored quote" }, "404": { description: "not found" } } },
      },
      "/v1/product/journeys": {
        get: {
          summary: "Read a bounded, account-scoped Activity page without selecting or mutating a journey",
          parameters: [
            { name: "account", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
            { name: "before", in: "query", schema: { type: "integer", minimum: 1 }, description: "Composite Activity cursor updated-at component in milliseconds" },
            { name: "beforeJourneyId", in: "query", schema: { type: "string", format: "uuid" }, description: "Composite Activity cursor journey-id tie-breaker; required with before and beforeActive" },
            { name: "beforeActive", in: "query", schema: { type: "boolean" }, description: "Composite Activity cursor active-work category; required with before and beforeJourneyId" },
            { name: "includeAbandoned", in: "query", schema: { type: "boolean", default: false }, description: "Owner-retired drafts are excluded by default; they are never deleted and are read back with this flag" },
          ],
          responses: { "200": { description: "server-authoritative activity summaries and next cursor" }, "400": { description: "invalid account or cursor" } },
        },
        post: {
          summary: "Persist an executable stored quote as an idempotent journey; no chain mutation",
          description: "An unsigned planted journey is an inert server record. It cannot create a wallet boundary, authorize a destination call, sign, submit, spend, or move funds; before durable external evidence the owner can retire it with JourneyAbandon consent.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }],
          responses: { "201": { description: "durable journey" }, "409": { description: "quote/lifecycle gate" }, "503": { description: "PostgreSQL unavailable" } },
        },
      },
      "/v1/product/journeys/{id}": {
        get: { summary: "Pure read of journey, effective quote, events, and server-authoritative recovery decision", responses: { "200": { description: "journey and recovery decision; no quote minting or state transition" }, "404": { description: "not found" } } },
      },
      "/v1/product/journeys/{id}/events": {
        get: { summary: "Read ordered append-only journey events", responses: { "200": { description: "events" }, "404": { description: "not found" } } },
      },
      "/v1/product/journeys/{id}/submissions": {
        get: { summary: "Read durable submission attempts and unknown/terminal results", responses: { "200": { description: "submissions" }, "404": { description: "not found" } } },
      },
      "/v1/product/journeys/{id}/activate": {
        post: { summary: "Idempotently fund a hollow destination alias within sponsor caps", description: "Requires an EIP-712 SourceLegConsent recovering to the journey account, bound to this journey, its current quote, and its origin chain. A journey id is not a secret and is never sufficient on its own. Unsigned, this spent real sponsor HBAR on an anonymous caller's command.", responses: { "200": { description: "activation state" }, "400": { description: "malformed consent signature" }, "409": { description: "consent does not recover to the journey account" }, "503": { description: "activation sponsor disabled" } } },
      },
      "/v1/product/journeys/{id}/wallet-boundary": {
        post: { summary: "Write ahead the source approval/bridge wallet-consent boundary before requesting MetaMask", description: "Requires an EIP-712 SourceLegConsent recovering to the journey account, bound to this journey, its current quote, and its origin chain. A journey id is not a secret and is never sufficient on its own. The event is append-only and no route removes it, so unsigned this permanently blocked a journey from resume, re-quote and retirement alike.", responses: { "200": { description: "durable wallet boundary" }, "400": { description: "malformed consent signature" }, "409": { description: "consent does not recover to the journey account" } } },
      },
      "/v1/product/journeys/{id}/bridge": {
        post: { summary: "Persist the origin provider transaction identity", description: "Requires an EIP-712 SourceLegConsent recovering to the journey account, bound to this journey, its current quote, and its origin chain. A journey id is not a secret and is never sufficient on its own. Unsigned, an arbitrary hash foreclosed both abandon and adoption and made the owner's own later submission conflict.", responses: { "200": { description: "bridge submission" }, "400": { description: "malformed consent signature" }, "409": { description: "consent does not recover to the journey account" } } },
        get: { summary: "Read provider status and confirm exact destination arrival", responses: { "200": { description: "bridge and arrival state" } } },
      },
      "/v1/product/journeys/{id}/bridge/adopt": {
        post: {
          summary: "Bind a lost source hash from EIP-712 owner consent plus provider and unique destination-credit evidence",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["sourceTransactionHash", "confirmation"], properties: { sourceTransactionHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, confirmation: { type: "string", description: "65-byte EIP-712 BridgeAdoption signature by the journey account", pattern: "^0x[0-9a-fA-F]{130}$" } } } } } },
          responses: { "200": { description: "adopted bridge submission" }, "400": { description: "invalid hash or owner consent" }, "409": { description: "missing, conflicting, already-bound, or ambiguous evidence" }, "503": { description: "chain-evidence adoption unavailable" } },
        },
      },
      "/v1/product/journeys/{id}/abandon": {
        post: {
          summary: "Owner retires a draft that never reached the outside world; the record and its events are preserved, not deleted",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["confirmation"], properties: { confirmation: { type: "string", description: "65-byte EIP-712 JourneyAbandon signature by the journey account", pattern: "^0x[0-9a-fA-F]{130}$" } } } } } },
          responses: { "200": { description: "journey marked abandoned; idempotent if already abandoned" }, "400": { description: "invalid owner consent" }, "409": { description: "owner consent does not recover, or the journey holds durable or in-flight evidence" }, "503": { description: "PostgreSQL unavailable" } },
        },
      },
      "/v1/product/journeys/{id}/source-quote": {
        post: {
          summary: "Bind a live source re-quote to the same pre-wallet-boundary journey without creating a new journey",
          description: "Requires an EIP-712 SourceLegConsent recovering to the journey account, bound to this journey, the REPLACEMENT quote, and the journey's origin chain. The same consent covers the source leg that follows, so a resend costs one prompt in total.",
          responses: {
            "200": { description: "same journey with a live replacement quote" },
            "400": { description: "malformed quote id or consent signature" },
            "409": { description: "consent does not recover to the journey account, or wallet boundary, bridge hash, submission evidence, changed source intent, or stale/non-executable quote" },
          },
        },
      },
      "/v1/product/journeys/{id}/refuel-authorization": {
        post: {
          summary: "Verify and persist one Permit2 Refuel402RefuelAuthorization before the source bridge",
          description: "Requires both the existing SourceLegConsent and a Hedera-domain Permit2 witness recovering to the journey owner. The server re-derives the exact cap, route hash, service fee, HBAR output, nonce, and deadline from the quote before storing it.",
          responses: {
            "201": { description: "append-only refuel_authorization_recorded event and redacted journey readback" },
            "400": { description: "malformed owner signatures or deadline" },
            "409": { description: "owner, quote, route, state, deadline, or replay conflict" },
            "503": { description: "preauthorization remains dormant until contract/sweeper live gates pass" },
          },
        },
      },
      "/v1/product/journeys/{id}/destination-quote": {
        post: {
          summary: "Explicitly refresh the Saucer/x402/sponsor quote after authoritative arrival",
          description: "This writes quote evidence only. It creates no chain authorization and cannot sign, submit, swap, spend, or move funds; every later manual destination transaction is signed directly on Hedera, while the one-signature path uses the separately verified refuel authorization.",
          responses: {
            "200": { description: "fresh executable destination quote" },
            "409": { description: "journey-state conflict or QUOTE_ECONOMICS_WORSENED with consented/refreshed terms; no quote is written" },
          },
        },
      },
      "/v1/product/journeys/{id}/reconcile-submissions": {
        post: {
          summary: "Resolve review state from authoritative mirror evidence without signing or resubmission",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { authorizationId: { type: "string", description: "Optional exact authorization to reconcile" }, confirmation: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", description: "Required SourceLegConsent only when releasing a bridge wallet boundary after authoritative no-broadcast proof" } } } } } },
          responses: { "200": { description: "submitted, rejected, or still-ambiguous evidence outcomes and current recovery decision" }, "400": { description: "invalid authorization selector" }, "409": { description: "state or evidence conflict, including unknown origin no-broadcast evidence (the wallet boundary is never cleared on unknown)" }, "503": { description: "mirror-backed reconciliation unavailable" } },
        },
      },
      "/v1/product/journeys/{id}/payment": {
        post: { summary: "Issue or settle the manual destination path's HTTP 402 exact Permit2 payment; the pre-authorized executeRefuel fee is a separate atomic contract path", responses: { "200": { description: "settled quote-bound manual payment" }, "402": { description: "quote-bound Refuel402 exact payment challenge" }, "503": { description: "EVM facilitator disabled" } } },
      },
      "/v1/product/journeys/{id}/intents/{kind}/authorize": {
        post: {
          summary: "Build and persist one exact policy-RPC authorization",
          responses: {
            "200": { description: "authorization and MetaMask transaction" },
            "409": { description: "lifecycle conflict, including QUOTE_EXPIRES_TOO_SOON when the client must refresh the destination quote before requesting wallet consent" },
            "503": { description: "intent builder disabled" },
          },
        },
      },
      "/v1/product/journeys/{id}/intents/{kind}/confirm": {
        post: { summary: "Confirm an authorized destination intent by authoritative receipt", responses: { "200": { description: "confirmed intent" }, "503": { description: "receipt reconciler disabled" } } },
      },
      "/v1/product/journeys/{id}/reconcile": {
        post: { summary: "Reconcile the terminal router receipt and complete the journey", responses: { "200": { description: "completed journey" }, "503": { description: "receipt reconciler disabled" } } },
      },
      "/v1/product/policy-rpc": { get: { summary: "Policy-RPC capability contract", responses: { "200": { description: "capability" } } } },
      "/rpc/{mode}": { post: { summary: "MetaMask-compatible read RPC; writes require exact authorization", responses: { "200": { description: "JSON-RPC response" }, "503": { description: "write path disabled" } } } },
      "/v1/policy":  { get: { summary: "Machine-readable policy (router, tokens, limits, bundle shape)", responses: { "200": { description: "policy" } } } },
      "/v1/tokens": { get: { summary: "Whitelisted fuel tokens with build fields", responses: { "200": { description: "tokens" } } } },
      "/v1/account/{idOrAddress}": {
        get: {
          summary: "Inspect an account: stranded? which holdings are fuelable?",
          parameters: [{ name: "idOrAddress", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "account view" }, "400": { description: "bad id" } },
        },
      },
      "/v1/refuel/plan": {
        post: {
          summary: "Legacy destination-only exact-output plan (not the unified product)",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/RefuelPlanRequest" } } } },
          responses: { "200": { description: "value-bounded route, fee ledger and transaction intents" }, "422": { description: "account/liquidity/value/reserve gate" } },
        },
      },
      "/v1/quote": {
        post: {
          summary: "Legacy technical bundle quote (not the stock-MetaMask product)",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/FuelRequest" } } } },
          responses: { "200": { description: "quote + accepts" }, "400": { description: "policy rejection" }, "422": { description: "preflight failed" } },
        },
      },
      "/v1/fuel": {
        post: {
          summary: "Legacy native-Hedera x402/HAPI sponsorship endpoint.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/FuelRequest" } } } },
          responses: {
            "200": { description: "sponsorship receipt (execution.transactionIds / hashscanLinks)" },
            "402": { description: "payment required (accepts[] + PAYMENT-REQUIRED header)" },
            "409": { description: "in-flight / nonce busy" },
            "422": { description: "preflight or re-simulation failed" },
          },
        },
      },
      "/v1/fuel/{bundleHash}": { get: { summary: "Sponsorship status/receipt", responses: { "200": { description: "record" }, "404": { description: "unknown" } } } },
      "/v1/health": { get: { summary: "Liveness", responses: { "200": { description: "ok" } } } },
    },
    components: {
      schemas: {
        RefuelPlanRequest: {
          type: "object",
          required: ["network", "account", "tokenId", "desiredHbar"],
          properties: {
            network: { type: "string", enum: ["testnet", "mainnet"] },
            account: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            tokenId: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
            desiredHbar: { type: "string", description: "Exact native HBAR output, up to 8 decimals" },
            minimumRetained: { type: "string", description: "Optional input-token amount that must remain" },
            slippageBps: { type: "integer", minimum: 0, maximum: 300 },
          },
        },
        FuelRequest: {
          type: "object",
          required: ["transactions"],
          properties: {
            transactions: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
              description: "Ordered [associate?, approve?, swap?] signed EIP-1559 txs, chainId 296, maxFeePerGas 0, sequential nonces.",
            },
            feeTokenId: { type: "string", description: "Required for swap-less bundles: whitelisted token the account holds to pay the fee." },
          },
        },
        PaymentRequirements: paymentRequirements,
        Error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            retriable: { type: "boolean" },
            details: {},
          },
        },
      },
    },
  };
}

const app = express();
installHttpBoundary(app);
// This service serves the same frontend as Cloudflare Pages, and `_headers` is a
// Pages-only mechanism that never reaches here. Without this the two origins
// disagree: express.static would hand out `max-age=0` for content-hashed bundles
// and, worse, let a browser reuse a stale entry document. Kept deliberately
// identical to the rules in scripts/write-web-headers.ts.
app.use(express.static(webDir, {
  setHeaders: (res, filePath) => {
    const cacheControl = /[\\/]assets[\\/]/.test(filePath)
      ? "public, max-age=31536000, immutable"
      : filePath.endsWith(".html")
        ? "no-store"
        : "public, max-age=600";
    res.setHeader("Cache-Control", cacheControl);
  },
}));
registerOperationalRoutes(app, store, {
  network: NETWORK,
  executable: runtimeExecutable,
  lifecycleStore: store instanceof PostgresStore ? "postgres" : "local-json",
  checkFacilitator: async () => {
    if (!runtimeExecutable) return true;
    if (process.env.PRODUCT_PAYMENT_VERIFIER_ENABLED === "1") {
      return productFacilitatorReady({
        url: process.env.X402_EVM_FACILITATOR_URL,
        mode: SPONSOR.network,
      });
    }
    return !!(await discoverFeePayer());
  },
});

function productMode(value: unknown): ProductMode {
  return value === "mainnet" ? "mainnet" : "testnet";
}

app.get("/v1/product/options", async (req, res) => {
  if (!(await readLimiter.allow(requestClientIp(req)))) return fail(res, 429, "RATE_LIMITED", "slow down", true);
  const mode = productMode(req.query.mode);
  const gates = await probeRuntimeGates(mode, mirrors[mode]);
  let catalog = loadSupportCatalog(mode);
  let saucerFailure: string | undefined;
  if (process.env.SAUCERSWAP_API_KEY) {
    try {
      catalog = await hydrateSaucerSupportCatalog(catalog);
    } catch (error) {
      saucerFailure = error instanceof SaucerApiError ? error.code : "SAUCER_GRAPH_PROBE_FAILED";
    }
  }
  res.json(productOptions(mode, gates, catalog, saucerFailure));
});

const productQuoteHandler = createProductQuoteHandler({
  mirrors,
  lifecycleStore: productLifecycleStore,
});
app.post("/v1/product/quote", async (req, res) => {
  if (!(await readLimiter.allow(requestClientIp(req)))) {
    return fail(res, 429, "RATE_LIMITED", "slow down", true);
  }
  return productQuoteHandler(req, res);
});

app.use(["/v1/product/journeys", "/v1/product/quotes"], async (req, res, next) => {
  if (!(await productLifecycleLimiter.allow(requestClientIp(req)))) {
    return fail(res, 429, "RATE_LIMITED", "slow down", true);
  }
  next();
});
// Single authority for every daily-cap decision; see sponsor-exposure.ts.
const sponsorExposureSince = createSponsorExposureReader({
  legacy: store,
  product: productLifecycleStore,
});
const productDestinationActivator = productLifecycleStore && sponsor
  ? createProductDestinationActivator({
      store: productLifecycleStore,
      mirrors,
      sponsors: { [SPONSOR.network]: sponsor },
      exposureSince: sponsorExposureSince,
    })
  : undefined;
const productBridgeTracker = productLifecycleStore
  ? createProductBridgeTracker({ store: productLifecycleStore, mirrors })
  : undefined;
const productDestinationQuoteRefresher = productLifecycleStore
  ? createProductDestinationQuoteRefresher({ store: productLifecycleStore, mirrors })
  : undefined;
const productRefuelExecutor =
  productLifecycleStore &&
  productDestinationQuoteRefresher &&
  sponsor &&
  process.env.REFUEL_PREAUTHORIZATION_ENABLED === "1"
    ? createProductRefuelExecutor({
        store: productLifecycleStore,
        sponsor,
        sponsorMode: SPONSOR.network,
        refreshDestinationQuote: productDestinationQuoteRefresher,
        async authorizeSponsorExposure(authorization) {
          const maximum = BigInt(authorization.maxSponsorExposureTinybar);
          if (maximum > SPONSOR.perRequestExposureCapTinybar) {
            throw new Error("atomic refuel sponsor exposure exceeds the per-request cap");
          }
          const [account, exposure] = await Promise.all([
            mirrors[SPONSOR.network].account(SPONSOR.operatorId),
            sponsorExposureSince(Date.now() - 86_400_000),
          ]);
          if (!account) throw new Error("sponsor reserve account is unavailable");
          if (exposure > SPONSOR.dailyExposureCapTinybar) {
            throw new Error("atomic refuel would exceed the rolling sponsor cap");
          }
          const balance = BigInt(account.balance.balance);
          if (balance < SPONSOR.minReserveTinybar + exposure) {
            throw new Error("atomic refuel would breach the sponsor reserve floor after active/historical exposure");
          }
        },
        async readExecutionEvidence(mode, transactionId) {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const result = await mirrors[mode].contractExecutionResult(transactionId);
            if (result) return result;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          return null;
        },
        async simulate(mode, from, to, data) {
          const response = await fetch(mirrors[mode].rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{ from, to, data, value: "0x0" }, "latest"],
            }),
          });
          const body = await response.json() as { result?: string; error?: { code?: number; message?: string; data?: unknown } };
          if (!response.ok || body.error || typeof body.result !== "string") {
            throw new Error(`refuel simulation refused: ${body.error?.message ?? response.status}`);
          }
        },
      })
    : undefined;
const productBridgeSweeper = productLifecycleStore && productBridgeTracker && process.env.PRODUCT_BRIDGE_SWEEPER_ENABLED !== "0"
  ? createProductBridgeSweeper({
      store: productLifecycleStore,
      bridgeTracker: productBridgeTracker,
      ...(productRefuelExecutor ? { refuelExecutor: productRefuelExecutor } : {}),
      intervalMs: Number(process.env.PRODUCT_BRIDGE_SWEEPER_INTERVAL_MS ?? 15_000),
      minimumBackoffMs: Number(process.env.PRODUCT_BRIDGE_SWEEPER_MIN_BACKOFF_MS ?? 5_000),
      maximumBackoffMs: Number(process.env.PRODUCT_BRIDGE_SWEEPER_MAX_BACKOFF_MS ?? 20_000),
      concurrency: Number(process.env.PRODUCT_BRIDGE_SWEEPER_CONCURRENCY ?? 2),
    })
  : undefined;
const productPaymentVerifier =
  productLifecycleStore &&
  process.env.PRODUCT_PAYMENT_VERIFIER_ENABLED === "1" &&
  process.env.X402_EVM_FACILITATOR_URL
    ? createFacilitatorProductPaymentVerifier({
        url: process.env.X402_EVM_FACILITATOR_URL,
        loadQuote: (journey) => productLifecycleStore.getEffectiveQuote(journey.id),
      })
    : undefined;
const productIntentBuilder =
  productLifecycleStore &&
  process.env.PRODUCT_INTENT_BUILDER_ENABLED === "1"
    ? createProductIntentBuilder({
        loadQuote: (journey) => productLifecycleStore.getEffectiveQuote(journey.id),
        nonce: (mode, account) => mirrors[mode].evmNonce(account),
        estimateGas: (mode, transaction) => mirrors[mode].estimateGas(transaction.from, transaction.to, transaction.data),
      })
    : undefined;
const productReceiptReconciler =
  productLifecycleStore && process.env.PRODUCT_RECEIPT_RECONCILER_ENABLED === "1"
    ? createRpcReceiptReconciler({
        mirrors,
        expectedTargets: { testnet: TESTNET.router, mainnet: MAINNET.router },
        loadQuote: (journey) => productLifecycleStore.getEffectiveQuote(journey.id),
        balanceReadback: async (journey) => {
          const quote = await productLifecycleStore.getEffectiveQuote(journey.id);
          if (!quote) throw new Error("journey quote is unavailable during receipt reconciliation");
          const account = await mirrors[journey.mode].account(journey.account);
          if (!account) throw new Error("destination account is unavailable during receipt reconciliation");
          const bridge = [...journey.events].reverse().find((event) => event.type === "bridge_submitted");
          const hbarBefore = BigInt(String(bridge?.record.hbarBalanceBefore ?? ""));
          const destinationBefore = BigInt(String(bridge?.record.destinationBalanceBefore ?? ""));
          const currentHbar = BigInt(account.balance.balance);
          if (currentHbar < hbarBefore) throw new Error("authoritative HBAR balance moved below the pre-bridge baseline");
          const currentDestination = await readProductDestinationBalance({
            quote,
            account: journey.account,
            mirror: mirrors[journey.mode],
          });
          if (currentDestination < destinationBefore) {
            throw new Error("authoritative destination balance moved below the pre-bridge baseline");
          }
          return {
            destinationAssetRemaining: (currentDestination - destinationBefore).toString(),
            hbarReceivedTinybar: (currentHbar - hbarBefore).toString(),
          };
        },
      })
    : undefined;
if (productLifecycleStore) {
  app.use("/v1/product", createProductLifecycleRouter({
    store: productLifecycleStore,
    destinationActivator: productDestinationActivator,
    bridgeTracker: productBridgeTracker,
    destinationQuoteRefresher: productDestinationQuoteRefresher,
    paymentVerifier: productPaymentVerifier,
    intentBuilder: productIntentBuilder,
    receiptReconciler: productReceiptReconciler,
    submissionEvidence: {
      testnet: mirrorSubmissionEvidence(mirrors.testnet),
      mainnet: mirrorSubmissionEvidence(mirrors.mainnet),
    },
  }));
} else {
  app.post("/v1/product/journeys", (_req, res) => res.status(503).json({
    code: "POSTGRES_LIFECYCLE_REQUIRED",
    message: "the product lifecycle requires PostgreSQL and is disabled in local JSON mode",
    acceptanceLevel: "integration_harness",
    retriable: false,
  }));
}

const policyRpcWriteGate =
  process.env.POLICY_RPC_ENABLED === "1" &&
  process.env.POLICY_RPC_AUTHORIZER_READY === "1";
const policyRpcSubmitter = policyRpcWriteGate && sponsor
  ? createBoundedPolicyRpcSubmitter({
      policy: {
        chainId: EXECUTION.chainId,
        allowedTargets: [
          EXECUTION.router,
          ...(EXECUTION.v1Router ? [EXECUTION.v1Router] : []),
          ...policy.tokens.map((token) => token.evmAddress),
          ...loadSupportCatalog(SPONSOR.network).assets.flatMap((asset) => [
            asset.destination.address,
            ...(asset.destination.wrapper ? [asset.destination.wrapper.address, asset.destination.wrapper.htsAddress] : []),
          ]),
        ],
        allowedSelectors: ["0x0a754de6" as Hex, "0x095ea7b3" as Hex, "0x62355638" as Hex, "0xac9650d8" as Hex, "0x4a25d94a" as Hex],
        perTransactionCapTinybar: SPONSOR.perTxAllowanceCapTinybar,
        dailyCapTinybar: SPONSOR.dailyExposureCapTinybar,
        minimumReserveTinybar: SPONSOR.minReserveTinybar,
      },
      sponsor: {
        submitSponsored: async (rawTransaction, allowance) => {
          const submitted = await sponsor.submitSponsored(rawTransaction, allowance);
          return { ethereumHash: submitted.ethereumHash };
        },
      },
      estimateGas: async (rawTransaction) => {
        const serialized = rawTransaction as TransactionSerialized;
        const transaction = parseTransaction(serialized);
        if (!transaction.to) throw new Error("transaction target is missing");
        const from = getAddress(await recoverTransactionAddress({ serializedTransaction: serialized }));
        return mirror.estimateGas(from, getAddress(transaction.to), (transaction.data ?? "0x") as Hex);
      },
      reserveTinybar: async () => {
        const account = await mirror.account(SPONSOR.operatorId);
        return account ? BigInt(account.balance.balance) : 0n;
      },
      exposureSince: sponsorExposureSince,
    })
  : undefined;
const policyRpc = createPolicyRpcProcessor({
  upstreams: { testnet: TESTNET.rpcUrl, mainnet: MAINNET.rpcUrl },
  authorizer: policyRpcWriteGate ? productLifecycleStore ?? undefined : undefined,
  submitter: policyRpcSubmitter ? { [SPONSOR.network]: policyRpcSubmitter } : undefined,
});
app.post("/rpc/:mode", async (req, res) => {
  if (!(await readLimiter.allow(`${requestClientIp(req)}:policy-rpc`))) {
    return res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "Rate limited" } });
  }
  if (req.params.mode !== "testnet" && req.params.mode !== "mainnet") {
    return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "Unknown network mode" } });
  }
  const mode = req.params.mode;
  if (Array.isArray(req.body)) {
    if (req.body.length > 20) {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } });
    }
    const bodies = await Promise.all(req.body.map((request) => policyRpc(mode, request)));
    return res.json(bodies);
  }
  const body = await policyRpc(mode, req.body);
  res.status("error" in body && body.error?.code === -32004 ? 503 : 200).json(body);
});
app.get("/v1/product/policy-rpc", (_req, res) => {
  res.json({
    schema: "refuel402.policy-rpc-capability.v1",
    readMethods: policyRpcReadMethods,
    writeMethod: "eth_sendRawTransaction",
    writeEnabled: !!productLifecycleStore && !!policyRpcSubmitter,
    lifecyclePersistenceReady: !!productLifecycleStore,
    submitterReady: !!policyRpcSubmitter,
    intentBuilderReady: !!productIntentBuilder,
    paymentVerifierReady: !!productPaymentVerifier,
    receiptReconcilerReady: !!productReceiptReconciler,
    authorizationBinding: [
      "account",
      "chainId",
      "nonce",
      "target",
      "calldataHash",
      "value",
      "gasLimitMaximum",
      "maxGasAllowanceTinybar",
      "expiry",
    ],
    acceptanceLevel: "integration_harness",
  });
});

/**
 * Inspect any account: is it "stranded" (holds fuelable tokens but ~zero HBAR)?
 * Returns, per held token, whether Refuel402 can fuel it, plus bridge provenance
 * — this is what the frontend and bridge integrations key off.
 */
app.get("/v1/account/:idOrAddress", async (req, res) => {
  try {
    if (!(await readLimiter.allow(requestClientIp(req)))) return fail(res, 429, "RATE_LIMITED", "slow down", true);
    const network = reqNet(req);
    const nc = NETWORKS[network];
    const id = req.params.idOrAddress;
    if (!/^(\d+\.\d+\.\d+|0x[0-9a-fA-F]{40})$/.test(id)) {
      return res.status(400).json({ error: "expected a Hedera id (0.0.x) or EVM address (0x…40 hex)" });
    }
    const acct = await mirrors[network].account(id);
    if (!acct) {
      return res.json({
        exists: false,
        network,
        accountState: "nonexistent",
        stranded: false,
        message: "No account yet. Receiving HBAR or an HTS token at this EVM alias auto-creates one; arbitrary calls do not.",
      });
    }
    const hbar = BigInt(acct.balance.balance);
    const held = acct.balance.tokens ?? [];
    const netTokens = tokensFor(network);
    const fuelable = [];
    const bridgeById: Record<string, { bridge: string; symbol: string; fuelableToday: boolean; note?: string }> = {};
    if (network === "mainnet") {
      for (const [bridge, data] of Object.entries(BRIDGES)) {
        for (const [tid, meta] of Object.entries(data.tokens ?? {})) {
          bridgeById[tid] = { bridge: data.displayName ?? bridge, ...meta };
        }
      }
    }
    for (const t of held) {
      if (BigInt(t.balance) <= 0n) continue;
      const supported = netTokens.find((s) => s.tokenId === t.token_id);
      const br = bridgeById[t.token_id];
      fuelable.push({
        tokenId: t.token_id,
        balance: t.balance,
        symbol: supported?.symbol ?? br?.symbol ?? null,
        fuelable: !!supported,
        bridge: br?.bridge ?? supported?.bridge ?? null,
        note: supported
          ? "fuelable now"
          : br
            ? br.fuelableToday
              ? "bridge asset, liquid — add to whitelist"
              : "bridge asset, insufficient SaucerSwap liquidity to fuel directly today"
          : "not on the fuel whitelist",
      });
    }
    const hasFuelable = fuelable.some((f) => f.fuelable);
    const accountState = !acct.key
      ? "hollow"
      : hbar === 0n
        ? "complete_zero_hbar"
        : "complete_funded";
    res.json({
      exists: true,
      network,
      accountState,
      keyType: acct.key?._type ?? null,
      account: acct.account,
      evmAddress: acct.evm_address,
      hbarTinybar: hbar.toString(),
      ethereumNonce: acct.ethereum_nonce,
      stranded: hbar < 100_000_000n && hasFuelable, // < 1 HBAR and holds a fuelable token
      tokens: fuelable,
      hashscan: `${nc.hashscanBase}/account/${acct.account}`,
    });
  } catch {
    return fail(res, 503, "ACCOUNT_LOOKUP_UNAVAILABLE", "account state is temporarily unavailable", true);
  }
});

app.get("/v1/bridges", (req, res) => {
  const network = reqNet(req);
  // Configured bridge arrivals are a mainnet-only read surface. Returning an
  // empty testnet map prevents UI/read clients from mixing chain provenance.
  res.json(network === "mainnet" ? BRIDGES : {});
});

app.get("/v1/whitelist", (req, res) => {
  const network = reqNet(req);
  const file = path.join(sourceWebDir, "..", "config", `whitelist.${network}.json`);
  if (!fs.existsSync(file)) return res.json({ network, tokens: [], rejected: [] });
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    tokens?: ({ bridge?: string | null; supported?: boolean } & Record<string, unknown>)[];
    rejected?: unknown[];
  };
  const tokens = (raw.tokens ?? []).filter((token) => token.supported !== false && token.bridge !== "hashport");
  res.json({ ...raw, network, chainId: NETWORKS[network].chainId, tokens });
});
app.get("/v1/tokens", (req, res) => {
  // Agent-friendly alias of the whitelist, with the fields an agent needs to
  // build a bundle (evm address, decimals, pool fee, route, max amount, bridge).
  const network = reqNet(req);
  const nc = NETWORKS[network];
  res.json({
    network: nc.caip2,
    router: { evm: nc.router, hedera: nc.routerId },
    whbar: { evm: nc.whbarToken, hedera: nc.whbarTokenId },
    quoter: nc.quoter,
    chainId: nc.chainId,
    tokens: tokensFor(network).map((t) => ({
      symbol: t.symbol,
      tokenId: t.tokenId,
      evmAddress: t.evmAddress,
      decimals: t.decimals,
      poolFee: t.poolFee,
      route: t.route ?? null,
      maxAmountIn: t.maxAmountIn.toString(),
      bridge: t.bridge ?? null,
    })),
  });
});

app.get("/v1/health", async (_req, res) => {
  const [testnetGates, mainnetGates] = await Promise.all([
    probeRuntimeGates("testnet", mirrors.testnet),
    probeRuntimeGates("mainnet", mirrors.mainnet),
  ]);
  const productTestnet = productOptions("testnet", testnetGates);
  const productMainnet = productOptions("mainnet", mainnetGates);
  res.json({
    ok: true,
    service: "Refuel402",
    acceptanceLevel: "integration_harness",
    product: {
      testnet: productTestnet.capabilities,
      mainnet: productMainnet.capabilities,
      sameWallet: true,
    },
    legacyTechnicalApi: {
      network: NETWORK,
      executable: runtimeExecutable,
      sponsor: runtimeExecutable ? SPONSOR.operatorId : null,
      facilitator: runtimeExecutable ? FACILITATOR_URL : null,
    },
    time: new Date().toISOString(),
  });
});

app.get("/.well-known/x402", async (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const [testnetGates, mainnetGates] = await Promise.all([
    probeRuntimeGates("testnet", mirrors.testnet),
    probeRuntimeGates("mainnet", mirrors.mainnet),
  ]);
  const testnetReady = productOptions("testnet", testnetGates).capabilities.execution;
  const mainnetReady = productOptions("mainnet", mainnetGates).capabilities.execution;
  res.json({
    x402Version: 2,
    service: "Refuel402",
    acceptanceLevel: "integration_harness",
    description: "Manual same-wallet Hedera refuel payment resource using HTTP 402 exact/Permit2 settlement. The separate pre-authorized path collects its bounded service fee inside atomic executeRefuel.",
    resources: [
      {
        resource: `${base}/v1/product/journeys/{journeyId}/payment`,
        type: "http",
        method: "POST",
        quote: `${base}/v1/product/quote`,
        executionReady: mainnetReady || testnetReady,
        networkReadiness: {
          testnet: testnetReady,
          mainnet: mainnetReady,
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:<295|296 from the stored quote>",
            asset: "<exact Hedera destination token from the stored quote>",
            amount: "<quote-bound service fee>",
            maxTimeoutSeconds: 180,
            extra: { assetTransferMethod: "permit2" },
          },
        ],
        metadata: {
          options: `${base}/v1/product/options?mode=testnet`,
          policyRpc: `${base}/v1/product/policy-rpc`,
          productContract: "docs/PRODUCT.md",
          paymentRole: "manual_destination_conversion",
          preauthorizedFeeRole: "collected_inside_executeRefuel_not_a_second_http_402_round_trip",
        },
      },
    ],
    legacyTechnicalResources: [
      {
        resource: `${base}/v1/fuel`,
        network: NETWORK,
        note: "Native-Hedera x402/HAPI compatibility endpoint; not the stock-MetaMask product path.",
      },
    ],
  });
});

app.get("/v1/openapi.json", (req, res) => {
  res.json(openApiSpec(`${req.protocol}://${req.get("host")}`));
});

const RefuelPlanBody = z.object({
  network: z.enum(["testnet", "mainnet"]).default("testnet"),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^\d+\.\d+\.\d+$/),
  desiredHbar: z.string().regex(/^\d+(\.\d{1,8})?$/),
  minimumRetained: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  slippageBps: z.number().int().min(0).max(refuelPlanLimits().maxSlippageBps).optional(),
});

// Legacy technical pre-signature planner retained for regression/agent clients.
// The human product authority is /v1/product/quote. This endpoint never mutates.
app.post("/v1/refuel/plan", async (req, res) => {
  try {
    if (!(await readLimiter.allow(requestClientIp(req)))) return fail(res, 429, "RATE_LIMITED", "slow down", true);
    const parsed = RefuelPlanBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "BAD_REQUEST", "invalid plan request", false, parsed.error.issues);
    const token = tokensFor(parsed.data.network).find((candidate) => candidate.tokenId === parsed.data.tokenId);
    if (!token) return fail(res, 400, "FEE_TOKEN_UNSUPPORTED", "token is not on the live fuel whitelist", false);
    const desiredHbarTinybar = parseDecimalUnits(parsed.data.desiredHbar, 8);
    const minimumRetainedToken = parsed.data.minimumRetained
      ? parseDecimalUnits(parsed.data.minimumRetained, token.decimals)
      : undefined;
    const plan = await createRefuelPlan(mirrors[parsed.data.network], {
      network: parsed.data.network,
      account: getAddress(parsed.data.account),
      token,
      desiredHbarTinybar,
      minimumRetainedToken,
      slippageBps: parsed.data.slippageBps,
      sponsorAccountId:
        parsed.data.network === SPONSOR.network && runtimeExecutable ? SPONSOR.operatorId : undefined,
      dailyCommittedTinybar: await sponsorExposureSince(Date.now() - 86_400_000),
      allowHollowExperiment: process.env.ALLOW_HOLLOW_EXPERIMENT === "1",
    });
    res.status(plan.ok ? 200 : 422).json(plan);
  } catch (error) {
    return fail(res, 422, "PLAN_UNAVAILABLE", (error as Error).message, true);
  }
});

// Signed-bundle quote: prices the exact immutable bundle without payment or
// submission and returns the x402 requirements used by POST /v1/fuel.
app.post("/v1/quote", async (req, res) => {
  try {
    if (!(await readLimiter.allow(requestClientIp(req)))) return fail(res, 429, "RATE_LIMITED", "slow down", true);
    const parsed = FuelBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "BAD_REQUEST", "invalid body", false, parsed.error.issues);
    const rawTxs = parsed.data.transactions as Hex[];

    const verdict = await evaluateBundle(policy, rawTxs);
    if (!verdict.ok || !verdict.summary) {
      return fail(res, 400, "POLICY_REJECTED", "bundle rejected by policy", false, verdict.violations);
    }
    const summary = verdict.summary;
    const pre = await preflightBundle(mirror, verdict.decoded, summary, { requiredExtraBalance: 0n });
    if (!pre.ok) return fail(res, 422, "PREFLIGHT_FAILED", "preflight failed", true, pre.failures);

    const feeCtx = await resolveFeeContext(summary, pre, parsed.data.feeTokenId);
    if (!feeCtx.ok) return fail(res, feeCtx.status, feeCtx.code, feeCtx.message, feeCtx.status >= 500);

    const quote = await priceSponsorship({
      mirror,
      cfg: pricing,
      totalGasLimit: summary.totalGasLimit,
      expectedGasUnits: pre.expectedGasUnits,
      perLegExpectedGas: pre.perLegGas,
      perTxAllowanceCapTinybar: SPONSOR.perTxAllowanceCapTinybar,
      hapiReservePerLegTinybar: SPONSOR.hapiReservePerLegTinybar,
      amountIn: feeCtx.amountInForConv,
      expectedOutTinybar: feeCtx.expectedOutTinybar,
      feeTokenId: feeCtx.feeToken.tokenId,
      feeTokenSymbol: feeCtx.feeToken.symbol,
    });

    const feeIsSwapInput = summary.hasSwap && summary.swapInputToken?.tokenId === feeCtx.feeToken.tokenId;
    const requiredFeeTokenBalance = (feeIsSwapInput ? summary.amountIn : 0n) + quote.feeAmount;
    const x402server = await getX402Server();
    const requirements = await buildRequirements(
      x402server,
      makeContext(req),
      feeCtx.feeToken.tokenId,
      quote.feeAmount.toString(),
    );

    res.json({
      bundleHash: semanticBundleHash(summary),
      ops: summary.kinds,
      quote: {
        feeToken: feeCtx.feeToken.symbol,
        feeTokenId: feeCtx.feeToken.tokenId,
        feeAmount: quote.feeAmount.toString(),
        feeAmountDisplay: `${(Number(quote.feeAmount) / 10 ** feeCtx.feeToken.decimals).toFixed(feeCtx.feeToken.decimals)} ${feeCtx.feeToken.symbol}`,
        feeUsd: quote.feeUsd,
        expiresAt: quote.expiresAt,
        maxGasAllowanceTinybar: quote.maxGasAllowanceTinybar.toString(),
        perLegGasAllowanceTinybar: quote.perLegGasAllowanceTinybar.map(String),
        hapiReserveTinybar: quote.hapiReserveTinybar.toString(),
        maxSponsorExposureTinybar: quote.maxSponsorExposureTinybar.toString(),
        feeComponentsTinybar: Object.fromEntries(
          Object.entries(quote.feeComponentsTinybar).map(([key, value]) => [key, value.toString()]),
        ),
      },
      swap: summary.hasSwap
        ? {
            mode: summary.swapMode,
            sender: summary.sender,
            inputToken: summary.swapInputToken!.symbol,
            amountInMaximum: summary.amountIn.toString(),
            expectedAmountIn: pre.expectedAmountIn?.toString() ?? null,
            expectedOutTinybar: pre.expectedOut?.toString() ?? null,
            desiredHbarTinybar: summary.amountOutMinimum.toString(),
          }
        : null,
      requiresFeeTokenBalance: requiredFeeTokenBalance.toString(),
      payment: { x402Version: 2, accepts: requirements },
    });
  } catch {
    return fail(res, 500, "INTERNAL", "quote generation failed", true);
  }
});

function demoAuthorized(req: express.Request): boolean {
  const configured = process.env.DEMO_AUTH_TOKEN;
  const presented = req.header("authorization");
  return process.env.NODE_ENV !== "production" &&
    process.env.DEMO_ENABLE === "1" &&
    typeof configured === "string" && configured.length >= 16 &&
    presented === `Bearer ${configured}`;
}

app.get("/v1/demo/user", (_req, res) => {
  const enabled = process.env.NODE_ENV !== "production" && process.env.DEMO_ENABLE === "1";
  res.json({
    evmAddress: enabled ? process.env.DEMO_USER_EVM_ADDRESS ?? null : null,
    enabled,
    mutationAuthRequired: true,
  });
});

// Labeled testnet post-arrival stand-in for the legacy technical harness. Axelar
// and LayerZero have testnet infrastructure, but no current provider asset also
// has a qualifying Saucer testnet route. This creates only the isolated
// destination state (held token, 0 HBAR). Guarded; testnet only.
app.post("/v1/demo/bridge-arrival", async (req, res) => {
  if (!demoAuthorized(req) || !sponsor) {
    return fail(res, 403, "DEMO_AUTH_REQUIRED", "demo mutation requires an operator bearer token", false);
  }
  if (!(await demoLimiter.allow(`bridge:${requestClientIp(req)}`))) {
    return fail(res, 429, "DEMO_CAP_REACHED", "demo mutation cap reached", false);
  }
  const body = z
    .object({
      account: z.string().regex(/^(\d+\.\d+\.\d+|0x[0-9a-fA-F]{40})$/),
      tokenId: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
      amount: z.string().regex(/^\d+$/).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "BAD_REQUEST", "expected {account, tokenId?, amount?}", false, body.error.issues);
  const token = ALL_TOKENS.find((t) => t.tokenId === (body.data.tokenId ?? ALL_TOKENS[0]?.tokenId));
  if (!token) return fail(res, 400, "FEE_TOKEN_UNSUPPORTED", "tokenId not whitelisted", false);
  // Cap the stand-in transfer at a small "arrival" amount regardless of caller
  // input — this is a demo faucet, not a treasury drain. Default + max = a few
  // whole tokens' worth of the smallest units.
  const oneToken = BigInt(10) ** BigInt(token.decimals);
  const maxArrival = oneToken * 5n;
  const requested = body.data.amount ? BigInt(body.data.amount) : oneToken;
  const amount = requested > maxArrival ? maxArrival : requested;
  try {
    const r = await sponsor.sendToken(token.tokenId, body.data.account, amount);
    res.json({
      simulated: true,
      note: "TESTNET STAND-IN for a mainnet Squid/Axelar or Stargate/LayerZero arrival",
      token: token.symbol,
      amount: amount.toString(),
      transactionId: r.transactionId,
      status: r.status,
      hashscan: hashscanTx(r.transactionId),
    });
  } catch {
    return fail(res, 502, "TRANSFER_FAILED", "testnet stand-in transfer failed", true);
  }
});

// Frontend "Run the flow" button. Guarded: only enabled when DEMO_ENABLE=1 and
// a demo user key is configured. Runs the exact client flow server-side and
// streams step updates as newline-delimited JSON.
app.post("/v1/demo/run", async (req, res) => {
  if (!demoAuthorized(req) || !process.env.DEMO_USER_PRIVATE_KEY || !sponsor) {
    return fail(res, 403, "DEMO_AUTH_REQUIRED", "demo runner requires operator authentication and configured testnet credentials", false);
  }
  if (!(await demoLimiter.allow(`run:${requestClientIp(req)}`))) {
    return fail(res, 429, "DEMO_CAP_REACHED", "demo mutation cap reached", false);
  }
  res.setHeader("content-type", "application/x-ndjson");
  const emit = (k: string, data: Record<string, unknown>) =>
    res.write(JSON.stringify({ step: k, ...data }) + "\n");
  try {
    const { runFuelDemo } = await import("./demorunner.js");
    await runFuelDemo(`http://127.0.0.1:${SPONSOR.port}`, emit);
  } catch (e) {
    emit("error", { message: (e as Error).message });
  }
  res.end();
});

app.get("/v1/policy", (req, res) => {
  const network = reqNet(req);
  const nc = NETWORKS[network];
  const p = policyConfig(network);
  // Execution (sponsorship) is available only on the network the sponsor is
  // funded on; other networks are read/analysis-only.
  const executable = network === SPONSOR.network && runtimeExecutable;
  res.json({
    service: "Refuel402",
    legacyTechnicalApi: true,
    productAuthority: "/v1/product/options",
    network: nc.caip2,
    executable,
    executionNetwork: SPONSOR.network,
    chainId: p.chainId,
    router: { evm: nc.router, hedera: nc.routerId },
    whbar: { evm: nc.whbarToken, hedera: nc.whbarTokenId },
    quoter: nc.quoter,
    sponsor: executable ? SPONSOR.operatorId : null,
    facilitator: executable ? FACILITATOR_URL : null,
    sponsorLimits: {
      perTransactionAllowanceTinybar: SPONSOR.perTxAllowanceCapTinybar.toString(),
      perRequestExposureTinybar: SPONSOR.perRequestExposureCapTinybar.toString(),
      dailyExposureTinybar: SPONSOR.dailyExposureCapTinybar.toString(),
      minimumReserveTinybar: SPONSOR.minReserveTinybar.toString(),
    },
    gasLimits: {
      swap: p.maxGasLimit.toString(),
      associate: p.associateGasLimit.toString(),
      approve: p.approveGasLimit.toString(),
    },
    deadlineWindowSec: { min: p.minDeadlineBufferSec, max: p.maxDeadlineSkewSec },
    ops: ["associate", "approve", "swap"],
    bundleShape:
      "ordered subset of [associate: IHRC719(token).associate() only when missing; approve: ERC20(token).approve(router, exact maximum) only when allowance is low; swap: multicall([exactOutput(vetted reverse path, recipient=router), unwrapWHBAR(exact output, recipient=signer)])] — same signer, sequential nonces, EIP-1559, value 0. Legacy exactInput decoding remains compatibility-only; /v1/refuel/plan always emits exactOutput. Standalone operations need feeTokenId.",
    tokens: p.tokens.map((t) => ({
      symbol: t.symbol,
      tokenId: t.tokenId,
      evmAddress: t.evmAddress,
      decimals: t.decimals,
      maxAmountIn: t.maxAmountIn.toString(),
      poolFee: t.poolFee,
      route: t.route ?? null,
      bridge: t.bridge ?? null,
    })),
    discovery: "/.well-known/x402",
    openapi: "/v1/openapi.json",
    productFlow: "GET /v1/product/options -> POST /v1/product/quote -> unified same-wallet journey (write-gated)",
    legacyFlow: "POST /v1/refuel/plan -> POST /v1/quote -> POST /v1/fuel -> native-Hedera x402/HAPI compatibility lifecycle",
  });
});

app.get("/v1/fuel/:hash", async (req, res) => {
  const rec = await store.get(req.params.hash as Hex);
  if (!rec) return res.status(404).json({ error: "unknown bundle" });
  res.json(publicRecord(rec));
});

export function createFuelHandler(overrides: Record<string, unknown> = {}) {
  // productLedger is consumed here rather than merged into d: it only feeds the
  // daily-cap reader below and must be injectable exactly like the legacy store,
  // otherwise a harness that points its own store at a shared database reads
  // leftover product authorization rows the module-level binding still sees.
  const { productLedger = productLifecycleStore, ...rest } = overrides as
    Record<string, unknown> & { productLedger?: ProductSponsorLedger | null };
  const d = {
    evaluateBundle,
    preflightBundle,
    recheckBalance,
    resolveFeeContext,
    getX402Server,
    makeContext,
    priceSponsorship,
    buildRequirements,
    refundPayment,
    hashscanTx,
    checkSponsorReserve,
    allowHollowExperiment: process.env.ALLOW_HOLLOW_EXPERIMENT === "1",
    store,
    limiter,
    mirror,
    policy,
    pricing,
    sponsor,
    runtimeExecutable,
    nowSec: () => Math.floor(Date.now() / 1000),
    ...rest,
  } as any;
  // Bound after overrides so an injected store is the legacy ledger it reads.
  d.sponsorExposureSince ??= createSponsorExposureReader({
    legacy: d.store,
    product: productLedger ?? null,
  });
  return async (req: express.Request, res: express.Response) => {
  try {
    if (!d.runtimeExecutable || !d.sponsor) {
      return fail(res, 503, "EXECUTION_DISABLED", `sponsorship execution is disabled on ${SPONSOR.network}`, false);
    }
    const parsed = FuelBody.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "BAD_REQUEST", "invalid body", false, parsed.error.issues);
    }
    const rawTxs = parsed.data.transactions as Hex[];

    // ---- 1. Policy: is this a bundle we are willing to sponsor at all? ----
    const verdict = await d.evaluateBundle(d.policy, rawTxs);
    if (!verdict.ok || !verdict.summary) {
      return fail(res, 400, "POLICY_REJECTED", "bundle rejected by policy", false, verdict.violations);
    }
    const summary = verdict.summary;
    // Store key = semantic bundle hash, plus the REQUESTED fee token for
    // swap-less bundles (the fee token is a request-level choice not in the
    // bundle bytes; binding it here prevents a re-quote in a cheaper fee token
    // from reusing the first token's fee amount — audit HIGH). Swap bundles bill
    // in the swap input token, which is already inside the semantic hash.
    const requestedFeeTokenId = summary.hasSwap
      ? summary.swapInputToken!.tokenId
      : parsed.data.feeTokenId ?? summary.approve?.token.tokenId ?? "";
    const hash = summary.hasSwap
      ? semanticBundleHash(summary)
      : keccak256(stringToHex(`${semanticBundleHash(summary)}:${requestedFeeTokenId}`));
    const rawHash = rawBundleHash(rawTxs);

    // Idempotency: a finished bundle returns its receipt; an in-flight one its state.
    const existing = await d.store.get(hash);
    if (existing && ["submitting", "completed", "partial", "refunded", "review", "failed"].includes(existing.state)) {
      return res.status(existing.state === "completed" ? 200 : 409).json(publicRecord(existing));
    }
    // Same semantics re-encoded with different bytes while a quote is live -> refuse.
    if (existing && existing.rawHash !== rawHash) {
      return fail(res, 409, "RAW_BUNDLE_MISMATCH", "an equivalent bundle with different encoding already has a live quote", false, { bundleHash: hash });
    }
    // Expire first so stale quotes never retain a nonce lock.
    await d.store.expireStaleQuotes(d.nowSec());
    // One live bundle per (signer, nonce): kills concurrent-nonce griefing.
    const busy = await d.store.nonceBusy(summary.sender, summary.nonces, hash);
    if (busy) {
      return fail(res, 409, "NONCE_BUSY", `bundle ${busy.bundleHash} already holds a live quote for these nonces`, true, { bundleHash: busy.bundleHash });
    }

    if (!(await d.limiter.allow(requestClientIp(req))) || !(await d.limiter.allow(`sender:${summary.sender}`))) {
      return fail(res, 429, "RATE_LIMITED", "slow down", true);
    }

    // ---- 2. Preflight against live chain state ----
    const pre = await d.preflightBundle(d.mirror, verdict.decoded, summary, {
      requiredExtraBalance: 0n,
      allowHollow: d.allowHollowExperiment,
    });
    if (!pre.ok) {
      return fail(res, 422, "PREFLIGHT_FAILED", "preflight failed", true, pre.failures);
    }

    // ---- 2b. Resolve the fee token + conversion basis (swap or swap-less) ----
    const feeCtx = await d.resolveFeeContext(summary, pre, parsed.data.feeTokenId);
    if (!feeCtx.ok) {
      return fail(res, feeCtx.status, feeCtx.code, feeCtx.message, feeCtx.status >= 500);
    }

    const x402server = await d.getX402Server();
    const context = d.makeContext(req);
    const opDesc = summary.kinds.join("+");
    const resourceInfo: ResourceInfo = {
      url: `${req.protocol}://${req.get("host")}/v1/fuel`,
      description: summary.hasSwap
        ? `Sponsored SaucerSwap execution (${opDesc}): ${summary.amountIn} ${summary.swapInputToken!.symbol} -> native HBAR for ${summary.sender}`
        : `Sponsored Hedera ops (${opDesc}) for ${summary.sender}, fee in ${feeCtx.feeToken.symbol}`,
      mimeType: "application/json",
      serviceName: "Refuel402",
      tags: ["gas", "hedera", "saucerswap", "refuel", ...summary.kinds],
    };

    // ---- 3. Quote (reuse the stored unexpired quote so payment matches exactly) ----
    const now = d.nowSec();
    let feeAmount: bigint;
    let quote: Quote | null = null;
    // Reuse only if the stored quote is for the SAME fee token (belt-and-suspenders
    // with the fee-token-bound store key above — never reprice one token's amount
    // into a different token).
    if (
      existing?.quote &&
      existing.state === "quoted" &&
      existing.quote.expiresAt > now &&
      existing.quote.feeTokenId === feeCtx.feeToken.tokenId
    ) {
      feeAmount = BigInt(existing.quote.feeAmount);
    } else {
      const priced = await d.priceSponsorship({
        mirror: d.mirror,
        cfg: d.pricing,
        totalGasLimit: summary.totalGasLimit,
        expectedGasUnits: pre.expectedGasUnits,
        perLegExpectedGas: pre.perLegGas,
        perTxAllowanceCapTinybar: SPONSOR.perTxAllowanceCapTinybar,
        hapiReservePerLegTinybar: SPONSOR.hapiReservePerLegTinybar,
        amountIn: feeCtx.amountInForConv,
        expectedOutTinybar: feeCtx.expectedOutTinybar,
        feeTokenId: feeCtx.feeToken.tokenId,
        feeTokenSymbol: feeCtx.feeToken.symbol,
      }) as Quote;
      quote = priced;
      feeAmount = priced.feeAmount;
    }

    const maxExposureTinybar = quote
      ? quote.maxSponsorExposureTinybar
      : BigInt(existing!.quote!.maxSponsorExposureTinybar);
    if (maxExposureTinybar > SPONSOR.perRequestExposureCapTinybar) {
      return fail(res, 422, "REQUEST_SPONSOR_CAP", "request exceeds the aggregate sponsor exposure cap", false, {
        requestedExposureTinybar: maxExposureTinybar.toString(),
        requestCapTinybar: SPONSOR.perRequestExposureCapTinybar.toString(),
      });
    }
    const dailyCommittedTinybar = await d.sponsorExposureSince(Date.now() - 86_400_000);
    if (dailyCommittedTinybar + maxExposureTinybar > SPONSOR.dailyExposureCapTinybar) {
      return fail(res, 429, "DAILY_SPONSOR_CAP", "daily sponsor exposure cap reached", true, {
        dailyCommittedTinybar: dailyCommittedTinybar.toString(),
        requestedExposureTinybar: maxExposureTinybar.toString(),
        dailyCapTinybar: SPONSOR.dailyExposureCapTinybar.toString(),
      });
    }
    const reserve = await d.checkSponsorReserve(maxExposureTinybar);
    if (!reserve.ok) {
      return fail(res, 503, "SPONSOR_RESERVE_LOW", "sponsor reserve is below the configured post-request floor", true, {
        balanceTinybar: reserve.balanceTinybar?.toString() ?? null,
        requiredTinybar: reserve.requiredTinybar.toString(),
      });
    }

    // The payer must hold (swap amountIn if the fee token is the swap input) + fee.
    // Fail CLOSED on an "unknown" (RPC error) — never let an unverified balance through.
    const feeIsSwapInput =
      summary.hasSwap && summary.swapInputToken?.tokenId === feeCtx.feeToken.tokenId;
    const requiredFeeTokenBalance = (feeIsSwapInput ? summary.amountIn : 0n) + feeAmount;
    const funded = await d.recheckBalance(
      d.mirror,
      feeCtx.feeToken.evmAddress,
      summary.sender,
      requiredFeeTokenBalance,
    );
    if (funded !== "ok") {
      return fail(res, funded === "unknown" ? 503 : 422, "PREFLIGHT_FAILED", "preflight failed", funded === "unknown", [
          {
            code: funded === "unknown" ? "BALANCE_UNVERIFIABLE" : "INSUFFICIENT_BALANCE_WITH_FEE",
            message:
              funded === "unknown"
                ? "could not verify balance (mirror/RPC error) — retry shortly"
                : `account must hold ${requiredFeeTokenBalance} ${feeCtx.feeToken.symbol} units (${feeIsSwapInput ? "amountIn + fee" : "fee"})`,
          },
        ]);
    }

    const routeDescriptor = d.policy.routeFor(feeCtx.feeToken)
      .map((hop: { toToken: string; fee: number }) => `${hop.toToken.toLowerCase()}:${hop.fee}`)
      .join("|");
    const routeId = keccak256(stringToHex(
      `${SPONSOR.network}:${EXECUTION.chainId}:${EXECUTION.router.toLowerCase()}:${feeCtx.feeToken.tokenId}:${routeDescriptor}`,
    ));
    const activeQuote = quote
      ? {
          feeToken: quote.feeTokenSymbol,
          feeTokenId: quote.feeTokenId,
          feeAmount: quote.feeAmount.toString(),
          expiresAt: quote.expiresAt,
          estimatedGasTinybar: quote.estimatedCostTinybar.toString(),
          maxGasAllowanceTinybar: quote.maxGasAllowanceTinybar.toString(),
          perLegGasAllowanceTinybar: quote.perLegGasAllowanceTinybar.map(String),
          hapiReserveTinybar: quote.hapiReserveTinybar.toString(),
          maxSponsorExposureTinybar: quote.maxSponsorExposureTinybar.toString(),
          feeComponentsTinybar: Object.fromEntries(
            Object.entries(quote.feeComponentsTinybar).map(([key, value]) => [key, value.toString()]),
          ),
        }
      : existing?.quote ?? null;
    if (!activeQuote) return fail(res, 409, "QUOTE_IDENTITY_MISSING", "stored quote identity is missing", false);
    const quoteId = keccak256(stringToHex(
      `${NETWORK}:${EXECUTION.chainId}:${hash}:${rawHash}:${feeCtx.feeToken.tokenId}:${feeAmount}:${routeId}:${activeQuote.maxSponsorExposureTinybar}`,
    ));
    const requirements = existing?.requirements?.length
      ? (existing.requirements as PaymentRequirements[])
      : (await d.buildRequirements(
          x402server,
          context,
          feeCtx.feeToken.tokenId,
          feeAmount.toString(),
        )).map((requirement: PaymentRequirements) => ({
          ...requirement,
          extra: { ...(requirement.extra ?? {}), refuel402QuoteId: quoteId },
        }));
    const requirementsHash = keccak256(stringToHex(canonicalJson(requirements)));
    if (existing && (
      existing.network !== SPONSOR.network || existing.chainId !== EXECUTION.chainId ||
      existing.quoteId !== quoteId || existing.routeId !== routeId ||
      existing.requirementsHash !== requirementsHash
    )) {
      return fail(res, 409, "IMMUTABLE_IDENTITY_MISMATCH", "request no longer matches the paid quote identity", false);
    }

    // ---- 4. No payment yet -> 402 challenge ----
    if (!context.paymentHeader) {
      const rec: SponsorshipRecord = {
        bundleHash: hash,
        rawHash,
        rawTxs,
        network: SPONSOR.network,
        chainId: EXECUTION.chainId,
        quoteId,
        routeId,
        requirementsHash,
        requirements,
        economicContract: "prepaid_bounded_attempt_v1",
        signer: summary.sender,
        nonces: summary.nonces,
        state: "quoted",
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        quote: activeQuote,
        payment: null,
        execution: null,
        refund: null,
        error: null,
      };
      await d.store.upsert(rec);
      const body = await x402server.createPaymentRequiredResponse(
        requirements,
        resourceInfo,
        "Payment required to sponsor this SaucerSwap bundle",
      );
      res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(body));
      const idem = req.header("idempotency-key");
      if (idem) res.setHeader("Idempotency-Key", idem);
      return res.status(402).json({
        ...body,
        // Forward-compat x402 Bazaar signal (the testnet facilitator does not
        // index today; a Hedera-indexing facilitator would auto-catalog on settle).
        extensions: {
          ...(body as { extensions?: Record<string, unknown> }).extensions,
          bazaar: { serviceName: "Refuel402", tags: ["gas", "hedera", "saucerswap", "refuel"] },
        },
        sponsorship: {
          bundleHash: hash,
          rawHash,
          quoteId,
          routeId,
          requirementsHash,
          network: NETWORK,
          chainId: EXECUTION.chainId,
          sender: summary.sender,
          ops: summary.kinds,
          swap: summary.hasSwap
            ? `${summary.swapMode}: <=${summary.amountIn} ${summary.swapInputToken!.symbol} -> ${summary.amountOutMinimum} tinybar native HBAR`
            : null,
          associate: summary.associateToken ? summary.associateToken.tokenId : null,
          approve: summary.approve
            ? { token: summary.approve.token.tokenId, amount: summary.approve.amount.toString() }
            : null,
          fee: `${feeAmount} ${feeCtx.feeToken.symbol} smallest-units`,
          expectedOutTinybar: pre.expectedOut ? pre.expectedOut.toString() : null,
          quoteExpiresAt: rec.quote?.expiresAt ?? null,
          exposure: {
            perLegGasAllowanceTinybar: rec.quote?.perLegGasAllowanceTinybar ?? [],
            hapiReserveTinybar: rec.quote?.hapiReserveTinybar ?? null,
            maxSponsorExposureTinybar: rec.quote?.maxSponsorExposureTinybar ?? null,
            feeComponentsTinybar: rec.quote?.feeComponentsTinybar ?? null,
          },
        },
      });
    }

    // ---- 5. Payment present -> verify, settle ----
    const rec = await d.store.get(hash);
    if (!rec || !rec.quote) {
      return fail(res, 402, "QUOTE_REQUIRED", "no live quote for this bundle; request one first", true);
    }
    if (rec.quote.expiresAt <= now) {
      return fail(res, 402, "QUOTE_EXPIRED", "quote expired; sign a fresh bundle with a new nonce", true);
    }
    let payload;
    try {
      payload = decodePaymentSignatureHeader(context.paymentHeader);
    } catch {
      return fail(res, 400, "PAYMENT_HEADER_MALFORMED", "malformed PAYMENT-SIGNATURE header", false);
    }
    const matched = x402server.findMatchingRequirements(requirements, payload);
    if (!matched) {
      return fail(res, 402, "PAYMENT_REQUIREMENTS_MISMATCH", "payment does not match the stored quoted requirements", false);
    }
    const paymentIdentity = keccak256(stringToHex(JSON.stringify(payload)));
    const verification = await x402server.verifyPayment(payload, matched);
    if (!verification.isValid) {
      return fail(res, 402, "PAYMENT_VERIFICATION_FAILED", "payment verification failed", false, {
        reason: (verification as { invalidReason?: string }).invalidReason ?? "unknown",
      });
    }

    // Persist a "paying" intent BEFORE settling so a crash during the on-chain
    // fee transfer is recoverable (audit: the record must not stay "quoted" while
    // funds move). Record the ACTUAL asset+amount being charged (from the matched
    // requirements) so a refund always returns exactly what was paid.
    const paidTokenId = feeCtx.feeToken.tokenId;
    const paidAmount = feeAmount.toString();
    rec.state = "paying";
    rec.payment = {
      settlementId: null, payer: rec.signer, network: NETWORK,
      paidTokenId, paidAmount, paymentIdentity, raw: { intent: true },
    };
    await d.store.upsert(rec);

    let settlement;
    try {
      settlement = await x402server.settlePayment(payload, matched);
    } catch (e) {
      // Settlement threw (facilitator/network error) — status genuinely unknown.
      // Flag for review (don't strand the nonce silently); recovery handles it.
      rec.state = "review";
      rec.error = "NEEDS_OPERATOR_REVIEW: settlement status is unknown; verify on-chain and refund if the fee landed";
      await d.store.upsert(rec);
      return fail(res, 502, "SETTLEMENT_ERROR", "payment settlement errored; retry or contact operator", true);
    }
    if (!settlement.success) {
      // Payment did not settle — the user was not charged. Free the record.
      rec.state = "failed";
      rec.error = `payment settlement failed: ${settlement.errorReason ?? "unknown"}`;
      await d.store.upsert(rec);
      return fail(res, 402, "PAYMENT_SETTLEMENT_FAILED", "payment settlement failed", true, { reason: settlement.errorReason });
    }

    rec.state = "settled";
    rec.payment = {
      settlementId: settlement.transaction ?? null,
      payer: settlement.payer ?? rec.signer,
      network: settlement.network ?? null,
      paidTokenId,
      paidAmount,
      paymentIdentity,
      raw: settlement,
    };
    await d.store.upsert(rec);

    if (!(await d.store.claimForSubmission(hash))) {
      const claimed = await d.store.get(hash);
      return res.status(409).json(claimed ? publicRecord(claimed) : { code: "SUBMISSION_CLAIM_LOST" });
    }
    // The JSON store mutates the in-memory record during claim; PostgreSQL
    // performs an atomic compare-and-set. Keep the caller's record aligned so
    // subsequent execution checkpoints cannot regress the durable state.
    rec.state = "submitting";

    // ---- 6. RE-SIMULATE against post-payment state (security review F5) ----
    // The fee debit, pool moves, allowance games, or a consumed nonce all show
    // up here — BEFORE any sponsor gas is spent. Deadline gets a reduced buffer.
    const reVerdict = await d.evaluateBundle({ ...d.policy, minDeadlineBufferSec: 20 }, rawTxs);
    const rePre =
      reVerdict.ok && reVerdict.summary
        ? await d.preflightBundle(d.mirror, reVerdict.decoded, reVerdict.summary, {
            requiredExtraBalance: 0n,
            allowHollow: d.allowHollowExperiment,
          })
        : null;
    if (!reVerdict.ok || !rePre || !rePre.ok) {
      rec.state = "failed";
      rec.error = `post-settlement re-simulation failed: ${JSON.stringify(
        rePre?.failures ?? reVerdict.violations,
      )}`;
      await d.refundPayment(rec, "re-simulation failed");
      rec.state = rec.refund ? "refunded" : "review";
      await d.store.upsert(rec);
      return res.status(422).json(publicRecord(rec));
    }

    // ---- 7. Sponsored submission: consume only the immutable quote-time
    // per-leg allowances. No gas-price or exposure recomputation is permitted. ----
    const allowances = rec.quote.perLegGasAllowanceTinybar.map(BigInt);
    const quotedGas = allowances.reduce((a: bigint, b: bigint) => a + b, 0n);
    const quotedExposure = BigInt(rec.quote.maxSponsorExposureTinybar);
    if (
      allowances.length !== rawTxs.length ||
      quotedGas !== BigInt(rec.quote.maxGasAllowanceTinybar) ||
      quotedGas + BigInt(rec.quote.hapiReserveTinybar) !== quotedExposure ||
      allowances.some((a: bigint) => a < 0n || a > SPONSOR.perTxAllowanceCapTinybar)
    ) {
      rec.error = "stored sponsor exposure authorization is invalid";
      await d.refundPayment(rec, "invalid stored exposure authorization before submission");
      rec.state = rec.refund ? "refunded" : "review";
      await d.store.upsert(rec);
      return fail(res, 409, "EXPOSURE_AUTHORIZATION_INVALID", rec.error, false, publicRecord(rec));
    }

    rec.execution = {
      transactionIds: [],
      evmHashes: [],
      hashscanLinks: [],
      sponsorFeeTinybar: "0",
      attemptedLegs: 0,
      successfulLegs: 0,
      perLeg: [],
      disposition: "not_started",
      reconciliation: "complete",
      status: "PENDING",
    };
    await d.store.upsert(rec);

    let sponsorPaidTotal = 0n;
    let failure: string | null = null;
    for (const [i, raw] of rawTxs.entries()) {
      const kind = summary.kinds[i] ?? "swap";
      const allowance = allowances[i]!;
      rec.execution.attemptedLegs = i + 1;
      rec.execution.disposition = "attempt_failed";
      rec.execution.perLeg.push({
        index: i,
        kind,
        allowanceTinybar: allowance.toString(),
        transactionId: null,
        ethereumHash: null,
        status: "SUBMITTING",
        sponsorPaidTinybar: "0",
        sender: rec.signer,
      });
      // Persist the attempt boundary before handing bytes to Hedera. Recovery
      // can now distinguish a refundable pre-attempt crash from consumed work.
      await d.store.upsert(rec);
      try {
        const out = await d.sponsor.submitSponsored(raw, allowance);
        const leg = rec.execution.perLeg[i]!;
        leg.transactionId = out.hederaTransactionId;
        leg.ethereumHash = out.ethereumHash;
        leg.status = out.status;
        leg.sponsorPaidTinybar = out.sponsorPaidTinybar.toString();
        rec.execution.transactionIds.push(out.hederaTransactionId);
        if (out.ethereumHash) rec.execution.evmHashes.push(out.ethereumHash);
        rec.execution.hashscanLinks.push(d.hashscanTx(out.hederaTransactionId));
        sponsorPaidTotal += out.sponsorPaidTinybar;
        rec.execution.sponsorFeeTinybar = sponsorPaidTotal.toString();
        if (sponsorPaidTotal > quotedExposure) {
          failure = `actual sponsor exposure ${sponsorPaidTotal} exceeded quoted cap ${quotedExposure}`;
          rec.execution.reconciliation = "manual_review";
          break;
        }
        if (out.status !== "SUCCESS") {
          failure = `transaction ${i} (${kind}) ended with status ${out.status}`;
          break;
        }
        rec.execution.successfulLegs++;
        rec.execution.disposition = rec.execution.successfulLegs === rawTxs.length
          ? "delivered"
          : "partially_delivered";
        await d.store.upsert(rec);
      } catch (e) {
        const leg = rec.execution.perLeg[i]!;
        leg.status = "SUBMISSION_ERROR";
        failure = `transaction ${i} (${kind}) submission status is unknown; reconciliation required`;
        break;
      }
    }

    rec.execution.sponsorFeeTinybar = sponsorPaidTotal.toString();
    rec.execution.status = failure ?? "SUCCESS";
    if (!failure) {
      rec.state = "completed";
      rec.execution.disposition = "delivered";
      rec.error = null;
    } else if (rec.execution.successfulLegs > 0) {
      rec.state = "partial";
      rec.execution.disposition = "partially_delivered";
      rec.error = `${failure}; prepaid attempt consumed sponsor/HAPI exposure and is not refundable`;
    } else {
      rec.state = rec.execution.reconciliation === "manual_review" ? "review" : "failed";
      rec.execution.disposition = "attempt_failed";
      rec.error = `${failure}; prepaid attempt began and is not refundable`;
    }
    await d.store.upsert(rec);

    res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement));
    return res.status(failure ? 502 : 200).json(publicRecord(rec));
  } catch (e) {
    if (e instanceof LifecycleConflictError) {
      return fail(
        res,
        409,
        e.code,
        e.code === "NONCE_BUSY" ? "a live quote already owns this signer nonce" : e.message,
        e.code === "NONCE_BUSY",
      );
    }
    console.error(`[/v1/fuel] internal error requestId=${res.locals.requestId ?? "unknown"}`);
    return fail(res, 500, "INTERNAL", "internal request failure", true);
  }
  };
}

app.post("/v1/fuel", createFuelHandler());

function publicRecord(rec: SponsorshipRecord) {
  const hashscanBase = NETWORKS[rec.network]?.hashscanBase ?? EXECUTION.hashscanBase;
  return {
    bundleHash: rec.bundleHash,
    rawHash: rec.rawHash,
    quoteId: rec.quoteId,
    routeId: rec.routeId,
    requirementsHash: rec.requirementsHash,
    network: rec.network,
    chainId: rec.chainId,
    economicContract: rec.economicContract,
    state: rec.state,
    signer: rec.signer,
    quote: rec.quote,
    payment: rec.payment
      ? {
          settlementId: rec.payment.settlementId,
          payer: rec.payment.payer,
          network: rec.payment.network,
          paymentIdentity: rec.payment.paymentIdentity,
          hashscan: rec.payment.settlementId ? `${hashscanBase}/transaction/${rec.payment.settlementId}` : null,
        }
      : null,
    execution: rec.execution,
    refund: rec.refund
      ? { ...rec.refund, hashscan: `${hashscanBase}/transaction/${rec.refund.transactionId}` }
      : null,
    reconciliation: rec.execution?.reconciliation ?? (rec.state === "review" ? "manual_review" : "complete"),
    error: rec.error,
  };
}

/**
 * Crash recovery: records left "submitting" OR "settled" (paid, not yet
 * submitted) by a previous run are reconciled against the chain. Each leg's EVM
 * tx hash is deterministic from the signed bytes, so the mirror node tells us
 * definitively what executed; anything paid-but-not-executed is refunded, so a
 * crash can never leave a user charged with neither execution nor refund.
 */
async function recoverStuckRecords(): Promise<void> {
  for (const rec of await store.stuckSubmitting()) {
    try {
      // "paying" means the fee transfer was in flight when we died — we do NOT
      // know whether the user was charged, so we must NOT auto-refund (could
      // refund an uncharged user) NOR auto-submit. Flag for operator review;
      // this converts the audit's SILENT unrefundable loss into a LOUD, visible
      // one. Full auto-reconciliation needs the transactional store (roadmap).
      if (rec.state === "paying" && !rec.payment?.settlementId) {
        rec.state = "review";
        rec.error =
          "NEEDS_OPERATOR_REVIEW: crashed during x402 settlement; verify whether the fee transfer landed on-chain before refund or execution";
        await store.upsert(rec);
        console.error(`[recovery] ${rec.bundleHash} -> NEEDS_OPERATOR_REVIEW (paying)`);
        continue;
      }

      const attempted = rec.execution?.attemptedLegs ?? 0;
      const results = [] as { hash: string; found: boolean; ok: boolean; from: string | null }[];
      for (const raw of rec.rawTxs) {
        const hash = keccak256(raw);
        const cr = await mirror.contractResult(hash);
        results.push({
          hash,
          found: !!cr,
          ok: !!cr && (cr.status === "0x1" || cr.result === "SUCCESS"),
          from: cr?.from ?? null,
        });
      }
      const successful = results.filter((r) => r.ok).length;
      const allSuccessful = successful === rec.rawTxs.length;
      const hashscanBase = NETWORKS[rec.network].hashscanBase;
      rec.execution ??= {
        transactionIds: [],
        evmHashes: results.filter((r) => r.found).map((r) => r.hash),
        hashscanLinks: results.filter((r) => r.found).map((r) => `${hashscanBase}/transaction/${r.hash}`),
        sponsorFeeTinybar: null,
        attemptedLegs: attempted,
        successfulLegs: successful,
        perLeg: [],
        disposition: attempted === 0 ? "not_started" : "attempt_failed",
        reconciliation: "complete",
        status: "RECOVERED",
      };
      rec.execution.successfulLegs = successful;
      rec.execution.reconciliation = "complete";
      if (allSuccessful) {
        rec.state = "completed";
        rec.execution.disposition = "delivered";
        rec.execution.status = "SUCCESS (recovered)";
        rec.error = null;
      } else if (successful > 0) {
        rec.state = "partial";
        rec.execution.disposition = "partially_delivered";
        rec.execution.status = "PARTIAL (recovered)";
        rec.error = "crash recovery found a partially delivered prepaid attempt; no full refund is due";
      } else if (attempted === 0) {
        rec.error = "payment settled but no sponsored submission attempt began before crash";
        await refundPayment(rec, "crash recovery before sponsored attempt");
        rec.state = rec.refund ? "refunded" : "review";
        rec.execution.disposition = "not_started";
        rec.execution.status = rec.refund ? "REFUNDED" : "REFUND_REVIEW";
      } else {
        rec.state = "failed";
        rec.execution.disposition = "attempt_failed";
        rec.execution.status = "ATTEMPT_FAILED (recovered)";
        rec.error = "crash recovery found no successful leg after a persisted submission attempt; prepaid attempt is not refundable";
      }
      await store.upsert(rec);
      console.log(`[recovery] ${rec.bundleHash} -> ${rec.state}`);
    } catch {
      console.error(`[recovery] failed for ${rec.bundleHash}`);
    }
  }
}

export { app, recoverStuckRecords };

if (process.env.REFUEL402_NO_LISTEN !== "1") {
  const httpServer = app.listen(SPONSOR.port, () => {
    console.log(`Refuel402 ${runtimeExecutable ? "sponsor" : "read-only server"} listening on :${SPONSOR.port}`);
    console.log(`  execution network: ${SPONSOR.network}`);
    console.log(`  sponsor account: ${runtimeExecutable ? SPONSOR.operatorId : "disabled"}`);
    console.log(`  facilitator:     ${runtimeExecutable ? "configured" : "disabled"}`);
    console.log(`  lifecycle store: ${store instanceof PostgresStore ? "postgres" : "local-json"}`);
    console.log(`  router:          ${EXECUTION.routerId} (${EXECUTION.router})`);
    if (runtimeExecutable) void recoverStuckRecords();
    productBridgeSweeper?.start();
    if (
      productRecoverySummary &&
      (productRecoverySummary.unknownAuthorizations > 0 ||
        productRecoverySummary.expiredAuthorizations > 0)
    ) {
      console.warn(`[product-recovery] ${JSON.stringify(productRecoverySummary)}`);
    }
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();
    const stopHttp = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    void Promise.all([stopHttp, productBridgeSweeper?.stop() ?? Promise.resolve()])
      .then(() => Promise.all([store.close?.(), sponsor?.close()]))
      .finally(() => {
        clearTimeout(forced);
        process.exit(0);
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
