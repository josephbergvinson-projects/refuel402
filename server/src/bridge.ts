import crypto from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { layerZeroScanStatus, quoteLayerZeroDirect } from "./layerzero-oft.js";
import type { ProductMode, ProviderId, SupportAsset } from "./support.js";

export type BridgeQuoteRequest = {
  mode: ProductMode;
  provider: ProviderId;
  originChainId: string;
  originToken: Address;
  amount: bigint;
  account: Address;
  asset: SupportAsset;
  slippageBps: number;
};

export type BridgeFee = {
  name: string;
  category: "provider" | "gas_relayer";
  amount: string;
  symbol: string | null;
  usd: number | null;
  payer: "user";
};

export type BridgeTransferStatus = {
  provider: ProviderId;
  state: "pending" | "arrived" | "failed" | "unknown";
  sourceTransactionHash: Hex;
  destinationTransactionHash: Hex | null;
  providerStatus: string;
  providerUrl: string | null;
  observedAt: string;
};

export type BridgeQuote = {
  provider: ProviderId;
  providerLabel: string;
  quoteId: string | null;
  originChainId: string;
  destinationChainId: number;
  fromAddress: Address;
  toAddress: Address;
  originToken: Address;
  destinationToken: Address;
  fromAmount: string;
  expectedDestinationAmount: string;
  minimumDestinationAmount: string;
  estimatedSeconds: number | null;
  fees: BridgeFee[];
  normalized: {
    sourceAmount: {
      amount: string;
      token: Address;
      decimals: number;
      symbol: string;
      native?: boolean;
    };
    destinationAsset: {
      address: Address;
      tokenId: string | null;
      standard: "HTS" | "ERC20";
      decimals: number;
      symbol: string;
    };
    slippage: {
      requestedBps: number;
      expectedDestinationAmount: string;
      minimumDestinationAmount: string;
    };
    evidence: {
      source: "squid-v2" | "layerzero-value-transfer" | "layerzero-oft-v2" | "stargate-v2-taxi";
      quoteId: string | null;
      routeId: string | null;
      observedAt: string;
      responseHash: string;
    };
    destinationAmountNormalization?: {
      providerDecimals: number;
      destinationDecimals: number;
      expectedProviderBaseUnits: string;
      minimumProviderBaseUnits: string;
      rounding: "floor_toward_zero";
    };
  };
  originApproval: {
    token: Address;
    spender: Address;
    amount: string;
  } | null;
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas?: string;
  } | null;
  userSteps: {
    type: "TRANSACTION" | "SIGNATURE";
    description: string;
    chainKey: string;
    signerAddress: Address;
    transaction?: { to: Address; data: Hex; value: string; gas?: string; chainId?: number };
    typedData?: Record<string, unknown>;
  }[];
  expiresAt: number;
  source: "squid-v2" | "layerzero-value-transfer" | "layerzero-oft-v2" | "stargate-v2-taxi";
  timing?: {
    providerRequestMs: number;
    transactionConstructionMs: number;
    totalMs: number;
    externalProvider: true;
  };
};

export class BridgeAdapterError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_CREDENTIAL_MISSING"
      | "PROVIDER_NETWORK_UNCONFIGURED"
      | "PROVIDER_UNSUPPORTED_TOKEN_NETWORK"
      | "PROVIDER_ROUTE_UNAVAILABLE"
      | "PROVIDER_TEMPORARILY_PAUSED"
      | "PROVIDER_RESPONSE_INVALID"
      | "PROVIDER_REQUEST_FAILED"
      | "STALE_QUOTE",
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = "0"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function numericValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function providerAddress(value: unknown, label: string): Address {
  try {
    return getAddress(stringValue(value));
  } catch {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", `bridge provider returned an invalid ${label}`);
  }
}

function providerBaseUrl(raw: string | undefined, allowedHosts: string[]): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (
      !allowedHosts.includes(url.hostname) &&
      process.env.ALLOW_CUSTOM_PROVIDER_HOSTS !== "1"
    ) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function boundedJson(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "bridge provider response exceeded the size limit");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "bridge provider returned invalid JSON");
  }
}

