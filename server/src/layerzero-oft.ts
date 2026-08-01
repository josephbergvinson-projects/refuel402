import crypto from "node:crypto";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  pad,
  type Address,
  type Hex,
} from "viem";

const oftAbi = [
  {
    type: "function",
    name: "peers",
    stateMutability: "view",
    inputs: [{ name: "eid", type: "uint32" }],
    outputs: [{ name: "peer", type: "bytes32" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "approvalRequired",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "required", type: "bool" }],
  },
  {
    type: "function",
    name: "quoteOFT",
    stateMutability: "view",
    inputs: [{
      name: "sendParam",
      type: "tuple",
      components: [
        { name: "dstEid", type: "uint32" },
        { name: "to", type: "bytes32" },
        { name: "amountLD", type: "uint256" },
        { name: "minAmountLD", type: "uint256" },
        { name: "extraOptions", type: "bytes" },
        { name: "composeMsg", type: "bytes" },
        { name: "oftCmd", type: "bytes" },
      ],
    }],
    outputs: [
      {
        name: "limit",
        type: "tuple",
        components: [
          { name: "minAmountLD", type: "uint256" },
          { name: "maxAmountLD", type: "uint256" },
        ],
      },
      {
        name: "oftFeeDetails",
        type: "tuple[]",
        components: [
          { name: "feeAmountLD", type: "int256" },
          { name: "description", type: "string" },
        ],
      },
      {
        name: "receipt",
        type: "tuple",
        components: [
          { name: "amountSentLD", type: "uint256" },
          { name: "amountReceivedLD", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quoteSend",
    stateMutability: "view",
    inputs: [
      {
        name: "sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
      { name: "payInLzToken", type: "bool" },
    ],
    outputs: [{
      name: "fee",
      type: "tuple",
      components: [
        { name: "nativeFee", type: "uint256" },
        { name: "lzTokenFee", type: "uint256" },
      ],
    }],
  },
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [
      {
        name: "sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
      {
        name: "fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
      { name: "refundAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "localEid",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "eid", type: "uint32" }],
  },
  {
    type: "function",
    name: "sharedDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
  {
    type: "function",
    name: "stargateType",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "kind", type: "uint8" }],
  },
  {
    type: "function",
    name: "paths",
    stateMutability: "view",
    inputs: [{ name: "eid", type: "uint32" }],
    outputs: [{ name: "credit", type: "uint64" }],
  },
  {
    type: "function",
    name: "getAddressConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      name: "config",
      type: "tuple",
      components: [
        { name: "feeLib", type: "address" },
        { name: "planner", type: "address" },
        { name: "treasurer", type: "address" },
        { name: "tokenMessaging", type: "address" },
        { name: "creditMessaging", type: "address" },
        { name: "lzToken", type: "address" },
      ],
    }],
  },
] as const;

type DirectRoute = {
  id: string;
  mode: "mainnet";
  originChainId: "1";
  sourceEid: 30101;
  destinationEid: 30316;
  sourceToken: Address;
  sourceAdapter: Address;
  destinationOft: Address;
  destinationToken: Address;
  sourceRpcUrl: string;
  destinationRpcUrl: string;
};

const wbtcEthereumToHedera: DirectRoute = {
  id: "ethereum-wbtc-to-hedera-wbtc-oft-v2",
  mode: "mainnet",
  originChainId: "1",
  sourceEid: 30101,
  destinationEid: 30316,
  sourceToken: getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
  sourceAdapter: getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c"),
  destinationOft: getAddress("0xD7D4d91d64a6061fA00a94E2b3A2D2A5FB677849"),
  destinationToken: getAddress("0xD7D4d91d64a6061fA00a94E2b3A2D2A5FB677849"),
  sourceRpcUrl: "https://ethereum-rpc.publicnode.com",
  destinationRpcUrl: "https://mainnet.hashio.io/api",
};

const usdt0EthereumToHedera: DirectRoute = {
  id: "ethereum-usdt-to-hedera-usdt0-oft-v3",
  mode: "mainnet",
  originChainId: "1",
  sourceEid: 30101,
  destinationEid: 30316,
  sourceToken: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  sourceAdapter: getAddress("0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee"),
  destinationOft: getAddress("0xe3119e23fc2371d1e6b01775ba312035425a53d6"),
  destinationToken: getAddress("0x00000000000000000000000000000000009ce723"),
  sourceRpcUrl: "https://ethereum-rpc.publicnode.com",
  destinationRpcUrl: "https://mainnet.hashio.io/api",
};

const directRoutes = [wbtcEthereumToHedera, usdt0EthereumToHedera] as const;

const ethereumNativeEthToHederaWeth = {
  id: "ethereum-native-eth-to-hedera-weth-stargate-v2-taxi",
  mode: "mainnet" as const,
  originChainId: "1" as const,
  sourceEid: 30101 as const,
  destinationEid: 30316 as const,
  sourceToken: getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"),
  sourcePool: getAddress("0x77b2043768d28E9C9aB44E1aBfC95944bcE57931"),
  sourceTokenMessaging: getAddress("0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980"),
  destinationStargate: getAddress("0xda6087E69C51E7D31b6DBAD276a3c44703DFdCAd"),
  destinationTokenMessaging: getAddress("0x8a2B28364102Bea189D99A475C494330Ef2bDD0B"),
  destinationToken: getAddress("0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2"),
  sourceRpcUrl: "https://ethereum-rpc.publicnode.com",
  destinationRpcUrl: "https://mainnet.hashio.io/api",
};

function routeFor(input: {
  mode: string;
  originChainId: string;
  originToken: Address;
  destinationToken: Address;
}): DirectRoute | null {
  return directRoutes.find((route) =>
    input.mode === route.mode &&
    input.originChainId === route.originChainId &&
    input.originToken.toLowerCase() === route.sourceToken.toLowerCase() &&
    input.destinationToken.toLowerCase() === route.destinationToken.toLowerCase()
  ) ?? null;
}

export function hasLayerZeroDirectRoute(mode: string): boolean {
  return directRoutes.some((route) => route.mode === mode);
}

export function hasLayerZeroDirectRouteForAsset(input: {
  mode: string;
  originTokens?: { chainId: string; address: Address }[];
  destinationToken: Address;
}): boolean {
  return (input.originTokens ?? []).some((origin) => routeFor({
    mode: input.mode,
    originChainId: origin.chainId,
    originToken: origin.address,
    destinationToken: input.destinationToken,
  }) !== null || (
    input.mode === ethereumNativeEthToHederaWeth.mode &&
    origin.chainId === ethereumNativeEthToHederaWeth.originChainId &&
    origin.address.toLowerCase() === ethereumNativeEthToHederaWeth.sourceToken.toLowerCase() &&
    input.destinationToken.toLowerCase() === ethereumNativeEthToHederaWeth.destinationToken.toLowerCase()
  ));
}

export type DirectOftQuote = {
  quoteId: string;
  routeId: string;
  source: "layerzero-oft-v2" | "stargate-v2-taxi";
  expectedDestinationAmount: string;
  minimumDestinationAmount: string;
  nativeFee: string;
  transactionValue: string;
  sourceAdapter: Address;
  transactionData: Hex;
  approvalRequired: boolean;
  nativeSource: boolean;
  evidence: Record<string, unknown>;
};

type LayerZeroReadClient = {
  readContract: (input: any) => Promise<any>;
  getCode?: (input: { address: Address }) => Promise<Hex | undefined>;
};

type LayerZeroReadClients = {
  source: LayerZeroReadClient;
  destination: LayerZeroReadClient;
};

function hasCode(code: Hex | undefined): boolean {
  return typeof code === "string" && code !== "0x";
}

async function quoteStargateNativeDirect(input: {
  mode: string;
  originChainId: string;
  originToken: Address;
  destinationToken: Address;
  account: Address;
  amount: bigint;
  slippageBps: number;
}, clients?: LayerZeroReadClients): Promise<DirectOftQuote | null> {
  const route = ethereumNativeEthToHederaWeth;
  if (
    input.mode !== route.mode ||
    input.originChainId !== route.originChainId ||
    input.originToken.toLowerCase() !== route.sourceToken.toLowerCase() ||
    input.destinationToken.toLowerCase() !== route.destinationToken.toLowerCase()
  ) return null;
  const sourceRpcUrl = process.env.LAYERZERO_ETHEREUM_RPC_URL ?? route.sourceRpcUrl;
  const destinationRpcUrl = process.env.LAYERZERO_HEDERA_RPC_URL ?? route.destinationRpcUrl;
  for (const [name, value, allowed] of [
    ["source", sourceRpcUrl, ["ethereum-rpc.publicnode.com"]],
    ["destination", destinationRpcUrl, ["mainnet.hashio.io", "295.rpc.thirdweb.com"]],
  ] as const) {
    const url = new URL(value);
    if (url.protocol !== "https:" || (!(allowed as readonly string[]).includes(url.hostname) && process.env.ALLOW_CUSTOM_PROVIDER_HOSTS !== "1")) {
      throw new Error(`LayerZero ${name} RPC route is not allowed`);
    }
  }
  const source = clients?.source ?? createPublicClient({ transport: http(sourceRpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const destination = clients?.destination ?? createPublicClient({ transport: http(destinationRpcUrl, { timeout: 15_000, retryCount: 0 }) });
  if (!source.getCode || !destination.getCode) throw new Error("Stargate native route code verification is unavailable");
  const [
    sourcePoolCode,
    destinationStargateCode,
    destinationTokenCode,
    sourceMessagingCode,
    destinationMessagingCode,
    sourceToken,
    sourceLocalEid,
    sourceSharedDecimals,
    sourceType,
    sourceCredit,
    sourceConfig,
    destinationContractToken,
    destinationLocalEid,
    destinationSharedDecimals,
    destinationType,
    destinationCredit,
    destinationConfig,
    sourceMessagingPeer,
    destinationMessagingPeer,
  ] = await Promise.all([
    source.getCode({ address: route.sourcePool }),
    destination.getCode({ address: route.destinationStargate }),
    destination.getCode({ address: route.destinationToken }),
    source.getCode({ address: route.sourceTokenMessaging }),
    destination.getCode({ address: route.destinationTokenMessaging }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "token" }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "localEid" }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "sharedDecimals" }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "stargateType" }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "paths", args: [route.destinationEid] }),
    source.readContract({ address: route.sourcePool, abi: oftAbi, functionName: "getAddressConfig" }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "token" }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "localEid" }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "sharedDecimals" }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "stargateType" }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "paths", args: [route.sourceEid] }),
    destination.readContract({ address: route.destinationStargate, abi: oftAbi, functionName: "getAddressConfig" }),
    source.readContract({ address: route.sourceTokenMessaging, abi: oftAbi, functionName: "peers", args: [route.destinationEid] }),
    destination.readContract({ address: route.destinationTokenMessaging, abi: oftAbi, functionName: "peers", args: [route.sourceEid] }),
  ]);
  if (
    ![sourcePoolCode, destinationStargateCode, destinationTokenCode, sourceMessagingCode, destinationMessagingCode].every(hasCode) ||
    sourceToken.toLowerCase() !== "0x0000000000000000000000000000000000000000" ||
    Number(sourceLocalEid) !== route.sourceEid ||
    Number(destinationLocalEid) !== route.destinationEid ||
    Number(sourceSharedDecimals) !== 6 ||
    Number(destinationSharedDecimals) !== 6 ||
    Number(sourceType) !== 0 ||
    Number(destinationType) !== 1 ||
    BigInt(sourceCredit) <= 0n ||
    BigInt(destinationCredit) <= 0n ||
    sourceConfig.tokenMessaging.toLowerCase() !== route.sourceTokenMessaging.toLowerCase() ||
    destinationConfig.tokenMessaging.toLowerCase() !== route.destinationTokenMessaging.toLowerCase() ||
    destinationContractToken.toLowerCase() !== route.destinationToken.toLowerCase() ||
    sourceMessagingPeer.toLowerCase() !== pad(route.destinationTokenMessaging, { size: 32 }).toLowerCase() ||
    destinationMessagingPeer.toLowerCase() !== pad(route.sourceTokenMessaging, { size: 32 }).toLowerCase()
  ) {
    throw new Error("Stargate native pool, OFT, token-messaging peer, or token identity changed");
  }
  const requestedMinimum = input.amount * BigInt(10_000 - input.slippageBps) / 10_000n;
  const requestedSendParam = {
    dstEid: route.destinationEid,
    to: pad(input.account, { size: 32 }),
    amountLD: input.amount,
    minAmountLD: requestedMinimum,
    extraOptions: "0x" as Hex,
    composeMsg: "0x" as Hex,
    oftCmd: "0x" as Hex,
  };
  const oftQuote = await source.readContract({
    address: route.sourcePool,
    abi: oftAbi,
    functionName: "quoteOFT",
    args: [requestedSendParam],
    account: input.account,
  });
  const [limit, oftFeeDetails, receipt] = oftQuote;
  if (
    input.amount < limit.minAmountLD ||
    input.amount > limit.maxAmountLD ||
    receipt.amountSentLD !== input.amount ||
    receipt.amountReceivedLD < requestedMinimum
  ) {
    throw new Error("Stargate native quote violates amount, shared-decimal, or slippage limits");
  }
  const sendParam = { ...requestedSendParam, minAmountLD: receipt.amountReceivedLD };
  const fee = await source.readContract({
    address: route.sourcePool,
    abi: oftAbi,
    functionName: "quoteSend",
    args: [sendParam, false],
    account: input.account,
  });
  const transactionData = encodeFunctionData({
    abi: oftAbi,
    functionName: "send",
    args: [sendParam, fee, input.account],
  });
  const transactionValue = receipt.amountSentLD + fee.nativeFee;
  const observedAt = new Date().toISOString();
  const evidence = {
    route: route.id,
    routeKind: "stargate-v2-taxi",
    sourceEid: route.sourceEid,
    destinationEid: route.destinationEid,
    sourcePool: route.sourcePool,
    sourceTokenMessaging: route.sourceTokenMessaging,
    destinationStargate: route.destinationStargate,
    destinationTokenMessaging: route.destinationTokenMessaging,
    destinationToken: route.destinationToken,
    sourceMessagingPeer,
    destinationMessagingPeer,
    sourceCredit: BigInt(sourceCredit).toString(),
    destinationCredit: BigInt(destinationCredit).toString(),
    amountSent: receipt.amountSentLD.toString(),
    amountReceived: receipt.amountReceivedLD.toString(),
    nativeFee: fee.nativeFee.toString(),
    transactionValue: transactionValue.toString(),
    oftFees: oftFeeDetails.map((entry: { feeAmountLD: bigint; description: string }) => ({
      amount: entry.feeAmountLD.toString(),
      description: entry.description,
    })),
    observedAt,
  };
  const quoteId = `direct-stargate-${crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
  return {
    quoteId,
    routeId: route.id,
    source: "stargate-v2-taxi",
    expectedDestinationAmount: receipt.amountReceivedLD.toString(),
    minimumDestinationAmount: receipt.amountReceivedLD.toString(),
    nativeFee: fee.nativeFee.toString(),
    transactionValue: transactionValue.toString(),
    sourceAdapter: route.sourcePool,
    transactionData,
    approvalRequired: false,
    nativeSource: true,
    evidence,
  };
}

export async function quoteLayerZeroDirect(input: {
  mode: string;
  originChainId: string;
  originToken: Address;
  destinationToken: Address;
  account: Address;
  amount: bigint;
  slippageBps: number;
}, clients?: LayerZeroReadClients): Promise<DirectOftQuote | null> {
  const route = routeFor(input);
  if (!route) return quoteStargateNativeDirect(input, clients);
  const sourceRpcUrl = process.env.LAYERZERO_ETHEREUM_RPC_URL ?? route.sourceRpcUrl;
  const destinationRpcUrl = process.env.LAYERZERO_HEDERA_RPC_URL ?? route.destinationRpcUrl;
  for (const [name, value, allowed] of [
    ["source", sourceRpcUrl, ["ethereum-rpc.publicnode.com"]],
    ["destination", destinationRpcUrl, ["mainnet.hashio.io", "295.rpc.thirdweb.com"]],
  ] as const) {
    const url = new URL(value);
    if (url.protocol !== "https:" || (!(allowed as readonly string[]).includes(url.hostname) && process.env.ALLOW_CUSTOM_PROVIDER_HOSTS !== "1")) {
      throw new Error(`LayerZero ${name} RPC route is not allowed`);
    }
  }
  const source = clients?.source ?? createPublicClient({ transport: http(sourceRpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const destination = clients?.destination ?? createPublicClient({ transport: http(destinationRpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const minimumDestinationAmount = input.amount * BigInt(10_000 - input.slippageBps) / 10_000n;
  const sendParam = {
    dstEid: route.destinationEid,
    to: pad(input.account, { size: 32 }),
    amountLD: input.amount,
    minAmountLD: minimumDestinationAmount,
    extraOptions: "0x" as Hex,
    composeMsg: "0x" as Hex,
    oftCmd: "0x" as Hex,
  };
  const [sourcePeer, destinationPeer, token, approvalRequired, fee, oftQuote] = await Promise.all([
    source.readContract({ address: route.sourceAdapter, abi: oftAbi, functionName: "peers", args: [route.destinationEid] }),
    destination.readContract({ address: route.destinationOft, abi: oftAbi, functionName: "peers", args: [route.sourceEid] }),
    source.readContract({ address: route.sourceAdapter, abi: oftAbi, functionName: "token" }),
    source.readContract({ address: route.sourceAdapter, abi: oftAbi, functionName: "approvalRequired" }),
    source.readContract({ address: route.sourceAdapter, abi: oftAbi, functionName: "quoteSend", args: [sendParam, false], account: input.account }),
    source.readContract({ address: route.sourceAdapter, abi: oftAbi, functionName: "quoteOFT", args: [sendParam], account: input.account }),
  ]);
  if (
    sourcePeer.toLowerCase() !== pad(route.destinationOft, { size: 32 }).toLowerCase() ||
    destinationPeer.toLowerCase() !== pad(route.sourceAdapter, { size: 32 }).toLowerCase() ||
    token.toLowerCase() !== route.sourceToken.toLowerCase()
  ) {
    throw new Error("LayerZero direct OFT peer or token identity changed");
  }
  const [limit, oftFeeDetails, receipt] = oftQuote;
  if (
    input.amount < limit.minAmountLD ||
    input.amount > limit.maxAmountLD ||
    receipt.amountSentLD !== input.amount ||
    receipt.amountReceivedLD < minimumDestinationAmount
  ) {
    throw new Error("LayerZero direct OFT quote violates amount limits");
  }
  const transactionData = encodeFunctionData({
    abi: oftAbi,
    functionName: "send",
    args: [sendParam, fee, input.account],
  });
  const observedAt = new Date().toISOString();
  const evidence = {
    route: route.id,
    sourceEid: route.sourceEid,
    destinationEid: route.destinationEid,
    sourceAdapter: route.sourceAdapter,
    destinationOft: route.destinationOft,
    sourcePeer,
    destinationPeer,
    amountSent: receipt.amountSentLD.toString(),
    amountReceived: receipt.amountReceivedLD.toString(),
    nativeFee: fee.nativeFee.toString(),
    lzTokenFee: fee.lzTokenFee.toString(),
    oftFees: oftFeeDetails.map((entry: { feeAmountLD: bigint; description: string }) => ({
      amount: entry.feeAmountLD.toString(),
      description: entry.description,
    })),
    observedAt,
  };
  const quoteId = `direct-oft-${crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
  return {
    quoteId,
    routeId: route.id,
    source: "layerzero-oft-v2",
    expectedDestinationAmount: receipt.amountReceivedLD.toString(),
    minimumDestinationAmount: minimumDestinationAmount.toString(),
    nativeFee: fee.nativeFee.toString(),
    transactionValue: fee.nativeFee.toString(),
    sourceAdapter: route.sourceAdapter,
    transactionData,
    approvalRequired,
    nativeSource: false,
    evidence,
  };
}

