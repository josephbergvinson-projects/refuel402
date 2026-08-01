import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { hasLayerZeroDirectRoute, hasLayerZeroDirectRouteForAsset } from "./layerzero-oft.js";
import type { Mirror } from "./mirror.js";

export type ProductMode = "testnet" | "mainnet";
export type ProductRouteMode = "bridge_only" | "bridge_plus_refuel";
export type ProviderId = "axelar" | "layerzero";
export type ProviderSelectionId = "auto" | ProviderId;
export type ArrivalMode = "arrival_auto_create_proven" | "activation_required" | "arrival_unproven";

export type ProductProviderOption = {
  id: ProviderSelectionId;
  label: string;
  description: string;
  strategy: "best_eligible_quote" | "explicit";
};

export type NetworkProviderOption = ProductProviderOption & {
  assetIds: string[];
  runtime: ProductRouteRuntime;
  routeModes: Record<ProductRouteMode, ProductRouteRuntime>;
};

export type OriginNetwork = {
  chainId: string;
  providerChain?: string;
  name: string;
  icon: string;
  // Block-explorer origin for this chain, e.g. "https://etherscan.io". Declared in
  // config/support.*.json rather than inferred from the chain id, so a transaction
  // link is only ever built from a URL somebody wrote down on purpose. Absent means
  // no link is offered — never a guessed one.
  explorer?: string;
  providers: ProviderId[];
  discoveryStatus: string;
};

export type SupportAsset = {
  id: string;
  provider: ProviderId;
  providerLabel: string;
  comparisonGroup?: string;
  symbol: string;
  name: string;
  icon: string;
  originNetworks: string[];
  originTokens?: {
    chainId: string;
    address: Address;
    decimals: number;
    symbol: string;
    name: string;
    icon?: string;
    native?: boolean;
  }[];
  destination: {
    standard: "HTS" | "ERC20";
    tokenId?: string;
    address: Address;
    decimals: number;
    /** Decimal domain used by the provider quote before chain-authoritative destination normalization. */
    providerAmountDecimals?: number;
    arrival: ArrivalMode;
    wrapper?: {
      contractId: string;
      address: Address;
      htsTokenId: string;
      htsAddress: Address;
      htsDecimals: number;
      rate: string;
    };
  };
  saucer: {
    status: "verified" | "no_route" | "below_liquidity_policy";
    route: {
      toToken: Address;
      fee: number;
      venue?: "v1" | "v2";
      poolId?: string;
      contractId?: string;
    }[];
    quotedAmountInAt50Hbar?: string;
    gasEstimate?: string;
    evidence?: string;
  };
  x402: { transferMethod: "permit2"; status: string };
  sponsorship: { status: string };
  discovery: boolean;
  quote: boolean;
  execute: boolean;
  blockers: string[];
  riskDisclosures?: {
    code: string;
    severity: "low" | "medium" | "high";
    message: string;
  }[];
};

export type SupportCatalog = {
  schema: "refuel402.support-catalog.v1";
  mode: ProductMode;
  evidenceAt: string;
  saucerEvidence?: {
    status: "verified_complete_graph";
    source: string;
    graphHash: string;
    fetchedAt: string;
    v1PoolCount: number;
    v2PoolCount: number;
  };
  hedera: {
    chainId: number;
    caip2: string;
    name: string;
    icon: string;
  };
  originNetworks: OriginNetwork[];
  assets: SupportAsset[];
};

export type RuntimeSupportGates = {
  providerQuoteReady: Partial<Record<ProviderId, boolean>>;
  providerBlockers?: Partial<Record<ProviderId, string[]>>;
  saucerGraphReady: boolean;
  quoteSimulationReady: boolean;
  permit2Ready: boolean;
  x402ProxyReady: boolean;
  paymentRecipientReady?: boolean;
  facilitatorReady: boolean;
  policyRpcReady: boolean;
  wrapperReady: boolean;
  executionModeReady: boolean;
};

export type ProductRouteRuntime = {
  discoverable: boolean;
  quoteReady: boolean;
  executable: boolean;
  blockers: string[];
};