function feeRows(estimate: Record<string, unknown>): BridgeFee[] {
  const rows: BridgeFee[] = [];
  const groups = [
    { category: "provider" as const, values: Array.isArray(estimate.feeCosts) ? estimate.feeCosts : [] },
    { category: "gas_relayer" as const, values: Array.isArray(estimate.gasCosts) ? estimate.gasCosts : [] },
  ];
  for (const group of groups) {
    group.values.forEach((entry, index) => {
      const row = asRecord(entry);
      const token = asRecord(row.token);
      rows.push({
        name: stringValue(row.name, `${group.category === "provider" ? "provider" : "gas/relayer"} fee ${index + 1}`),
        category: group.category,
        amount: stringValue(row.amount),
        symbol: typeof token.symbol === "string" ? token.symbol : null,
        usd: numericValue(row.amountUSD ?? row.amountUsd),
        payer: "user",
      });
    });
  }
  return rows;
}

function normalizedEvidence(
  request: BridgeQuoteRequest,
  source: BridgeQuote["source"],
  quoteId: string | null,
  routeId: string | null,
  body: unknown,
  expectedDestinationAmount: string,
  minimumDestinationAmount: string,
  destinationAmountNormalization?: BridgeQuote["normalized"]["destinationAmountNormalization"],
): BridgeQuote["normalized"] {
  const origin = request.asset.originTokens?.find(
    (token) => token.chainId === request.originChainId && getAddress(token.address) === request.originToken,
  );
  if (!origin) {
    throw new BridgeAdapterError("PROVIDER_UNSUPPORTED_TOKEN_NETWORK", "origin token is not mapped for the provider/network");
  }
  return {
    sourceAmount: {
      amount: request.amount.toString(),
      token: request.originToken,
      decimals: origin.decimals,
      symbol: origin.symbol,
      ...(origin.native ? { native: true } : {}),
    },
    destinationAsset: {
      address: request.asset.destination.address,
      tokenId: request.asset.destination.tokenId ?? null,
      standard: request.asset.destination.standard,
      decimals: request.asset.destination.decimals,
      symbol: request.asset.symbol,
    },
    slippage: {
      requestedBps: request.slippageBps,
      expectedDestinationAmount,
      minimumDestinationAmount,
    },
    evidence: {
      source,
      quoteId,
      routeId,
      observedAt: new Date().toISOString(),
      responseHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
    ...(destinationAmountNormalization ? { destinationAmountNormalization } : {}),
  };
}

function providerAmountToDestinationBaseUnits(value: string, providerDecimals: number, destinationDecimals: number): string {
  if (!/^\d+$/.test(value)) throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "bridge provider returned a non-integer destination amount");
  const amount = BigInt(value);
  if (providerDecimals === destinationDecimals) return amount.toString();
  return providerDecimals > destinationDecimals
    ? (amount / 10n ** BigInt(providerDecimals - destinationDecimals)).toString()
    : (amount * 10n ** BigInt(destinationDecimals - providerDecimals)).toString();
}