export function normalizeLayerZeroScanStatus(body: unknown): {
  state: "pending" | "arrived" | "failed" | "unknown";
  providerStatus: string;
  destinationTransactionHash: Hex | null;
} {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const rows = Array.isArray(record.data) ? record.data as Record<string, any>[] : [];
  if (rows.length === 0) return { state: "pending", providerStatus: "not_found", destinationTransactionHash: null };
  const row = rows[0]!;
  const status = String(row.status?.name ?? row.status ?? "unknown").toUpperCase();
  const destinationStatus = String(row.destination?.status ?? "unknown").toUpperCase();
  const hash = row.destination?.tx?.txHash;
  const destinationTransactionHash = typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash as Hex : null;
  if (status === "DELIVERED" && destinationStatus === "SUCCEEDED") {
    return { state: "arrived", providerStatus: "delivered", destinationTransactionHash };
  }
  if (["FAILED", "BLOCKED", "PAYLOAD_STORED", "APPLICATION_BURNED", "APPLICATION_SKIPPED", "UNRESOLVABLE_COMMAND", "MALFORMED_COMMAND"].includes(status) ||
      ["FAILED", "SIMULATION_REVERTED", "PAYLOAD_STORED"].includes(destinationStatus)) {
    return { state: "failed", providerStatus: status.toLowerCase(), destinationTransactionHash };
  }
  if (["INFLIGHT", "CONFIRMING"].includes(status)) {
    return { state: "pending", providerStatus: status.toLowerCase(), destinationTransactionHash };
  }
  return { state: "unknown", providerStatus: status.toLowerCase(), destinationTransactionHash };
}

export async function layerZeroScanStatus(sourceTransactionHash: Hex, fetcher: typeof fetch = fetch) {
  const base = process.env.LAYERZERO_SCAN_API_URL ?? "https://scan.layerzero-api.com/v1";
  const url = new URL(base);
  if (url.protocol !== "https:" || (url.hostname !== "scan.layerzero-api.com" && process.env.ALLOW_CUSTOM_PROVIDER_HOSTS !== "1")) {
    throw new Error("LayerZero Scan API route is not allowed");
  }
  const response = await fetcher(`${base.replace(/\/$/, "")}/messages/tx/${encodeURIComponent(sourceTransactionHash)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return normalizeLayerZeroScanStatus({ data: [] });
  if (!response.ok) throw new Error(`LayerZero Scan status unavailable (${response.status})`);
  return normalizeLayerZeroScanStatus(await response.json());
}
