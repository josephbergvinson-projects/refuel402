import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AmountInvariantError } from "../src/amount-domain.js";
import { bridgeTransferStatus, discoverLayerZeroTransferRoute, normalizeLayerZeroQuote, normalizeSquidQuote } from "../src/bridge.js";
import { composeBridgeOnlyQuote } from "../src/bridge-only-quote.js";
import {
  assessQuoteFairValue,
  composeCombinedQuote,
  quantizationAwarePriceImpactBps,
  rankProviderQuotes,
  saucerQuoteSimulationCaller,
} from "../src/combined-quote.js";
import { createProductQuoteHandler, ProductQuoteBody } from "../src/product-quote.js";
import {
  createPolicyRpcProcessor,
  verifyAuthorizedRawTransaction,
  type PolicyRpcAuthorization,
} from "../src/policy-rpc.js";
import {
  defaultRuntimeGates,
  intersectSupport,
  loadSupportCatalog,
  productOptions,
  probeRuntimeGates,
  type RuntimeSupportGates,
} from "../src/support.js";

const allGates: RuntimeSupportGates = {
  providerQuoteReady: { axelar: true, layerzero: true },
  saucerGraphReady: true,
  quoteSimulationReady: true,
  permit2Ready: true,
  x402ProxyReady: true,
  facilitatorReady: true,
  policyRpcReady: true,
  wrapperReady: true,
  executionModeReady: true,
};

const user = "0x1111111111111111111111111111111111111111" as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pre-activation quote caller", () => {
  it("uses a deployed operational caller rather than the hollow destination user", () => {
    expect(saucerQuoteSimulationCaller({
      SAUCERSWAP_QUOTE_CALLER: "0x2222222222222222222222222222222222222222",
      SPONSOR_EVM_ADDRESS: user,
    })).toBe("0x2222222222222222222222222222222222222222");
    expect(saucerQuoteSimulationCaller({ SPONSOR_EVM_ADDRESS: user })).toBe(user);
    expect(saucerQuoteSimulationCaller({})).toBeUndefined();
  });
});

describe("product quote input contract", () => {
  const valid = {
    mode: "mainnet",
    account: "0x1111111111111111111111111111111111111111",
    provider: "layerzero",
    assetId: "layerzero:mainnet:wbtc",
    originChainId: "1",
    originToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    amountBaseUnits: "10000",
    desiredHbar: "1.25",
    slippageBps: 100,
  };

  it("requires desired HBAR for refuel while allowing an explicit bridge-only route without HBAR", () => {
    expect(ProductQuoteBody.safeParse(valid).success).toBe(true);
    expect(ProductQuoteBody.safeParse({ ...valid, desiredHbar: undefined }).success).toBe(false);
    expect(ProductQuoteBody.safeParse({ ...valid, routeMode: "bridge_only", desiredHbar: undefined }).success).toBe(true);
    expect(ProductQuoteBody.safeParse({ ...valid, desiredHbar: "0.000000001" }).success).toBe(false);
    expect(ProductQuoteBody.safeParse({ ...valid, desiredHbar: "1." }).success).toBe(false);
  });

  it("treats positive HBAR as exact user-selected output with no arbitrary 10-HBAR minimum", () => {
    for (const desiredHbar of ["0.00000001", "0.5", "1", "2", "10", "20", "50"]) {
      expect(ProductQuoteBody.parse({ ...valid, desiredHbar }).desiredHbar).toBe(desiredHbar);
    }
    expect(ProductQuoteBody.parse(valid).solveMaximumHbar).toBe(false);
    expect(ProductQuoteBody.parse({ ...valid, solveMaximumHbar: true }).solveMaximumHbar).toBe(true);
  });

  it("rejects configured-cap violations before provider or journey work and returns the authoritative maximum", async () => {
    vi.stubEnv("MAX_REFUEL_TINYBAR", "500000000");
    const handler = createProductQuoteHandler({ mirrors: { mainnet: {} as never, testnet: {} as never } });
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    await handler({ body: { ...valid, desiredHbar: "6" } } as any, response);
    expect(status).toBe(422);
    expect(body).toMatchObject({
      code: "DESIRED_HBAR_EXCEEDS_MAXIMUM",
      details: { maximumTinybar: "500000000", limitingConstraint: "CONFIGURED_MAX_HBAR" },
    });
  });

  it("rejects an exact output above the route-affordability maximum before saving a journey quote", async () => {
    vi.stubEnv("MAX_REFUEL_TINYBAR", "500000000");
    const combinedQuote = vi.fn(async () => ({
      capabilities: { quote: false, execute: false },
      feasibility: {
        maximumTinybar: "50000000",
        limitingConstraint: "DESTINATION_AFFORDABILITY",
        resolutionTinybar: "1000",
        desiredAssessment: { feasible: false },
      },
      bridge: { provider: "layerzero" },
    }) as any);
    const handler = createProductQuoteHandler({
      mirrors: { mainnet: {} as never, testnet: {} as never },
      runtimeGates: async () => allGates,
      bridgeQuote: async () => ({}) as any,
      combinedQuote,
      saucerCatalog: async (catalog) => catalog,
    });
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    await handler({ body: { ...valid, desiredHbar: "1" } } as any, response);
    expect(status).toBe(422);
    expect(combinedQuote).toHaveBeenCalledOnce();
    expect(combinedQuote).toHaveBeenCalledWith(expect.objectContaining({ solveMaximumHbar: false }));
    expect(body).toMatchObject({
      code: "DESIRED_HBAR_EXCEEDS_MAXIMUM",
      details: {
        desiredTinybar: "100000000",
        maximumTinybar: "50000000",
        limitingConstraint: "DESTINATION_AFFORDABILITY",
        solverResolutionTinybar: "1000",
      },
    });
  });

  it("maps hard amount-invariant violations to a non-retriable 502 instead of a transient 503", async () => {
    const combinedQuote = vi.fn(async () => {
      throw new AmountInvariantError("EXPOSURE_DECOMPOSITION_MISMATCH", "execution exposure decomposition does not reconcile");
    });
    const handler = createProductQuoteHandler({
      mirrors: { mainnet: {} as never, testnet: {} as never },
      runtimeGates: async () => allGates,
      bridgeQuote: async () => ({}) as any,
      combinedQuote,
      saucerCatalog: async (catalog) => catalog,
    });
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    await handler({ body: valid } as any, response);
    expect(status).toBe(502);
    expect(body).toMatchObject({
      code: "QUOTE_DATA_INCONSISTENT",
      retriable: false,
      details: { code: "EXPOSURE_DECOMPOSITION_MISMATCH" },
    });
  });

  it("distinguishes a non-monotonic exact-output route failure from an above-maximum request", async () => {
    vi.stubEnv("MAX_REFUEL_TINYBAR", "500000000");
    const combinedQuote = vi.fn(async () => ({
      capabilities: { quote: false, execute: false },
      feasibility: {
        maximumTinybar: "200000000",
        limitingConstraint: "DESTINATION_AFFORDABILITY",
        resolutionTinybar: "1000",
        desiredAssessment: { feasible: false },
      },
      bridge: { provider: "axelar" },
    }) as any);
    const handler = createProductQuoteHandler({
      mirrors: { mainnet: {} as never, testnet: {} as never },
      runtimeGates: async () => allGates,
      bridgeQuote: async () => ({}) as any,
      combinedQuote,
      saucerCatalog: async (catalog) => catalog,
    });
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    await handler({ body: { ...valid, desiredHbar: "1" } } as any, response);
    expect(status).toBe(422);
    expect(body).toMatchObject({
      code: "DESIRED_HBAR_ROUTE_INFEASIBLE",
      details: {
        desiredTinybar: "100000000",
        maximumTinybar: "200000000",
        limitingConstraint: "DESTINATION_AFFORDABILITY",
      },
    });
  });
});