export function normalizeSquidQuote(
  request: BridgeQuoteRequest,
  responseBody: unknown,
  responseQuoteId?: string | null,
): BridgeQuote {
  const body = asRecord(responseBody);
  const route = asRecord(body.route);
  const estimate = asRecord(route.estimate);
  const transactionRequest = asRecord(route.transactionRequest ?? body.transactionRequest);
  const providerToAmount = stringValue(estimate.toAmount, "");
  const providerToAmountMin = stringValue(estimate.toAmountMin ?? estimate.toAmount, "");
  if (!providerToAmount || !providerToAmountMin) {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "bridge provider returned no destination amount");
  }
  const providerDecimals = request.asset.destination.providerAmountDecimals ?? request.asset.destination.decimals;
  const toAmount = providerAmountToDestinationBaseUnits(providerToAmount, providerDecimals, request.asset.destination.decimals);
  const toAmountMin = providerAmountToDestinationBaseUnits(providerToAmountMin, providerDecimals, request.asset.destination.decimals);
  if (BigInt(toAmount) <= 0n || BigInt(toAmountMin) <= 0n) {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "bridge provider returned no destination amount");
  }

  let transaction: BridgeQuote["transaction"] = null;
  if (typeof transactionRequest.target === "string" && typeof transactionRequest.data === "string") {
    transaction = {
      to: providerAddress(transactionRequest.target, "transaction target"),
      data: transactionRequest.data as Hex,
      value: stringValue(transactionRequest.value, "0"),
      ...(transactionRequest.gasLimit ? { gas: stringValue(transactionRequest.gasLimit) } : {}),
    };
  }

  const quoteId =
    (typeof body.quoteId === "string" && body.quoteId) ||
    (typeof route.quoteId === "string" && route.quoteId) ||
    responseQuoteId ||
    null;
  const estimatedSeconds = numericValue(
    estimate.estimatedRouteDuration ?? estimate.estimatedRouteDurationSeconds,
  );
  const source = "squid-v2" as const;
  const routeId = stringValue(route.routeId ?? route.id, "") || quoteId;
  return {
    provider: "axelar",
    providerLabel: request.asset.providerLabel,
    quoteId,
    originChainId: request.originChainId,
    destinationChainId: request.mode === "mainnet" ? 295 : 296,
    fromAddress: request.account,
    toAddress: request.account,
    originToken: request.originToken,
    destinationToken: request.asset.destination.address,
    fromAmount: request.amount.toString(),
    expectedDestinationAmount: toAmount,
    minimumDestinationAmount: toAmountMin,
    estimatedSeconds,
    fees: feeRows(estimate),
    normalized: normalizedEvidence(
      request,
      source,
      quoteId,
      routeId,
      body,
      toAmount,
      toAmountMin,
      providerDecimals === request.asset.destination.decimals
        ? undefined
        : {
            providerDecimals,
            destinationDecimals: request.asset.destination.decimals,
            expectedProviderBaseUnits: providerToAmount,
            minimumProviderBaseUnits: providerToAmountMin,
            rounding: "floor_toward_zero",
          },
    ),
    originApproval: transaction
      ? { token: request.originToken, spender: transaction.to, amount: request.amount.toString() }
      : null,
    transaction,
    userSteps: transaction
      ? [{
          type: "TRANSACTION",
          description: "bridge",
          chainKey: request.originChainId,
          signerAddress: request.account,
          transaction,
        }]
      : [],
    expiresAt: Math.floor(Date.now() / 1000) + Number(process.env.BRIDGE_QUOTE_TTL_SEC ?? 300),
    source,
  };
}

