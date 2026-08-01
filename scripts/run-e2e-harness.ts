// Faithful injected integration harness for the canonical POST /v1/fuel wrapper.
// No network calls, secrets, or chain mutations. Live proof uses the same route
// with real dependencies and is intentionally a separate acceptance level.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import express from "express";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refuel402-harness-"));
process.env.DATA_DIR = tmp;
process.env.REFUEL402_NO_LISTEN = "1";
process.env.HEDERA_NETWORK = "testnet";

const [
  { createFuelHandler },
  { Store },
  { PostgresStore },
  { ProductLifecycleStore },
  { evaluateBundle },
  config,
  txbuilder,
] = await Promise.all([
  import("../server/src/index.js"),
  import("../server/src/store.js"),
  import("../server/src/postgres-store.js"),
  import("../server/src/product-lifecycle-store.js"),
  import("../server/src/policy.js"),
  import("../server/src/config.js"),
  import("../client/src/txbuilder.js"),
]);

const testnet = config.TESTNET;
const token = config.tokensFor("testnet")[0]!;
const policy = config.policyConfig("testnet");
const key = generatePrivateKey();
const signer = privateKeyToAccount(key).address;
const amountInMaximum = 1_100_000n;
const desiredHbarTinybar = 100_000_000n;
const raw = await txbuilder.signRawTx({
  privateKey: key,
  chainId: testnet.chainId,
  to: token.evmAddress,
  data: txbuilder.buildApproveCalldata(testnet.router, amountInMaximum),
  nonce: 0,
  gasLimit: 1_000_000n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
});
const swapRaw = await txbuilder.signRawTx({
  privateKey: key,
  chainId: testnet.chainId,
  to: testnet.router,
  data: txbuilder.buildExactOutputFuelCalldata({
    ctx: { chainId: testnet.chainId, router: testnet.router, whbar: testnet.whbarToken, maxFeePerGas: 0n },
    inputToken: token.evmAddress,
    poolFee: token.poolFee,
    route: token.route,
    amountOut: desiredHbarTinybar,
    amountInMaximum,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    recipient: signer,
  }),
  nonce: 1,
  gasLimit: 1_500_000n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
});
const failureRaw = await txbuilder.signRawTx({
  privateKey: key,
  chainId: testnet.chainId,
  to: token.evmAddress,
  data: txbuilder.buildApproveCalldata(testnet.router, 2_000_000n),
  nonce: 1,
  gasLimit: 800_000n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
});
const capKey = generatePrivateKey();
const capRaw = await txbuilder.signRawTx({
  privateKey: capKey,
  chainId: testnet.chainId,
  to: token.evmAddress,
  data: txbuilder.buildApproveCalldata(testnet.router, 3_000_000n),
  nonce: 0,
  gasLimit: 800_000n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
});

const requirements = [{
  scheme: "exact",
  network: testnet.caip2,
  payTo: "0.0.9001",
  asset: token.tokenId,
  amount: "1000",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.9002" },
}];
const submissions: { raw: Hex; allowance: bigint }[] = [];
const refunds: string[] = [];
const preflightCalls = new Map<string, number>();
const store = process.env.TEST_DATABASE_URL
  ? await PostgresStore.connect(process.env.TEST_DATABASE_URL)
  : new Store(tmp);
// The legacy daily-cap check now also reads the product authorization ledger, so
// leftover product rows in a shared database would 429 this harness. Reset them
// and bind the ledger to this harness's own database.
const productLedger = store instanceof PostgresStore ? new ProductLifecycleStore(store.pool) : null;
if (store instanceof PostgresStore) {
  await store.pool.query(`
    TRUNCATE refuel402_product_events, refuel402_product_submissions,
      refuel402_product_authorizations, refuel402_product_payments,
      refuel402_product_journeys, refuel402_product_quotes,
      refuel402_payment_identities, refuel402_nonce_reservations,
      refuel402_sponsorships, refuel402_rate_limit_buckets
    RESTART IDENTITY CASCADE`);
}
const x402 = {
  createPaymentRequiredResponse: async (accepts: unknown[], resource: unknown, error: string) => ({
    x402Version: 2,
    accepts,
    resource,
    error,
  }),
  findMatchingRequirements: (accepts: typeof requirements, payload: { accepted?: unknown }) =>
    isDeepStrictEqual(payload.accepted, accepts[0]) ? accepts[0] : null,
  verifyPayment: async () => ({ isValid: true, payer: "0.0.7001" }),
  settlePayment: async () => ({
    success: true,
    transaction: "0.0.9002@1753020000.000000001",
    payer: "0.0.7001",
    network: testnet.caip2,
  }),
};
const sponsor = {
  submitSponsored: async (rawTx: Hex, allowance: bigint) => {
    submissions.push({ raw: rawTx, allowance });
    return {
      hederaTransactionId: `0.0.9001@1753020001.00000000${submissions.length}`,
      ethereumHash: `0x${String(submissions.length).padStart(64, "0")}` as Hex,
      status: "SUCCESS",
      sponsorPaidTinybar: 6_000_000n,
      consensusTimestamp: "1753020001.000000001",
      transfers: [{ account: "0.0.9001", tinybar: "-6000000" }],
    };
  },
};
const quote = {
  gasPriceTinybarPerGas: 10n,
  estimatedCostTinybar: 5_000_000n,
  maxGasAllowanceTinybar: 10_000_000n,
  perLegGasAllowanceTinybar: [4_000_000n, 6_000_000n],
  hapiReserveTinybar: 4_000_000n,
  maxSponsorExposureTinybar: 14_000_000n,
  feeComponentsTinybar: {
    gasAllowance: 10_000_000n,
    hapiReserve: 4_000_000n,
    failedAttemptReserve: 0n,
    operatingMargin: 0n,
  },
  hbarUsd: 0.1,
  feeUsd: 0.01,
  feeAmount: 1_000n,
  feeTokenId: token.tokenId,
  feeTokenSymbol: token.symbol,
  expiresAt: Math.floor(Date.now() / 1000) + 120,
};

