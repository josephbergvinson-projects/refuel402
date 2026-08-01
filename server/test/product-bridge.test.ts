import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { createProductBridgeTracker } from "../src/product-bridge.js";
import type { ProductJourneyRecord, StoredProductQuote } from "../src/product-lifecycle-store.js";

const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const sourceTransactionHash = `0x${"12".repeat(32)}` as Hex;
const submittedAt = 1_785_022_894_000;
const destinationHashBase64 = Buffer.from("destination-transaction-hash").toString("base64");

function quote(): StoredProductQuote {
  return {
    quoteId: "q".repeat(64),
    mode: "mainnet",
    account,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:mainnet:usdc",
    originChainId: "1",
    expiresAt: Math.floor(Date.now() / 1_000) + 600,
    executable: true,
    record: {
      schema: "refuel402.combined-quote.v1",
      routeMode: "bridge_plus_refuel",
      asset: {
        destination: {
          standard: "HTS",
          tokenId: "0.0.10285486",
          address: "0x00000000000000000000000000000000009cf1ae",
          decimals: 6,
        },
      },
      bridge: {
        provider: "axelar",
        quoteId: "squid-route-1",
        fromAddress: account,
        toAddress: account,
        expectedDestinationAmount: "3000000",
        minimumDestinationAmount: "2970000",
        normalized: {
          destinationAsset: { tokenId: "0.0.10285486" },
          evidence: {
            source: "squid-v2",
            routeId: "route-1",
            responseHash: "response-1",
          },
        },
      },
    },
  };
}

function journey(): ProductJourneyRecord {
  return {
    id: "4530d34f-dda4-4183-86b4-4fb4df48b3d6",
    quoteId: quote().quoteId,
    mode: "mainnet",
    account,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:mainnet:usdc",
    originChainId: "1",
    state: "bridge_pending",
    createdAt: submittedAt - 60_000,
    updatedAt: submittedAt,
    payment: null,
    authorizations: [],
    submissions: [],
    events: [{
      id: 1,
      type: "bridge_submitted",
      record: {
        sourceTransactionHash,
        destinationBalanceBefore: "3000000",
        hbarBalanceBefore: "10000000",
      },
      createdAt: submittedAt,
    }],
  };
}

function fixture(input: {
  currentBalance?: number;
  credits?: Array<{ accountId?: string; tokenId?: string; amount?: bigint; consensusTimestamp?: string }>;
  providerState?: "pending" | "arrived";
} = {}) {
  let current = journey();
  const recordBridgeArrival = vi.fn(async (arrival: Record<string, unknown>) => {
    current = {
      ...current,
      state: "arrival_confirmed",
      events: [...current.events, { id: 2, type: "bridge_arrived", record: arrival, createdAt: submittedAt + 1_000 }],
    };
    return current;
  });
  const store = {
    getJourney: vi.fn(async () => current),
    getQuote: vi.fn(async () => quote()),
    recordBridgeArrival,
    completeBridgeOnly: vi.fn(async () => current),
  };
  const mirror = {
    account: vi.fn(async () => ({
      account: "0.0.1001",
      evm_address: account,
      ethereum_nonce: 0,
      key: null,
      balance: {
        balance: 10_000_000,
        tokens: [{ token_id: "0.0.10285486", balance: input.currentBalance ?? 6_000_000 }],
      },
    })),
    tokenCreditsAfter: vi.fn(async () => (input.credits ?? [{ amount: 3_000_000n }]).map((credit, index) => ({
      transactionId: `0.0.6319439-1785022894-${997522183 + index}`,
      transactionHash: destinationHashBase64,
      consensusTimestamp: credit.consensusTimestamp ?? `1785022901.89372336${5 + index}`,
      tokenId: credit.tokenId ?? "0.0.10285486",
      accountId: credit.accountId ?? "0.0.1001",
      amount: credit.amount ?? 3_000_000n,
    }))),
    ethCall: vi.fn(),
  };
  const transferStatus = vi.fn(async () => ({
    provider: "axelar" as const,
    state: input.providerState ?? "pending" as const,
    sourceTransactionHash,
    destinationTransactionHash: null,
    providerStatus: input.providerState === "arrived" ? "success" : "ongoing",
    providerUrl: "https://axelarscan.io/fixture",
    observedAt: new Date().toISOString(),
  }));
  const tracker = createProductBridgeTracker({
    store: store as any,
    mirrors: { testnet: mirror as any, mainnet: mirror as any },
    transferStatus,
  });
  return { tracker, store, mirror, recordBridgeArrival, transferStatus };
}