export async function quoteSquid(request: BridgeQuoteRequest): Promise<BridgeQuote> {
  const startedAt = Date.now();
  const baseUrl = providerBaseUrl(
    request.mode === "mainnet"
      ? process.env.SQUID_MAINNET_API_BASE_URL
      : process.env.SQUID_TESTNET_API_BASE_URL,
    ["v2.api.squidrouter.com", "testnet.v2.api.squidrouter.com"],
  );
  const integratorId = process.env.SQUID_INTEGRATOR_ID;
  if (!integratorId) {
    throw new BridgeAdapterError("PROVIDER_CREDENTIAL_MISSING", "Axelar/Squid integrator ID is not configured on the server");
  }
  if (!baseUrl) {
    throw new BridgeAdapterError("PROVIDER_NETWORK_UNCONFIGURED", `Axelar/Squid ${request.mode} API route is not configured`);
  }
  const payload = {
    fromChain: request.originChainId,
    toChain: String(request.mode === "mainnet" ? 295 : 296),
    fromToken: request.originToken,
    toToken: request.asset.destination.address,
    fromAmount: request.amount.toString(),
    fromAddress: request.account,
    toAddress: request.account,
    slippage: request.slippageBps / 100,
    quoteOnly: false,
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v2/route`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-integrator-id": integratorId,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", "Axelar/Squid quote request failed");
  }
  if (!response.ok) {
    // 403 after a VALID integrator id is Squid pausing swaps service-wide, not a
    // route or credential problem: an invalid id answers 401 before this point,
    // and the pause reproduces on every route and on both API hosts. Reported as
    // a generic request failure it looked like our outage, so the owner had
    // nothing to act on — when the useful thing to say is "this provider is
    // paused, the other one is not".
    const code = response.status === 403
      ? "PROVIDER_TEMPORARILY_PAUSED"
      : response.status === 400 || response.status === 404
        ? "PROVIDER_ROUTE_UNAVAILABLE"
        : "PROVIDER_REQUEST_FAILED";
    throw new BridgeAdapterError(
      code,
      code === "PROVIDER_TEMPORARILY_PAUSED"
        ? "Axelar/Squid has paused swaps. Nothing was sent or spent — try LayerZero, or this provider again later."
        : `Axelar/Squid quote unavailable (${response.status})`,
    );
  }
  const body = await boundedJson(response);
  const providerCompletedAt = Date.now();
  const quote = normalizeSquidQuote(request, body, response.headers.get("x-request-id"));
  const completedAt = Date.now();
  quote.timing = {
    providerRequestMs: providerCompletedAt - startedAt,
    transactionConstructionMs: completedAt - providerCompletedAt,
    totalMs: completedAt - startedAt,
    externalProvider: true,
  };
  return quote;
}

const layerZeroChainKeys: Record<string, string> = {
  "1": "ethereum",
  "42161": "arbitrum",
  "8453": "base",
  "43114": "avalanche",
  "56": "bsc",
  "137": "polygon",
};

export async function discoverLayerZeroTransferRoute(input: {
  originChainId: string;
  originToken: Address;
  mode: ProductMode;
  destinationToken: Address;
}, fetcher: typeof fetch = fetch): Promise<{
  sourceChainKey: string;
  destinationChainKey: string;
  sourceToken: Address;
  destinationToken: Address;
  destinationSymbol: string;
} | null> {
  const sourceChainKey = layerZeroChainKeys[input.originChainId];
  if (!sourceChainKey) return null;
  const destinationChainKey = input.mode === "mainnet" ? "hedera" : "hedera-testnet";
  const baseUrl = providerBaseUrl(
    process.env.LAYERZERO_TRANSFER_API_URL ?? "https://transfer.layerzero-api.com/v1",
    ["transfer.layerzero-api.com"],
  );
  const query = new URLSearchParams({
    transferrableFromChainKey: sourceChainKey,
    transferrableFromTokenAddress: input.originToken,
  });
  const response = await fetcher(`${baseUrl}/tokens?${query}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", `LayerZero route discovery unavailable (${response.status})`);
  const body = asRecord(await boundedJson(response, 5_000_000));
  const match = (Array.isArray(body.tokens) ? body.tokens.map(asRecord) : []).find((token) =>
    token.isSupported === true &&
    stringValue(token.chainKey, "") === destinationChainKey &&
    typeof token.address === "string" &&
    token.address.toLowerCase() === input.destinationToken.toLowerCase()
  );
  if (!match) return null;
  return {
    sourceChainKey,
    destinationChainKey,
    sourceToken: input.originToken,
    destinationToken: input.destinationToken,
    destinationSymbol: stringValue(match.symbol, ""),
  };
}

export function normalizeLayerZeroQuote(
  request: BridgeQuoteRequest,
  responseBody: unknown,
): BridgeQuote {
  const body = asRecord(responseBody);
  const quotes = Array.isArray(body.quotes) ? body.quotes.map(asRecord) : [];
  const quote = quotes.find((candidate) => {
    const routeSteps = Array.isArray(candidate.routeSteps) ? candidate.routeSteps.map(asRecord) : [];
    return routeSteps.some((step) => ["OFT", "STARGATE_V2_TAXI", "STARGATE_V2_BUS"].includes(stringValue(step.type, "")));
  });
  if (!quote) throw new BridgeAdapterError("PROVIDER_ROUTE_UNAVAILABLE", "LayerZero returned no transfer quote");
  const expected = stringValue(quote.dstAmount, "");
  const minimum = stringValue(quote.dstAmountMin ?? quote.dstAmount, "");
  if (!expected || !minimum) {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "LayerZero returned no destination amount");
  }
  const steps: BridgeQuote["userSteps"] = [];
  for (const entry of Array.isArray(quote.userSteps) ? quote.userSteps : []) {
    const step = asRecord(entry);
    const signerAddress = providerAddress(step.signerAddress, "step signer");
    const chainKey = stringValue(step.chainKey, "");
    if (chainKey !== layerZeroChainKeys[request.originChainId]) {
      throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "LayerZero step chain differs from the selected origin");
    }
    if (signerAddress !== request.account) {
      throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "LayerZero step signer differs from the connected account");
    }
    if (step.type === "TRANSACTION") {
      const encoded = asRecord(asRecord(step.transaction).encoded);
      const from = typeof encoded.from === "string"
        ? providerAddress(encoded.from, "transaction sender")
        : signerAddress;
      const chainId = numericValue(encoded.chainId);
      if (
        from !== request.account ||
        typeof encoded.to !== "string" ||
        typeof encoded.data !== "string" ||
        (chainId !== null && chainId !== Number(request.originChainId))
      ) {
        throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "LayerZero transaction step failed identity validation");
      }
      steps.push({
        type: "TRANSACTION",
        description: stringValue(step.description, "transfer"),
        chainKey,
        signerAddress,
        transaction: {
          to: providerAddress(encoded.to, "transaction target"),
          data: encoded.data as Hex,
          value: stringValue(encoded.value, "0"),
          ...(encoded.gasLimit ? { gas: stringValue(encoded.gasLimit) } : {}),
          ...(chainId !== null ? { chainId } : {}),
        },
      });
    } else if (step.type === "SIGNATURE") {
      const signature = asRecord(step.signature);
      const typedData = asRecord(signature.typedData);
      steps.push({
        type: "SIGNATURE",
        description: stringValue(step.description, "authorize transfer"),
        chainKey,
        signerAddress,
        typedData,
      });
    }
  }
  const transactions = steps.filter((step) => step.type === "TRANSACTION" && step.transaction);
  const firstBridge = transactions.at(-1)?.transaction ?? null;
  if (!firstBridge) {
    throw new BridgeAdapterError("PROVIDER_RESPONSE_INVALID", "LayerZero returned no executable transaction step");
  }
  const fees = (Array.isArray(quote.fees) ? quote.fees : []).map((entry, index) => {
    const row = asRecord(entry);
    return {
      name: stringValue(row.description || row.type, `LayerZero fee ${index + 1}`),
      category: "provider" as const,
      amount: stringValue(row.amount),
      symbol: null,
      usd: numericValue(quote.feeUsd),
      payer: "user" as const,
    };
  });
  const durationMs = numericValue(asRecord(quote.duration).estimated);
  const parsedExpiry = typeof quote.expiresAt === "string" ? Math.floor(Date.parse(quote.expiresAt) / 1000) : NaN;
  const quoteId = stringValue(quote.id, "") || null;
  const source = "layerzero-value-transfer" as const;
  return {
    provider: "layerzero",
    providerLabel: request.asset.providerLabel,
    quoteId,
    originChainId: request.originChainId,
    destinationChainId: request.mode === "mainnet" ? 295 : 296,
    fromAddress: request.account,
    toAddress: request.account,
    originToken: request.originToken,
    destinationToken: request.asset.destination.address,
    fromAmount: stringValue(quote.srcAmount, request.amount.toString()),
    expectedDestinationAmount: expected,
    minimumDestinationAmount: minimum,
    estimatedSeconds: durationMs === null ? null : Math.ceil(durationMs / 1000),
    fees,
    normalized: normalizedEvidence(request, source, quoteId, quoteId, body, expected, minimum),
    originApproval: null,
    transaction: firstBridge,
    userSteps: steps,
    expiresAt: Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : Math.floor(Date.now() / 1000) + Number(process.env.BRIDGE_QUOTE_TTL_SEC ?? 300),
    source,
  };
}

