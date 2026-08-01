import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { NETWORKS } from "../src/config.js";
import { createProductIntentBuilder } from "../src/product-intents.js";
import type { ProductJourneyRecord, StoredProductQuote } from "../src/product-lifecycle-store.js";
import { bindSaucerRoute } from "../src/route-binding.js";
import { loadSupportCatalog } from "../src/support.js";

const account = getAddress("0x1111111111111111111111111111111111111111");

function executionRoute(asset: ReturnType<typeof loadSupportCatalog>["assets"][number], mode: "testnet" | "mainnet") {
  return asset.saucer.route.length > 0
    ? asset.saucer.route
    : [{ toToken: NETWORKS[mode].whbarToken, fee: 3000, venue: "v2" as const }];
}

function routeEvidence(asset: ReturnType<typeof loadSupportCatalog>["assets"][number], route = asset.saucer.route) {
  const start = asset.destination.wrapper?.htsAddress ?? asset.destination.address;
  const tokens = [start, ...route.map((hop) => hop.toToken)];
  const venue = route[0]?.venue ?? "v2";
  return {
    graphHash: "b".repeat(64),
    selectedRoute: {
      routeId: route.map((hop, index) => `${hop.venue ?? "v2"}:${hop.poolId ?? index}`).join("->"),
      venue,
      tokens,
      fees: route.map((hop) => hop.fee),
      amountIn: "5000",
      amountOutTinybar: "500000000",
      simulatedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-07-26T00:05:00.000Z",
      hops: route.map((hop, index) => ({
        index,
        venue: hop.venue ?? "v2",
        input: { address: tokens[index] },
        output: { address: tokens[index + 1] },
        pool: { id: hop.poolId ?? `pool-${index}`, contractId: hop.contractId ?? `contract-${index}` },
        feeTier: hop.fee,
      })),
    },
  };
}

function fixture(mode: "testnet" | "mainnet", wrapped = false) {
  const asset = wrapped
    ? loadSupportCatalog("mainnet").assets.find((candidate) => candidate.destination.wrapper)!
    : loadSupportCatalog(mode).assets.find((candidate) => candidate.destination.standard === "HTS")!;
  const route = executionRoute(asset, mode);
  const evidence = routeEvidence(asset, route);
  const quote: StoredProductQuote = {
    quoteId: "a".repeat(64),
    mode,
    account,
    requestedProvider: asset.provider,
    selectedProvider: asset.provider,
    assetId: asset.id,
    originChainId: asset.originNetworks[0]!,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    executable: true,
    record: {
      quoteId: "a".repeat(64),
      routeMode: "bridge_plus_refuel",
      asset: { id: asset.id, symbol: asset.symbol, destination: asset.destination },
      refuelCap: {
        schema: "refuel402.refuel-cap.v1",
        preset: "flexible",
        maxAmountIn: "1392",
      },
      refuelAuthorization: {
        schema: "refuel402.refuel-authorization-terms.v1",
        enabled: true,
        maxAmountIn: "1392",
      },
      destination: {
        route,
        routeBinding: bindSaucerRoute(evidence),
        saucerApiEvidence: evidence,
        amountInMaximum: "5000",
      },
      amountLedger: {
        destination: { swapInputMaximum: "500000" },
        hbar: { exactOutputTinybar: "500000000" },
      },
      x402: {
        feeAmount: "200",
        executionLegs: [
          "destination_activation",
          "permit2_approval",
          "wrapper_approval",
          "wrapper_execution",
          "router_approval",
          "router_execution",
        ].map((id) => ({ id, payer: "sponsor", gasAllowanceTinybar: "1234567", hapiReserveTinybar: "100", maximumTinybar: "1234667" })),
      },
    },
  };
  const journey: ProductJourneyRecord = {
    id: `journey-${mode}-${wrapped}`,
    quoteId: quote.quoteId,
    mode,
    account,
    requestedProvider: asset.provider,
    selectedProvider: asset.provider,
    assetId: asset.id,
    originChainId: quote.originChainId,
    state: "payment_settled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payment: null,
    authorizations: [],
    submissions: [],
    events: [],
  };
  const builder = createProductIntentBuilder({
    loadQuote: async () => quote,
    nonce: async () => 7,
    estimateGas: async () => 100_000n,
  });
  return { asset, quote, journey, builder };
}