describe("chain-authoritative product bridge reconciliation", () => {
  it("advances once from a unique post-submission HTS credit while provider indexing lags", async () => {
    const { tracker, recordBridgeArrival, transferStatus } = fixture();
    const first = await tracker.status(journey().id);
    expect(first.transfer).toMatchObject({ state: "arrived", providerStatus: "ongoing" });
    expect(first.arrival).toMatchObject({
      confirmed: true,
      chainAuthoritative: true,
      providerLagging: true,
      amountReceived: "3000000",
      expectedAmount: "3000000",
      minimumExpected: "2970000",
      expectedRecipient: account,
      expectedTokenId: "0.0.10285486",
      destinationTransactionId: "0.0.6319439-1785022894-997522183",
      amountCriterion: "exact",
      candidateCount: 1,
    });
    expect(recordBridgeArrival).toHaveBeenCalledTimes(1);
    expect(recordBridgeArrival).toHaveBeenCalledWith(expect.objectContaining({
      journeyId: journey().id,
      sourceTransactionHash,
      destinationBalanceBefore: "3000000",
      destinationBalanceAfter: "6000000",
      destinationAmountReceived: "3000000",
      providerState: "pending",
      providerStatus: "ongoing",
      providerLagging: true,
      consensusTimestamp: "1785022901.893723365",
      routeIdentity: expect.objectContaining({ quoteId: "squid-route-1", evidenceSource: "squid-v2" }),
    }));

    const replay = await tracker.status(journey().id);
    expect(replay.journey.state).toBe("arrival_confirmed");
    expect(recordBridgeArrival).toHaveBeenCalledTimes(1);
    expect(transferStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong recipient", { credits: [{ accountId: "0.0.999", amount: 3_000_000n }] }],
    ["wrong token", { credits: [{ tokenId: "0.0.999", amount: 3_000_000n }] }],
    ["wrong amount", { credits: [{ amount: 2_000_000n }] }],
    ["ambiguous duplicate credits", { credits: [{ amount: 3_000_000n }, { amount: 3_000_000n }] }],
    ["pre-submission consensus", { credits: [{ amount: 3_000_000n, consensusTimestamp: "1785022893.999999999" }] }],
    // `received` is a balance delta against a baseline frozen at submission, so
    // the older the journey the less that delta describes THIS transfer: any later
    // credit of the same size starts to look like an arrival. Tolerable when only
    // an open browser could trigger a poll; the sweeper now runs it unattended and
    // forever, so a coincidence days later would terminalize the journey against a
    // stranger's credit. Bounded by the same 72h window adopt() already uses.
    ["post-window consensus", { credits: [{ amount: 3_000_000n, consensusTimestamp: "1785282094.000000001" }] }],
  ])("keeps %s pending even when provider says arrived", async (_label, input) => {
    const { tracker, recordBridgeArrival } = fixture({ ...input, providerState: "arrived" });
    const result = await tracker.status(journey().id);
    expect(result.arrival.confirmed).toBe(false);
    expect(result.arrival.chainAuthoritative).toBe(false);
    expect(result.transfer.state).toBe("pending");
    expect(recordBridgeArrival).not.toHaveBeenCalled();
  });
});