describe("support intersection", () => {
  it("publishes an editable desired-HBAR default separately from the server policy maximum", () => {
    vi.stubEnv("RECOMMENDED_REFUEL_TINYBAR", "125000000");
    vi.stubEnv("MAX_REFUEL_TINYBAR", "5000000000");
    const options = productOptions("mainnet", allGates);
    expect(options.defaults).toEqual({ routeMode: "bridge_plus_refuel", desiredHbarTinybar: "125000000", desiredHbar: "1.25", slippageBps: 100 });
    expect(options.limits.maximumConfiguredHbarTinybar).toBe("5000000000");
  });

  // The published default is what actually lands in the compose field. At 1 HBAR
  // the near-fixed service fee dwarfs what arrives, so the product introduced
  // itself at its worst possible ratio.
  it("recommends 10 HBAR — the first preset — when no explicit amount is configured", () => {
    vi.stubEnv("RECOMMENDED_REFUEL_TINYBAR", undefined as unknown as string);
    const options = productOptions("mainnet", allGates);
    expect(options.defaults.desiredHbar).toBe("10");
    expect(options.defaults.desiredHbarTinybar).toBe("1000000000");
  });

  it("keeps real testnet provider assets visible while disabling the empty product intersection", () => {
    const options = productOptions("testnet", allGates);
    const axe = options.assets.find((asset) => asset.symbol === "AXE")!;
    expect(axe.runtime.discoverable).toBe(true);
    expect(axe.runtime.quoteReady).toBe(false);
    expect(axe.runtime.executable).toBe(false);
    expect(axe.runtime.blockers).toContain("SAUCER_ROUTE_UNAVAILABLE");
    expect(options.providers.map((provider) => provider.id)).toEqual(["auto", "axelar", "layerzero"]);
    const monad = options.networks.find((network) => network.chainId === "10143")!;
    expect(monad.providerOptions.find((provider) => provider.id === "layerzero")?.runtime.blockers)
      .toContain("PROVIDER_NOT_AVAILABLE_ON_ORIGIN_NETWORK");
  });

  it("keeps bridge-only quote readiness independent of Saucer route and liquidity gates", () => {
    const base = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "USDC.axl")!;
    const thin = {
      ...base,
      quote: false,
      execute: false,
      saucer: { ...base.saucer, status: "below_liquidity_policy" as const, route: [] },
      blockers: ["SAUCER_LIQUIDITY_POLICY"],
    };
    const gates = { ...allGates, saucerGraphReady: false, quoteSimulationReady: false };
    expect(intersectSupport(thin, gates, "bridge_plus_refuel").runtime.quoteReady).toBe(false);
    expect(intersectSupport(thin, gates, "bridge_only").runtime).toMatchObject({
      quoteReady: true,
      executable: true,
      blockers: [],
    });
    const refuel = intersectSupport(thin, allGates, "bridge_plus_refuel");
    expect(refuel.runtime.quoteReady).toBe(false);
    expect(refuel.runtime.executable).toBe(false);
    expect(refuel.runtime.blockers).toContain("SAUCER_LIQUIDITY_POLICY");
  });

  it("lets a liquid runtime route execute refuel and keeps a below-floor route blocked", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:weth")!;
    expect(asset.execute).toBe(false);
    // Stale-pessimistic catalog, liquid hydrated route: the catalog flag alone may not veto forever.
    const hydratedLiquid = { ...asset, quote: true, blockers: [], saucer: { ...asset.saucer, status: "verified" as const } };
    const liquid = intersectSupport(hydratedLiquid, allGates, "bridge_plus_refuel");
    expect(liquid.runtime.quoteReady).toBe(true);
    expect(liquid.runtime.executable).toBe(true);
    // Catalog and runtime both below the floor: hydration keeps the policy blocker.
    const hydratedBelowFloor = {
      ...asset,
      quote: false,
      blockers: ["SAUCER_LIQUIDITY_POLICY"],
      saucer: { ...asset.saucer, status: "below_liquidity_policy" as const },
    };
    const belowFloor = intersectSupport(hydratedBelowFloor, allGates, "bridge_plus_refuel");
    expect(belowFloor.runtime.quoteReady).toBe(false);
    expect(belowFloor.runtime.executable).toBe(false);
    expect(belowFloor.runtime.blockers).toContain("SAUCER_LIQUIDITY_POLICY");
    // bridge_only is unaffected by either Saucer verdict.
    expect(intersectSupport(hydratedLiquid, allGates, "bridge_only").runtime.executable).toBe(true);
    expect(intersectSupport(hydratedBelowFloor, allGates, "bridge_only").runtime.executable).toBe(true);
  });

  it("does not make refuel permanently impossible on a network whose catalog ships execute:false", () => {
    const asset = loadSupportCatalog("testnet").assets[0]!;
    expect(asset.execute).toBe(false);
    const hydrated = {
      ...asset,
      quote: true,
      blockers: [],
      saucer: { ...asset.saucer, status: "verified" as const, route: [{ toToken: asset.destination.address, fee: 3000 }] },
    };
    expect(intersectSupport(hydrated, allGates, "bridge_plus_refuel").runtime.executable).toBe(true);
  });

  it("keeps mainnet USDC.axl statically eligible while deriving current provider gates at runtime", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "USDC.axl")!;
    expect(asset.x402.status).toBe("deployed_verified");
    expect(asset.sponsorship.status).toBe("runtime_gated");
    expect(asset.blockers).toEqual([]);
    expect(intersectSupport(asset, { ...allGates, providerQuoteReady: { axelar: false } }).runtime.quoteReady)
      .toBe(false);
    const state = intersectSupport(asset, allGates);
    expect(state.runtime.quoteReady).toBe(true);
    expect(state.runtime.blockers).toEqual([]);
    expect(state.runtime.executable).toBe(true);
  });

  it("accepts the documented public Mirror contract-call endpoint and HTTPS overrides", () => {
    vi.stubEnv("MAINNET_QUOTE_MIRROR_BASE_URL", "");
    expect(defaultRuntimeGates("mainnet").quoteSimulationReady).toBe(true);
    vi.stubEnv("MAINNET_QUOTE_MIRROR_BASE_URL", "https://mainnet.mirrornode.hedera.com");
    expect(defaultRuntimeGates("mainnet").quoteSimulationReady).toBe(true);
    vi.stubEnv("MAINNET_QUOTE_MIRROR_BASE_URL", "http://unsafe.example");
    expect(defaultRuntimeGates("mainnet").quoteSimulationReady).toBe(false);
  });

  it("does not treat /supported as facilitator readiness while /health is disabled", async () => {
    vi.stubEnv("X402_EVM_FACILITATOR_URL", "http://facilitator.internal:4402");
    const mirror = { rpc: vi.fn(async () => "0x01") };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/health")
      ? new Response(JSON.stringify({ ok: false, verificationReady: false, settlementReady: false }), { status: 503 })
      : new Response(JSON.stringify({ kinds: [{ network: "eip155:296", scheme: "exact" }] }), { status: 200 })));
    await expect(probeRuntimeGates("testnet", mirror as never)).resolves.toMatchObject({ facilitatorReady: false });
  });

  it("keeps quote readiness blocked when no valid HTTPS simulation endpoint is available", () => {
    const catalogAsset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "USDT0")!;
    const asset = { ...catalogAsset, quote: true, blockers: [] };
    const state = intersectSupport(asset, { ...allGates, quoteSimulationReady: false });
    expect(state.runtime.quoteReady).toBe(false);
    expect(state.runtime.blockers).toContain("MIRROR_QUOTE_ENDPOINT_NOT_CONFIGURED");
    expect(state.runtime.executable).toBe(false);
  });

  it("makes the verified direct WBTC route quote-ready without stale catalog blockers", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:wbtc")!;
    const state = intersectSupport(asset, allGates);
    expect(asset.blockers).toEqual([]);
    expect(state.runtime.quoteReady).toBe(true);
    expect(state.runtime.blockers).toEqual([]);
    expect(state.runtime.executable).toBe(true);
  });

  it("makes the official direct USDT0 route executable while retaining high-severity token-authority disclosures", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:usdt0")!;
    const state = intersectSupport(asset, allGates);
    expect(asset.blockers).toEqual([]);
    expect(asset.riskDisclosures).toEqual([
      expect.objectContaining({ code: "TOKEN_ADMIN_KEY_PRESENT", severity: "high" }),
      expect.objectContaining({ code: "TOKEN_FREEZE_KEY_PRESENT", severity: "high" }),
    ]);
    expect(state.runtime).toMatchObject({ quoteReady: true, executable: true, blockers: [] });
  });

  it("admits the route-specific permissionless native ETH Stargate adapter without a Value Transfer credential", () => {
    vi.stubEnv("LAYERZERO_TRANSFER_API_KEY", "");
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:weth")!;
    const state = intersectSupport({ ...asset, quote: true, blockers: [] }, allGates, "bridge_only");
    expect(state.runtime).toMatchObject({ quoteReady: true, executable: true, blockers: [] });
  });

  it("names provider API authorization when a LayerZero asset has neither a permissionless route nor a configured credential", () => {
    vi.stubEnv("LAYERZERO_TRANSFER_API_KEY", "");
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "layerzero:mainnet:weth")!;
    const state = intersectSupport({
      ...asset,
      quote: true,
      blockers: [],
      originTokens: [{ ...asset.originTokens![0]!, address: getAddress("0x1111111111111111111111111111111111111111") }],
    }, allGates);
    expect(state.runtime.quoteReady).toBe(false);
    expect(state.runtime.executable).toBe(false);
    expect(state.runtime.blockers).toContain("PROVIDER_API_AUTHORIZATION_REQUIRED");
  });

  it("derives the mainnet execution-mode blocker without storing it in the static catalog", () => {
    const catalog = loadSupportCatalog("mainnet");
    const staleRuntimeCodes = new Set([
      "PROVIDER_QUOTE_REQUIRED",
      "SAUCER_QUOTER_CURRENT_PROBE_FAILED",
      "PERMIT2_NOT_DEPLOYED",
      "X402_PROXY_NOT_DEPLOYED",
      "POLICY_RPC_NOT_LIVE_PROVEN",
      "WRAPPER_EXECUTION_NOT_LIVE_PROVEN",
      "MAINNET_EXECUTION_DISABLED",
    ]);
    expect(catalog.assets.every((asset) => asset.blockers.every((code) => !staleRuntimeCodes.has(code))))
      .toBe(true);
    const asset = catalog.assets.find((row) => row.symbol === "USDC.axl")!;
    const state = intersectSupport(asset, { ...allGates, executionModeReady: false });
    expect(state.runtime.blockers).toContain("MAINNET_EXECUTION_DISABLED");
    expect(state.runtime.executable).toBe(false);
  });

  it("keeps ERC20-wrapper assets blocked until wrapper execution is proven", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "WETH")!;
    const state = intersectSupport(asset, { ...allGates, wrapperReady: false });
    expect(state.runtime.blockers).toContain("WRAPPER_EXECUTION_NOT_LIVE_PROVEN");
    expect(state.runtime.executable).toBe(false);
  });

  it("does not promote a quote-ready asset whose execution adapter remains unproven", () => {
    const catalogAsset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "USDT0")!;
    const asset = {
      ...catalogAsset,
      quote: true,
      blockers: ["PROVIDER_EXECUTION_ADAPTER_NOT_PROVEN"],
    };
    const state = intersectSupport(asset, allGates);
    expect(state.runtime.quoteReady).toBe(true);
    expect(state.runtime.blockers).toContain("PROVIDER_EXECUTION_ADAPTER_NOT_PROVEN");
    expect(state.runtime.executable).toBe(false);
  });
});