const dependencies = {
  runtimeExecutable: true,
  sponsor,
  store,
  productLedger,
  limiter: { allow: () => true },
  policy,
  evaluateBundle,
  preflightBundle: async (_mirror: unknown, decoded: { raw: string }[]) => {
    const identity = decoded[0]?.raw ?? "unknown";
    const calls = (preflightCalls.get(identity) ?? 0) + 1;
    preflightCalls.set(identity, calls);
    if (identity === failureRaw && calls === 3) {
      return {
        ok: false,
        failures: [{ code: "NONCE_CHANGED", message: "fixture post-payment state changed" }],
        expectedOut: null,
        expectedAmountIn: null,
        expectedGasUnits: 500_000n,
        perLegGas: [500_000n],
      };
    }
    return {
      ok: true,
      failures: [],
      expectedOut: desiredHbarTinybar,
      expectedAmountIn: 900_000n,
      expectedGasUnits: 1_500_000n,
      perLegGas: [500_000n, 1_000_000n],
    };
  },
  resolveFeeContext: async () => ({
    ok: true,
    feeToken: token,
    amountInForConv: 1_000_000n,
    expectedOutTinybar: 1_000_000n,
  }),
  getX402Server: async () => x402,
  priceSponsorship: async () => quote,
  recheckBalance: async () => "ok",
  buildRequirements: async () => requirements,
  refundPayment: async (rec: Record<string, any>, reason: string) => {
    refunds.push(reason);
    rec.refund = {
      transactionId: "0.0.9001@1753020002.000000001",
      amount: rec.payment.paidAmount,
      tokenId: rec.payment.paidTokenId,
      reason,
      status: "SUCCESS",
    };
  },
  hashscanTx: (id: string) => `${testnet.hashscanBase}/transaction/${id}`,
  checkSponsorReserve: async (exposure: bigint) => ({
    ok: true,
    balanceTinybar: 1_000_000_000n,
    requiredTinybar: exposure,
  }),
  mirror: {},
  pricing: {},
};
const handler = createFuelHandler(dependencies);
// The legacy daily cap shares one sponsor account with the product ledger, so
// that ledger must be injectable exactly like the legacy store - otherwise this
// handler would silently read whatever database the module happened to bind.
const injectedProductSpendTinybar = 10n ** 18n;
const cappedHandler = createFuelHandler({
  ...dependencies,
  productLedger: {
    activationExposureSince: async () => 0n,
    sponsoredIntentExposureSince: async () => injectedProductSpendTinybar,
  },
});

const app = express();
app.use(express.json());
app.post("/v1/fuel", handler);
app.post("/v1/fuel-injected-product-ledger", cappedHandler);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("harness listener unavailable");
const url = `http://127.0.0.1:${address.port}/v1/fuel`;

