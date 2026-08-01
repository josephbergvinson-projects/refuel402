import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  pad,
  type Address,
  type Hex,
} from "viem";

const sourceRpc = "https://ethereum-rpc.publicnode.com";
const destinationRpc = "https://mainnet.hashio.io/api";
const sourceEid = 30101;
const destinationEid = 30316;
const sourceToken = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
const destinationOft = getAddress("0xD7D4d91d64a6061fA00a94E2b3A2D2A5FB677849");
const wrapper = getAddress("0x000000000000000000000000000000000093a3a8");
const expectedHtsToken = getAddress("0x000000000000000000000000000000000099d925");
const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const amount = 10_000n;
const minimumAmount = 9_900n;

const abi = [
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
    ],
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
    outputs: [
      {
        name: "fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
    ],
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
    outputs: [
      {
        name: "msgReceipt",
        type: "tuple",
        components: [
          { name: "guid", type: "bytes32" },
          { name: "nonce", type: "uint64" },
          {
            name: "fee",
            type: "tuple",
            components: [
              { name: "nativeFee", type: "uint256" },
              { name: "lzTokenFee", type: "uint256" },
            ],
          },
        ],
      },
      {
        name: "oftReceipt",
        type: "tuple",
        components: [
          { name: "amountSentLD", type: "uint256" },
          { name: "amountReceivedLD", type: "uint256" },
        ],
      },
    ],
  },
] as const;

const wrapperAbi = [
  {
    type: "function",
    name: "htsCounterpart",
    stateMutability: "view",
    inputs: [{ name: "erc20Token", type: "address" }],
    outputs: [{ name: "htsToken", type: "address" }],
  },
  {
    type: "function",
    name: "rates",
    stateMutability: "view",
    inputs: [{ name: "erc20Token", type: "address" }],
    outputs: [{ name: "rate", type: "uint256" }],
  },
] as const;

const source = createPublicClient({ transport: http(sourceRpc) });
const destination = createPublicClient({ transport: http(destinationRpc) });
const metadata = await fetch("https://metadata.layerzero-api.com/v1/metadata").then((response) => response.json()) as any;
const candidates: Address[] = metadata.ethereum.tokens[sourceToken.toLowerCase()].proxyAddresses.map(
  (address: string) => address.toLowerCase() as Address,
);
const expectedDestinationPeer = pad(destinationOft, { size: 32 }).toLowerCase();
const expectedSourcePeers = new Set(candidates.map((candidate) => pad(candidate, { size: 32 }).toLowerCase()));
const sendParam = {
  dstEid: destinationEid,
  to: pad(account, { size: 32 }),
  amountLD: amount,
  minAmountLD: minimumAmount,
  extraOptions: "0x" as Hex,
  composeMsg: "0x" as Hex,
  oftCmd: "0x" as Hex,
};

const rows = [];
for (const candidate of candidates) {
  try {
    const [peer, token, approvalRequired] = await Promise.all([
      source.readContract({ address: candidate, abi, functionName: "peers", args: [destinationEid] }),
      source.readContract({ address: candidate, abi, functionName: "token" }),
      source.readContract({ address: candidate, abi, functionName: "approvalRequired" }),
    ]);
    rows.push({
      candidate,
      peer,
      destinationPeerMatch: peer.toLowerCase() === expectedDestinationPeer,
      token,
      sourceTokenMatch: token.toLowerCase() === sourceToken.toLowerCase(),
      approvalRequired,
    });
  } catch (error) {
    const diagnostic = error as Error & { shortMessage?: string };
    rows.push({ candidate, error: error instanceof Error ? diagnostic.shortMessage ?? error.message : String(error) });
  }
}

const selected = rows.find((row: any) => row.destinationPeerMatch && row.sourceTokenMatch)?.candidate as Address | undefined;
const destinationPeer = await destination.readContract({
  address: destinationOft,
  abi,
  functionName: "peers",
  args: [sourceEid],
});
const destinationSourcePeerMatch = expectedSourcePeers.has(destinationPeer.toLowerCase());
if (!selected || !destinationSourcePeerMatch) {
  console.log(JSON.stringify({ sourceEid, destinationEid, sourceToken, destinationOft, rows, destinationPeer, destinationSourcePeerMatch }, null, 2));
  process.exitCode = 2;
} else {
  const [fee, oftQuote, htsCounterpart, wrapperRate, tokenMetadata] = await Promise.all([
    source.readContract({
      address: selected,
      abi,
      functionName: "quoteSend",
      args: [sendParam, false],
      account,
    }),
    source.readContract({
      address: selected,
      abi,
      functionName: "quoteOFT",
      args: [sendParam],
      account,
    }),
    destination.readContract({
      address: wrapper,
      abi: wrapperAbi,
      functionName: "htsCounterpart",
      args: [destinationOft],
    }),
    destination.readContract({
      address: wrapper,
      abi: wrapperAbi,
      functionName: "rates",
      args: [destinationOft],
    }),
    fetch("https://mainnet-public.mirrornode.hedera.com/api/v1/tokens/0.0.10082597").then((response) => response.json()) as Promise<Record<string, unknown>>,
  ]);
  const { nativeFee, lzTokenFee } = fee;
  const [limit, oftFeeDetails, receipt] = oftQuote;
  const transactionData = encodeFunctionData({
    abi,
    functionName: "send",
    args: [sendParam, { nativeFee, lzTokenFee }, account],
  });
  console.log(JSON.stringify({
    sourceEid,
    destinationEid,
    sourceToken,
    sourceAdapter: selected,
    destinationOft,
    destinationPeer,
    destinationSourcePeerMatch,
    amount: amount.toString(),
    minimumAmount: minimumAmount.toString(),
    quoteOFT: {
      minimum: limit.minAmountLD.toString(),
      maximum: limit.maxAmountLD.toString(),
      fees: oftFeeDetails.map((entry) => ({ amount: entry.feeAmountLD.toString(), description: entry.description })),
      amountSent: receipt.amountSentLD.toString(),
      amountReceived: receipt.amountReceivedLD.toString(),
    },
    nativeFee: nativeFee.toString(),
    lzTokenFee: lzTokenFee.toString(),
    approval: { token: sourceToken, spender: selected, amount: amount.toString() },
    transaction: { to: selected, data: transactionData, value: nativeFee.toString() },
    wrapper: {
      address: wrapper,
      htsCounterpart,
      htsCounterpartMatch: htsCounterpart.toLowerCase() === expectedHtsToken.toLowerCase(),
      rate: wrapperRate.toString(),
      tokenId: tokenMetadata.token_id,
      decimals: tokenMetadata.decimals,
      adminKey: tokenMetadata.admin_key,
      freezeKey: tokenMetadata.freeze_key,
      kycKey: tokenMetadata.kyc_key,
      pauseKey: tokenMetadata.pause_key,
      supplyKey: tokenMetadata.supply_key,
      wipeKey: tokenMetadata.wipe_key,
      treasuryAccountId: tokenMetadata.treasury_account_id,
      freezeDefault: tokenMetadata.freeze_default,
      deleted: tokenMetadata.deleted,
    },
    candidates: rows,
  }, null, 2));
}