describe("bridge normalization", () => {
  it("discovers the official public native-ETH to Hedera-WETH route before the credentialed quote boundary", async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toContain("transferrableFromChainKey=ethereum");
      expect(url.toLowerCase()).toContain("transferrablefromtokenaddress=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      return new Response(JSON.stringify({ tokens: [{
        isSupported: true,
        chainKey: "hedera",
        address: "0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2",
        symbol: "WETH",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(discoverLayerZeroTransferRoute({
      originChainId: "1",
      originToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      mode: "mainnet",
      destinationToken: "0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2",
    }, fetcher as typeof fetch)).resolves.toMatchObject({
      sourceChainKey: "ethereum",
      destinationChainKey: "hedera",
      destinationSymbol: "WETH",
    });
  });

  it("tracks permissionless Stargate native quotes through public LayerZero Scan rather than the credentialed status API", async () => {
    const sourceTransactionHash = `0x${"12".repeat(32)}` as const;
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toContain(`/messages/tx/${sourceTransactionHash}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(bridgeTransferStatus({
      mode: "mainnet",
      provider: "layerzero",
      quoteId: `direct-stargate-${"a".repeat(64)}`,
      sourceTransactionHash,
      originChainId: "1",
    })).resolves.toMatchObject({
      provider: "layerzero",
      state: "pending",
      providerStatus: "not_found",
      sourceTransactionHash,
      providerUrl: `https://layerzeroscan.com/tx/${sourceTransactionHash}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("forces the same MetaMask account into Squid bridge sender and destination", () => {
    const asset = loadSupportCatalog("mainnet").assets[0]!;
    const quote = normalizeSquidQuote(
      {
        mode: "mainnet",
        provider: "axelar",
        originChainId: "1",
        originToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amount: 1_000_000n,
        account: user,
        asset,
        slippageBps: 100,
      },
      {
        route: {
          quoteId: "provider-quote",
          estimate: {
            toAmount: "995000",
            toAmountMin: "985000",
            estimatedRouteDuration: 180,
            feeCosts: [{ name: "bridge fee", amount: "5000", amountUSD: 0.005, token: { symbol: "USDC" } }],
          },
          transactionRequest: {
            target: "0x2222222222222222222222222222222222222222",
            data: "0x1234",
            value: "0",
          },
        },
      },
    );
    expect(quote.fromAddress).toBe(user);
    expect(quote.toAddress).toBe(user);
    expect(quote.expectedDestinationAmount).toBe("995000");
    expect(quote.fees[0]).toMatchObject({ payer: "user", symbol: "USDC" });
  });

  it("normalizes Squid's 18-decimal LCX quote domain into chain-authoritative 6-decimal HTS units", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "axelar:mainnet:lcx")!;
    const quote = normalizeSquidQuote({
      mode: "mainnet",
      provider: "axelar",
      originChainId: "1",
      originToken: getAddress(asset.originTokens![0]!.address),
      amount: 40_000_000_000_000_000_000n,
      account: user,
      asset,
      slippageBps: 100,
    }, {
      route: {
        quoteId: "lcx-provider-quote",
        estimate: { toAmount: "40000000000000000000", toAmountMin: "39600000000000000000" },
        transactionRequest: { target: "0x2222222222222222222222222222222222222222", data: "0x1234", value: "0" },
      },
    });
    expect(quote.expectedDestinationAmount).toBe("40000000");
    expect(quote.minimumDestinationAmount).toBe("39600000");
    expect(quote.normalized.destinationAmountNormalization).toEqual({
      providerDecimals: 18,
      destinationDecimals: 6,
      expectedProviderBaseUnits: "40000000000000000000",
      minimumProviderBaseUnits: "39600000000000000000",
      rounding: "floor_toward_zero",
    });
  });

  it("normalizes official native-ETH to Hedera-WETH Value Transfer steps without ERC20 approval", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "WETH")!;
    const quote = normalizeLayerZeroQuote(
      {
        mode: "mainnet",
        provider: "layerzero",
        originChainId: "1",
        originToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        amount: 1_000_000_000_000_000_000n,
        account: user,
        asset,
        slippageBps: 100,
      },
      {
        quotes: [{
          id: "lz-quote",
          routeSteps: [{ type: "STARGATE_V2_TAXI", srcChainKey: "ethereum" }],
          fees: [{ type: "MESSAGE", amount: "100", description: "message fee" }],
          duration: { estimated: "30000" },
          feeUsd: "0.20",
          srcAmount: "1000000000000000000",
          dstAmount: "990000000000000000",
          dstAmountMin: "980000000000000000",
          userSteps: [
            {
              type: "TRANSACTION", description: "bridge", chainKey: "ethereum", signerAddress: user,
              transaction: { encoded: { chainId: 1, from: user, to: "0x2222222222222222222222222222222222222222", data: "0xabcd", value: "1000000000000000100" } },
            },
          ],
        }],
      },
    );
    expect(quote.source).toBe("layerzero-value-transfer");
    expect(quote.userSteps).toHaveLength(1);
    expect(quote.originToken).toBe("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    expect(quote.originApproval).toBeNull();
    expect(quote.transaction).toMatchObject({
      to: "0x2222222222222222222222222222222222222222",
      value: "1000000000000000100",
    });
    expect(quote.estimatedSeconds).toBe(30);
  });

  it("rejects a LayerZero quote outside the reviewed OFT/Stargate route classes", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.symbol === "WETH")!;
    expect(() => normalizeLayerZeroQuote({
      mode: "mainnet",
      provider: "layerzero",
      originChainId: "1",
      originToken: asset.originTokens![0]!.address,
      amount: 1n,
      account: user,
      asset,
      slippageBps: 100,
    }, {
      quotes: [{ id: "intent-only", routeSteps: [{ type: "AORI", srcChainKey: "ethereum" }] }],
    })).toThrow("no transfer quote");
  });
});

