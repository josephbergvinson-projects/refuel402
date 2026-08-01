import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import {
  getAddress,
  keccak256,
  stringToHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { exactPaymentTypes as exactTypes } from "../server/src/exact-payment-witness.js";
import { journeySourceLegTypedData } from "../server/src/journey-source-leg-witness.js";
import { journeyNonce, refuelAuthorizationTypedData } from "../server/src/refuel-authorization-witness.js";
// @ts-expect-error The browser product model is intentionally plain ESM JavaScript.
import { buildCombinedQuoteRequest } from "../web/product-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = `refuel402-product-harness-${process.pid}`;
const password = "refuel402-local-proof";
// A disposable Docker PostgreSQL is the default. HARNESS_DATABASE_URL points the
// same proof at an externally provisioned throwaway database instead; the harness
// still truncates and owns every table it touches.
const externalDatabaseUrl = process.env.HARNESS_DATABASE_URL?.trim() || null;
let postgres: Awaited<ReturnType<(typeof import("../server/src/postgres-store.js"))["PostgresStore"]["connect"]>> | null = null;
const servers: http.Server[] = [];

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function listen(app: express.Express): Promise<string> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local harness listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServers() {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

async function request(base: string, url: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.json().catch(() => ({})) as Record<string, any>;
  return { response, body };
}

try {
  let databaseUrl: string;
  if (externalDatabaseUrl) {
    databaseUrl = externalDatabaseUrl;
  } else {
    docker("run", "-d", "--rm", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=refuel402", "-p", "127.0.0.1::5432", "postgres:18-alpine");
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        docker("exec", container, "pg_isready", "-U", "postgres", "-d", "refuel402");
        break;
      } catch {
        if (attempt === 29) throw new Error("disposable PostgreSQL did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const portLine = docker("port", container, "5432/tcp");
    const port = Number(portLine.match(/:(\d+)$/)?.[1]);
    if (!port) throw new Error(`could not parse disposable PostgreSQL port: ${portLine}`);
    databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/refuel402`;
  }

  process.env.X402_PAYMENT_RECIPIENT = "0x3333333333333333333333333333333333333333";
  process.env.X402_PROXY_TESTNET_ADDRESS = "0x4444444444444444444444444444444444444444";
  process.env.X402_PROXY_MAINNET_ADDRESS = "0x5555555555555555555555555555555555555555";
  process.env.RECOMMENDED_REFUEL_TINYBAR = "500000000";
  process.env.MAX_REFUEL_TINYBAR = "5000000000";
  process.env.PER_REQUEST_EXPOSURE_CAP_TINYBAR = "1500000000";
  process.env.DAILY_SPONSOR_CAP_TINYBAR = "7500000000";

  const [
    { PostgresStore },
    { ProductLifecycleStore },
    { createProductLifecycleRouter },
    { createProductBridgeTracker },
    { createProductQuoteHandler },
    { normalizeSquidQuote },
    { composeCombinedQuote },
    { LocalEvmFacilitator },
    { createFacilitatorProductPaymentVerifier },
    { createProductIntentBuilder },
    { createBoundedPolicyRpcSubmitter, createPolicyRpcProcessor, authorizedRawTransactionCandidate },
    { productContractAddresses },
    { signRawTx },
  ] = await Promise.all([
    import("../server/src/postgres-store.js"),
    import("../server/src/product-lifecycle-store.js"),
    import("../server/src/product-lifecycle.js"),
    import("../server/src/product-bridge.js"),
    import("../server/src/product-quote.js"),
    import("../server/src/bridge.js"),
    import("../server/src/combined-quote.js"),
    import("../server/src/evm-facilitator.js"),
    import("../server/src/product-payment.js"),
    import("../server/src/product-intents.js"),
    import("../server/src/policy-rpc.js"),
    import("../server/src/support.js"),
    import("../client/src/txbuilder.js"),
  ]);

  // pg_isready runs inside the container against the unix socket, so it reports
  // ready while the official image is still doing its init-restart and drops
  // host TCP connections. Only a successful connect from here proves readiness.
  for (let attempt = 0; ; attempt += 1) {
    try {
      postgres = await PostgresStore.connect(databaseUrl);
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (externalDatabaseUrl) {
    // The disposable-container path starts empty; an external database must be
    // reset to the same blank state or idempotency keys collide across runs.
    await postgres.pool.query(`
      TRUNCATE refuel402_product_events, refuel402_product_submissions,
        refuel402_product_authorizations, refuel402_product_payments,
        refuel402_product_journeys, refuel402_product_quotes,
        refuel402_payment_identities, refuel402_nonce_reservations,
        refuel402_sponsorships, refuel402_rate_limit_buckets
      RESTART IDENTITY CASCADE`);
  }
  // Virtual quote-liveness clock. Human pacing routinely outlives a ~60s Saucer
  // simulation, so the harness advances past real expiry instead of sleeping.
  let clockSkewMs = 0;
  const pacedNow = () => Date.now() + clockSkewMs;
  const lifecycle = new ProductLifecycleStore(postgres.pool, pacedNow);
  const key = `0x${"21".repeat(32)}` as Hex;
  const account = privateKeyToAccount(key);
  const recipient = getAddress(process.env.X402_PAYMENT_RECIPIENT);
  const originToken = getAddress("0x1000000000000000000000000000000000000001");
  const destinationToken = getAddress("0x2000000000000000000000000000000000000002");
  const transactionTarget = getAddress("0x3000000000000000000000000000000000000003");
  const layerZeroOriginToken = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
  const layerZeroDestinationToken = getAddress("0xD7D4d91d64a6061fA00a94E2b3A2D2A5FB677849");
  const layerZeroAdapter = getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c");
  const wrapper = getAddress("0x000000000000000000000000000000000093a3a8");
  const wrappedHts = getAddress("0x000000000000000000000000000000000099d925");
  const whbar = getAddress("0x0000000000000000000000000000000000003ad2");
  const router = getAddress("0x0000000000000000000000000000000000159398");
  const permit2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

  function catalog(mode: "testnet" | "mainnet") {
    const chainId = mode === "testnet" ? 296 : 295;
    const originChainId = mode === "testnet" ? "11155111" : "1";
    const proxy = productContractAddresses(mode).proxy;
    const asset = {
      id: `axelar:${mode}:fixture-usdc`,
      provider: "axelar" as const,
      providerLabel: "Axelar / Squid",
      comparisonGroup: `${mode}:fixture-usdc`,
      symbol: "USDC.axl",
      name: "Fixture USD Coin",
      icon: "",
      originNetworks: [originChainId],
      originTokens: [{ chainId: originChainId, address: originToken, decimals: 6, symbol: "USDC", name: "USD Coin" }],
      destination: { standard: "HTS" as const, tokenId: mode === "testnet" ? "0.0.7001" : "0.0.7002", address: destinationToken, decimals: 6, arrival: "activation_required" as const },
      saucer: { status: "verified" as const, route: [{ toToken: whbar, fee: 500 }], evidence: "deterministic local exact-output fixture" },
      x402: { transferMethod: "permit2" as const, status: "local_proxy_simulation" },
      sponsorship: { status: "local_policy_rpc_simulation" },
      discovery: true,
      quote: true,
      execute: true,
      blockers: [],
    };
    const layerZeroAsset = {
      ...asset,
      id: "layerzero:mainnet:fixture-wbtc",
      provider: "layerzero" as const,
      providerLabel: "LayerZero / OFT V2",
      comparisonGroup: "mainnet:fixture-wbtc",
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
      originNetworks: ["1"],
      originTokens: [{ chainId: "1", address: layerZeroOriginToken, decimals: 8, symbol: "WBTC", name: "Wrapped Bitcoin" }],
      destination: {
        standard: "ERC20" as const,
        address: layerZeroDestinationToken,
        decimals: 8,
        arrival: "activation_required" as const,
        wrapper: {
          contractId: "0.0.9675688",
          address: wrapper,
          htsTokenId: "0.0.10082597",
          htsAddress: wrappedHts,
          htsDecimals: 8,
          rate: "1",
        },
      },
      saucer: { status: "verified" as const, route: [{ toToken: whbar, fee: 1500 }], evidence: "deterministic direct-OFT wrapper fixture" },
    };
    const liquidityAsset = {
      ...asset,
      id: `axelar:${mode}:fixture-thin`,
      comparisonGroup: `${mode}:fixture-thin`,
      saucer: { status: "below_liquidity_policy" as const, route: [], evidence: "fixture below floor" },
      quote: false,
      execute: false,
      blockers: ["SAUCER_LIQUIDITY_POLICY"],
    };
    return {
      schema: "refuel402.support-catalog.v1" as const,
      mode,
      evidenceAt: "2026-07-22T12:00:00Z",
      hedera: { chainId, caip2: `eip155:${chainId}`, name: `Hedera ${mode}`, icon: "" },
      originNetworks: [{
        chainId: originChainId,
        name: mode === "testnet" ? "Ethereum Sepolia" : "Ethereum",
        icon: "",
        providers: mode === "mainnet"
          ? (["axelar", "layerzero"] as ("axelar" | "layerzero")[])
          : (["axelar"] as ("axelar" | "layerzero")[]),
        discoveryStatus: "local_fixture",
      }],
      assets: [asset, liquidityAsset, ...(mode === "mainnet" ? [layerZeroAsset] : [])],
      proxy,
    };
  }

  const allGates = {
    providerQuoteReady: { axelar: true, layerzero: true },
    providerBlockers: { axelar: [], layerzero: [] },
    saucerGraphReady: true,
    quoteSimulationReady: true,
    permit2Ready: true,
    x402ProxyReady: true,
    paymentRecipientReady: true,
    facilitatorReady: true,
    policyRpcReady: true,
    wrapperReady: true,
    executionModeReady: true,
  };
  const mirrorStub = {} as any;
  let quoteScenario: "happy" | "stale" | "underfunded" | "impact" = "happy";
  const quoteHandler = createProductQuoteHandler({
    mirrors: { testnet: mirrorStub, mainnet: mirrorStub },
    lifecycleStore: lifecycle,
    catalog,
    runtimeGates: async () => allGates,
    bridgeQuote: async (input) => {
      if (input.provider === "layerzero") {
        const minimum = input.amount * 99n / 100n;
        const nativeFee = "75000000000000";
        return {
          provider: "layerzero" as const,
          providerLabel: input.asset.providerLabel,
          quoteId: `direct-oft-${"a".repeat(64)}`,
          originChainId: input.originChainId,
          destinationChainId: 295,
          fromAddress: input.account,
          toAddress: input.account,
          originToken: input.originToken,
          destinationToken: input.asset.destination.address,
          fromAmount: input.amount.toString(),
          expectedDestinationAmount: input.amount.toString(),
          minimumDestinationAmount: minimum.toString(),
          estimatedSeconds: null,
          fees: [{ name: "LayerZero messaging fee", category: "gas_relayer" as const, amount: nativeFee, symbol: "ETH", usd: null, payer: "user" as const }],
          normalized: {
            sourceAmount: { amount: input.amount.toString(), token: input.originToken, decimals: 8, symbol: "WBTC" },
            destinationAsset: { address: input.asset.destination.address, tokenId: null, standard: "ERC20" as const, decimals: 8, symbol: "WBTC" },
            slippage: { requestedBps: input.slippageBps, expectedDestinationAmount: input.amount.toString(), minimumDestinationAmount: minimum.toString() },
            evidence: { source: "layerzero-oft-v2" as const, quoteId: `direct-oft-${"a".repeat(64)}`, routeId: "ethereum-wbtc-to-hedera-wbtc-oft-v2", observedAt: new Date().toISOString(), responseHash: "b".repeat(64) },
          },
          originApproval: { token: input.originToken, spender: layerZeroAdapter, amount: input.amount.toString() },
          transaction: { to: layerZeroAdapter, data: "0xc7c7f5b3" as Hex, value: nativeFee, chainId: 1 },
          userSteps: [],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          source: "layerzero-oft-v2" as const,
        };
      }
      const expected = quoteScenario === "underfunded" ? "100000" : (input.amount * 99n / 100n).toString();
      const minimum = quoteScenario === "underfunded" ? "90000" : (input.amount * 98n / 100n).toString();
      const body = {
        route: {
          quoteId: `${input.mode}-${quoteScenario}-provider-quote`,
          routeId: `${input.mode}-${quoteScenario}-route`,
          estimate: {
            toAmount: expected,
            toAmountMin: minimum,
            estimatedRouteDuration: 180,
            feeCosts: [{ name: "bridge/provider fee", amount: "50000", token: { symbol: "USDC" } }],
            gasCosts: [{ name: "bridge gas/relayer fee", amount: "50000", token: { symbol: "USDC" } }],
          },
          transactionRequest: { target: transactionTarget, data: "0x1234", value: "0" },
        },
      };
      const quote = normalizeSquidQuote(input, body);
      if (quoteScenario === "stale") quote.expiresAt = Math.floor(Date.now() / 1000) - 1;
      return quote;
    },
    combinedQuote: async (input) => {
      const tradeAddress = input.asset.destination.wrapper?.htsAddress ?? input.asset.destination.address;
      const tradeTokenId = input.asset.destination.wrapper?.htsTokenId ?? input.asset.destination.tokenId ?? "fixture-contract-token";
      const tradeSymbol = input.asset.destination.wrapper ? `HTS-${input.asset.symbol}` : input.asset.symbol;
      const selectedFee = input.asset.saucer.route[0]?.fee ?? 1500;
      const fixtureAmountIn = input.desiredHbarTinybar / 1_000n;
      const fixtureAmountInMaximum = fixtureAmountIn * 101n / 100n;
      const executionLegCount = input.asset.destination.wrapper ? 7 : 5;
      const perLegGasAllowanceTinybar = Array.from({ length: executionLegCount }, () => 1_000_000n);
      const perLegHapiReserveTinybar = Array.from({ length: executionLegCount }, (_value, index) => index === 2 ? 0n : 100_000n);
      const facilitatorExposureTinybar = perLegGasAllowanceTinybar[2]!;
      const sponsorExposureTinybar = perLegGasAllowanceTinybar.reduce((sum, value, index) =>
        index === 2 ? sum : sum + value + perLegHapiReserveTinybar[index]!, 0n);
      try {
        return composeCombinedQuote({
          ...input,
        saucer: {
          amountIn: fixtureAmountIn,
          amountInMaximum: fixtureAmountInMaximum,
          paymentAssetAmountInMaximum: fixtureAmountInMaximum,
          gasEstimate: 160_000n,
          priceImpactBps: quoteScenario === "impact" ? 200 : 25,
          apiEvidence: {
            source: "local-product-harness",
            tokenId: tradeTokenId,
            symbol: tradeSymbol,
            decimals: input.asset.destination.wrapper ? 8 : input.asset.destination.decimals,
            associatedPoolCount: 1,
            maximumLiquidityUsd: 50_000,
            verifiedAt: new Date().toISOString(),
            graphHash: "c".repeat(64),
            v1PoolCount: 2,
            v2PoolCount: 1,
            completeGraph: true,
            structuralCandidatePathCount: 1,
            v1ExecutableCandidatePathCount: 0,
            v2ExecutableCandidatePathCount: 1,
            liquidityEligibleV2CandidatePathCount: 1,
            selectedRoute: {
              venue: "v2",
              executionScope: "venue_aware_exact_output",
              routeId: "v2:0.0.fixture-pool",
              tokens: [tradeAddress, whbar],
              fees: [selectedFee],
              hopCount: 1,
              minimumLiquidityUsd: 50_000,
              amountIn: fixtureAmountIn.toString(),
              amountOutTinybar: input.desiredHbarTinybar.toString(),
              gasEstimate: "160000",
              perHopAmountsAvailable: false,
              hops: [{
                index: 0,
                venue: "v2",
                version: "v2",
                input: { tokenId: tradeTokenId, address: tradeAddress, symbol: tradeSymbol },
                output: { tokenId: "0.0.1456986", address: whbar, symbol: "WHBAR" },
                pool: { id: "0.0.fixture-pool", contractId: "0.0.fixture-pool" },
                feeTier: selectedFee,
                feeBps: selectedFee / 100,
                liquidityUsd: 50_000,
                amountContext: "route_level_exact_output",
              }],
              discovery: {
                v1PoolCount: 2,
                v2PoolCount: 1,
                structuralCandidatePathCount: 1,
                v1ExecutableCandidatePathCount: 0,
                v2ExecutableCandidatePathCount: 1,
                liquidityEligibleV2CandidatePathCount: 1,
                v1DiscoveryOnly: true,
              },
              simulatedAt: new Date().toISOString(),
              expiresAt: new Date(input.bridge.expiresAt * 1_000).toISOString(),
            },
          },
          simulatedAtMs: Date.now(),
          expiresAtMs: input.bridge.expiresAt * 1_000,
        },
        x402: {
          feeAmount: 20_000n,
          feeUsd: 0.02,
          maxSponsorExposureTinybar: sponsorExposureTinybar,
          maxFacilitatorExposureTinybar: facilitatorExposureTinybar,
          maxExecutionExposureTinybar: sponsorExposureTinybar + facilitatorExposureTinybar,
          componentsTinybar: {
            gasAllowance: perLegGasAllowanceTinybar.reduce<bigint>((sum, value) => sum + value, 0n),
            hapiReserve: perLegHapiReserveTinybar.reduce<bigint>((sum, value) => sum + value, 0n),
          },
          perLegGasAllowanceTinybar,
          perLegHapiReserveTinybar,
          expiresAt: input.bridge.expiresAt,
        },
          minimumRetainedBps: 500,
        });
      } catch (error) {
        console.error("[product-harness] combined quote fixture failed", error);
        throw error;
      }
    },
  });

  const proxyCalls: Record<string, unknown>[] = [];
  const proxyByChain = {
    295: productContractAddresses("mainnet").proxy,
    296: productContractAddresses("testnet").proxy,
  };
  const facilitator = new LocalEvmFacilitator({
    chains: [295, 296],
    proxies: proxyByChain,
    verifier: async (payment, requirements) => verifyTypedData({
      address: payment.payer,
      domain: { name: "Permit2", chainId: payment.chainId, verifyingContract: permit2 },
      types: exactTypes(),
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: payment.token, amount: BigInt(payment.amount) },
        spender: payment.spender,
        nonce: BigInt(payment.nonce),
        deadline: BigInt(payment.deadline),
        witness: {
          payer: payment.payer,
          token: payment.token,
          amount: BigInt(payment.amount),
          recipient: payment.recipient,
          chainId: BigInt(payment.chainId),
          nonce: BigInt(payment.nonce),
          deadline: BigInt(payment.deadline),
          spender: payment.spender,
          contextHash: payment.contextHash,
        },
      },
      signature: payment.signature,
    }),
    settlement: {
      settle: async (payment, paymentId) => {
        proxyCalls.push({ paymentId, chainId: payment.chainId, token: payment.token, amount: payment.amount, recipient: payment.recipient, spender: payment.spender, nonce: payment.nonce, deadline: payment.deadline, contextHash: payment.contextHash });
        return { transactionHash: paymentId };
      },
    },
  });
  const facilitatorApp = express();
  facilitatorApp.use(facilitator.router());
  const facilitatorBase = await listen(facilitatorApp);
  const paymentVerifier = createFacilitatorProductPaymentVerifier({
    url: facilitatorBase,
    loadQuote: (journey) => lifecycle.getEffectiveQuote(journey.id),
  });

  const nextNonce = new Map<string, number>();
  const intentBuilder = createProductIntentBuilder({
    loadQuote: (journey) => lifecycle.getEffectiveQuote(journey.id),
    nonce: async (mode, address) => nextNonce.get(`${mode}:${address}`) ?? 0,
    estimateGas: async () => 100_000n,
    now: pacedNow,
  });
  const sponsored: Record<string, unknown>[] = [];
  const submitterByMode = Object.fromEntries((["testnet", "mainnet"] as const).map((mode) => {
    const chainId = mode === "testnet" ? 296 : 295;
    const policyRouter = mode === "testnet"
      ? router
      : getAddress("0x00000000000000000000000000000000003c437a");
    const submitter = createBoundedPolicyRpcSubmitter({
      policy: {
        chainId,
        allowedTargets: [destinationToken, policyRouter],
        allowedSelectors: ["0x0a754de6", "0x095ea7b3", "0x62355638", "0xac9650d8"],
        perTransactionCapTinybar: 3_000_000_000n,
        dailyCapTinybar: 10_000_000_000n,
        minimumReserveTinybar: 500_000_000n,
      },
      sponsor: {
        submitSponsored: async (raw: Hex, allowance: bigint) => {
          const hash = keccak256(raw);
          sponsored.push({ mode, chainId, rawHash: hash, allowance: allowance.toString() });
          const key = `${mode}:${account.address}`;
          nextNonce.set(key, (nextNonce.get(key) ?? 0) + 1);
          return { ethereumHash: hash };
        },
      },
      estimateGas: async () => 100_000n,
      reserveTinybar: async () => 10_000_000_000n,
      exposureSince: async () => 0n,
    });
    return [mode, submitter];
  })) as Record<"testnet" | "mainnet", ReturnType<typeof createBoundedPolicyRpcSubmitter>>;
  const policyRpc = createPolicyRpcProcessor({
    upstreams: { testnet: "http://127.0.0.1/unused", mainnet: "http://127.0.0.1/unused" },
    authorizer: lifecycle,
    submitter: submitterByMode,
  });
  const receiptReconciler = {
    reconcile: async ({ journey, ethereumHash }: any) => {
      const effective = await lifecycle.getEffectiveQuote(journey.id);
      if (!effective) throw new Error("effective quote missing from fixture reconciliation");
      const record = effective.record as any;
      return {
        transactionHash: ethereumHash,
        status: "success",
        from: journey.account,
        to: router,
        gasUsed: "90000",
        destinationAssetRemaining: String(record.outcome.destinationAssetRemaining),
        hbarReceivedTinybar: String(record.destination.desiredHbarTinybar),
        reconciliation: "complete_with_balance_readback",
      };
    },
  };

  const destinationActivator = async (journeyId: string) => {
    const journey = await lifecycle.recordDestinationActivation({
      journeyId,
      transactionId: `fixture-activation-${journeyId}`,
      amountTinybar: "10000000",
      status: "SUCCESS",
    });
    return { required: true, funded: true, associated: false, journey };
  };
  const bridgeTracker = {
    submit: async (journeyId: string, sourceTransactionHash: Hex) => lifecycle.recordBridgeSubmission({
      journeyId,
      sourceTransactionHash,
      destinationBalanceBefore: "0",
      hbarBalanceBefore: "10000000",
    }),
    status: async (journeyId: string) => {
      const journey = await lifecycle.getJourney(journeyId);
      const submitted = journey!.events.find((event) => event.type === "bridge_submitted")!;
      const sourceTransactionHash = submitted.record.sourceTransactionHash as Hex;
      let arrived = await lifecycle.recordBridgeArrival({
        journeyId,
        sourceTransactionHash,
        destinationTransactionHash: keccak256(stringToHex(`destination-${journeyId}`)),
        destinationBalanceAfter: "9900000",
        destinationAmountReceived: "9900000",
        providerStatus: "success",
      });
      const quote = await lifecycle.getEffectiveQuote(journeyId);
      if (quote?.record.routeMode === "bridge_only") {
        arrived = await lifecycle.completeBridgeOnly(journeyId);
      }
      return {
        transfer: { state: "arrived", providerStatus: "success", sourceTransactionHash },
        arrival: { confirmed: true, balanceBefore: "0", balanceAfter: "9900000", amountReceived: "9900000", minimumExpected: "9900000" },
        journey: arrived,
      };
    },
  };
  // A live re-simulation is never identical to the last one: destinationQuoteTtlSec
  // models the hard SAUCERSWAP_QUOTE_MAX_AGE_MS cap, and refreshEconomics models a
  // route that moved in the user's favour or against it between legs.
  let destinationQuoteTtlSec = 300;
  let refreshEconomics: "same" | "better" | "worse" = "same";
  let destinationQuoteSequence = 0;
  const destinationQuoteRefresher = async (journeyId: string) => {
    const original = await lifecycle.getEffectiveQuote(journeyId);
    const current = original!.record as any;
    const drift = refreshEconomics === "same" ? 0n : refreshEconomics === "better" ? -2_000n : 20_000n;
    const ledger = current.amountLedger;
    const swapInputMaximum = BigInt(ledger.destination.swapInputMaximum) + drift;
    const remainingAtMinimum = BigInt(ledger.destination.remainingAtMinimum) - drift;
    const consumedMaximum = BigInt(ledger.destination.x402ProtocolFee) + swapInputMaximum;
    destinationQuoteSequence += 1;
    const refreshed = {
      ...current,
      quoteId: keccak256(stringToHex(`destination-refresh-${journeyId}-${destinationQuoteSequence}`)).slice(2),
      expiresAt: Math.floor(pacedNow() / 1000) + destinationQuoteTtlSec,
      capabilities: { ...current.capabilities, execute: true },
      destination: {
        ...current.destination,
        amountInMaximum: swapInputMaximum.toString(),
        paymentAssetAmountInMaximum: swapInputMaximum.toString(),
      },
      amountLedger: {
        ...ledger,
        destination: {
          ...ledger.destination,
          swapInputMaximum: swapInputMaximum.toString(),
          consumedMaximum: consumedMaximum.toString(),
          remainingAtMinimum: remainingAtMinimum.toString(),
        },
      },
      outcome: {
        ...current.outcome,
        destinationSwapInputMaximum: swapInputMaximum.toString(),
        maximumDebit: consumedMaximum.toString(),
        destinationAssetRemaining: remainingAtMinimum.toString(),
        retainedAtMinimumArrival: remainingAtMinimum.toString(),
      },
    };
    return lifecycle.recordDestinationQuoteRefresh({ journeyId, quote: refreshed });
  };

  // Deterministic mirror evidence for reconcile-submissions: resolutions come
  // only from these fixture reads, never from request bodies.
  const mirrorEvidence = {
    contractResults: new Map<string, Record<string, unknown>>(),
    ethereumNonce: 0,
  };
  const submissionEvidence = {
    contractResult: async (hash: string) => mirrorEvidence.contractResults.get(hash.toLowerCase()) ?? null,
    account: async () => ({ ethereum_nonce: mirrorEvidence.ethereumNonce }),
    contractResultByNonce: async () => null,
  };

  const productApp = express();
  productApp.use(express.json({ limit: "128kb" }));
  productApp.post("/v1/product/quote", quoteHandler);
  productApp.use("/v1/product", createProductLifecycleRouter({
    store: lifecycle,
    destinationActivator,
    bridgeTracker,
    destinationQuoteRefresher,
    paymentVerifier,
    intentBuilder,
    receiptReconciler,
    submissionEvidence: { testnet: submissionEvidence, mainnet: submissionEvidence },
  }));
  productApp.post("/rpc/:mode", async (req, res) => {
    const mode = req.params.mode as "testnet" | "mainnet";
    const body = await policyRpc(mode, req.body);
    res.status("error" in body ? 400 : 200).json(body);
  });
  const productBase = await listen(productApp);

  const modeProofs: Record<string, any> = {};
  let finalJourney: Record<string, any> | null = null;
  let happyQuote: Record<string, any> | null = null;

  async function sourceLegConsent(journeyId: string, quote: Record<string, any>, mode: "testnet" | "mainnet") {
    return account.signTypedData(journeySourceLegTypedData({
      journeyId,
      quoteId: quote.quoteId,
      account: account.address,
      mode,
      originChainId: quote.bridge.originChainId,
    }));
  }

  // Each attempt re-reads the effective quote, because permit2_approval binds its
  // request body to the exact quote id currently in force.
  async function authorizeIntent(
    base: string,
    mode: "testnet" | "mainnet",
    journeyId: string,
    kind: string,
    confirmation?: Hex,
  ) {
    const body: Record<string, unknown> = {};
    if (kind === "permit2_approval") {
      const current = await request(base, `/v1/product/journeys/${journeyId}`);
      body.quoteId = current.body.quote?.quoteId;
    }
    if (confirmation) body.confirmation = confirmation;
    return request(base, `/v1/product/journeys/${journeyId}/intents/${kind}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${kind}-${mode}-${journeyId}`.slice(0, 120) },
      body: JSON.stringify(body),
    });
  }

  async function authorizeAndSubmit(
    base: string,
    mode: "testnet" | "mainnet",
    journeyId: string,
    kind: string,
    confirmation?: Hex,
  ) {
    // Refresh-and-retry: a thin expiry runway is never fatal and never prompts the
    // wallet. At most two refreshes per leg, then the 409 stands.
    let authorized = await authorizeIntent(base, mode, journeyId, kind, confirmation);
    const refreshedQuoteIds: string[] = [];
    for (let attempt = 0; attempt < 2 && authorized.body.code === "QUOTE_EXPIRES_TOO_SOON"; attempt += 1) {
      const refreshed = await request(base, `/v1/product/journeys/${journeyId}/destination-quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (refreshed.response.status !== 200) {
        throw new Error(`${kind} destination quote refresh failed: ${JSON.stringify(refreshed.body)}`);
      }
      refreshedQuoteIds.push(refreshed.body.quote.quoteId);
      authorized = await authorizeIntent(base, mode, journeyId, kind, confirmation);
    }
    if (authorized.response.status !== 200) throw new Error(`${kind} authorization failed: ${JSON.stringify(authorized.body)}`);
    const tx = authorized.body.transaction;
    const raw = await signRawTx({
      privateKey: key,
      chainId: tx.chainId,
      to: tx.to,
      data: tx.data,
      nonce: tx.nonce,
      gasLimit: BigInt(tx.gas),
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    const rpc = await request(base, `/rpc/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
    });
    if (!rpc.body.result) throw new Error(`${kind} policy-RPC failed: ${JSON.stringify(rpc.body)}`);
    if (kind !== "router_execution") {
      const confirmed = await request(base, `/v1/product/journeys/${journeyId}/intents/${kind}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ethereumHash: rpc.body.result }),
      });
      if (confirmed.response.status !== 200) throw new Error(`${kind} confirmation failed: ${JSON.stringify(confirmed.body)}`);
    }
    return { authorization: authorized.body.authorization, transaction: tx, rawHash: keccak256(raw), ethereumHash: rpc.body.result, refreshedQuoteIds };
  }

  for (const mode of ["testnet", "mainnet"] as const) {
    quoteScenario = "happy";
    const cfg = catalog(mode);
    const provider = { id: "axelar", label: "Axelar / Squid" };
    const network = { chainId: cfg.originNetworks[0]!.chainId };
    const token = {
      assetId: cfg.assets[0]!.id,
      provider: "axelar",
      address: originToken,
      decimals: 6,
      disabled: false,
      asset: cfg.assets[0],
    };
    const uiRequest = buildCombinedQuoteRequest({
      mode,
      account: account.address,
      network,
      provider,
      token,
      amount: "3",
      desiredHbar: "10",
      slippageBps: 100,
    });
    if (uiRequest.desiredHbar !== "10" || uiRequest.amountBaseUnits !== "3000000") {
      throw new Error("UI quote request did not bind the exact 3-USDC -> 10-HBAR acceptance amounts");
    }
    const quoted = await request(productBase, "/v1/product/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(uiRequest),
    });
    if (
      quoted.response.status !== 200 ||
      !quoted.body.amountLedger?.allInvariantsHold ||
      quoted.body.destination?.desiredHbarTinybar !== "1000000000" ||
      !quoted.body.destination?.maximumFeasibleHbar ||
      !quoted.body.costLedger?.summary
    ) {
      throw new Error(`${mode} product quote failed: ${JSON.stringify(quoted.body)}`);
    }
    const journey = await request(productBase, "/v1/product/journeys", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `journey-${mode}-fixture-0001` },
      body: JSON.stringify({ mode, quoteId: quoted.body.quoteId, account: account.address }),
    });
    if (journey.response.status !== 201) throw new Error(`${mode} journey failed: ${JSON.stringify(journey.body)}`);
    const journeyId = journey.body.journey.id;
    const consent = await sourceLegConsent(journeyId, quoted.body, mode);
    const intents: Record<string, any> = {};
    const activation = await request(productBase, `/v1/product/journeys/${journeyId}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: consent }),
    });
    if (activation.response.status !== 200 || activation.body.associated !== false) {
      throw new Error(`${mode} destination activation failed: ${JSON.stringify(activation.body)}`);
    }
    intents.activation = await authorizeAndSubmit(productBase, mode, journeyId, "activation", consent);
    const sourceTransactionHash = keccak256(stringToHex(`source-${mode}-${journeyId}`));
    const walletBoundary = await request(productBase, `/v1/product/journeys/${journeyId}/wallet-boundary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "bridge", confirmation: consent }),
    });
    if (walletBoundary.response.status !== 200) throw new Error(`${mode} wallet boundary failed: ${JSON.stringify(walletBoundary.body)}`);
    const bridgeSubmission = await request(productBase, `/v1/product/journeys/${journeyId}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTransactionHash, confirmation: consent }),
    });
    if (bridgeSubmission.response.status !== 200) throw new Error(`${mode} bridge submission failed`);
    const bridgeStatus = await request(productBase, `/v1/product/journeys/${journeyId}/bridge`);
    if (bridgeStatus.response.status !== 200 || bridgeStatus.body.arrival?.confirmed !== true) {
      throw new Error(`${mode} bridge arrival failed: ${JSON.stringify(bridgeStatus.body)}`);
    }
    const preContinuation = await request(productBase, `/v1/product/journeys/${journeyId}`);
    const preContinuationReplay = await request(productBase, `/v1/product/journeys/${journeyId}`);
    if (
      preContinuation.response.status !== 200 ||
      preContinuation.body.schema !== "refuel402.product-journey.v4" ||
      preContinuation.body.continuation?.schema !== "refuel402.arrival-continuation.v2" ||
      preContinuation.body.continuation?.ready !== false ||
      preContinuation.body.continuation?.nextAction !== "refresh_destination_quote" ||
      preContinuationReplay.body.journey?.events?.length !== preContinuation.body.journey?.events?.length ||
      preContinuation.body.journey.events.some((event: any) => event.type === "destination_quote_refreshed")
    ) {
      throw new Error(`${mode} journey GET was not a side-effect-free read: ${JSON.stringify(preContinuation.body)}`);
    }
    const materialized = await request(productBase, `/v1/product/journeys/${journeyId}/destination-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (materialized.response.status !== 200) {
      throw new Error(`${mode} explicit destination quote refresh failed: ${JSON.stringify(materialized.body)}`);
    }
    const automaticContinuation = await request(productBase, `/v1/product/journeys/${journeyId}`);
    if (
      automaticContinuation.response.status !== 200 ||
      automaticContinuation.body.continuation?.ready !== true ||
      automaticContinuation.body.continuation?.nextAction !== "destination_wallet_consent" ||
      automaticContinuation.body.quote?.capabilities?.execute !== true ||
      automaticContinuation.body.recovery?.nextAtomicStep !== "destination_wallet_consent"
    ) {
      throw new Error(`${mode} post-refresh arrival continuation failed: ${JSON.stringify(automaticContinuation.body)}`);
    }
    const destinationQuote = { response: automaticContinuation.response, body: { quote: automaticContinuation.body.quote } };
    const duplicateRefresh = await request(productBase, `/v1/product/journeys/${journeyId}/destination-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const continuationReadback = await request(productBase, `/v1/product/journeys/${journeyId}`);
    const continuationEvents = continuationReadback.body.journey.events.filter((event: any) => event.type === "destination_quote_refreshed");
    if (
      duplicateRefresh.body.quote?.quoteId !== destinationQuote.body.quote.quoteId ||
      continuationEvents.length !== 1
    ) throw new Error(`${mode} destination quote continuation was not idempotent`);
    intents.permit2Approval = await authorizeAndSubmit(productBase, mode, journeyId, "permit2_approval");

    const challenge = await request(productBase, `/v1/product/journeys/${journeyId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `payment-${mode}-fixture-0001` },
      body: "{}",
    });
    if (
      challenge.response.status !== 402 ||
      challenge.body.refuel402?.schema !== "refuel402.exact-permit2-payment-required.v1" ||
      !challenge.response.headers.get("payment-required")
    ) throw new Error(`${mode} custom x402 challenge failed: ${JSON.stringify(challenge.body)}`);

    const x402 = destinationQuote.body.quote.x402;
    const payment = {
      payer: account.address,
      token: getAddress(x402.asset),
      amount: String(x402.feeAmount),
      recipient,
      chainId: mode === "testnet" ? 296 as const : 295 as const,
      nonce: "1",
      deadline: Math.floor(Date.now() / 1000) + 120,
      spender: getAddress(x402.contract.proxy),
      contextHash: x402.contextHash as Hex,
      signature: "0x" as Hex,
    };
    const signature = await account.signTypedData({
      domain: { name: "Permit2", chainId: payment.chainId, verifyingContract: permit2 },
      types: exactTypes(),
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: payment.token, amount: BigInt(payment.amount) },
        spender: payment.spender,
        nonce: BigInt(payment.nonce),
        deadline: BigInt(payment.deadline),
        witness: {
          payer: payment.payer,
          token: payment.token,
          amount: BigInt(payment.amount),
          recipient: payment.recipient,
          chainId: BigInt(payment.chainId),
          nonce: BigInt(payment.nonce),
          deadline: BigInt(payment.deadline),
          spender: payment.spender,
          contextHash: payment.contextHash,
        },
      },
    });
    payment.signature = signature;
    const paymentHeader = encodePaymentSignatureHeader({ x402Version: 2, accepted: null, payload: { payment } } as never);
    const paid = await request(productBase, `/v1/product/journeys/${journeyId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `payment-${mode}-fixture-0001`, "payment-signature": paymentHeader },
      body: "{}",
    });
    if (paid.response.status !== 200) throw new Error(`${mode} payment failed: ${JSON.stringify(paid.body)}`);
    const paymentReplay = await request(productBase, `/v1/product/journeys/${journeyId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `payment-${mode}-fixture-0002`, "payment-signature": paymentHeader },
      body: "{}",
    });
    if (paymentReplay.response.status !== 409 || paymentReplay.body.code !== "PAYMENT_REPLAY") {
      throw new Error(`${mode} payment replay did not fail closed`);
    }

    intents.routerApproval = await authorizeAndSubmit(productBase, mode, journeyId, "router_approval");
    intents.routerExecution = await authorizeAndSubmit(productBase, mode, journeyId, "router_execution");
    const reconciled = await request(productBase, `/v1/product/journeys/${journeyId}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ethereumHash: intents.routerExecution.ethereumHash }),
    });
    const eventCounts = Object.fromEntries(
      reconciled.body.journey.events.map((event: any) => event.type)
        .reduce((counts: Map<string, number>, type: string) => counts.set(type, (counts.get(type) ?? 0) + 1), new Map()),
    );
    if (
      reconciled.response.status !== 200 ||
      reconciled.body.journey.state !== "completed" ||
      reconciled.body.receipt?.hbarReceivedTinybar !== "1000000000" ||
      BigInt(reconciled.body.receipt?.destinationAssetRemaining ?? 0) < BigInt(destinationQuote.body.quote.outcome.minimumRetainedByPolicy) ||
      eventCounts.payment_settled !== 1 ||
      eventCounts.authorization_submitted < 1 ||
      eventCounts.journey_reconciled !== 1
    ) {
      throw new Error(`${mode} exact 3-USDC -> 10-HBAR reconciliation failed: ${JSON.stringify({ reconciled: reconciled.body, eventCounts })}`);
    }
    const routerExecutionSubmissions = reconciled.body.journey.authorizations.filter((authorization: any) => authorization.intentKind === "router_execution" && authorization.state === "submitted");
    if (routerExecutionSubmissions.length !== 1) throw new Error(`${mode} produced duplicate or missing sponsored Saucer execution`);
    modeProofs[mode] = {
      chainId: payment.chainId,
      uiRequest,
      quote: {
        quoteId: quoted.body.quoteId,
        providerEvidence: quoted.body.bridge.normalized.evidence,
        amountLedger: quoted.body.amountLedger,
        outcome: quoted.body.outcome,
        blockers: quoted.body.blockers,
      },
      activation: {
        funded: activation.body.funded,
        transactionId: activation.body.transactionId,
      },
      bridge: {
        sourceTransactionHash,
        providerStatus: bridgeStatus.body.transfer.providerStatus,
        arrival: bridgeStatus.body.arrival,
      },
      destinationQuote: {
        quoteId: destinationQuote.body.quote.quoteId,
        expiresAt: destinationQuote.body.quote.expiresAt,
        getSideEffectFree: true,
        materializedByExplicitPost: true,
        refreshEventCount: continuationEvents.length,
      },
      paymentChallenge: {
        schema: challenge.body.refuel402.schema,
        permit2: challenge.body.refuel402.permit2,
        spender: challenge.body.refuel402.spender,
      },
      payment: paid.body.payment,
      proxy: proxyCalls.at(-1),
      intents,
      reconciliation: reconciled.body.receipt,
      finalState: reconciled.body.journey.state,
      replayStatus: paymentReplay.body.code,
    };
    if (mode === "testnet") {
      happyQuote = quoted.body;
      finalJourney = reconciled.body.journey;
    }
  }

  const mainnetCfg = catalog("mainnet");
  const layerZeroAsset = mainnetCfg.assets.find((candidate) => candidate.provider === "layerzero")!;
  const layerZeroUiRequest = buildCombinedQuoteRequest({
    mode: "mainnet",
    account: account.address,
    network: { chainId: "1" },
    provider: { id: "layerzero", label: "LayerZero / OFT V2" },
    token: {
      assetId: layerZeroAsset.id,
      provider: "layerzero",
      address: layerZeroOriginToken,
      decimals: 8,
      disabled: false,
      asset: layerZeroAsset,
    },
    amount: "0.01",
    desiredHbar: "0.5",
    slippageBps: 100,
  });
  const layerZeroQuoted = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layerZeroUiRequest),
  });
  if (
    layerZeroQuoted.response.status !== 200 ||
    layerZeroQuoted.body.bridge?.source !== "layerzero-oft-v2" ||
    layerZeroQuoted.body.destination?.desiredHbarTinybar !== "50000000" ||
    layerZeroQuoted.body.destination?.routePresentation?.scope !== "saucer_venue_aware_exact_output" ||
    layerZeroQuoted.body.destination?.routePresentation?.wrapperBoundary?.output?.tokenId !== "0.0.10082597" ||
    !layerZeroQuoted.body.amountLedger?.allInvariantsHold ||
    !layerZeroQuoted.body.costLedger?.summary
  ) {
    throw new Error(`mainnet LayerZero quote model failed: ${JSON.stringify(layerZeroQuoted.body)}`);
  }
  const layerZeroJourney = await request(productBase, "/v1/product/journeys", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "journey-mainnet-layerzero-prewallet-0001" },
    body: JSON.stringify({ mode: "mainnet", quoteId: layerZeroQuoted.body.quoteId, account: account.address }),
  });
  if (layerZeroJourney.response.status !== 201) {
    throw new Error(`mainnet LayerZero pre-wallet journey failed: ${JSON.stringify(layerZeroJourney.body)}`);
  }
  modeProofs.layerzeroMainnetPreWallet = {
    uiRequest: layerZeroUiRequest,
    quoteId: layerZeroQuoted.body.quoteId,
    desiredHbarTinybar: layerZeroQuoted.body.destination.desiredHbarTinybar,
    maximumFeasibleHbar: layerZeroQuoted.body.destination.maximumFeasibleHbar,
    providerSource: layerZeroQuoted.body.bridge.source,
    routePresentation: layerZeroQuoted.body.destination.routePresentation,
    costSummary: layerZeroQuoted.body.costLedger.summary,
    amountLedger: layerZeroQuoted.body.amountLedger,
    journeyId: layerZeroJourney.body.journey.id,
    stoppedBeforeWallet: true,
  };

  const testnetCfg = catalog("testnet");
  const baseUi = {
    mode: "testnet",
    account: account.address,
    provider: "axelar",
    originChainId: testnetCfg.originNetworks[0]!.chainId,
    originToken,
    amountBaseUnits: "10000000",
    desiredHbar: "1",
    slippageBps: 100,
  };
  const scenarios: Record<string, unknown> = {};

  // Faithful current client order for the one-signature path. This composes the
  // real structured refuelCap, carries one SourceLegConsent across every source
  // mutation, takes the capped Permit2 approval before the bridge, records the
  // RefuelAuthorization witness, then writes the bridge boundary/hash. Every
  // wallet/chain action is simulated locally through the policy-RPC harness.
  const previousPreauthorization = process.env.REFUEL_PREAUTHORIZATION_ENABLED;
  process.env.REFUEL_PREAUTHORIZATION_ENABLED = "1";
  const preauthorizedQuote = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id }),
  });
  if (previousPreauthorization === undefined) delete process.env.REFUEL_PREAUTHORIZATION_ENABLED;
  else process.env.REFUEL_PREAUTHORIZATION_ENABLED = previousPreauthorization;
  if (
    preauthorizedQuote.response.status !== 200 ||
    preauthorizedQuote.body.refuelCap?.schema !== "refuel402.refuel-cap.v1" ||
    preauthorizedQuote.body.refuelAuthorization?.enabled !== true ||
    preauthorizedQuote.body.refuelAuthorization?.prerequisite !== "permit2_allowance"
  ) throw new Error(`pre-bridge quote did not expose accepted refuel terms: ${JSON.stringify(preauthorizedQuote.body)}`);
  const preauthorizedJourney = await request(productBase, "/v1/product/journeys", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "journey-preauthorized-source-order-0001" },
    body: JSON.stringify({ mode: "testnet", quoteId: preauthorizedQuote.body.quoteId, account: account.address }),
  });
  if (preauthorizedJourney.response.status !== 201) throw new Error(`preauthorized journey failed: ${JSON.stringify(preauthorizedJourney.body)}`);
  const preauthorizedJourneyId = preauthorizedJourney.body.journey.id as string;
  const preauthorizedConsent = await sourceLegConsent(preauthorizedJourneyId, preauthorizedQuote.body, "testnet");
  const preauthorizedActivation = await request(productBase, `/v1/product/journeys/${preauthorizedJourneyId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: preauthorizedConsent }),
  });
  if (preauthorizedActivation.response.status !== 200) throw new Error(`preauthorized activation failed: ${JSON.stringify(preauthorizedActivation.body)}`);
  await authorizeAndSubmit(productBase, "testnet", preauthorizedJourneyId, "activation", preauthorizedConsent);
  const preauthorizedPermit2 = await authorizeAndSubmit(productBase, "testnet", preauthorizedJourneyId, "permit2_approval", preauthorizedConsent);
  const terms = preauthorizedQuote.body.refuelAuthorization;
  const deadline = Math.floor(Date.now() / 1_000) + Math.min(Number(terms.authorizationTtlSeconds), 600);
  const authorization = {
    owner: account.address,
    token: getAddress(terms.token),
    maxAmountIn: BigInt(terms.maxAmountIn),
    exactHbarTinybar: BigInt(terms.exactHbarTinybar),
    serviceFeeAmount: BigInt(terms.serviceFeeAmount),
    recipient: account.address,
    journeyNonce: journeyNonce(preauthorizedJourneyId),
    deadline: BigInt(deadline),
    routeHash: terms.routeHash as Hex,
  };
  const refuelSignature = await account.signTypedData(refuelAuthorizationTypedData({
    chainId: 296,
    permit2: getAddress(terms.permit2),
    spender: getAddress(terms.spender),
    authorization,
  }));
  const recordedRefuel = await request(productBase, `/v1/product/journeys/${preauthorizedJourneyId}/refuel-authorization`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: preauthorizedConsent, deadline, signature: refuelSignature }),
  });
  if (recordedRefuel.response.status !== 201) throw new Error(`preauthorized witness failed: ${JSON.stringify(recordedRefuel.body)}`);
  const preauthorizedBoundary = await request(productBase, `/v1/product/journeys/${preauthorizedJourneyId}/wallet-boundary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "bridge", confirmation: preauthorizedConsent }),
  });
  if (preauthorizedBoundary.response.status !== 200) throw new Error(`preauthorized bridge boundary failed: ${JSON.stringify(preauthorizedBoundary.body)}`);
  const preauthorizedSourceHash = keccak256(stringToHex(`source-preauthorized-${preauthorizedJourneyId}`));
  const preauthorizedBridge = await request(productBase, `/v1/product/journeys/${preauthorizedJourneyId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: preauthorizedSourceHash, confirmation: preauthorizedConsent }),
  });
  if (preauthorizedBridge.response.status !== 200) throw new Error(`preauthorized bridge bind failed: ${JSON.stringify(preauthorizedBridge.body)}`);
  const preauthorizedReadback = await request(productBase, `/v1/product/journeys/${preauthorizedJourneyId}`);
  const preauthorizedEvents = preauthorizedReadback.body.journey.events.map((event: any) => event.type);
  const preauthorizedOrder = [
    "intent_activation_confirmed",
    "intent_permit2_approval_confirmed",
    "refuel_authorization_recorded",
    "bridge_wallet_boundary",
    "bridge_submitted",
  ].map((type) => preauthorizedEvents.indexOf(type));
  if (
    preauthorizedOrder.some((index) => index < 0) ||
    preauthorizedOrder.some((index, position) => position > 0 && index <= preauthorizedOrder[position - 1]!) ||
    BigInt(`0x${preauthorizedPermit2.transaction.data.slice(-64)}`) !== BigInt(preauthorizedQuote.body.refuelCap.maxAmountIn) ||
    preauthorizedReadback.body.journey.authorizations.filter((entry: any) => entry.intentKind === "permit2_approval").length !== 1
  ) throw new Error(`preauthorized source ordering did not match the client contract: ${JSON.stringify({ events: preauthorizedEvents, journey: preauthorizedReadback.body.journey })}`);
  scenarios.preauthorizedSourceOrder = {
    quoteId: preauthorizedQuote.body.quoteId,
    journeyId: preauthorizedJourneyId,
    structuredRefuelCap: preauthorizedQuote.body.refuelCap,
    permit2Token: preauthorizedQuote.body.asset.destination.address,
    permit2Spender: preauthorizedQuote.body.x402.contract.permit2,
    permit2ApprovalAmount: BigInt(`0x${preauthorizedPermit2.transaction.data.slice(-64)}`).toString(),
    refuelAuthorizationMaxAmountIn: terms.maxAmountIn,
    orderedEvents: preauthorizedOrder.map((index) => preauthorizedEvents[index]),
    authorizationCount: 1,
    externalWalletOrChainCalls: 0,
  };

  quoteScenario = "stale";
  const staleScenario = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id }) });
  scenarios.staleQuote = { status: staleScenario.response.status, code: staleScenario.body.code };
  quoteScenario = "underfunded";
  const underfundedScenario = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id }) });
  scenarios.underfunded = { status: underfundedScenario.response.status, code: underfundedScenario.body.code, details: underfundedScenario.body.details };
  quoteScenario = "impact";
  const impactScenario = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id }) });
  scenarios.priceImpact = { status: impactScenario.response.status, code: impactScenario.body.code, details: impactScenario.body.details };
  quoteScenario = "happy";
  const mapping = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id, originToken: "0x9999999999999999999999999999999999999999" }) });
  scenarios.unsupportedMapping = mapping.body.code;
  const liquidity = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[1]!.id }) });
  scenarios.liquidity = { status: liquidity.response.status, code: liquidity.body.code, blockers: liquidity.body.candidates?.[0]?.runtime?.blockers };
  const slippage = await request(productBase, "/v1/product/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id, slippageBps: 301 }) });
  scenarios.slippage = slippage.body.code;

  // A cap the owner typed is their input, not an outage. Both of these used to
  // fall through every typed handler into the catch-all 503 "temporarily
  // unavailable, retriable: true", so the UI invited an infinite retry of a
  // request that could never succeed until the cap changed.
  const capBelowFee = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id, refuelProtection: { preset: "custom", customMaxAmountIn: "1" } }),
  });
  const capBelowToday = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseUi, assetId: testnetCfg.assets[0]!.id, refuelProtection: { preset: "custom", customMaxAmountIn: "20001" } }),
  });
  if (
    capBelowFee.response.status !== 422 || capBelowFee.body.code !== "REFUEL_CAP_BELOW_SERVICE_FEE" || capBelowFee.body.retriable !== false ||
    capBelowToday.response.status !== 422 || capBelowToday.body.code !== "REFUEL_CAP_BELOW_TODAY_PRICE" || capBelowToday.body.retriable !== false ||
    !capBelowToday.body.details?.minimumMaxAmountIn
  ) {
    throw new Error(`custom refuel cap refusals must be non-retriable 422s naming the minimum: ${JSON.stringify({ capBelowFee: capBelowFee.body, capBelowToday: capBelowToday.body })}`);
  }
  scenarios.customRefuelCapRefusals = {
    belowServiceFee: { status: capBelowFee.response.status, code: capBelowFee.body.code, retriable: capBelowFee.body.retriable },
    belowTodayPrice: {
      status: capBelowToday.response.status,
      code: capBelowToday.body.code,
      retriable: capBelowToday.body.retriable,
      minimumMaxAmountIn: capBelowToday.body.details.minimumMaxAmountIn,
    },
  };
  const fiftyHbar = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseUi, routeMode: "bridge_plus_refuel", assetId: testnetCfg.assets[0]!.id, desiredHbar: "50", slippageBps: 100 }),
  });
  if (
    fiftyHbar.response.status !== 200 ||
    fiftyHbar.body.destination?.desiredHbarTinybar !== "5000000000" ||
    fiftyHbar.body.feasibility?.maximumTinybar !== "5000000000" ||
    fiftyHbar.body.x402?.sponsorPolicy?.concurrentReservationVerification === undefined ||
    fiftyHbar.body.destination?.slippageBps !== 100
  ) throw new Error(`50-HBAR source risk model did not satisfy the bounded harness: ${JSON.stringify(fiftyHbar.body)}`);
  const aboveFiftyHbar = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseUi, routeMode: "bridge_plus_refuel", assetId: testnetCfg.assets[0]!.id, desiredHbar: "50.00000001", slippageBps: 100 }),
  });
  if (aboveFiftyHbar.response.status !== 422 || aboveFiftyHbar.body.code !== "DESIRED_HBAR_EXCEEDS_MAXIMUM") {
    throw new Error(`above-cap HBAR request did not fail closed: ${JSON.stringify(aboveFiftyHbar.body)}`);
  }
  scenarios.fiftyHbarSourceModel = {
    desiredTinybar: fiftyHbar.body.destination.desiredHbarTinybar,
    maximumTinybar: fiftyHbar.body.feasibility.maximumTinybar,
    sponsorPolicy: fiftyHbar.body.x402.sponsorPolicy,
    slippageBps: fiftyHbar.body.destination.slippageBps,
    aboveCapCode: aboveFiftyHbar.body.code,
    liveActivationPerformed: false,
  };

  const bridgeOnlyQuote = await request(productBase, "/v1/product/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...baseUi,
      routeMode: "bridge_only",
      assetId: testnetCfg.assets[1]!.id,
      desiredHbar: "0",
    }),
  });
  if (
    bridgeOnlyQuote.response.status !== 200 ||
    bridgeOnlyQuote.body.routeMode !== "bridge_only" ||
    bridgeOnlyQuote.body.destination?.hbarOutput?.kind !== "unavailable" ||
    bridgeOnlyQuote.body.destination?.routePresentation !== null ||
    bridgeOnlyQuote.body.capabilities?.execute !== true
  ) throw new Error(`bridge-only quote did not survive the Saucer liquidity blocker: ${JSON.stringify(bridgeOnlyQuote.body)}`);
  const bridgeOnlyJourney = await request(productBase, "/v1/product/journeys", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "bridge-only-journey-fixture-0001" },
    body: JSON.stringify({ mode: "testnet", quoteId: bridgeOnlyQuote.body.quoteId, account: account.address }),
  });
  const bridgeOnlyJourneyId = bridgeOnlyJourney.body.journey.id;
  const bridgeOnlyConsent = await sourceLegConsent(bridgeOnlyJourneyId, bridgeOnlyQuote.body, "testnet");
  await request(productBase, `/v1/product/journeys/${bridgeOnlyJourneyId}/wallet-boundary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "bridge", confirmation: bridgeOnlyConsent }),
  });
  const bridgeOnlySourceHash = keccak256(stringToHex(`source-bridge-only-${bridgeOnlyJourneyId}`));
  await request(productBase, `/v1/product/journeys/${bridgeOnlyJourneyId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: bridgeOnlySourceHash, confirmation: bridgeOnlyConsent }),
  });
  const bridgeOnlyArrival = await request(productBase, `/v1/product/journeys/${bridgeOnlyJourneyId}/bridge`);
  const bridgeOnlyReadback = await request(productBase, `/v1/product/journeys/${bridgeOnlyJourneyId}`);
  if (
    bridgeOnlyArrival.body.journey?.state !== "completed" ||
    bridgeOnlyReadback.body.recovery?.disposition !== "terminal" ||
    bridgeOnlyReadback.body.journey?.payment !== null ||
    bridgeOnlyReadback.body.journey?.authorizations?.length !== 0
  ) throw new Error(`bridge-only lifecycle did not terminate without refuel: ${JSON.stringify(bridgeOnlyReadback.body)}`);
  scenarios.bridgeOnly = {
    quoteId: bridgeOnlyQuote.body.quoteId,
    journeyId: bridgeOnlyJourneyId,
    destinationMinimum: bridgeOnlyQuote.body.outcome.minimumArrival,
    hbarClaim: bridgeOnlyQuote.body.destination.hbarOutput.kind,
    routePresentation: bridgeOnlyQuote.body.destination.routePresentation,
    finalState: bridgeOnlyReadback.body.journey.state,
    recovery: bridgeOnlyReadback.body.recovery,
  };

  const recoveryQuoteId = "d".repeat(64);
  await lifecycle.saveQuote({
    quoteId: recoveryQuoteId,
    mode: "testnet",
    account: account.address,
    requestedProvider: "axelar",
    selectedProvider: "axelar",
    assetId: testnetCfg.assets[0]!.id,
    originChainId: testnetCfg.originNetworks[0]!.chainId,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    executable: true,
    record: { ...happyQuote!, quoteId: recoveryQuoteId, routeMode: "bridge_plus_refuel" },
  });
  const recoveryJourney = await lifecycle.createJourney({ quoteId: recoveryQuoteId, mode: "testnet", account: account.address, idempotencyKey: "refresh-recovery-journey-fixture" });
  await lifecycle.recordWalletBoundary({ journeyId: recoveryJourney.id, kind: "bridge" });
  const recoverySourceHash = keccak256(stringToHex(`source-recovery-${recoveryJourney.id}`));
  await lifecycle.recordBridgeSubmission({ journeyId: recoveryJourney.id, sourceTransactionHash: recoverySourceHash, destinationBalanceBefore: "0", hbarBalanceBefore: "10000000" });
  const recoveryBefore = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}`);
  const bridgeSubmittedAtMs = recoveryBefore.body.journey.events.find((event: any) => event.type === "bridge_submitted")?.createdAt;
  if (!Number.isSafeInteger(bridgeSubmittedAtMs)) throw new Error("recovery bridge submission timestamp is unavailable");
  const recoveryConsensusMs = bridgeSubmittedAtMs + 1;
  const recoveryConsensusSec = Math.floor(recoveryConsensusMs / 1_000);
  const recoveryConsensusNanos = String((recoveryConsensusMs % 1_000) * 1_000_000 + 1).padStart(9, "0");
  const recoveryTransactionId = `0.0.8008-${recoveryConsensusSec}-${recoveryConsensusNanos}`;
  const recoveryConsensusTimestamp = `${recoveryConsensusSec}.${recoveryConsensusNanos}`;
  const recoveryDestination = testnetCfg.assets[0]!.destination;
  const recoveryTokenId = "tokenId" in recoveryDestination
    ? recoveryDestination.tokenId
    : recoveryDestination.wrapper.htsTokenId;
  const chainMirror = {
    account: async () => ({
      account: "0.0.7007",
      evm_address: account.address,
      ethereum_nonce: 0,
      key: null,
      balance: { balance: 10_000_000, tokens: [{ token_id: recoveryTokenId, balance: 9_900_000 }] },
    }),
    tokenCreditsAfter: async () => [{
      transactionId: recoveryTransactionId,
      transactionHash: Buffer.from(`destination-${recoveryJourney.id}`).toString("base64"),
      consensusTimestamp: recoveryConsensusTimestamp,
      tokenId: recoveryTokenId,
      accountId: "0.0.7007",
      amount: 9_900_000n,
    }],
    ethCall: async () => "0x0",
  };
  const chainTracker = createProductBridgeTracker({
    store: lifecycle,
    mirrors: { testnet: chainMirror as any, mainnet: chainMirror as any },
    transferStatus: async (input) => ({
      provider: input.provider,
      state: "pending",
      sourceTransactionHash: input.sourceTransactionHash,
      destinationTransactionHash: null,
      providerStatus: "ongoing",
      providerUrl: "https://provider.example/fixture",
      observedAt: new Date().toISOString(),
    }),
  });
  const chainApp = express();
  chainApp.use(express.json({ limit: "128kb" }));
  chainApp.use("/v1/product", createProductLifecycleRouter({ store: lifecycle, bridgeTracker: chainTracker }));
  const chainBase = await listen(chainApp);
  const recoveryArrival = await request(chainBase, `/v1/product/journeys/${recoveryJourney.id}/bridge`);
  const recoveryArrivalReplay = await request(chainBase, `/v1/product/journeys/${recoveryJourney.id}/bridge`);
  const recoveryAfter = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}`);
  const arrivalEvents = recoveryAfter.body.journey.events.filter((event: any) => event.type === "bridge_arrived");
  if (
    recoveryBefore.body.recovery?.disposition !== "resume_safe" ||
    recoveryBefore.body.recovery?.nextAtomicStep !== "poll_bridge" ||
    recoveryArrival.body.journey?.state !== "arrival_confirmed" ||
    recoveryArrival.body.arrival?.chainAuthoritative !== true ||
    recoveryArrival.body.arrival?.providerLagging !== true ||
    recoveryArrival.body.arrival?.destinationTransactionId !== recoveryTransactionId ||
    recoveryArrivalReplay.body.journey?.state !== "arrival_confirmed" ||
    arrivalEvents.length !== 1 ||
    recoveryAfter.body.recovery?.nextAtomicStep !== "destination_wallet_consent" ||
    recoveryAfter.body.recovery?.autoSignAllowed !== false ||
    recoveryAfter.body.recovery?.autoSubmitAllowed !== false
  ) throw new Error(`chain-authoritative refresh recovery did not preserve the replay-safe boundary: ${JSON.stringify({ recoveryArrival: recoveryArrival.body, recoveryArrivalReplay: recoveryArrivalReplay.body, recoveryAfter: recoveryAfter.body })}`);
  const recoveryRefresh = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}/destination-quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const recoveryAfterRefresh = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}`);
  const quoteRefreshEvents = recoveryAfterRefresh.body.journey.events.filter((event: any) => event.type === "destination_quote_refreshed");
  const wrongQuoteAuthorization = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}/intents/permit2_approval/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "recovery-wrong-quote-authorization" },
    body: JSON.stringify({ quoteId: "e".repeat(64) }),
  });
  const recoveryAfterRejectedConsent = await request(productBase, `/v1/product/journeys/${recoveryJourney.id}`);
  if (
    recoveryRefresh.response.status !== 200 ||
    recoveryRefresh.body.quote?.quoteId !== recoveryAfterRefresh.body.quote?.quoteId ||
    quoteRefreshEvents.length !== 1 ||
    quoteRefreshEvents[0]?.record?.quoteId !== recoveryRefresh.body.quote?.quoteId ||
    wrongQuoteAuthorization.response.status !== 409 ||
    recoveryAfterRejectedConsent.body.journey?.payment !== null ||
    recoveryAfterRejectedConsent.body.journey?.authorizations?.length !== 0 ||
    recoveryAfterRejectedConsent.body.journey?.submissions?.length !== 0
  ) throw new Error(`two-step destination recovery boundary did not persist the exact quote and reject mismatched consent without mutation: ${JSON.stringify({ recoveryRefresh: recoveryRefresh.body, recoveryAfterRefresh: recoveryAfterRefresh.body, wrongQuoteAuthorization: wrongQuoteAuthorization.body, recoveryAfterRejectedConsent: recoveryAfterRejectedConsent.body })}`);
  scenarios.refreshRecovery = {
    journeyId: recoveryJourney.id,
    before: recoveryBefore.body.recovery,
    after: recoveryAfterRefresh.body.recovery,
    arrival: recoveryArrival.body.arrival,
    providerStatus: recoveryArrival.body.transfer.providerStatus,
    bridgeArrivedEvents: arrivalEvents.length,
    duplicatePollState: recoveryArrivalReplay.body.journey.state,
    destinationQuoteId: recoveryRefresh.body.quote.quoteId,
    destinationQuoteExpiresAt: recoveryRefresh.body.quote.expiresAt,
    destinationQuoteRefreshEvents: quoteRefreshEvents.length,
    mismatchedConsentStatus: wrongQuoteAuthorization.response.status,
    payment: recoveryAfterRejectedConsent.body.journey.payment,
    authorizations: recoveryAfterRejectedConsent.body.journey.authorizations.length,
    submissions: recoveryAfterRejectedConsent.body.journey.submissions.length,
  };

  const unknownQuote = { ...happyQuote!, quoteId: "b".repeat(64), providerSelection: { ...happyQuote!.providerSelection, requested: "axelar", selected: "axelar" } };
  await lifecycle.saveQuote({
    quoteId: unknownQuote.quoteId,
    mode: "testnet",
    account: account.address,
    requestedProvider: "axelar",
    selectedProvider: "axelar",
    assetId: testnetCfg.assets[0]!.id,
    originChainId: testnetCfg.originNetworks[0]!.chainId,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    executable: true,
    record: unknownQuote,
  });
  const unknownJourney = await lifecycle.createJourney({ quoteId: unknownQuote.quoteId, mode: "testnet", account: account.address, idempotencyKey: "unknown-journey-fixture" });
  const unknownRaw = await signRawTx({ privateKey: key, chainId: 296, to: destinationToken, data: "0x0a754de6", nonce: nextNonce.get(`testnet:${account.address}`) ?? 0, gasLimit: 120_000n, maxFeePerGas: 0n });
  const unknownCandidate = await authorizedRawTransactionCandidate("testnet", unknownRaw);
  await lifecycle.createAuthorization({
    journeyId: unknownJourney.id,
    intentKind: "activation",
    idempotencyKey: "unknown-authorization-fixture",
    authorization: {
      id: "unknown-auth",
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: unknownCandidate.nonce,
      to: unknownCandidate.to,
      dataHash: unknownCandidate.dataHash,
      value: 0n,
      gasLimitMaximum: 120_000n,
      maxGasAllowanceTinybar: 1_000_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 180,
    },
  });
  const unknownProcessor = createPolicyRpcProcessor({
    upstreams: { testnet: "http://127.0.0.1/unused", mainnet: "http://127.0.0.1/unused" },
    authorizer: lifecycle,
    submitter: { testnet: { submit: async () => { throw new Error("deterministic unknown"); } } },
  });
  const unknownResult = await unknownProcessor("testnet", { jsonrpc: "2.0", id: 99, method: "eth_sendRawTransaction", params: [unknownRaw] });
  scenarios.unknownSubmit = unknownResult;

  async function settleExactPayment(journeyId: string, paymentNonce: string, idempotencyPrefix: string) {
    const readback = await request(productBase, `/v1/product/journeys/${journeyId}`);
    const x402 = readback.body.quote.x402;
    const payment = {
      payer: account.address,
      token: getAddress(x402.asset),
      amount: String(x402.feeAmount),
      recipient,
      chainId: 296 as const,
      nonce: paymentNonce,
      deadline: Math.floor(Date.now() / 1000) + 120,
      spender: getAddress(x402.contract.proxy),
      contextHash: x402.contextHash as Hex,
      signature: "0x" as Hex,
    };
    payment.signature = await account.signTypedData({
      domain: { name: "Permit2", chainId: payment.chainId, verifyingContract: permit2 },
      types: exactTypes(),
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: payment.token, amount: BigInt(payment.amount) },
        spender: payment.spender,
        nonce: BigInt(payment.nonce),
        deadline: BigInt(payment.deadline),
        witness: {
          payer: payment.payer,
          token: payment.token,
          amount: BigInt(payment.amount),
          recipient: payment.recipient,
          chainId: BigInt(payment.chainId),
          nonce: BigInt(payment.nonce),
          deadline: BigInt(payment.deadline),
          spender: payment.spender,
          contextHash: payment.contextHash,
        },
      },
    });
    const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: null, payload: { payment } } as never);
    return request(productBase, `/v1/product/journeys/${journeyId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `${idempotencyPrefix}-0001`, "payment-signature": header },
      body: "{}",
    });
  }

  // Restart scenarios: an expired-pending authorization (never consumed) must
  // revert its journey to the durable-event state, while an unknown-consumed
  // authorization is the only evidence that produces review.
  const expiredPendingQuoteId = "f".repeat(64);
  await lifecycle.saveQuote({ quoteId: expiredPendingQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: expiredPendingQuoteId } });
  const expiredPendingJourney = await lifecycle.createJourney({ quoteId: expiredPendingQuoteId, mode: "testnet", account: account.address, idempotencyKey: "expired-pending-journey-fixture" });
  const expiredPendingSource = keccak256(stringToHex(`source-expired-${expiredPendingJourney.id}`));
  await lifecycle.recordBridgeSubmission({ journeyId: expiredPendingJourney.id, sourceTransactionHash: expiredPendingSource, destinationBalanceBefore: "0", hbarBalanceBefore: "10000000" });
  await lifecycle.recordBridgeArrival({ journeyId: expiredPendingJourney.id, sourceTransactionHash: expiredPendingSource, destinationTransactionHash: keccak256(stringToHex(`destination-expired-${expiredPendingJourney.id}`)), destinationBalanceAfter: "9900000", destinationAmountReceived: "9900000", providerStatus: "success" });
  await lifecycle.createAuthorization({ journeyId: expiredPendingJourney.id, intentKind: "permit2_approval", idempotencyKey: "expired-pending-authorization-fixture", authorization: { id: "expired-pending-auth", mode: "testnet", account: account.address, chainId: 296, nonce: 55, to: destinationToken, dataHash: keccak256("0x095ea7b3"), value: 0n, gasLimitMaximum: 120_000n, maxGasAllowanceTinybar: 1_000_000n, expiresAt: Math.floor(Date.now() / 1000) + 60 } });

  const restartQuoteId = "c".repeat(64);
  await lifecycle.saveQuote({ quoteId: restartQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 300, executable: true, record: { ...happyQuote!, quoteId: restartQuoteId } });
  const restartJourney = await lifecycle.createJourney({ quoteId: restartQuoteId, mode: "testnet", account: account.address, idempotencyKey: "restart-journey-fixture" });
  const restartRaw = await signRawTx({ privateKey: key, chainId: 296, to: destinationToken, data: "0x0a754de6", nonce: 98, gasLimit: 120_000n, maxFeePerGas: 0n });
  const restartCandidate = await authorizedRawTransactionCandidate("testnet", restartRaw);
  await lifecycle.createAuthorization({ journeyId: restartJourney.id, intentKind: "activation", idempotencyKey: "restart-authorization-fixture", authorization: { id: "restart-auth", mode: "testnet", account: account.address, chainId: 296, nonce: 98, to: restartCandidate.to, dataHash: restartCandidate.dataHash, value: 0n, gasLimitMaximum: 120_000n, maxGasAllowanceTinybar: 1_000_000n, expiresAt: Math.floor(Date.now() / 1000) + 180 } });
  await lifecycle.consume(keccak256(restartRaw), restartCandidate);
  const restarted = new ProductLifecycleStore(postgres.pool);
  // A restart right after consume() must not poison the in-flight submission.
  const freshRestart = await restarted.recoverInterrupted();
  if (freshRestart.expiredAuthorizations !== 0 || freshRestart.unknownAuthorizations !== 0 || freshRestart.reviewJourneys !== 0) {
    throw new Error(`fresh restart poisoned live authorizations: ${JSON.stringify(freshRestart)}`);
  }
  const agedRecovery = await restarted.recoverInterrupted(Math.floor(Date.now() / 1000) + 600);
  const revertedJourney = await lifecycle.getJourney(expiredPendingJourney.id);
  const restartReview = await lifecycle.getJourney(restartJourney.id);
  if (
    agedRecovery.expiredAuthorizations !== 1 ||
    agedRecovery.unknownAuthorizations !== 1 ||
    agedRecovery.reviewJourneys !== 1 ||
    agedRecovery.revertedJourneys !== 1 ||
    revertedJourney?.state !== "arrival_confirmed" ||
    !revertedJourney.events.some((event: any) => event.type === "journey_reverted") ||
    restartReview?.state !== "review"
  ) {
    throw new Error(`aged restart recovery misclassified journeys: ${JSON.stringify({ agedRecovery, expiredPendingState: revertedJourney?.state, restartState: restartReview?.state })}`);
  }
  scenarios.restartRecovery = {
    fresh: freshRestart,
    aged: agedRecovery,
    expiredPendingState: revertedJourney.state,
    unknownConsumedState: restartReview.state,
  };

  // The reverted journey continues through the normal flow to terminal.
  const revertedRefresh = await request(productBase, `/v1/product/journeys/${expiredPendingJourney.id}/destination-quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (revertedRefresh.response.status !== 200) throw new Error(`reverted journey destination quote failed: ${JSON.stringify(revertedRefresh.body)}`);
  await authorizeAndSubmit(productBase, "testnet", expiredPendingJourney.id, "permit2_approval");
  const revertedPayment = await settleExactPayment(expiredPendingJourney.id, "7", "payment-expired-pending-fixture");
  if (revertedPayment.response.status !== 200) throw new Error(`reverted journey payment failed: ${JSON.stringify(revertedPayment.body)}`);
  await authorizeAndSubmit(productBase, "testnet", expiredPendingJourney.id, "router_approval");
  const revertedExecution = await authorizeAndSubmit(productBase, "testnet", expiredPendingJourney.id, "router_execution");
  const revertedReconciled = await request(productBase, `/v1/product/journeys/${expiredPendingJourney.id}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ethereumHash: revertedExecution.ethereumHash }),
  });
  if (revertedReconciled.response.status !== 200 || revertedReconciled.body.journey?.state !== "completed") {
    throw new Error(`reverted journey did not reach terminal: ${JSON.stringify(revertedReconciled.body)}`);
  }
  scenarios.expiredPendingRestart = {
    journeyId: expiredPendingJourney.id,
    revertedTo: "arrival_confirmed",
    finalState: revertedReconciled.body.journey.state,
  };

  // Review exit: reconcile-submissions resolves the unknown authorization from
  // mirror evidence and the journey continues.
  const restartEthereumHash = keccak256(restartRaw);
  mirrorEvidence.contractResults.set(restartEthereumHash.toLowerCase(), {
    hash: restartEthereumHash,
    from: account.address,
    to: restartCandidate.to,
    nonce: 98,
    function_parameters: "0x0a754de6",
    amount: 0,
    status: "0x1",
  });
  const reconciledSubmissions = await request(productBase, `/v1/product/journeys/${restartJourney.id}/reconcile-submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "reconcile-restart-fixture-0001" },
    body: "{}",
  });
  if (
    reconciledSubmissions.response.status !== 200 ||
    reconciledSubmissions.body.schema !== "refuel402.product-reconcile-submissions.v1" ||
    reconciledSubmissions.body.resolutions?.length !== 1 ||
    reconciledSubmissions.body.resolutions[0]?.resolution !== "submitted" ||
    reconciledSubmissions.body.resolutions[0]?.ethereumHash !== restartEthereumHash ||
    reconciledSubmissions.body.journey?.state !== "activation_pending" ||
    reconciledSubmissions.body.recovery?.nextAtomicStep !== "source_wallet_consent" ||
    reconciledSubmissions.body.recovery?.revalidateAfterMs !== 15000
  ) {
    throw new Error(`reconcile-submissions did not release the review journey: ${JSON.stringify(reconciledSubmissions.body)}`);
  }
  const reconcileReplay = await request(productBase, `/v1/product/journeys/${restartJourney.id}/reconcile-submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "reconcile-restart-fixture-0002" },
    body: "{}",
  });
  if (reconcileReplay.response.status !== 200 || reconcileReplay.body.resolutions?.length !== 0) {
    throw new Error(`reconcile-submissions replay was not a no-op: ${JSON.stringify(reconcileReplay.body)}`);
  }
  const reconciledActivation = await request(productBase, `/v1/product/journeys/${restartJourney.id}/intents/activation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ethereumHash: restartEthereumHash }),
  });
  if (reconciledActivation.response.status !== 200 || reconciledActivation.body.journey?.state !== "bridge_ready") {
    throw new Error(`reconciled journey did not continue: ${JSON.stringify(reconciledActivation.body)}`);
  }
  scenarios.reconcileRelease = {
    journeyId: restartJourney.id,
    resolutions: reconciledSubmissions.body.resolutions,
    releasedState: reconciledSubmissions.body.journey.state,
    replayResolutions: reconcileReplay.body.resolutions.length,
    continuedState: reconciledActivation.body.journey.state,
  };

  // Pending liveness: a surviving still-consumable authorization defers the
  // durable-state revert instead of reopening the state-machine bypass.
  const livePendingQuoteId = "7".repeat(64);
  await lifecycle.saveQuote({ quoteId: livePendingQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: livePendingQuoteId } });
  const livePendingJourney = await lifecycle.createJourney({ quoteId: livePendingQuoteId, mode: "testnet", account: account.address, idempotencyKey: "live-pending-journey-fixture" });
  const livePendingSource = keccak256(stringToHex(`source-live-pending-${livePendingJourney.id}`));
  await lifecycle.recordBridgeSubmission({ journeyId: livePendingJourney.id, sourceTransactionHash: livePendingSource, destinationBalanceBefore: "0", hbarBalanceBefore: "10000000" });
  await lifecycle.recordBridgeArrival({ journeyId: livePendingJourney.id, sourceTransactionHash: livePendingSource, destinationTransactionHash: keccak256(stringToHex(`destination-live-pending-${livePendingJourney.id}`)), destinationBalanceAfter: "9900000", destinationAmountReceived: "9900000", providerStatus: "success" });
  const livePendingNowSec = Math.floor(Date.now() / 1000);
  // Distinct intent kinds: a second live reservation for the SAME kind now
  // supersedes the first, so the two coexisting rows this sweep is about would
  // otherwise collapse to one.
  for (const [suffix, kind, nonce, expiresAt] of [["short", "permit2_approval", 95, livePendingNowSec + 60], ["long", "wrapper_approval", 96, livePendingNowSec + 7200]] as const) {
    await lifecycle.createAuthorization({ journeyId: livePendingJourney.id, intentKind: kind, idempotencyKey: `live-pending-${suffix}`, authorization: { id: `live-pending-${suffix}`, mode: "testnet", account: account.address, chainId: 296, nonce, to: destinationToken, dataHash: keccak256("0x095ea7b3"), value: 0n, gasLimitMaximum: 120_000n, maxGasAllowanceTinybar: 1_000_000n, expiresAt } });
  }
  const deferredRevert = await lifecycle.recoverInterrupted(livePendingNowSec + 120);
  const deferredJourney = await lifecycle.getJourney(livePendingJourney.id);
  const settledRevert = await lifecycle.recoverInterrupted(livePendingNowSec + 8000);
  const settledJourney = await lifecycle.getJourney(livePendingJourney.id);
  if (
    deferredRevert.expiredAuthorizations !== 1 ||
    deferredRevert.revertedJourneys !== 0 ||
    deferredJourney?.state !== "authorizing" ||
    settledRevert.expiredAuthorizations !== 1 ||
    settledRevert.revertedJourneys !== 1 ||
    settledJourney?.state !== "arrival_confirmed"
  ) {
    throw new Error(`pending liveness did not gate the durable-state revert: ${JSON.stringify({ deferredRevert, deferredState: deferredJourney?.state, settledRevert, settledState: settledJourney?.state })}`);
  }
  scenarios.pendingLiveness = {
    journeyId: livePendingJourney.id,
    deferred: deferredRevert,
    deferredState: deferredJourney.state,
    settled: settledRevert,
    settledState: settledJourney.state,
  };

  // Runtime promotion: a crash between consume() and markSubmitted strands the
  // journey in 'submitting'. The user-facing reconcile endpoint must release it
  // without a process restart, and must leave in-grace evidence untouched.
  const strandedQuoteId = "6".repeat(64);
  await lifecycle.saveQuote({ quoteId: strandedQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: strandedQuoteId } });
  const strandedJourney = await lifecycle.createJourney({ quoteId: strandedQuoteId, mode: "testnet", account: account.address, idempotencyKey: "stranded-journey-fixture" });
  const strandedRaw = await signRawTx({ privateKey: key, chainId: 296, to: destinationToken, data: "0x0a754de6", nonce: 97, gasLimit: 120_000n, maxFeePerGas: 0n });
  const strandedCandidate = await authorizedRawTransactionCandidate("testnet", strandedRaw);
  await lifecycle.createAuthorization({ journeyId: strandedJourney.id, intentKind: "activation", idempotencyKey: "stranded-authorization-fixture", authorization: { id: "stranded-auth", mode: "testnet", account: account.address, chainId: 296, nonce: 97, to: strandedCandidate.to, dataHash: strandedCandidate.dataHash, value: 0n, gasLimitMaximum: 120_000n, maxGasAllowanceTinybar: 1_000_000n, expiresAt: Math.floor(Date.now() / 1000) + 180 } });
  await lifecycle.consume(keccak256(strandedRaw), strandedCandidate);
  const strandedBefore = await request(productBase, `/v1/product/journeys/${strandedJourney.id}`);
  const strandedInGrace = await request(productBase, `/v1/product/journeys/${strandedJourney.id}/reconcile-submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (
    strandedBefore.body.journey?.state !== "submitting" ||
    strandedBefore.body.recovery?.nextAtomicStep !== "reconcile_submissions" ||
    strandedInGrace.response.status !== 200 ||
    strandedInGrace.body.resolutions?.length !== 0 ||
    strandedInGrace.body.journey?.state !== "submitting" ||
    !(strandedInGrace.body.recovery?.revalidateAfterMs > 0)
  ) {
    throw new Error(`in-flight consumed evidence was not left alone with a re-poll hint: ${JSON.stringify({ before: strandedBefore.body.recovery, inGrace: strandedInGrace.body })}`);
  }
  await postgres.pool.query(
    "UPDATE refuel402_product_authorizations SET expires_at = $2 WHERE authorization_id = $1",
    ["stranded-auth", Math.floor(Date.now() / 1000) - 400],
  );
  const strandedEthereumHash = keccak256(strandedRaw);
  mirrorEvidence.contractResults.set(strandedEthereumHash.toLowerCase(), {
    hash: strandedEthereumHash,
    from: account.address,
    to: strandedCandidate.to,
    nonce: 97,
    function_parameters: "0x0a754de6",
    amount: 0,
    status: "0x1",
  });
  const strandedReleased = await request(productBase, `/v1/product/journeys/${strandedJourney.id}/reconcile-submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (
    strandedReleased.response.status !== 200 ||
    strandedReleased.body.resolutions?.length !== 1 ||
    strandedReleased.body.resolutions[0]?.resolution !== "submitted" ||
    strandedReleased.body.resolutions[0]?.ethereumHash !== strandedEthereumHash ||
    strandedReleased.body.journey?.state !== "activation_pending" ||
    !strandedReleased.body.journey.events.some((event: any) => event.type === "restart_unknown_submission")
  ) {
    throw new Error(`grace-expired consumed evidence was not promoted at runtime: ${JSON.stringify(strandedReleased.body)}`);
  }
  scenarios.strandedSubmitting = {
    journeyId: strandedJourney.id,
    strandedState: strandedBefore.body.journey.state,
    inGraceResolutions: strandedInGrace.body.resolutions.length,
    inGraceRevalidateAfterMs: strandedInGrace.body.recovery.revalidateAfterMs,
    promotedResolutions: strandedReleased.body.resolutions,
    releasedState: strandedReleased.body.journey.state,
    startupSweepAlsoPromotes: true,
  };

  // Source-hash adoption: chain + provider evidence binds a lost bridge hash;
  // ambiguity always fails closed.
  const adoptQuoteId = "9".repeat(64);
  await lifecycle.saveQuote({ quoteId: adoptQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: adoptQuoteId } });
  const adoptJourney = await lifecycle.createJourney({ quoteId: adoptQuoteId, mode: "testnet", account: account.address, idempotencyKey: "bridge-adopt-journey-fixture" });
  await lifecycle.recordWalletBoundary({ journeyId: adoptJourney.id, kind: "bridge" });
  const ambiguousQuoteId = "8".repeat(64);
  await lifecycle.saveQuote({ quoteId: ambiguousQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: ambiguousQuoteId } });
  const ambiguousJourney = await lifecycle.createJourney({ quoteId: ambiguousQuoteId, mode: "testnet", account: account.address, idempotencyKey: "bridge-adopt-ambiguous-journey" });
  await lifecycle.recordWalletBoundary({ journeyId: ambiguousJourney.id, kind: "bridge" });
  const adoptCreditTs = `${Math.floor(Date.now() / 1000) + 60}.000000001`;
  const adoptCredit = {
    transactionId: "0.0.8008-1111111111-000000001",
    transactionHash: Buffer.from(`adopt-${adoptJourney.id}`).toString("base64"),
    consensusTimestamp: adoptCreditTs,
    tokenId: recoveryTokenId,
    accountId: "0.0.7007",
    amount: 2_970_000n,
  };
  const laterCredit = { ...adoptCredit, transactionId: "0.0.8008-1111111112-000000001", transactionHash: Buffer.from(`adopt-later-${ambiguousJourney.id}`).toString("base64"), consensusTimestamp: `${Math.floor(Date.now() / 1000) + 120}.000000001` };
  const thirdCredit = { ...adoptCredit, transactionId: "0.0.8008-1111111113-000000001", transactionHash: Buffer.from(`adopt-third-${ambiguousJourney.id}`).toString("base64"), consensusTimestamp: `${Math.floor(Date.now() / 1000) + 180}.000000001` };
  let adoptCredits = [adoptCredit];
  const adoptMirror = {
    account: async () => ({
      account: "0.0.7007",
      evm_address: account.address,
      ethereum_nonce: 0,
      key: null,
      balance: { balance: 10_000_000, tokens: [{ token_id: recoveryTokenId, balance: 2_970_000 }] },
    }),
    tokenCreditsAfter: async () => adoptCredits,
    ethCall: async () => "0x0",
  };
  const adoptTracker = createProductBridgeTracker({
    store: lifecycle,
    mirrors: { testnet: adoptMirror as any, mainnet: adoptMirror as any },
    transferStatus: async (input) => ({
      provider: input.provider,
      state: "pending",
      sourceTransactionHash: input.sourceTransactionHash,
      destinationTransactionHash: null,
      providerStatus: "ongoing",
      providerUrl: "https://provider.example/adopt",
      observedAt: new Date().toISOString(),
    }),
    tokenTransfersSince: async () => [{ consensusTimestamp: adoptCreditTs, amount: 2_970_000n }],
  });
  const adoptApp = express();
  adoptApp.use(express.json({ limit: "128kb" }));
  adoptApp.use("/v1/product", createProductLifecycleRouter({ store: lifecycle, bridgeTracker: adoptTracker }));
  const adoptBase = await listen(adoptApp);
  // Adoption consent is the owner's EIP-712 signature over the exact hash being
  // bound, not a boolean flag; eth_signTypedData_v4 is the only signing method
  // the product contract permits besides eth_sendTransaction.
  const adoptionTypes = {
    BridgeAdoption: [
      { name: "journeyId", type: "string" },
      { name: "account", type: "address" },
      { name: "sourceTransactionHash", type: "bytes32" },
      { name: "mode", type: "string" },
    ],
  } as const;
  const adoptionConfirmation = (
    journeyId: string,
    sourceTransactionHash: Hex,
    mode: "testnet" | "mainnet" = "testnet",
  ) => account.signTypedData({
    domain: { name: "Refuel402", version: "1", chainId: mode === "mainnet" ? 295 : 296 },
    types: adoptionTypes,
    primaryType: "BridgeAdoption",
    message: { journeyId, account: account.address, sourceTransactionHash, mode },
  });
  const adoptSourceHash = keccak256(stringToHex(`source-adopt-${adoptJourney.id}`));
  const adoptConfirmation = await adoptionConfirmation(adoptJourney.id, adoptSourceHash);
  if (!await verifyTypedData({
    address: account.address,
    domain: { name: "Refuel402", version: "1", chainId: 296 },
    types: adoptionTypes,
    primaryType: "BridgeAdoption",
    message: { journeyId: adoptJourney.id, account: account.address, sourceTransactionHash: adoptSourceHash, mode: "testnet" },
    signature: adoptConfirmation,
  })) throw new Error("adoption consent signature did not verify against the connected account");
  const unsignedAdopt = await request(adoptBase, `/v1/product/journeys/${adoptJourney.id}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: adoptSourceHash, confirm: true }),
  });
  if (unsignedAdopt.response.status !== 400) {
    throw new Error(`bridge adoption accepted a boolean confirmation: ${JSON.stringify(unsignedAdopt.body)}`);
  }
  const adopted = await request(adoptBase, `/v1/product/journeys/${adoptJourney.id}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: adoptSourceHash, confirmation: adoptConfirmation }),
  });
  const adoptedReplay = await request(adoptBase, `/v1/product/journeys/${adoptJourney.id}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: adoptSourceHash, confirmation: adoptConfirmation }),
  });
  const adoptedEvents = (adoptedReplay.body.journey?.events ?? []).map((event: any) => event.type);
  if (
    adopted.response.status !== 200 ||
    adopted.body.journey?.state !== "arrival_confirmed" ||
    adoptedReplay.response.status !== 200 ||
    adoptedEvents.filter((type: string) => type === "bridge_arrived").length !== 1 ||
    !adoptedEvents.includes("bridge_submission_adopted") ||
    !adoptedEvents.includes("bridge_submitted")
  ) {
    throw new Error(`bridge adoption happy path failed: ${JSON.stringify({ adopted: adopted.body, adoptedReplay: adoptedReplay.body })}`);
  }
  // The adopted credit is now bound: with two fresh candidates remaining the
  // second journey must fail closed instead of auto-picking.
  adoptCredits = [adoptCredit, laterCredit, thirdCredit];
  const ambiguousSourceHash = keccak256(stringToHex(`source-adopt-${ambiguousJourney.id}`));
  const ambiguousConfirmation = await adoptionConfirmation(ambiguousJourney.id, ambiguousSourceHash);
  const ambiguousAdopt = await request(adoptBase, `/v1/product/journeys/${ambiguousJourney.id}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: ambiguousSourceHash, confirmation: ambiguousConfirmation }),
  });
  if (ambiguousAdopt.response.status !== 409 || ambiguousAdopt.body.code !== "AMBIGUOUS_CREDIT") {
    throw new Error(`ambiguous adoption did not fail closed: ${JSON.stringify(ambiguousAdopt.body)}`);
  }
  // With exactly one unbound candidate left, adoption binds it.
  adoptCredits = [adoptCredit, laterCredit];
  const disambiguatedAdopt = await request(adoptBase, `/v1/product/journeys/${ambiguousJourney.id}/bridge/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTransactionHash: ambiguousSourceHash, confirmation: ambiguousConfirmation }),
  });
  if (disambiguatedAdopt.response.status !== 200 || disambiguatedAdopt.body.journey?.state !== "arrival_confirmed") {
    throw new Error(`bound-credit exclusion did not disambiguate adoption: ${JSON.stringify(disambiguatedAdopt.body)}`);
  }
  // The bound credit is now exclusive inside the committing transaction: a
  // third journey cannot double-count the arrival the first one adopted.
  const doubleBindQuoteId = "5".repeat(64);
  await lifecycle.saveQuote({ quoteId: doubleBindQuoteId, mode: "testnet", account: account.address, requestedProvider: "axelar", selectedProvider: "axelar", assetId: testnetCfg.assets[0]!.id, originChainId: testnetCfg.originNetworks[0]!.chainId, expiresAt: Math.floor(Date.now() / 1000) + 3600, executable: true, record: { ...happyQuote!, quoteId: doubleBindQuoteId } });
  const doubleBindJourney = await lifecycle.createJourney({ quoteId: doubleBindQuoteId, mode: "testnet", account: account.address, idempotencyKey: "bridge-adopt-double-bind-journey" });
  await lifecycle.recordWalletBoundary({ journeyId: doubleBindJourney.id, kind: "bridge" });
  const doubleBind = await lifecycle.adoptBridgeSubmission({
    journeyId: doubleBindJourney.id,
    sourceTransactionHash: keccak256(stringToHex(`source-adopt-double-${doubleBindJourney.id}`)),
    destinationBalanceBefore: "0",
    hbarBalanceBefore: "10000000",
    credit: {
      transactionId: adoptCredit.transactionId,
      transactionHash: `0x${Buffer.from(adoptCredit.transactionHash, "base64").toString("hex")}`,
      consensusTimestamp: adoptCredit.consensusTimestamp,
      tokenId: adoptCredit.tokenId,
      accountId: adoptCredit.accountId,
      amount: adoptCredit.amount.toString(),
    },
    amountCriterion: "exact",
    provider: "axelar",
    providerState: "pending",
    providerStatus: "ongoing",
    evidence: { candidateCount: 1 },
  }).then(() => "bound").catch((error: any) => error?.code ?? "unexpected");
  if (doubleBind !== "EVIDENCE_CONFLICT") {
    throw new Error(`a destination credit was bound to two journeys of one account: ${doubleBind}`);
  }
  scenarios.bridgeAdopt = {
    journeyId: adoptJourney.id,
    sourceTransactionHash: adoptSourceHash,
    unsignedConfirmationStatus: unsignedAdopt.response.status,
    adoptedState: adopted.body.journey.state,
    replayState: adoptedReplay.body.journey.state,
    ambiguousCode: ambiguousAdopt.body.code,
    boundCreditExcluded: disambiguatedAdopt.body.journey.state === "arrival_confirmed",
    doubleBindCode: doubleBind,
  };

  // Human-paced journey: the destination quote genuinely dies between legs — twice
  // after the x402 fee has already settled — so every sponsored leg must refresh
  // and retry. This is the acceptance proof that a realistically-slow user is not
  // stranded in payment_settled with no HBAR.
  async function pacedJourney(input: { desiredHbar: string; idempotencyKey: string; sourceLabel: string }) {
    clockSkewMs = 0;
    const asset = testnetCfg.assets[0]!;
    const uiRequest = buildCombinedQuoteRequest({
      mode: "testnet",
      account: account.address,
      network: { chainId: testnetCfg.originNetworks[0]!.chainId },
      provider: { id: "axelar", label: "Axelar / Squid" },
      token: { assetId: asset.id, provider: "axelar", address: originToken, decimals: 6, disabled: false, asset },
      amount: "3",
      desiredHbar: input.desiredHbar,
      slippageBps: 100,
    });
    const quoted = await request(productBase, "/v1/product/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(uiRequest),
    });
    if (quoted.response.status !== 200) throw new Error(`paced quote failed: ${JSON.stringify(quoted.body)}`);
    const created = await request(productBase, "/v1/product/journeys", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ mode: "testnet", quoteId: quoted.body.quoteId, account: account.address }),
    });
    if (created.response.status !== 201) throw new Error(`paced journey failed: ${JSON.stringify(created.body)}`);
    const journeyId = created.body.journey.id as string;
    const consent = await sourceLegConsent(journeyId, quoted.body, "testnet");
    await request(productBase, `/v1/product/journeys/${journeyId}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: consent }),
    });
    await authorizeAndSubmit(productBase, "testnet", journeyId, "activation", consent);
    const sourceTransactionHash = keccak256(stringToHex(`${input.sourceLabel}-${journeyId}`));
    await request(productBase, `/v1/product/journeys/${journeyId}/wallet-boundary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "bridge", confirmation: consent }),
    });
    await request(productBase, `/v1/product/journeys/${journeyId}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTransactionHash, confirmation: consent }),
    });
    const arrival = await request(productBase, `/v1/product/journeys/${journeyId}/bridge`);
    if (arrival.body.arrival?.confirmed !== true) throw new Error(`paced arrival failed: ${JSON.stringify(arrival.body)}`);
    const first = await request(productBase, `/v1/product/journeys/${journeyId}/destination-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (first.response.status !== 200) throw new Error(`paced destination quote failed: ${JSON.stringify(first.body)}`);
    return { journeyId, quoted, firstQuote: first.body.quote };
  }

  async function journeyEvents(journeyId: string) {
    const events = await request(productBase, `/v1/product/journeys/${journeyId}/events`);
    return events.body.events as Array<{ id: number; type: string; record: any }>;
  }

  destinationQuoteTtlSec = 60;
  refreshEconomics = "same";
  const paced = await pacedJourney({
    desiredHbar: "11",
    idempotencyKey: "journey-human-paced-fixture-0001",
    sourceLabel: "source-human-paced",
  });
  // Reading the route disclosure and adding the Hedera network in MetaMask.
  clockSkewMs += 75_000;
  const pacedPermit2 = await authorizeAndSubmit(productBase, "testnet", paced.journeyId, "permit2_approval");
  const pacedPayment = await settleExactPayment(paced.journeyId, "11", "payment-human-paced-fixture");
  if (pacedPayment.response.status !== 200) throw new Error(`paced payment failed: ${JSON.stringify(pacedPayment.body)}`);
  // Reviewing the signature, facilitator settlement, and a distracted user.
  clockSkewMs += 130_000;
  const pacedRouterApproval = await authorizeAndSubmit(productBase, "testnet", paced.journeyId, "router_approval");
  // One more stall, and this time the re-simulation comes back strictly better.
  clockSkewMs += 95_000;
  refreshEconomics = "better";
  const pacedRouterExecution = await authorizeAndSubmit(productBase, "testnet", paced.journeyId, "router_execution");
  refreshEconomics = "same";
  const pacedReconciled = await request(productBase, `/v1/product/journeys/${paced.journeyId}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ethereumHash: pacedRouterExecution.ethereumHash }),
  });
  const pacedEvents = await journeyEvents(paced.journeyId);
  const pacedSettledEvent = pacedEvents.find((event) => event.type === "payment_settled")!;
  const pacedRefreshEvents = pacedEvents.filter((event) => event.type === "destination_quote_refreshed");
  const pacedConsented = pacedRefreshEvents.find((event) => event.record.quoteId === pacedSettledEvent?.record?.quoteId);
  const pacedPostPaymentRefreshes = pacedRefreshEvents.filter((event) => event.id > pacedSettledEvent.id);
  const pacedReceipt = pacedReconciled.body.receipt;
  const pacedFinalQuote = pacedRefreshEvents.at(-1)!.record.quote;
  if (
    pacedReconciled.response.status !== 200 ||
    pacedReconciled.body.journey?.state !== "completed" ||
    pacedReceipt?.hbarReceivedTinybar !== "1100000000" ||
    BigInt(pacedReceipt.destinationAssetRemaining) <= BigInt(paced.firstQuote.outcome.minimumRetainedByPolicy) ||
    // Setup intents deliberately use their own authorization runway: the owner
    // already consented to these quote-bound fields and no destination price is
    // consumed yet. Only post-payment execution legs refresh market economics.
    pacedPermit2.refreshedQuoteIds.length !== 0 ||
    pacedRouterApproval.refreshedQuoteIds.length !== 1 ||
    pacedRouterExecution.refreshedQuoteIds.length !== 1 ||
    pacedRefreshEvents.length !== 3 ||
    pacedPostPaymentRefreshes.length !== 2 ||
    !pacedConsented ||
    // Consent preservation: the executed terms are equal or better, never worse.
    BigInt(pacedFinalQuote.amountLedger.destination.swapInputMaximum) > BigInt(pacedConsented.record.quote.amountLedger.destination.swapInputMaximum) ||
    BigInt(pacedFinalQuote.amountLedger.destination.remainingAtMinimum) < BigInt(pacedConsented.record.quote.amountLedger.destination.remainingAtMinimum) ||
    pacedFinalQuote.amountLedger.hbar.exactOutputTinybar !== pacedConsented.record.quote.amountLedger.hbar.exactOutputTinybar ||
    pacedEvents.filter((event) => event.type === "payment_settled").length !== 1 ||
    pacedReconciled.body.journey.authorizations.filter((authorization: any) => authorization.intentKind === "router_execution" && authorization.state === "submitted").length !== 1
  ) {
    throw new Error(`human-paced journey did not survive genuine mid-journey quote expiry: ${JSON.stringify({ reconciled: pacedReconciled.body, refreshes: pacedRefreshEvents.length, postPayment: pacedPostPaymentRefreshes.length })}`);
  }
  scenarios.humanPacedJourney = {
    journeyId: paced.journeyId,
    destinationQuoteLifetimeSec: 60,
    virtualSecondsBetweenLegs: { beforeDestinationConsent: 75, afterPaymentBeforeRouterApproval: 130, beforeRouterExecution: 95 },
    refreshesPerLeg: {
      permit2_approval: pacedPermit2.refreshedQuoteIds.length,
      router_approval: pacedRouterApproval.refreshedQuoteIds.length,
      router_execution: pacedRouterExecution.refreshedQuoteIds.length,
    },
    destinationQuoteRefreshEvents: pacedRefreshEvents.length,
    postPaymentRefreshEvents: pacedPostPaymentRefreshes.length,
    consentedQuoteId: pacedConsented.record.quoteId,
    consentedEconomics: {
      swapInputMaximum: pacedConsented.record.quote.amountLedger.destination.swapInputMaximum,
      minimumRetained: pacedConsented.record.quote.amountLedger.destination.remainingAtMinimum,
      desiredHbarTinybar: pacedConsented.record.quote.amountLedger.hbar.exactOutputTinybar,
    },
    executedEconomics: {
      swapInputMaximum: pacedFinalQuote.amountLedger.destination.swapInputMaximum,
      minimumRetained: pacedFinalQuote.amountLedger.destination.remainingAtMinimum,
      desiredHbarTinybar: pacedFinalQuote.amountLedger.hbar.exactOutputTinybar,
    },
    payments: 1,
    walletPromptsForRefresh: 0,
    receipt: pacedReceipt,
    finalState: pacedReconciled.body.journey.state,
  };

  // Worsened re-quote: the post-consent comparison fails closed, writes nothing,
  // and leaves the journey exactly where a fresh explicit consent can resume it.
  const worsened = await pacedJourney({
    desiredHbar: "12",
    idempotencyKey: "journey-worsened-requote-fixture-0001",
    sourceLabel: "source-worsened-requote",
  });
  await authorizeAndSubmit(productBase, "testnet", worsened.journeyId, "permit2_approval");
  const worsenedPayment = await settleExactPayment(worsened.journeyId, "12", "payment-worsened-requote-fixture");
  if (worsenedPayment.response.status !== 200) throw new Error(`worsened-requote payment failed: ${JSON.stringify(worsenedPayment.body)}`);
  const worsenedBefore = await request(productBase, `/v1/product/journeys/${worsened.journeyId}`);
  const worsenedEventsBefore = await journeyEvents(worsened.journeyId);
  clockSkewMs += 90_000;
  refreshEconomics = "worse";
  const worsenedRefresh = await request(productBase, `/v1/product/journeys/${worsened.journeyId}/destination-quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const worsenedAfter = await request(productBase, `/v1/product/journeys/${worsened.journeyId}`);
  const worsenedEventsAfter = await journeyEvents(worsened.journeyId);
  if (
    worsenedRefresh.response.status !== 409 ||
    worsenedRefresh.body.code !== "QUOTE_ECONOMICS_WORSENED" ||
    worsenedRefresh.body.retriable !== false ||
    !worsenedRefresh.body.details?.consented ||
    !worsenedRefresh.body.details?.refreshed ||
    BigInt(worsenedRefresh.body.details.refreshed.swapInputMaximum) <= BigInt(worsenedRefresh.body.details.consented.swapInputMaximum) ||
    BigInt(worsenedRefresh.body.details.refreshed.minimumRetained) >= BigInt(worsenedRefresh.body.details.consented.minimumRetained) ||
    worsenedEventsAfter.length !== worsenedEventsBefore.length ||
    worsenedAfter.body.journey.state !== worsenedBefore.body.journey.state ||
    worsenedAfter.body.quote.quoteId !== worsenedBefore.body.quote.quoteId
  ) {
    throw new Error(`worsened re-quote was not refused cleanly: ${JSON.stringify({ refresh: worsenedRefresh.body, before: worsenedEventsBefore.length, after: worsenedEventsAfter.length })}`);
  }
  // The refusal is not terminal: an equal-or-better route resumes the same journey.
  refreshEconomics = "same";
  const worsenedRouterApproval = await authorizeAndSubmit(productBase, "testnet", worsened.journeyId, "router_approval");
  const worsenedRouterExecution = await authorizeAndSubmit(productBase, "testnet", worsened.journeyId, "router_execution");
  const worsenedReconciled = await request(productBase, `/v1/product/journeys/${worsened.journeyId}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ethereumHash: worsenedRouterExecution.ethereumHash }),
  });
  if (
    worsenedReconciled.response.status !== 200 ||
    worsenedReconciled.body.journey?.state !== "completed" ||
    worsenedReconciled.body.receipt?.hbarReceivedTinybar !== "1200000000"
  ) {
    throw new Error(`refused re-quote stranded the journey: ${JSON.stringify(worsenedReconciled.body)}`);
  }
  scenarios.quoteEconomicsWorsened = {
    journeyId: worsened.journeyId,
    status: worsenedRefresh.response.status,
    code: worsenedRefresh.body.code,
    details: worsenedRefresh.body.details,
    journeyEventsBefore: worsenedEventsBefore.length,
    journeyEventsAfter: worsenedEventsAfter.length,
    stateUnchanged: worsenedAfter.body.journey.state,
    effectiveQuoteUnchanged: worsenedAfter.body.quote.quoteId === worsenedBefore.body.quote.quoteId,
    resumedRefreshes: worsenedRouterApproval.refreshedQuoteIds.length + worsenedRouterExecution.refreshedQuoteIds.length,
    finalState: worsenedReconciled.body.journey.state,
  };
  clockSkewMs = 0;
  destinationQuoteTtlSec = 300;

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const proof = {
    schema: "refuel402.product-e2e-proof.v1",
    acceptanceLevel: "integration_harness",
    liveProof: false,
    sourceCommit: commit,
    entrypoint: "npm run e2e:product-harness",
    uiContract: {
      routeModes: ["bridge_only", "bridge_plus_refuel"],
      amountInputs: 3,
      editableInputs: ["originAmount", "desiredHbar", "maximumSlippagePercent"],
      outputs: ["destinationBridgedAssetRemaining", "hbarExactOrMinimum", "maximumFeasibleHbar", "limitingConstraint"],
      clientHiddenArithmetic: false,
      explicitMultiHopSlippageConsent: true,
      refreshRecoveryPointer: "owner-scoped local storage only; the journey id is never written to the URL, and automatic resume is limited to a bridge already in flight",
    },
    modes: modeProofs,
    scenarios,
    lifecycle: {
      store: "disposable-postgresql-18",
      finalJourneyState: finalJourney?.state,
      unknownSubmitState: (await lifecycle.getJourney(unknownJourney.id))?.state,
      restartState: (await lifecycle.getJourney(restartJourney.id))?.state,
      expiredPendingState: (await lifecycle.getJourney(expiredPendingJourney.id))?.state,
      livePendingState: (await lifecycle.getJourney(livePendingJourney.id))?.state,
      strandedState: (await lifecycle.getJourney(strandedJourney.id))?.state,
      humanPacedState: (await lifecycle.getJourney(paced.journeyId))?.state,
      worsenedRequoteState: (await lifecycle.getJourney(worsened.journeyId))?.state,
      adoptedState: (await lifecycle.getJourney(adoptJourney.id))?.state,
    },
    sourceRiskModel: {
      maximumConfiguredHbarTinybar: process.env.MAX_REFUEL_TINYBAR,
      maximumConfiguredHbar: "50",
      liveActivationPerformed: false,
      gates: ["sponsor balance", "reserve floor", "per-request exposure", "daily exposure", "active concurrent reservations", "gas allowance", "slippage", "price impact", "minimum retained asset"],
    },
    security: {
      permit2TypedDataDomain: "Permit2",
      proxyBindings: ["payer", "token", "amount", "recipient", "chainId", "nonce", "deadline", "spender", "contextHash"],
      oneTimeReplayProtection: true,
      policyRpcRawMatch: "exact_unsigned_authorization_fields_then_atomic_raw_consumption",
      secretRedaction: true,
    },
    prohibitedSideEffects: {
      externalNetworkCalls: 0,
      liveProviderCalls: 0,
      liveChainTransactions: 0,
      walletPrompts: 0,
      contractDeployments: 0,
      mainnetFundsMoved: 0,
      secretsPersisted: 0,
      executionEnabled: 0,
    },
    evidence: {
      facilitatorHealth: facilitator.readiness(),
      facilitatorSupported: facilitator.supported(),
      proxySettlementCalls: proxyCalls.length,
      sponsoredSimulationCalls: sponsored.length,
      postgresRecovery: scenarios.restartRecovery,
    },
    generatedAt: new Date().toISOString(),
  };
  const proofDir = path.join(root, "proofs", "local");
  fs.mkdirSync(proofDir, { recursive: true });
  const proofPath = path.join(proofDir, "product-e2e-harness.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: true, proof: proofPath, acceptanceLevel: proof.acceptanceLevel, finalState: finalJourney?.state, scenarios: Object.keys(scenarios) }));
} finally {
  await closeServers();
  await postgres?.close().catch(() => undefined);
  if (!externalDatabaseUrl) {
    try { docker("rm", "-f", container); } catch { /* --rm may already have removed it */ }
  }
}