export async function quoteLayerZero(request: BridgeQuoteRequest): Promise<BridgeQuote> {
  const startedAt = Date.now();
  let direct;
  try {
    direct = await quoteLayerZeroDirect({
      mode: request.mode,
      originChainId: request.originChainId,
      originToken: request.originToken,
      destinationToken: request.asset.destination.address,
      account: request.account,
      amount: request.amount,
      slippageBps: request.slippageBps,
    });
  } catch (error) {
    throw new BridgeAdapterError(
      "PROVIDER_REQUEST_FAILED",
      error instanceof Error ? error.message : "LayerZero direct OFT quote failed",
    );
  }
  if (direct) {
    const providerCompletedAt = Date.now();
    const source = direct.source;
    const transaction = {
      to: direct.sourceAdapter,
      data: direct.transactionData,
      value: direct.transactionValue,
    };
    return {
      provider: "layerzero",
      providerLabel: request.asset.providerLabel,
      quoteId: direct.quoteId,
      originChainId: request.originChainId,
      destinationChainId: request.mode === "mainnet" ? 295 : 296,
      fromAddress: request.account,
      toAddress: request.account,
      originToken: request.originToken,
      destinationToken: request.asset.destination.address,
      fromAmount: request.amount.toString(),
      expectedDestinationAmount: direct.expectedDestinationAmount,
      minimumDestinationAmount: direct.minimumDestinationAmount,
      estimatedSeconds: null,
      fees: [{
        name: "LayerZero messaging fee",
        category: "gas_relayer",
        amount: direct.nativeFee,
        symbol: "ETH",
        usd: null,
        payer: "user",
      }],
      normalized: normalizedEvidence(
        request,
        source,
        direct.quoteId,
        direct.routeId,
        direct.evidence,
        direct.expectedDestinationAmount,
        direct.minimumDestinationAmount,
      ),
      originApproval: direct.approvalRequired
        ? { token: request.originToken, spender: direct.sourceAdapter, amount: request.amount.toString() }
        : null,
      transaction,
      userSteps: [{
        type: "TRANSACTION",
        description: source === "stargate-v2-taxi" ? "bridge native ETH with Stargate V2 taxi" : "bridge with LayerZero OFT V2",
        chainKey: layerZeroChainKeys[request.originChainId]!,
        signerAddress: request.account,
        transaction: { ...transaction, chainId: Number(request.originChainId) },
      }],
      expiresAt: Math.floor(Date.now() / 1000) + Number(process.env.BRIDGE_QUOTE_TTL_SEC ?? 300),
      source,
      timing: {
        providerRequestMs: providerCompletedAt - startedAt,
        transactionConstructionMs: Date.now() - providerCompletedAt,
        totalMs: Date.now() - startedAt,
        externalProvider: true,
      },
    };
  }

  const baseUrl = providerBaseUrl(
    process.env.LAYERZERO_TRANSFER_API_URL ?? "https://transfer.layerzero-api.com/v1",
    ["transfer.layerzero-api.com"],
  );
  const apiKey = process.env.LAYERZERO_TRANSFER_API_KEY;
  const route = await discoverLayerZeroTransferRoute({
    originChainId: request.originChainId,
    originToken: request.originToken,
    mode: request.mode,
    destinationToken: request.asset.destination.address,
  });
  if (!route) {
    throw new BridgeAdapterError("PROVIDER_ROUTE_UNAVAILABLE", "LayerZero public discovery returned no matching source-to-destination token route");
  }
  const sourceChainKey = route.sourceChainKey;
  if (!apiKey) {
    throw new BridgeAdapterError(
      "PROVIDER_CREDENTIAL_MISSING",
      `LayerZero public discovery verified ${sourceChainKey}:${request.originToken} -> ${route.destinationChainKey}:${request.asset.destination.address}, but POST /v1/quotes requires LAYERZERO_TRANSFER_API_KEY`,
    );
  }
  if (!baseUrl) {
    throw new BridgeAdapterError("PROVIDER_NETWORK_UNCONFIGURED", "LayerZero Value Transfer API route is not configured");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        amount: request.amount.toString(),
        srcChainKey: sourceChainKey,
        srcTokenAddress: request.originToken,
        srcWalletAddress: request.account,
        dstChainKey: request.mode === "mainnet" ? "hedera" : "hedera-testnet",
        dstTokenAddress: request.asset.destination.address,
        dstWalletAddress: request.account,
        options: {
          amountType: "EXACT_SRC_AMOUNT",
          feeTolerance: { type: "PERCENT", amount: request.slippageBps / 100 },
          dstNativeDropAmount: "0",
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", "LayerZero quote request failed");
  }
  if (!response.ok) {
    throw new BridgeAdapterError(
      response.status === 400 || response.status === 404
        ? "PROVIDER_ROUTE_UNAVAILABLE"
        : "PROVIDER_REQUEST_FAILED",
      `LayerZero quote unavailable (${response.status})`,
    );
  }
  const body = await boundedJson(response);
  const providerCompletedAt = Date.now();
  const quote = normalizeLayerZeroQuote(request, body);
  const completedAt = Date.now();
  quote.timing = {
    providerRequestMs: providerCompletedAt - startedAt,
    transactionConstructionMs: completedAt - providerCompletedAt,
    totalMs: completedAt - startedAt,
    externalProvider: true,
  };
  return quote;
}

export async function quoteBridge(request: BridgeQuoteRequest): Promise<BridgeQuote> {
  return request.provider === "axelar" ? quoteSquid(request) : quoteLayerZero(request);
}

export async function squidTransferStatus(input: {
  mode: ProductMode;
  quoteId: string;
  sourceTransactionHash: Hex;
  originChainId: string;
}): Promise<BridgeTransferStatus> {
  const baseUrl = providerBaseUrl(
    input.mode === "mainnet"
      ? process.env.SQUID_MAINNET_API_BASE_URL
      : process.env.SQUID_TESTNET_API_BASE_URL,
    ["v2.api.squidrouter.com", "testnet.v2.api.squidrouter.com"],
  );
  const integratorId = process.env.SQUID_INTEGRATOR_ID;
  if (!integratorId) throw new BridgeAdapterError("PROVIDER_CREDENTIAL_MISSING", "Axelar/Squid integrator ID is not configured");
  if (!baseUrl) throw new BridgeAdapterError("PROVIDER_NETWORK_UNCONFIGURED", `Axelar/Squid ${input.mode} API route is not configured`);
  const query = new URLSearchParams({
    transactionId: input.sourceTransactionHash,
    fromChainId: input.originChainId,
    toChainId: String(input.mode === "mainnet" ? 295 : 296),
    quoteId: input.quoteId,
  });
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v2/status?${query}`, {
      headers: { "x-integrator-id": integratorId },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", "Axelar/Squid status request failed");
  }
  if (!response.ok) throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", `Axelar/Squid status unavailable (${response.status})`);
  const body = asRecord(await boundedJson(response));
  const raw = stringValue(body.squidTransactionStatus ?? body.status, "unknown").toLowerCase();
  const destination = asRecord(body.toChain);
  const destinationHash = typeof destination.transactionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(destination.transactionId)
    ? destination.transactionId as Hex
    : null;
  const providerUrl = typeof body.axelarTransactionUrl === "string" && /^https:\/\//.test(body.axelarTransactionUrl)
    ? body.axelarTransactionUrl
    : null;
  const state: BridgeTransferStatus["state"] = raw === "success" || raw === "partial_success"
    ? "arrived"
    : raw === "ongoing" || raw === "not_found" || raw === "pending"
      ? "pending"
      : raw === "needs_gas" || raw === "refund" || raw === "failed" || raw === "error"
        ? "failed"
        : "unknown";
  return {
    provider: "axelar",
    state,
    sourceTransactionHash: input.sourceTransactionHash,
    destinationTransactionHash: destinationHash,
    providerStatus: raw,
    providerUrl,
    observedAt: new Date().toISOString(),
  };
}

export async function layerZeroTransferStatus(quoteId: string, txHash?: Hex) {
  const baseUrl = providerBaseUrl(
    process.env.LAYERZERO_TRANSFER_API_URL ?? "https://transfer.layerzero-api.com/v1",
    ["transfer.layerzero-api.com"],
  );
  const apiKey = process.env.LAYERZERO_TRANSFER_API_KEY;
  if (!apiKey) throw new BridgeAdapterError("PROVIDER_CREDENTIAL_MISSING", "LayerZero status API key is not configured");
  if (!baseUrl) throw new BridgeAdapterError("PROVIDER_NETWORK_UNCONFIGURED", "LayerZero status route is not configured");
  const query = txHash ? `?txHash=${encodeURIComponent(txHash)}` : "";
  const response = await fetch(`${baseUrl}/status/${encodeURIComponent(quoteId)}${query}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", `LayerZero status unavailable (${response.status})`);
  return boundedJson(response);
}

export async function bridgeTransferStatus(input: {
  mode: ProductMode;
  provider: ProviderId;
  quoteId: string;
  sourceTransactionHash: Hex;
  originChainId: string;
}): Promise<BridgeTransferStatus> {
  if (input.provider === "axelar") return squidTransferStatus(input);
  if (input.quoteId.startsWith("direct-oft-") || input.quoteId.startsWith("direct-stargate-")) {
    try {
      const scan = await layerZeroScanStatus(input.sourceTransactionHash);
      return {
        provider: "layerzero",
        state: scan.state,
        sourceTransactionHash: input.sourceTransactionHash,
        destinationTransactionHash: scan.destinationTransactionHash,
        providerStatus: scan.providerStatus,
        providerUrl: `https://layerzeroscan.com/tx/${input.sourceTransactionHash}`,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new BridgeAdapterError(
        "PROVIDER_REQUEST_FAILED",
        error instanceof Error ? error.message : "LayerZero Scan status request failed",
      );
    }
  }
  const body = asRecord(await layerZeroTransferStatus(input.quoteId, input.sourceTransactionHash));
  const raw = stringValue(body.status ?? body.state ?? body.transferStatus, "unknown").toLowerCase();
  const destinationHashValue = body.dstTxHash ?? body.destinationTransactionHash ?? asRecord(body.destination).transactionHash;
  const destinationTransactionHash = typeof destinationHashValue === "string" && /^0x[0-9a-fA-F]{64}$/.test(destinationHashValue)
    ? destinationHashValue as Hex
    : null;
  return {
    provider: "layerzero",
    state: ["delivered", "completed", "success"].includes(raw)
      ? "arrived"
      : ["pending", "inflight", "confirming", "submitted"].includes(raw)
        ? "pending"
        : ["failed", "refunded", "reverted"].includes(raw)
          ? "failed"
          : "unknown",
    sourceTransactionHash: input.sourceTransactionHash,
    destinationTransactionHash,
    providerStatus: raw,
    providerUrl: null,
    observedAt: new Date().toISOString(),
  };
}

export async function discoverLayerZeroHedera(mode: ProductMode) {
  const [deploymentsResponse, assetsResponse] = await Promise.all([
    fetch("https://metadata.layerzero-api.com/v1/metadata/deployments", {
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(
      mode === "mainnet"
        ? "https://mainnet.stargate-api.com/v1/metadata?version=v2"
        : "https://testnet.stargate-api.com/v1/metadata?version=v2",
      { signal: AbortSignal.timeout(15_000) },
    ),
  ]);
  if (!deploymentsResponse.ok || !assetsResponse.ok) {
    throw new BridgeAdapterError("PROVIDER_REQUEST_FAILED", "LayerZero metadata is unavailable");
  }
  const deployments = asRecord(await boundedJson(deploymentsResponse, 5_000_000));
  const chainKey = mode === "mainnet" ? "hedera" : "hedera-testnet";
  const chain = asRecord(deployments[chainKey]);
  const assetBody = asRecord(await boundedJson(assetsResponse, 5_000_000));
  const data = asRecord(assetBody.data);
  const assets = Array.isArray(data.v2)
    ? data.v2.filter((row) => asRecord(row).chainKey === (mode === "mainnet" ? "hedera" : "hedera-testnet"))
    : [];
  return {
    active: asRecord(chain.chainDetails).chainStatus === "ACTIVE",
    chainKey,
    assets,
  };
}