describe("combined quote", () => {
  it("does not misclassify low-decimal exact-output rounding as economic price impact", () => {
    expect(quantizationAwarePriceImpactBps({
      amountIn: 74n,
      amountOut: 100_000_000n,
      referenceAmountIn: 7n,
      referenceAmountOut: 10_000_000n,
    })).toBe(0);
    expect(quantizationAwarePriceImpactBps({
      amountIn: 90n,
      amountOut: 100_000_000n,
      referenceAmountIn: 7n,
      referenceAmountOut: 10_000_000n,
    })).toBeGreaterThan(1_000);
  });

  it("composes a bridge-only quote with no HBAR claim or Saucer dependency", () => {
    const asset = loadSupportCatalog("mainnet").assets.find((row) => row.id === "axelar:mainnet:usdc")!;
    const runtimeAsset = intersectSupport(asset, allGates, "bridge_only");
    const bridge = normalizeSquidQuote({
      mode: "mainnet",
      provider: "axelar",
      originChainId: "1",
      originToken: asset.originTokens![0]!.address,
      amount: 3_000_000n,
      account: user,
      asset,
      slippageBps: 100,
    }, {
      route: {
        quoteId: "bridge-only-provider-quote",
        estimate: { toAmount: "3000000", toAmountMin: "2970000", estimatedRouteDuration: 180, feeCosts: [] },
        transactionRequest: { target: "0x2222222222222222222222222222222222222222", data: "0x1234", value: "0" },
      },
    });
    const result = composeBridgeOnlyQuote({
      mode: "mainnet",
      requestedProvider: "auto",
      supportEvidenceAt: "2026-07-25T00:00:00Z",
      account: user,
      asset,
      runtimeAsset,
      bridge,
    });
    expect(result).toMatchObject({
      schema: "refuel402.product-quote.v2",
      routeMode: "bridge_only",
      destination: { hbarOutput: { kind: "unavailable", minimumTinybar: "0" }, routePresentation: null },
      outcome: { minimumArrival: "2970000", retainedAtMinimumArrival: "2970000", hbarMinimumTinybar: "0" },
      consent: { refuelConsentRequired: false },
      capabilities: { quote: true, execute: true },
    });
    expect(result.consent).not.toHaveProperty("slippageConsentRequired");
    expect(result.amountLedger.allInvariantsHold).toBe(true);
  });

  it("composes bridge, destination, x402, retained amount, and payer ledger", () => {
    const asset = loadSupportCatalog("mainnet").assets[0]!;
    const runtimeAsset = intersectSupport(asset, allGates);
    const input: Parameters<typeof composeCombinedQuote>[0] = {
      mode: "mainnet",
      requestedProvider: "auto",
      supportEvidenceAt: "2026-07-21T00:00:00Z",
      account: user,
      asset,
      runtimeAsset,
      bridge: {
        provider: "axelar",
        providerLabel: "Axelar / Squid",
        quoteId: "q1",
        originChainId: "1",
        destinationChainId: 295,
        fromAddress: user,
        toAddress: user,
        originToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        destinationToken: asset.destination.address,
        fromAmount: "10000000",
        expectedDestinationAmount: "9950000",
        minimumDestinationAmount: "9900000",
        estimatedSeconds: 180,
        fees: [],
        normalized: {
          sourceAmount: { amount: "10000000", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
          destinationAsset: { address: asset.destination.address, tokenId: asset.destination.tokenId ?? null, standard: asset.destination.standard, decimals: asset.destination.decimals, symbol: asset.symbol },
          slippage: { requestedBps: 100, expectedDestinationAmount: "9950000", minimumDestinationAmount: "9900000" },
          evidence: { source: "squid-v2", quoteId: "q1", routeId: "q1", observedAt: "2026-07-22T00:00:00Z", responseHash: "fixture" },
        },
        originApproval: null,
        transaction: null,
        userSteps: [],
        expiresAt: 1_900_000_000,
        source: "squid-v2",
      },
      desiredHbarTinybar: 500_000_000n,
      slippageBps: 100,
      saucer: {
        amountIn: 330_000n,
        amountInMaximum: 333_300n,
        paymentAssetAmountInMaximum: 333_300n,
        gasEstimate: 160_000n,
        priceImpactBps: 25,
        apiEvidence: {
          graphHash: "c".repeat(64),
          selectedRoute: {
            venue: "v2",
            executionScope: "venue_aware_exact_output",
            routeId: "v2:0.0.9001",
            tokens: [asset.destination.address, "0x0000000000000000000000000000000000163b5a"],
            fees: [1500],
            amountIn: "330000",
            amountOutTinybar: "500000000",
            perHopAmountsAvailable: false,
            simulatedAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2026-07-26T00:05:00.000Z",
            hops: [{
              index: 0,
              venue: "v2",
              input: { tokenId: asset.destination.tokenId, address: asset.destination.address, symbol: asset.symbol },
              output: { tokenId: "0.0.1456986", address: "0x0000000000000000000000000000000000163b5a", symbol: "WHBAR" },
              pool: { id: "0.0.9001", contractId: "0.0.9001" },
              feeTier: 1500,
              feeBps: 15,
              liquidityUsd: 25_000,
            }],
            discovery: { v1PoolCount: 10, v2PoolCount: 20, v1DiscoveryOnly: true },
          },
        } as any,
        simulatedAtMs: Date.now(),
        expiresAtMs: 1_900_000_000_000,
      },
      x402: {
        feeAmount: 20_000n,
        feeUsd: 0.02,
        maxSponsorExposureTinybar: 10_000_000n,
        componentsTinybar: {
          gasAllowance: 5_000_000n,
          hapiReserve: 3_000_000n,
          failedAttemptReserve: 1_000_000n,
          operatingMargin: 1_000_000n,
        },
        expiresAt: 1_900_000_000,
      },
      minimumRetainedBps: 500,
    };
    const quote = composeCombinedQuote(input);
    const explicit = composeCombinedQuote({ ...input, requestedProvider: "axelar" });
    const differentDesired = composeCombinedQuote({ ...input, desiredHbarTinybar: 400_000_000n });
    expect(explicit.quoteId).not.toBe(quote.quoteId);
    expect(differentDesired.quoteId).not.toBe(quote.quoteId);
    expect(quote.x402.contextHash).toBe(`0x${quote.quoteId}`);
    expect(quote.destination.desiredHbarTinybar).toBe("500000000");
    expect(quote.expiresAt).toBe(Math.min(input.bridge.expiresAt, input.x402.expiresAt, Math.floor(input.saucer.expiresAtMs / 1000)));
    expect(quote.providerSelection).toMatchObject({ requested: "auto", selected: "axelar" });
    expect(quote.support).toMatchObject({ assetId: asset.id, originChainId: "1" });
    expect(quote.sameAddress.valid).toBe(true);
    expect(quote.outcome.maximumDebit).toBe("353300");
    expect(quote.outcome.retainedAtMinimumArrival).toBe("9546700");
    expect(quote.x402.transferMethod).toBe("permit2");
    expect(quote.costLedger.entries.map((row) => row.fundingSource)).toContain("sponsor");
    expect(quote.destination.routePresentation).toMatchObject({
      scope: "saucer_venue_aware_exact_output",
      summary: expect.stringMatching(/Saucer V2 0\.15%.*HBAR/),
      disclosure: expect.stringMatching(/V1 and V2 candidates/),
      hops: [expect.objectContaining({ pool: { id: "0.0.9001", contractId: "0.0.9001" } })],
    });
    expect(quote.capabilities.acceptanceLevel).toBe("integration_harness");
    const stale = composeCombinedQuote({
      ...input,
      saucer: { ...input.saucer, expiresAtMs: Date.now() - 1 },
    });
    expect(stale.blockers).toContain("STALE_QUOTE");
    expect(stale.capabilities.execute).toBe(false);
    expect(stale.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("ranks Auto provider quotes by retained output, then fee and ETA", () => {
    const ranked = rankProviderQuotes([
      {
        bridge: { provider: "axelar", estimatedSeconds: 120 },
        outcome: { retainedAtMinimumArrival: "900" },
        x402: { feeUsd: 0.01 },
      },
      {
        bridge: { provider: "layerzero", estimatedSeconds: 60 },
        outcome: { retainedAtMinimumArrival: "1000" },
        x402: { feeUsd: 0.02 },
      },
    ]);
    expect(ranked.map((quote) => quote.bridge.provider)).toEqual(["layerzero", "axelar"]);
  });

  it("rejects a bridge quote that drifts from the connected account", () => {
    const asset = loadSupportCatalog("mainnet").assets[0]!;
    expect(() => composeCombinedQuote({
      mode: "mainnet",
      requestedProvider: "axelar",
      supportEvidenceAt: "2026-07-21T00:00:00Z",
      account: user,
      asset,
      runtimeAsset: intersectSupport(asset, allGates),
      bridge: {
        provider: "axelar", providerLabel: "Axelar", quoteId: null,
        originChainId: "1", destinationChainId: 295, fromAddress: user,
        toAddress: "0x2222222222222222222222222222222222222222",
        originToken: user, destinationToken: asset.destination.address,
        fromAmount: "1", expectedDestinationAmount: "1", minimumDestinationAmount: "1",
        estimatedSeconds: null,
        fees: [],
        normalized: {
          sourceAmount: { amount: "1", token: user, decimals: 6, symbol: "USDC" },
          destinationAsset: { address: asset.destination.address, tokenId: asset.destination.tokenId ?? null, standard: asset.destination.standard, decimals: asset.destination.decimals, symbol: asset.symbol },
          slippage: { requestedBps: 1, expectedDestinationAmount: "1", minimumDestinationAmount: "1" },
          evidence: { source: "squid-v2", quoteId: null, routeId: null, observedAt: "2026-07-22T00:00:00Z", responseHash: "fixture" },
        },
        originApproval: null, transaction: null, userSteps: [], expiresAt: 2_000_000_000, source: "squid-v2",
      },
      desiredHbarTinybar: 1n, slippageBps: 1,
      saucer: {
        amountIn: 0n,
        amountInMaximum: 0n,
        paymentAssetAmountInMaximum: 0n,
        gasEstimate: 0n,
        priceImpactBps: 0,
        simulatedAtMs: Date.now(),
        expiresAtMs: 2_000_000_000_000,
      },
      x402: { feeAmount: 0n, feeUsd: 0, maxSponsorExposureTinybar: 0n, componentsTinybar: {}, expiresAt: 2_000_000_000 },
      minimumRetainedBps: 0,
    })).toThrow("must equal the connected MetaMask account");
  });
});

describe("combined quote execution gates", () => {
  beforeEach(() => {
    vi.stubEnv("X402_PAYMENT_RECIPIENT", "0x3333333333333333333333333333333333333333");
  });
  const asset = loadSupportCatalog("mainnet").assets[0]!;
  const gateEvidence = (minimumLiquidityUsd: number | null) => ({
    graphHash: "d".repeat(64),
    liquidityDisclosureThresholdUsd: 20_000,
    selectedRoute: {
      venue: "v2",
      executionScope: "venue_aware_exact_output",
      routeId: "v2:0.0.9001",
      tokens: [asset.destination.address, "0x0000000000000000000000000000000000163b5a"],
      fees: [1500],
      minimumLiquidityUsd,
      amountIn: "330000",
      amountOutTinybar: "500000000",
      perHopAmountsAvailable: false,
      simulatedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-07-26T00:05:00.000Z",
      hops: [{
        index: 0,
        venue: "v2",
        input: { tokenId: asset.destination.tokenId, address: asset.destination.address, symbol: asset.symbol },
        output: { tokenId: "0.0.1456986", address: "0x0000000000000000000000000000000000163b5a", symbol: "WHBAR" },
        pool: { id: "0.0.9001", contractId: "0.0.9001" },
        feeTier: 1500,
        feeBps: 15,
        liquidityUsd: minimumLiquidityUsd,
      }],
      discovery: { v1PoolCount: 10, v2PoolCount: 20, v1DiscoveryOnly: true },
    },
  }) as any;
  const gateInput = (
    apiEvidence: unknown,
    fairValue?: Parameters<typeof composeCombinedQuote>[0]["fairValue"],
  ): Parameters<typeof composeCombinedQuote>[0] => ({
    mode: "mainnet",
    requestedProvider: "axelar",
    supportEvidenceAt: "2026-07-27T00:00:00Z",
    account: user,
    asset,
    runtimeAsset: intersectSupport(asset, allGates),
    bridge: {
      provider: "axelar",
      providerLabel: "Axelar / Squid",
      quoteId: "gate-quote",
      originChainId: "1",
      destinationChainId: 295,
      fromAddress: user,
      toAddress: user,
      originToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      destinationToken: asset.destination.address,
      fromAmount: "10000000",
      expectedDestinationAmount: "9950000",
      minimumDestinationAmount: "9900000",
      estimatedSeconds: 180,
      fees: [],
      normalized: {
        sourceAmount: { amount: "10000000", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
        destinationAsset: { address: asset.destination.address, tokenId: asset.destination.tokenId ?? null, standard: asset.destination.standard, decimals: asset.destination.decimals, symbol: asset.symbol },
        slippage: { requestedBps: 100, expectedDestinationAmount: "9950000", minimumDestinationAmount: "9900000" },
        evidence: { source: "squid-v2", quoteId: "gate-quote", routeId: "gate-quote", observedAt: "2026-07-27T00:00:00Z", responseHash: "fixture" },
      },
      originApproval: null,
      // These gates are about liquidity and fair value, not about whether the
      // provider returned something to send. The fixture left this null while
      // asserting `execute: true`, which is the state the capability now refuses:
      // a route with nothing to broadcast used to clear the client to create a
      // journey and pay for a Hedera activation before discovering it.
      transaction: { to: "0x2222222222222222222222222222222222222222", data: "0xabcd", value: "0" },
      userSteps: [],
      expiresAt: 1_900_000_000,
      source: "squid-v2",
    },
    desiredHbarTinybar: 500_000_000n,
    slippageBps: 100,
    saucer: {
      amountIn: 330_000n,
      amountInMaximum: 333_300n,
      paymentAssetAmountInMaximum: 333_300n,
      gasEstimate: 160_000n,
      priceImpactBps: 25,
      apiEvidence: apiEvidence as never,
      simulatedAtMs: Date.now(),
      expiresAtMs: 1_900_000_000_000,
    },
    x402: {
      feeAmount: 20_000n,
      feeUsd: 0.02,
      maxSponsorExposureTinybar: 10_000_000n,
      componentsTinybar: {},
      expiresAt: 1_900_000_000,
    },
    fairValue,
    minimumRetainedBps: 500,
  });

  it("keeps a below-floor selected route quotable but never executable", () => {
    const gated = composeCombinedQuote(gateInput(gateEvidence(500)));
    expect(gated.blockers).toContain("SAUCER_LIQUIDITY_POLICY");
    expect(gated.capabilities.quote).toBe(true);
    expect(gated.capabilities.execute).toBe(false);
    const liquid = composeCombinedQuote(gateInput(gateEvidence(25_000)));
    expect(liquid.blockers).not.toContain("SAUCER_LIQUIDITY_POLICY");
    expect(liquid.capabilities.execute).toBe(true);
    const unknownLiquidity = composeCombinedQuote(gateInput(gateEvidence(null)));
    expect(unknownLiquidity.blockers).toContain("SAUCER_LIQUIDITY_POLICY");
  });

  // A clean blocker list is not enough: a route the provider could not build a
  // transaction for has nothing to send. Clearing it for execution let the client
  // create a journey and pay for a Hedera activation, and only then fail — with no
  // wallet prompt ever raised and the journey left permanently unsendable. The
  // bridge-only path already required this; the combined path did not.
  it("refuses execution when the provider returned no transaction to broadcast", () => {
    const input = gateInput(gateEvidence(25_000));
    const nothingToSend = composeCombinedQuote({ ...input, bridge: { ...input.bridge, transaction: null } });
    expect(nothingToSend.blockers).not.toContain("SAUCER_LIQUIDITY_POLICY");
    expect(nothingToSend.capabilities.quote).toBe(true);
    expect(nothingToSend.capabilities.execute).toBe(false);
  });

  it("trips the fair-value deviation gate and emits both price sources in the destination evidence", () => {
    const tripped = assessQuoteFairValue({
      amountIn: 1_200_000n,
      tokenDecimals: 6,
      desiredHbarTinybar: 1_000_000_000n,
      tokenPriceUsd: 1,
      hbarUsd: 0.1,
    });
    expect(tripped).toMatchObject({ status: "verified", deviationBps: 1_667, maximumDeviationBps: 300 });
    const quote = composeCombinedQuote(gateInput(gateEvidence(25_000), tripped));
    expect(quote.blockers).toContain("SAUCER_FAIR_VALUE_DEVIATION");
    expect(quote.capabilities.quote).toBe(true);
    expect(quote.capabilities.execute).toBe(false);
    expect(quote.destination.fairValue).toMatchObject({
      status: "verified",
      deviationBps: 1_667,
      tokenPriceUsd: 1,
      hbarUsd: 0.1,
    });
  });

  it("passes an on-market quote and skips the gate without fabrication when price evidence is missing", () => {
    const aligned = assessQuoteFairValue({
      amountIn: 1_000_000n,
      tokenDecimals: 6,
      desiredHbarTinybar: 1_000_000_000n,
      tokenPriceUsd: 1,
      hbarUsd: 0.1,
    });
    expect(aligned).toMatchObject({ status: "verified", deviationBps: 0 });
    expect(composeCombinedQuote(gateInput(gateEvidence(25_000), aligned)).blockers)
      .not.toContain("SAUCER_FAIR_VALUE_DEVIATION");
    const unpriced = assessQuoteFairValue({
      amountIn: 1_000_000n,
      tokenDecimals: 6,
      desiredHbarTinybar: 1_000_000_000n,
      tokenPriceUsd: null,
      hbarUsd: 0.1,
    });
    expect(unpriced.status).toBe("fair_value_unverified");
    const quote = composeCombinedQuote(gateInput(gateEvidence(25_000), unpriced));
    expect(quote.blockers).not.toContain("SAUCER_FAIR_VALUE_DEVIATION");
    expect(quote.capabilities.execute).toBe(true);
    expect(quote.destination.fairValue).toMatchObject({ status: "fair_value_unverified" });
  });
});

describe("policy RPC", () => {
  it("binds sponsored raw transactions to exact immutable authorization fields", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const raw = await account.signTransaction({
      chainId: 296,
      type: "eip1559",
      nonce: 0,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    const authorization: PolicyRpcAuthorization = {
      id: "auth-1",
      mode: "testnet",
      account: account.address,
      chainId: 296,
      nonce: 0,
      to: "0x2222222222222222222222222222222222222222",
      dataHash: keccak256("0x1234"),
      value: 0n,
      gasLimitMaximum: 100_000n,
      maxGasAllowanceTinybar: 10_000_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    await expect(verifyAuthorizedRawTransaction(raw, authorization)).resolves.toBeUndefined();
    await expect(verifyAuthorizedRawTransaction(raw, { ...authorization, nonce: 1 })).rejects.toThrow("nonce mismatch");

    const submit = vi.fn(async () => ({ ethereumHash: keccak256(raw) }));
    const process = createPolicyRpcProcessor({
      upstreams: { testnet: "https://testnet.hashio.io/api", mainnet: "https://mainnet.hashio.io/api" },
      authorizer: { consume: vi.fn(async () => authorization) },
      submitter: { testnet: { submit } },
    });
    const result = await process("testnet", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [raw],
    });
    expect(result).toMatchObject({ result: keccak256(raw) });
    expect(submit).toHaveBeenCalledWith(raw, 10_000_000n);
  });

  it("fails closed when write authorization is not wired", async () => {
    const process = createPolicyRpcProcessor({
      upstreams: { testnet: "https://testnet.hashio.io/api", mainnet: "https://mainnet.hashio.io/api" },
    });
    const result = await process("testnet", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: ["0x1234"],
    });
    expect(result).toMatchObject({ error: { code: -32004 } });
  });
});