export type ProductAssetOption = Omit<SupportAsset, "execute"> & {
  runtime: ProductRouteRuntime;
  routeMode?: ProductRouteMode;
  routeModes?: Record<ProductRouteMode, ProductRouteRuntime>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cache = new Map<ProductMode, SupportCatalog>();

export const productProviders: ProductProviderOption[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Compare every eligible provider route without fabricating a fallback quote.",
    strategy: "best_eligible_quote",
  },
  {
    id: "axelar",
    label: "Axelar / Squid",
    description: "Axelar ITS/GMP routes normalized through the server-side Squid adapter.",
    strategy: "explicit",
  },
  {
    id: "layerzero",
    label: "LayerZero / Stargate",
    description: "Direct LayerZero OFT V2 routes plus credentialed Value Transfer fallback, normalized server-side.",
    strategy: "explicit",
  },
];

export function loadSupportCatalog(mode: ProductMode): SupportCatalog {
  const hit = cache.get(mode);
  if (hit) return hit;
  const file = path.join(root, "config", `support.${mode}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SupportCatalog;
  if (parsed.schema !== "refuel402.support-catalog.v1" || parsed.mode !== mode) {
    throw new Error(`invalid support catalog ${file}`);
  }
  cache.set(mode, parsed);
  return parsed;
}

const dynamicBlockers = new Set([
  "PROVIDER_QUOTE_REQUIRED",
  "SAUCER_API_NOT_READY",
  "MIRROR_QUOTE_ENDPOINT_NOT_CONFIGURED",
  "PERMIT2_NOT_DEPLOYED",
  "X402_PROXY_NOT_DEPLOYED",
  "X402_FACILITATOR_NOT_READY",
  "POLICY_RPC_NOT_LIVE_PROVEN",
  "WRAPPER_EXECUTION_NOT_LIVE_PROVEN",
  "MAINNET_EXECUTION_DISABLED",
]);

const refuelOnlyBlockers = new Set([
  "SAUCER_ROUTE_UNAVAILABLE",
  "SAUCER_MIXED_VENUE_EXECUTION_UNSUPPORTED",
  "SAUCER_LIQUIDITY_POLICY",
  "SAUCER_QUOTER_CURRENT_PROBE_FAILED",
]);

export function intersectSupport(
  asset: SupportAsset,
  gates: RuntimeSupportGates,
  routeMode: ProductRouteMode = "bridge_plus_refuel",
): ProductAssetOption {
  const blockers = asset.blockers.filter((code) =>
    !dynamicBlockers.has(code) && (routeMode === "bridge_plus_refuel" || !refuelOnlyBlockers.has(code)));
  const providerRouteReady = asset.provider !== "layerzero" ||
    hasLayerZeroDirectRouteForAsset({
      mode: asset.id.includes(":mainnet:") ? "mainnet" : "testnet",
      originTokens: asset.originTokens,
      destinationToken: asset.destination.address,
    }) ||
    !!process.env.LAYERZERO_TRANSFER_API_KEY;
  if (!gates.providerQuoteReady[asset.provider] || !providerRouteReady) {
    blockers.push(...(!providerRouteReady && asset.provider === "layerzero"
      ? ["PROVIDER_API_AUTHORIZATION_REQUIRED"]
      : gates.providerBlockers?.[asset.provider] ?? ["PROVIDER_QUOTE_REQUIRED"]));
  }
  if (routeMode === "bridge_plus_refuel") {
    if (!gates.saucerGraphReady) blockers.push("SAUCER_API_NOT_READY");
    if (!gates.quoteSimulationReady) blockers.push("MIRROR_QUOTE_ENDPOINT_NOT_CONFIGURED");
    if (!gates.permit2Ready) blockers.push("PERMIT2_NOT_DEPLOYED");
    if (!gates.x402ProxyReady) blockers.push("X402_PROXY_NOT_DEPLOYED");
    if (gates.paymentRecipientReady === false) blockers.push("X402_PAYMENT_RECIPIENT_NOT_CONFIGURED");
    if (!gates.facilitatorReady) blockers.push("X402_FACILITATOR_NOT_READY");
    if (!gates.policyRpcReady) blockers.push("POLICY_RPC_NOT_LIVE_PROVEN");
    if (asset.destination.wrapper && !gates.wrapperReady) blockers.push("WRAPPER_EXECUTION_NOT_LIVE_PROVEN");
  }
  if (!gates.executionModeReady) {
    blockers.push(asset.id.includes(":mainnet:") ? "MAINNET_EXECUTION_DISABLED" : "EXECUTION_MODE_DISABLED");
  }

  const unique = [...new Set(blockers)];
  const staticRouteReady = routeMode === "bridge_only"
    ? asset.discovery
    : asset.saucer.status === "verified" && asset.quote;
  const quoteReady = staticRouteReady &&
    !!gates.providerQuoteReady[asset.provider] &&
    providerRouteReady &&
    (routeMode === "bridge_only" || (gates.saucerGraphReady && gates.quoteSimulationReady));
  const { execute: _catalogExecutionEvidence, ...visibleAsset } = asset;
  return {
    ...visibleAsset,
    routeMode,
    runtime: {
      discoverable: asset.discovery,
      quoteReady,
      // The catalog's execute flag is stale evidence, never a standing veto: a
      // route that is genuinely non-executable reaches here as a blocker from
      // runtime hydration (SAUCER_LIQUIDITY_POLICY / SAUCER_ROUTE_UNAVAILABLE),
      // and any blocker already forces executable false below.
      executable:
        quoteReady &&
        (routeMode === "bridge_only" || (
          gates.permit2Ready &&
          gates.x402ProxyReady &&
          gates.paymentRecipientReady !== false &&
          gates.facilitatorReady &&
          gates.policyRpcReady &&
          (!asset.destination.wrapper || gates.wrapperReady)
        )) &&
        gates.executionModeReady &&
        unique.length === 0,
      blockers: unique,
    },
  };
}

function quoteEndpointReady(mode: ProductMode): boolean {
  const publicRaw = process.env[`${mode.toUpperCase()}_MIRROR_BASE_URL`]?.trim() ??
    (mode === "mainnet" ? "https://mainnet.mirrornode.hedera.com" : "https://testnet.mirrornode.hedera.com");
  const quoteRaw = process.env[`${mode.toUpperCase()}_QUOTE_MIRROR_BASE_URL`]?.trim() || publicRaw;
  try {
    return new URL(quoteRaw).protocol === "https:";
  } catch {
    return false;
  }
}

export function defaultRuntimeGates(mode: ProductMode): RuntimeSupportGates {
  const squidBase = mode === "mainnet"
    ? process.env.SQUID_MAINNET_API_BASE_URL
    : process.env.SQUID_TESTNET_API_BASE_URL;
  const squidCredentialReady = !!process.env.SQUID_INTEGRATOR_ID;
  const squidReady = squidCredentialReady && !!squidBase;
  const layerZeroReady = hasLayerZeroDirectRoute(mode);
  return {
    providerQuoteReady: { axelar: squidReady, layerzero: layerZeroReady },
    saucerGraphReady: !!process.env.SAUCERSWAP_API_KEY,
    quoteSimulationReady: quoteEndpointReady(mode),
    providerBlockers: {
      axelar: [
        ...(!squidCredentialReady ? ["PROVIDER_CREDENTIAL_MISSING"] : []),
        ...(!squidBase ? ["PROVIDER_NETWORK_UNCONFIGURED"] : []),
      ],
      layerzero: layerZeroReady ? [] : ["PROVIDER_ROUTE_UNAVAILABLE"],
    },
    permit2Ready: false,
    x402ProxyReady: false,
    paymentRecipientReady: /^0x[0-9a-fA-F]{40}$/.test(process.env.X402_PAYMENT_RECIPIENT ?? ""),
    facilitatorReady: false,
    policyRpcReady:
      process.env.POLICY_RPC_ENABLED === "1" &&
      process.env.POLICY_RPC_AUTHORIZER_READY === "1",
    wrapperReady: process.env.ERC20_WRAPPER_LIVE_PROVEN === "1",
    executionModeReady:
      mode === "testnet"
        ? process.env.SAME_WALLET_EXECUTION_ENABLED === "1"
        : process.env.SAME_WALLET_EXECUTION_ENABLED === "1" &&
          process.env.MAINNET_EXECUTION_ENABLED === "1",
  };
}

const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const CONTRACT_DEPLOYMENTS = JSON.parse(
  fs.readFileSync(path.join(root, "contracts", "deployments.json"), "utf8"),
) as { networks: Record<ProductMode, { permit2: string; proxy: string }> };

export function productContractAddresses(mode: ProductMode): { permit2: Address; proxy: Address } {
  const suffix = mode === "mainnet" ? "MAINNET" : "TESTNET";
  const deployment = CONTRACT_DEPLOYMENTS.networks[mode];
  const permit2 =
    process.env[`PERMIT2_${suffix}_ADDRESS`]?.trim() || deployment.permit2 || CANONICAL_PERMIT2;
  const proxy = process.env[`X402_PROXY_${suffix}_ADDRESS`]?.trim() || deployment.proxy;
  if (!/^0x[0-9a-fA-F]{40}$/.test(permit2) || !/^0x[0-9a-fA-F]{40}$/.test(proxy)) {
    throw new Error(`invalid ${mode} Permit2/x402 contract configuration`);
  }
  return { permit2: permit2 as Address, proxy: proxy as Address };
}

function hasCode(code: Hex | undefined): boolean {
  return !!code && code !== "0x" && !/^0x0+$/.test(code);
}

// One probe is 2x eth_getCode + 2 facilitator fetches (~120ms); memoize per
// mirror instance so every quote in a 30s window reuses one readback.
const RUNTIME_GATE_CACHE_MS = 30_000;
const runtimeGateCache = new WeakMap<Mirror, Map<ProductMode, { expiresAt: number; gates: RuntimeSupportGates }>>();

export async function probeRuntimeGates(mode: ProductMode, mirror: Mirror): Promise<RuntimeSupportGates> {
  const byMode = runtimeGateCache.get(mirror);
  const hit = byMode?.get(mode);
  if (hit && hit.expiresAt > Date.now()) return hit.gates;
  const gates = await probeRuntimeGatesOnce(mode, mirror);
  const store = byMode ?? new Map<ProductMode, { expiresAt: number; gates: RuntimeSupportGates }>();
  store.set(mode, { expiresAt: Date.now() + RUNTIME_GATE_CACHE_MS, gates });
  runtimeGateCache.set(mirror, store);
  return gates;
}

async function probeRuntimeGatesOnce(mode: ProductMode, mirror: Mirror): Promise<RuntimeSupportGates> {
  const gates = defaultRuntimeGates(mode);
  try {
    const contracts = productContractAddresses(mode);
    const [permit2Code, proxyCode] = await Promise.all([
      mirror.rpc<Hex>("eth_getCode", [contracts.permit2, "latest"]),
      mirror.rpc<Hex>("eth_getCode", [contracts.proxy, "latest"]),
    ]);
    gates.permit2Ready = hasCode(permit2Code);
    gates.x402ProxyReady = hasCode(proxyCode);
  } catch {
    gates.permit2Ready = false;
    gates.x402ProxyReady = false;
  }

  const facilitatorUrl = process.env.X402_EVM_FACILITATOR_URL?.replace(/\/$/, "");
  if (facilitatorUrl) {
    try {
      const [healthResponse, supportedResponse] = await Promise.all([
        fetch(`${facilitatorUrl}/health`),
        fetch(`${facilitatorUrl}/supported`),
      ]);
      const health = (await healthResponse.json()) as {
        ok?: boolean;
        verificationReady?: boolean;
        settlementReady?: boolean;
      };
      const supported = (await supportedResponse.json()) as { kinds?: { network?: string; scheme?: string }[] };
      gates.facilitatorReady =
        healthResponse.ok &&
        health.ok === true &&
        health.verificationReady === true &&
        health.settlementReady === true &&
        supportedResponse.ok &&
        (supported.kinds ?? []).some(
          (kind) => kind.network === `eip155:${mode === "mainnet" ? 295 : 296}` && kind.scheme === "exact",
        );
    } catch {
      gates.facilitatorReady = false;
    }
  }
  return gates;
}

function providerOptionForNetwork(
  provider: ProductProviderOption,
  network: OriginNetwork,
  assets: ProductAssetOption[],
): NetworkProviderOption {
  const networkAssets = assets.filter((asset) => asset.originNetworks.includes(network.chainId));
  const providerAssets = provider.id === "auto"
    ? networkAssets
    : networkAssets.filter((asset) => asset.provider === provider.id);
  const declared = provider.id === "auto" || network.providers.includes(provider.id);
  const aggregate = (states: ProductRouteRuntime[]): ProductRouteRuntime => {
    const quoteReady = states.some((state) => state.quoteReady);
    const executable = states.some((state) => state.executable);
    const relevant = executable
      ? []
      : quoteReady
        ? states.filter((state) => state.quoteReady)
        : states;
    const blockers = relevant.flatMap((state) => state.blockers);
    if (!declared) blockers.unshift("PROVIDER_NOT_AVAILABLE_ON_ORIGIN_NETWORK");
    if (declared && states.length === 0) blockers.unshift("PROVIDER_ASSET_DISCOVERY_EMPTY");
    if (provider.id === "auto" && !quoteReady) blockers.unshift("AUTO_PROVIDER_NO_QUOTE_READY_ROUTE");
    return {
      discoverable: declared || states.some((state) => state.discoverable),
      quoteReady,
      executable,
      blockers: [...new Set(blockers)],
    };
  };
  const routeModes = Object.fromEntries((["bridge_only", "bridge_plus_refuel"] as const).map((routeMode) => [
    routeMode,
    aggregate(providerAssets.map((asset) => asset.routeModes?.[routeMode] ?? asset.runtime)),
  ])) as Record<ProductRouteMode, ProductRouteRuntime>;
  return {
    ...provider,
    assetIds: providerAssets.map((asset) => asset.id),
    runtime: aggregate(providerAssets.map((asset) => asset.runtime)),
    routeModes,
  };
}

function formatTinybar(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function productOptions(
  mode: ProductMode,
  gates = defaultRuntimeGates(mode),
  catalog = loadSupportCatalog(mode),
  saucerFailure?: string,
) {
  const effectiveGates = saucerFailure ? { ...gates, saucerGraphReady: false } : gates;
  const assets = catalog.assets.map((asset) => {
    const bridgeOnly = intersectSupport(asset, effectiveGates, "bridge_only");
    const refuel = intersectSupport(asset, effectiveGates, "bridge_plus_refuel");
    return {
      ...refuel,
      routeModes: {
        bridge_only: bridgeOnly.runtime,
        bridge_plus_refuel: refuel.runtime,
      },
    };
  });
  const networks = catalog.originNetworks.map((network) => ({
    ...network,
    assets: assets
      .filter((asset) => asset.originNetworks.includes(network.chainId))
      .map((asset) => asset.id),
    providerOptions: productProviders.map((provider) =>
      providerOptionForNetwork(provider, network, assets),
    ),
  }));
  return {
    schema: "refuel402.product-options.v1",
    mode,
    evidenceAt: catalog.evidenceAt,
    hedera: catalog.hedera,
    providers: productProviders,
    networks,
    assets,
    defaults: {
      routeMode: "bridge_plus_refuel" as const,
      desiredHbarTinybar: BigInt(process.env.RECOMMENDED_REFUEL_TINYBAR ?? 1_000_000_000n).toString(),
      desiredHbar: formatTinybar(BigInt(process.env.RECOMMENDED_REFUEL_TINYBAR ?? 1_000_000_000n)),
      slippageBps: 100,
    },
    limits: {
      maximumConfiguredHbarTinybar: BigInt(process.env.MAX_REFUEL_TINYBAR ?? 5_000_000_000n).toString(),
      maximumSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 300),
      maximumPriceImpactBps: Number(process.env.MAX_PRICE_IMPACT_BPS ?? 150),
    },
    capabilities: {
      combinedQuote: assets.some((asset) => asset.runtime.quoteReady),
      bridgeOnlyQuote: assets.some((asset) => asset.routeModes.bridge_only.quoteReady),
      routeModes: {
        bridge_only: assets.some((asset) => asset.routeModes.bridge_only.executable),
        bridge_plus_refuel: assets.some((asset) => asset.routeModes.bridge_plus_refuel.executable),
      },
      execution: assets.some((asset) => asset.runtime.executable),
      sameWalletRequired: true,
      walletMethods: ["eth_sendTransaction", "eth_signTypedData_v4"],
      rawTransactionSigningRequested: false,
      quoteSimulationEndpoint: {
        status: effectiveGates.quoteSimulationReady ? "configured_public_or_override" : "not_configured",
        reason: effectiveGates.quoteSimulationReady ? null : "MIRROR_QUOTE_ENDPOINT_NOT_CONFIGURED",
        publicMirrorUsage: "contract_call_and_light_readback_with_bounded_rate_control",
      },
      saucerDeveloperApi: catalog.saucerEvidence
        ? { ...catalog.saucerEvidence, reason: null }
        : process.env.SAUCERSWAP_API_KEY
          ? {
              status: saucerFailure ? "configured_failed" : "configured_unverified",
              reason: saucerFailure ?? null,
            }
          : {
              status: "disabled",
              reason: process.env.SAUCERSWAP_API_DISABLED_REASON ?? "SAUCERSWAP_DEVELOPER_API_NOT_CONFIGURED",
            },
    },
  };
}

export function findProductAsset(mode: ProductMode, assetId: string): SupportAsset | undefined {
  return loadSupportCatalog(mode).assets.find((asset) => asset.id === assetId);
}