try {
  const first = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: [raw, swapRaw], feeTokenId: token.tokenId }),
  });
  const challenge = await first.json() as Record<string, any>;
  if (first.status !== 402 || !challenge.sponsorship?.quoteId) {
    throw new Error(`expected identity-bound 402 challenge, got ${first.status}`);
  }

  const paymentPayload = { x402Version: 2, accepted: challenge.accepts[0], payload: { transaction: "fixture-only-a" } };
  const paid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": encodePaymentSignatureHeader(paymentPayload as never),
    },
    body: JSON.stringify({ transactions: [raw, swapRaw], feeTokenId: token.tokenId }),
  });
  const receipt = await paid.json() as Record<string, any>;
  if (paid.status !== 200 || receipt.state !== "completed") {
    throw new Error(`expected completed lifecycle, got ${paid.status}: ${JSON.stringify(receipt)}`);
  }
  if (
    submissions.length !== 2 ||
    submissions[0]!.allowance !== 4_000_000n ||
    submissions[1]!.allowance !== 6_000_000n
  ) {
    throw new Error("exact-output approval/swap did not consume the stored per-leg allowances");
  }

  const failureBody = JSON.stringify({ transactions: [failureRaw], feeTokenId: token.tokenId });
  const failureChallenge = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: failureBody,
  });
  const failureChallengeBody = await failureChallenge.json() as Record<string, any>;
  if (failureChallenge.status !== 402) throw new Error("failure fixture did not receive a quote");
  const failurePaymentPayload = {
    x402Version: 2,
    accepted: failureChallengeBody.accepts[0],
    payload: { transaction: "fixture-only-b" },
  };
  const failurePaid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": encodePaymentSignatureHeader(failurePaymentPayload as never),
    },
    body: failureBody,
  });
  const failureReceipt = await failurePaid.json() as Record<string, any>;
  if (failurePaid.status !== 422 || failureReceipt.state !== "refunded" || refunds.length !== 1) {
    throw new Error(`pre-attempt post-payment failure was not deterministically refunded: ${JSON.stringify(failureReceipt)}`);
  }
  if (submissions.length !== 2) throw new Error("pre-attempt refund fixture spent sponsor gas");

  const capped = await fetch(`http://127.0.0.1:${address.port}/v1/fuel-injected-product-ledger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: [capRaw], feeTokenId: token.tokenId }),
  });
  const cappedBody = await capped.json() as Record<string, any>;
  if (
    capped.status !== 429 ||
    cappedBody.code !== "DAILY_SPONSOR_CAP" ||
    // Legacy spend from the completed bundles above is summed alongside it.
    BigInt(cappedBody.details?.dailyCommittedTinybar ?? 0) < injectedProductSpendTinybar
  ) {
    throw new Error(`injected product ledger did not reach the daily-cap decision: ${capped.status} ${JSON.stringify(cappedBody)}`);
  }
  if (submissions.length !== 2) throw new Error("daily-cap fixture spent sponsor gas");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const proof = {
    schema: "refuel402.integration-proof.v1",
    acceptanceLevel: "integration_harness",
    liveChain: false,
    network: receipt.network,
    chainId: receipt.chainId,
    account: {
      stateBefore: "complete_zero_hbar",
      stateSource: "faithful_fixture",
      evmAddress: receipt.signer,
      associationBefore: "held_hts_satisfies_association",
      routerAllowanceBefore: "0",
      routerAllowanceAfterApproval: amountInMaximum.toString(),
    },
    bundle: {
      semanticHash: receipt.bundleHash,
      rawHash: receipt.rawHash,
      quoteId: receipt.quoteId,
      routeId: receipt.routeId,
      requirementsHash: receipt.requirementsHash,
      mode: "exactOutput",
      desiredHbarTinybar: desiredHbarTinybar.toString(),
      quotedTokenInput: "900000",
      amountInMaximum: amountInMaximum.toString(),
      route: [token.evmAddress, testnet.whbarToken],
      router: testnet.router,
      feeTokenId: receipt.quote.feeTokenId,
      feeAmount: receipt.quote.feeAmount,
      feeComponentsTinybar: receipt.quote.feeComponentsTinybar,
    },
    payment: {
      transactionId: receipt.payment.settlementId,
      hashscan: receipt.payment.hashscan,
      identity: receipt.payment.paymentIdentity,
    },
    legs: receipt.execution.perLeg.map((leg: Record<string, unknown>, index: number) => ({
      ...leg,
      transactionId: receipt.execution.transactionIds[index] ?? null,
      hashscan: receipt.execution.hashscanLinks[index] ?? null,
      senderEvidence: { recoveredSigner: receipt.signer, msgSender: receipt.signer, source: "signed-raw-transaction" },
    })),
    exposure: {
      quotedAggregateTinybar: receipt.quote.maxSponsorExposureTinybar,
      quotedPerLegGasTinybar: receipt.quote.perLegGasAllowanceTinybar,
      actualAggregateTinybar: receipt.execution.sponsorFeeTinybar,
    },
    balances: {
      source: "faithful_fixture_not_live_chain",
      hbarBeforeTinybar: "0",
      hbarAfterTinybar: desiredHbarTinybar.toString(),
      feeTokenBefore: "10000000",
      feeTokenAfter: "9099000",
      finalReconciliation: "fixture_contract_satisfied",
    },
    lifecycle: {
      economicContract: receipt.economicContract,
      state: receipt.state,
      disposition: receipt.execution.disposition,
      refund: receipt.refund,
      reconciliation: receipt.reconciliation,
      adversarialCoverage: {
        postPaymentResimulationFailure: failureReceipt.state,
        refundTransactionId: failureReceipt.refund.transactionId,
        sponsorSubmissionCountUnchanged: submissions.length === 2,
      },
    },
    lifecycleStore: store instanceof PostgresStore ? "postgres" : "local-json",
    prohibitedSideEffects: {
      networkCalls: 0,
      chainMutations: 0,
      mainnetActions: 0,
      sourcePublication: 0,
      secretsPersisted: 0,
    },
    versions: {
      refuel402: "0.1.0",
      node: process.version,
      commit,
      generatedAt: new Date().toISOString(),
    },
  };
  const proofDir = path.join(root, "proofs", "local");
  fs.mkdirSync(proofDir, { recursive: true });
  const proofPath = path.join(proofDir, "integration-harness.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: true, proof: proofPath, quoteId: receipt.quoteId, state: receipt.state }));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (store instanceof PostgresStore) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