/** As above, but with the relay lagging for the first `failures` reads. */
function propagationFixture(
  failures: number,
  relayError = "rpc eth_estimateGas: [Request ID: abc] Error occurred during transaction simulation: Sender account not found.",
  mode: "testnet" | "mainnet" = "mainnet",
) {
  const base = fixture(mode);
  const waits: number[] = [];
  let estimateCalls = 0;
  const builder = createProductIntentBuilder({
    loadQuote: async () => base.quote,
    nonce: async () => 7,
    estimateGas: async () => {
      estimateCalls += 1;
      if (estimateCalls <= failures) throw new Error(relayError);
      return 100_000n;
    },
    wait: async (ms) => { waits.push(ms); },
  });
  return { ...base, builder, waits, estimateCalls: () => estimateCalls };
}

const ASSOCIATION_LAG =
  "rpc eth_estimateGas: [Request ID: abc] execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT";

describe("server-authoritative product intent builder", () => {
  for (const mode of ["testnet", "mainnet"] as const) {
    it(`binds ${mode} permit2 approval, router approval, and exact-output execution`, async () => {
      const { quote, journey, builder } = fixture(mode);
      const permit2 = await builder.build({ journey, intentKind: "permit2_approval", request: { quoteId: quote.quoteId } });
      const routerApproval = await builder.build({ journey, intentKind: "router_approval", request: {} });
      const swap = await builder.build({ journey, intentKind: "router_execution", request: {} });
      expect(permit2.transaction).toMatchObject({ chainId: NETWORKS[mode].chainId, from: account, nonce: 7, maxFeePerGas: "0" });
      expect(permit2.transaction.data.slice(0, 10)).toBe("0x095ea7b3");
      expect(routerApproval.transaction.to).not.toBe(NETWORKS[mode].router);
      expect(swap.transaction.to).toBe(NETWORKS[mode].router);
      expect(swap.transaction.data.slice(0, 10)).toBe("0xac9650d8");
      expect(swap.authorization).toMatchObject({ mode, account, chainId: NETWORKS[mode].chainId, nonce: 7, maxGasAllowanceTinybar: 1_234_567n });
      expect(swap.authorization).not.toHaveProperty("rawTransactionHash");
    });
  }

  // `/activate` auto-creates a first-time wallet's Hedera account and waits for
  // the MIRROR to see it; the very next call estimates gas against the RELAY,
  // which lags separately. Every wallet that had never touched Hedera hit this
  // and was told "a Hedera network read failed" one step after the sponsor had
  // already paid to create the account.
  it("waits out relay propagation for a freshly created sender instead of reporting an outage", async () => {
    const { journey, quote, builder, waits, estimateCalls } = propagationFixture(3);
    const built = await builder.build({
      journey,
      intentKind: "permit2_approval",
      request: { quoteId: quote.quoteId },
    });
    expect(built.transaction.gas).toBe("120000");
    expect(estimateCalls()).toBe(4);
    expect(waits).toEqual([1_000, 1_000, 1_000]);
  });

  it("gives up on a sender that never propagates rather than retrying forever", async () => {
    const { journey, quote, builder, waits, estimateCalls } = propagationFixture(Number.MAX_SAFE_INTEGER);
    await expect(builder.build({
      journey,
      intentKind: "permit2_approval",
      request: { quoteId: quote.quoteId },
    })).rejects.toThrow(/Sender account not found/);
    expect(estimateCalls()).toBe(8);
    expect(waits).toHaveLength(7);
  });

  // The HTS variant. The flow associates the token and then approves Permit2 on
  // that same token; the approve is estimated against a relay that has not seen
  // the association yet. Only HTS-native destinations reach it, which is why
  // WETH worked and USDC.axl did not.
  it("waits out a freshly submitted HTS association the same way", async () => {
    const { journey, quote, builder, waits, estimateCalls } = propagationFixture(3, ASSOCIATION_LAG);
    const built = await builder.build({
      journey,
      intentKind: "permit2_approval",
      request: { quoteId: quote.quoteId },
    });
    expect(built.transaction.gas).toBe("120000");
    expect(estimateCalls()).toBe(4);
    expect(waits).toEqual([1_000, 1_000, 1_000]);
  });

  it("gives up on an association that never lands rather than retrying forever", async () => {
    const { journey, quote, builder, estimateCalls } = propagationFixture(Number.MAX_SAFE_INTEGER, ASSOCIATION_LAG);
    await expect(builder.build({
      journey,
      intentKind: "permit2_approval",
      request: { quoteId: quote.quoteId },
    })).rejects.toThrow(/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/);
    expect(estimateCalls()).toBe(8);
  });

  it("never retries a failure that is not the propagation race", async () => {
    const { journey, quote } = fixture("mainnet");
    let calls = 0;
    const builder = createProductIntentBuilder({
      loadQuote: async () => quote,
      nonce: async () => 7,
      estimateGas: async () => { calls += 1; throw new Error("rpc eth_estimateGas: execution reverted"); },
      wait: async () => { throw new Error("must not wait on a non-propagation failure"); },
    });
    await expect(builder.build({
      journey,
      intentKind: "permit2_approval",
      request: { quoteId: quote.quoteId },
    })).rejects.toThrow(/execution reverted/);
    expect(calls).toBe(1);
  });

  // The bridge quote is the provider's own and lives about a minute. Funding,
  // associating and confirming a new Hedera account burns most of it, so gating
  // destination SETUP on that runway made the pre-authorized flow unreachable
  // for any wallet new to Hedera.
  it.each(["activation", "permit2_approval"] as const)(
    "builds %s against a quote that has already aged out, with its own runway",
    async (intentKind) => {
      const stale = fixture("mainnet");
      stale.quote.expiresAt = Math.floor(Date.now() / 1000) - 5;
      const built = await stale.builder.build({
        journey: stale.journey,
        intentKind,
        request: { quoteId: stale.quote.quoteId },
      });
      expect(built.authorization.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 60);
    },
  );

  it("still refuses a trading leg whose quote has no runway left", async () => {
    const stale = fixture("mainnet");
    stale.quote.expiresAt = Math.floor(Date.now() / 1000) - 5;
    await expect(stale.builder.build({
      journey: stale.journey,
      intentKind: "router_execution",
      request: {},
    })).rejects.toMatchObject({ code: "QUOTE_EXPIRES_TOO_SOON" });
  });

  it("uses the canonical structured refuel cap for both preauthorized and manual Permit2 approvals", async () => {
    const preauthorized = fixture("mainnet");
    const preauthorizedApproval = await preauthorized.builder.build({
      journey: preauthorized.journey,
      intentKind: "permit2_approval",
      request: { quoteId: preauthorized.quote.quoteId },
    });
    expect(BigInt(`0x${preauthorizedApproval.transaction.data.slice(-64)}`)).toBe(1392n);

    const manual = fixture("mainnet");
    (manual.quote.record.refuelAuthorization as any).enabled = false;
    const manualApproval = await manual.builder.build({
      journey: manual.journey,
      intentKind: "permit2_approval",
      request: { quoteId: manual.quote.quoteId },
    });
    expect(BigInt(`0x${manualApproval.transaction.data.slice(-64)}`)).toBe(1392n);
  });

  it("falls back to the x402 fee only for a historical quote with no refuel cap", async () => {
    const historical = fixture("testnet");
    delete (historical.quote.record as any).refuelCap;
    delete (historical.quote.record as any).refuelAuthorization;
    const approval = await historical.builder.build({
      journey: historical.journey,
      intentKind: "permit2_approval",
      request: { quoteId: historical.quote.quoteId },
    });
    expect(BigInt(`0x${approval.transaction.data.slice(-64)}`)).toBe(200n);
  });

  it.each([
    ["object max", { schema: "refuel402.refuel-cap.v1", maxAmountIn: { amount: "1392" } }, "refuelCap.maxAmountIn"],
    ["wrong schema", { schema: "refuel402.refuel-cap.v0", maxAmountIn: "1392" }, "refuelCap.schema"],
    ["non-decimal max", { schema: "refuel402.refuel-cap.v1", maxAmountIn: "13.92" }, "refuelCap.maxAmountIn"],
  ])("rejects malformed structured refuel caps: %s", async (_label, cap, field) => {
    const malformed = fixture("mainnet");
    (malformed.quote.record as any).refuelCap = cap;
    await expect(malformed.builder.build({
      journey: malformed.journey,
      intentKind: "permit2_approval",
      request: { quoteId: malformed.quote.quoteId },
    })).rejects.toMatchObject({
      code: "STORED_QUOTE_INVALID",
      details: { field },
    });
  });

  it("rejects a preauthorization cap that disagrees with the canonical refuel cap", async () => {
    const mismatched = fixture("mainnet");
    (mismatched.quote.record.refuelAuthorization as any).maxAmountIn = "1393";
    await expect(mismatched.builder.build({
      journey: mismatched.journey,
      intentKind: "permit2_approval",
      request: { quoteId: mismatched.quote.quoteId },
    })).rejects.toMatchObject({
      code: "STORED_QUOTE_INVALID",
      details: {
        field: "refuelAuthorization.maxAmountIn",
        refuelCapMaxAmountIn: "1392",
        refuelAuthorizationMaxAmountIn: "1393",
      },
    });
  });

  it("rejects a Permit2 approval above the HTS int64 allowance limit", async () => {
    const tooLarge = fixture("mainnet");
    const maximum = (1n << 63n).toString();
    (tooLarge.quote.record.refuelCap as any).maxAmountIn = maximum;
    (tooLarge.quote.record.refuelAuthorization as any).maxAmountIn = maximum;
    await expect(tooLarge.builder.build({
      journey: tooLarge.journey,
      intentKind: "permit2_approval",
      request: { quoteId: tooLarge.quote.quoteId },
    })).rejects.toMatchObject({ code: "STORED_QUOTE_INVALID" });
  });

  it("binds an LCX V1 quote to the V1 router approval and exact-output native-HBAR selector", async () => {
    const v1 = fixture("mainnet");
    const lcx = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "axelar:mainnet:lcx")!;
    (v1.quote.record.asset as any) = { id: lcx.id, symbol: lcx.symbol, destination: lcx.destination };
    const evidence = routeEvidence(lcx);
    (v1.quote.record.destination as any).route = lcx.saucer.route;
    (v1.quote.record.destination as any).saucerApiEvidence = evidence;
    (v1.quote.record.destination as any).routeBinding = bindSaucerRoute(evidence);
    const approval = await v1.builder.build({ journey: v1.journey, intentKind: "router_approval", request: {} });
    const swap = await v1.builder.build({ journey: v1.journey, intentKind: "router_execution", request: {} });
    expect(NETWORKS.mainnet.v1Router).not.toBeNull();
    expect(approval.transaction.data).toContain(NETWORKS.mainnet.v1Router!.slice(2).toLowerCase().padStart(64, "0"));
    expect(swap.transaction).toMatchObject({
      to: NETWORKS.mainnet.v1Router,
      value: "0",
    });
    expect(swap.transaction.data.slice(0, 10)).toBe("0x4a25d94a");
  });

  it("derives execution from bound live evidence rather than the legacy route array", async () => {
    const baseline = fixture("mainnet");
    const stale = fixture("mainnet");
    (stale.quote.record.destination as any).route = [{
      toToken: "0x2222222222222222222222222222222222222222",
      fee: 10_000,
      venue: "v2",
    }];
    const expected = await baseline.builder.build({ journey: baseline.journey, intentKind: "router_execution", request: {} });
    const actual = await stale.builder.build({ journey: stale.journey, intentKind: "router_execution", request: {} });
    expect(actual.transaction.data).toBe(expected.transaction.data);
  });

  it("rejects a stored route that no longer matches its quote-bound live evidence", async () => {
    const tampered = fixture("mainnet");
    (tampered.quote.record.destination as any).saucerApiEvidence.selectedRoute.amountIn = "5001";
    await expect(tampered.builder.build({
      journey: tampered.journey,
      intentKind: "router_execution",
      request: {},
    })).rejects.toThrow("does not match its quote-bound execution evidence");
  });

  it("fails closed when a stored quote lacks the requested quote-bound sponsor allowance", async () => {
    const missing = fixture("testnet");
    (missing.quote.record.x402 as any).executionLegs = [];
    await expect(missing.builder.build({
      journey: missing.journey,
      intentKind: "router_execution",
      request: {},
    })).rejects.toThrow("does not contain a sponsor allowance");
  });

  it("rejects destination consent unless it is bound to the current exact quote", async () => {
    const current = fixture("testnet");
    await expect(current.builder.build({
      journey: current.journey,
      intentKind: "permit2_approval",
      request: {},
    })).rejects.toThrow("not bound to the current exact quote");
    await expect(current.builder.build({
      journey: current.journey,
      intentKind: "permit2_approval",
      request: { quoteId: "b".repeat(64) },
    })).rejects.toThrow("not bound to the current exact quote");
  });

  it("rejects execution intent construction after the combined quote expiry with a refresh-and-retry code", async () => {
    const expired = fixture("testnet");
    expired.quote.expiresAt = Math.floor(Date.now() / 1000) - 1;
    await expect(expired.builder.build({
      journey: expired.journey,
      intentKind: "router_execution",
      request: {},
    })).rejects.toMatchObject({
      code: "QUOTE_EXPIRES_TOO_SOON",
      message: expect.stringContaining("quote expiry leaves insufficient authorization runway"),
    });
  });

  it("gates on the 30s authorization runway and builds again once a refresh restores it", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const thin = fixture("testnet");
    // A quote inside the runway is still live: only the runway gate rejects it.
    thin.quote.expiresAt = nowSec + 30;
    await expect(thin.builder.build({ journey: thin.journey, intentKind: "router_approval", request: {} }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRES_TOO_SOON" });
    thin.quote.expiresAt = nowSec + 31;
    await expect(thin.builder.build({ journey: thin.journey, intentKind: "router_approval", request: {} }))
      .resolves.toMatchObject({ authorization: { expiresAt: nowSec + 31 } });
    // Refresh-and-retry: the same leg succeeds against the re-minted quote.
    thin.quote.expiresAt = nowSec + 5;
    await expect(thin.builder.build({ journey: thin.journey, intentKind: "router_execution", request: {} }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRES_TOO_SOON" });
    thin.quote.expiresAt = nowSec + 60;
    const retried = await thin.builder.build({ journey: thin.journey, intentKind: "router_execution", request: {} });
    expect(retried.authorization.expiresAt).toBe(nowSec + 60);
  });

  it("caps sponsor allowances at the shared 10-HBAR per-transaction default", async () => {
    const capped = fixture("testnet");
    delete process.env.PER_TX_ALLOWANCE_CAP_TINYBAR;
    (capped.quote.record.x402 as any).executionLegs = (capped.quote.record.x402 as any).executionLegs
      .map((leg: any) => ({ ...leg, gasAllowanceTinybar: "1000000001" }));
    await expect(capped.builder.build({
      journey: capped.journey,
      intentKind: "router_execution",
      request: {},
    })).rejects.toThrow("exceeds product policy");
  });

  it("builds HTS association and wrapper approval only for matching asset representations", async () => {
    const plain = fixture("testnet");
    const activation = await plain.builder.build({ journey: plain.journey, intentKind: "activation", request: {} });
    expect(activation.transaction.data).toBe("0x0a754de6");
    await expect(plain.builder.build({ journey: plain.journey, intentKind: "wrapper_approval", request: {} })).rejects.toThrow("no wrapper");

    const wrapped = fixture("mainnet", true);
    const wrappedActivation = await wrapped.builder.build({ journey: wrapped.journey, intentKind: "activation", request: {} });
    const approval = await wrapped.builder.build({ journey: wrapped.journey, intentKind: "wrapper_approval", request: {} });
    const execution = await wrapped.builder.build({ journey: wrapped.journey, intentKind: "wrapper_execution", request: {} });
    const routerApproval = await wrapped.builder.build({ journey: wrapped.journey, intentKind: "router_approval", request: {} });
    expect(wrappedActivation.transaction.to).toBe(wrapped.asset.destination.wrapper!.htsAddress);
    expect(approval.transaction.data.slice(0, 10)).toBe("0x095ea7b3");
    expect(approval.transaction.to).toBe(wrapped.asset.destination.address);
    expect(execution.transaction.to).toBe(getAddress(wrapped.asset.destination.wrapper!.address));
    expect(execution.transaction.data.slice(0, 10)).toBe("0x62355638");
    expect(routerApproval.transaction.data).toContain(BigInt(5000).toString(16).padStart(64, "0"));
    expect(routerApproval.transaction.data).not.toContain(BigInt(500000).toString(16).padStart(64, "0"));
  });
});
