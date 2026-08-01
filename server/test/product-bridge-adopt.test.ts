import { describe, expect, it, vi } from "vitest";
import { hashTypedData, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bridgeAdoptionTypedData } from "../src/bridge-adoption-witness.js";
import { MirrorLedgerDepthError, createProductBridgeTracker } from "../src/product-bridge.js";
import type { ProductJourneyRecord, StoredProductQuote } from "../src/product-lifecycle-store.js";

const owner = privateKeyToAccount(`0x${"7c".repeat(32)}`);
const account = owner.address;
const journeyId = "adopt-journey-1";
const sourceTransactionHash = `0x${"12".repeat(32)}` as Hex;
const boundaryAt = 1_785_022_894_000;
const boundaryFrom = "1785022894.000000000";
const creditAt = "1785022901.893723365";
const creditHashBase64 = Buffer.from("adopted-destination-credit").toString("base64");
const creditHashHex = `0x${Buffer.from("adopted-destination-credit").toString("hex")}`;
const accountId = "0.0.1001";
const tokenId = "0.0.10285486";

const nanos = (value: string) => {
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction!.padEnd(9, "0"));
};
const at = (value: bigint) => `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, "0")}`;

function consent(overrides: Partial<Parameters<typeof bridgeAdoptionTypedData>[0]> = {}) {
  return bridgeAdoptionTypedData({
    journeyId,
    account,
    sourceTransactionHash,
    mode: "mainnet",
    ...overrides,
  });
}

const confirm = (overrides?: Partial<Parameters<typeof bridgeAdoptionTypedData>[0]>) =>
  owner.signTypedData(consent(overrides));

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
      routeMode: "bridge_plus_refuel",
      asset: {
        destination: { standard: "HTS", tokenId, address: "0x00000000000000000000000000000000009cf1ae", decimals: 6 },
      },
      bridge: {
        provider: "axelar",
        quoteId: "squid-route-1",
        expectedDestinationAmount: "3000000",
        minimumDestinationAmount: "2970000",
      },
    },
  };
}

function journey(events: ProductJourneyRecord["events"] = []): ProductJourneyRecord {
  return {
    id: journeyId,
    quoteId: quote().quoteId,
    mode: "mainnet",
    account,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:mainnet:usdc",
    originChainId: "1",
    state: "bridge_ready",
    createdAt: boundaryAt - 60_000,
    updatedAt: boundaryAt,
    payment: null,
    authorizations: [],
    submissions: [],
    events: [
      { id: 1, type: "bridge_wallet_boundary", record: { kind: "bridge" }, createdAt: boundaryAt },
      ...events,
    ],
  };
}

function credit(overrides: Partial<{
  transactionId: string;
  consensusTimestamp: string;
  tokenId: string;
  accountId: string;
  amount: bigint;
}> = {}) {
  return {
    transactionId: "0.0.6319439-1785022894-997522183",
    transactionHash: creditHashBase64,
    consensusTimestamp: creditAt,
    tokenId,
    accountId,
    amount: 3_000_000n,
    ...overrides,
  };
}

function fixture(input: {
  journey?: ProductJourneyRecord;
  credits?: ReturnType<typeof credit>[];
  /** Credits the first page misses; only an anchored re-read can identify them. */
  anchoredCredits?: ReturnType<typeof credit>[];
  ledger?: Array<{ consensusTimestamp: string; amount: bigint }>;
  ledgerThrows?: Error;
  bound?: string[];
  currentBalance?: number;
  deltas?: Array<{ consensusTimestamp: string; amount: bigint }>;
  providerState?: "pending" | "arrived" | "failed" | "unknown";
  providerDestinationHash?: Hex | null;
  providerThrows?: boolean;
} = {}) {
  const current = input.journey ?? journey();
  const firstPage = input.credits ?? [credit()];
  const anchoredCredits = input.anchoredCredits ?? [];
  const adoptBridgeSubmission = vi.fn(async () => ({ ...current, state: "arrival_confirmed" as const }));
  const store = {
    getJourney: vi.fn(async () => current),
    getQuote: vi.fn(async () => quote()),
    boundArrivalTransactionIds: vi.fn(async () => new Set(input.bound ?? [])),
    adoptBridgeSubmission,
  };
  const mirror = {
    account: vi.fn(async () => ({
      account: accountId,
      evm_address: account,
      ethereum_nonce: 0,
      key: null,
      balance: {
        balance: 10_000_000,
        tokens: [{ token_id: tokenId, balance: input.currentBalance ?? 9_000_000 }],
      },
    })),
    // The real index returns one page from the cursor; an anchored cursor lands
    // exactly on the transaction one nanosecond after it.
    tokenCreditsAfter: vi.fn(async (request: { consensusTimestamp: string }) =>
      request.consensusTimestamp === boundaryFrom
        ? firstPage
        : anchoredCredits.filter((row) => nanos(row.consensusTimestamp) === nanos(request.consensusTimestamp) + 1n)),
    ethCall: vi.fn(),
  };
  const transferStatus = vi.fn(async () => {
    if (input.providerThrows) throw new Error("provider unavailable");
    return {
      provider: "axelar" as const,
      state: input.providerState ?? "pending" as const,
      sourceTransactionHash,
      destinationTransactionHash: input.providerDestinationHash ?? null,
      providerStatus: "ongoing",
      providerUrl: "https://axelarscan.io/fixture",
      observedAt: new Date().toISOString(),
    };
  });
  // The signed ledger sees every transfer of this account+token, whichever page
  // of the credit index happens to carry it.
  const ledger = input.ledger ?? [...firstPage, ...anchoredCredits]
    .filter((row) => row.accountId === accountId && row.tokenId === tokenId)
    .map((row) => ({ consensusTimestamp: row.consensusTimestamp, amount: row.amount }));
  const tokenTransfersSince = vi.fn(async (
    _mirror: unknown,
    _accountId: string,
    _tokenId: string,
    _from: string,
    until?: string,
  ) => {
    if (!until) {
      return input.deltas ?? [
        { consensusTimestamp: creditAt, amount: 3_000_000n },
        { consensusTimestamp: "1785022999.000000001", amount: 3_000_000n },
      ];
    }
    if (input.ledgerThrows) throw input.ledgerThrows;
    return ledger;
  });
  const tracker = createProductBridgeTracker({
    store: store as any,
    mirrors: { testnet: mirror as any, mainnet: mirror as any },
    transferStatus,
    tokenTransfersSince: tokenTransfersSince as any,
  });
  return { tracker, store, mirror, transferStatus, tokenTransfersSince, adoptBridgeSubmission };
}

describe("bridge source-hash adoption evidence", () => {
  it("binds one unbound matching credit and replays the ledger for the pre-credit balance", async () => {
    const { tracker, adoptBridgeSubmission } = fixture();
    const adopted = await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(adopted.state).toBe("arrival_confirmed");
    expect(adoptBridgeSubmission).toHaveBeenCalledTimes(1);
    expect(adoptBridgeSubmission).toHaveBeenCalledWith(expect.objectContaining({
      journeyId,
      sourceTransactionHash,
      // 9,000,000 current minus 6,000,000 net since the credit, NOT the current balance
      destinationBalanceBefore: "3000000",
      hbarBalanceBefore: "10000000",
      amountCriterion: "exact",
      credit: expect.objectContaining({
        transactionId: "0.0.6319439-1785022894-997522183",
        transactionHash: creditHashHex,
        amount: "3000000",
      }),
    }));
  });

  it("rejects with NO_MATCHING_CREDIT when nothing matches", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({ credits: [credit({ amount: 1n })] });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "NO_MATCHING_CREDIT" });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("never auto-picks among multiple matching credits", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({
      credits: [credit(), credit({ transactionId: "0.0.6319439-1785022894-997522184", consensusTimestamp: "1785022955.000000001" })],
    });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "AMBIGUOUS_CREDIT" });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("excludes credits already bound to any journey arrival for the account", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({
      credits: [credit({ transactionId: "already-bound" }), credit()],
      bound: ["already-bound"],
    });
    await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(adoptBridgeSubmission).toHaveBeenCalledWith(expect.objectContaining({
      credit: expect.objectContaining({ transactionId: "0.0.6319439-1785022894-997522183" }),
    }));
  });

  it.each([
    ["pre-boundary consensus", { credits: [credit({ consensusTimestamp: "1785022893.999999999" })] }],
    ["outside the 72h window", { credits: [credit({ consensusTimestamp: "1785282095.000000001" })] }],
    ["wrong recipient", { credits: [credit({ accountId: "0.0.999" })] }],
    ["wrong token", { credits: [credit({ tokenId: "0.0.999" })] }],
  ])("rejects a credit with %s", async (_label, input) => {
    const { tracker } = fixture(input);
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "NO_MATCHING_CREDIT" });
  });

  it.each([
    ["an unavailable provider observation", { providerThrows: true }],
    ["a failed provider state", { providerState: "failed" as const }],
    ["an unknown provider state", { providerState: "unknown" as const }],
    ["a provider destination hash that contradicts the credit", { providerDestinationHash: `0x${"ee".repeat(32)}` as Hex }],
  ])("fails closed on %s", async (_label, input) => {
    const { tracker, adoptBridgeSubmission } = fixture(input);
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("accepts a provider destination hash that matches the credit", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({ providerDestinationHash: creditHashHex as Hex, providerState: "arrived" });
    await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(adoptBridgeSubmission).toHaveBeenCalledTimes(1);
  });

  it("points an already-submitted journey at the bridge poll instead of adopting", async () => {
    const submitted = journey([{ id: 2, type: "bridge_submitted", record: { sourceTransactionHash }, createdAt: boundaryAt + 1 }]);
    const { tracker } = fixture({ journey: { ...submitted, state: "bridge_pending" } });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm())).rejects.toMatchObject({
      code: "JOURNEY_STATE_CONFLICT",
      message: expect.stringContaining("GET /v1/product/journeys/:id/bridge"),
    });
  });

  it("replays an identical adoption without touching the store", async () => {
    const adoptedJourney = journey([
      { id: 2, type: "bridge_submission_adopted", record: { sourceTransactionHash }, createdAt: boundaryAt + 1 },
      { id: 3, type: "bridge_submitted", record: { sourceTransactionHash }, createdAt: boundaryAt + 2 },
      { id: 4, type: "bridge_arrived", record: { sourceTransactionHash }, createdAt: boundaryAt + 3 },
    ]);
    const { tracker, adoptBridgeSubmission } = fixture({ journey: { ...adoptedJourney, state: "arrival_confirmed" } });
    const replay = await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(replay.state).toBe("arrival_confirmed");
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
    const otherHash = `0x${"34".repeat(32)}` as Hex;
    const different = fixture({ journey: { ...adoptedJourney, state: "arrival_confirmed" } });
    await expect(different.tracker.adopt(journeyId, otherHash, await confirm({ sourceTransactionHash: otherHash })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("requires a recorded bridge wallet boundary", async () => {
    const bare = journey();
    const { tracker } = fixture({ journey: { ...bare, events: [] } });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "JOURNEY_STATE_CONFLICT" });
  });
});

describe("bridge adoption owner consent", () => {
  it("records the consent artifact instead of a bare confirmation flag", async () => {
    const { tracker, adoptBridgeSubmission } = fixture();
    const confirmation = await confirm();
    await tracker.adopt(journeyId, sourceTransactionHash, confirmation);
    expect(adoptBridgeSubmission).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        consentDigest: hashTypedData(consent()),
        consentSignature: confirmation,
        consentSignatureHash: keccak256(confirmation),
        ledgerMatchCount: 1,
        anchoredCreditPages: 0,
      }),
    }));
  });

  it.each([
    ["another wallet", async () => privateKeyToAccount(`0x${"5d".repeat(32)}`).signTypedData(consent())],
    ["a different source hash", async () => confirm({ sourceTransactionHash: `0x${"99".repeat(32)}` as Hex })],
    ["a different journey", async () => confirm({ journeyId: "adopt-journey-2" })],
    ["the other network's domain", async () => confirm({ mode: "testnet" })],
    ["a truncated signature", async () => `0x${"ab".repeat(32)}` as Hex],
    ["a well-formed but unrecoverable signature", async () => `0x${"00".repeat(65)}` as Hex],
  ])("refuses consent signed over %s", async (_label, sign) => {
    const { tracker, store, mirror, transferStatus, adoptBridgeSubmission } = fixture();
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await sign() as Hex))
      .rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    // Fail closed before the journey is touched, observed, or bound.
    expect(transferStatus).not.toHaveBeenCalled();
    expect(mirror.account).not.toHaveBeenCalled();
    expect(store.boundArrivalTransactionIds).not.toHaveBeenCalled();
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("refuses to replay an already adopted hash without consent", async () => {
    const adoptedJourney = journey([
      { id: 2, type: "bridge_submission_adopted", record: { sourceTransactionHash }, createdAt: boundaryAt + 1 },
    ]);
    const { tracker } = fixture({ journey: { ...adoptedJourney, state: "arrival_confirmed" } });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, `0x${"11".repeat(65)}` as Hex))
      .rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
  });
});

describe("bridge adoption credit paging", () => {
  it("identifies a matching credit that falls past the first credit page", async () => {
    const { tracker, mirror, adoptBridgeSubmission } = fixture({ credits: [], anchoredCredits: [credit()] });
    await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(mirror.tokenCreditsAfter).toHaveBeenNthCalledWith(2, expect.objectContaining({
      // one nanosecond before the ledger credit, so its transaction heads the page
      consensusTimestamp: at(nanos(creditAt) - 1n),
    }));
    expect(adoptBridgeSubmission).toHaveBeenCalledWith(expect.objectContaining({
      credit: expect.objectContaining({ consensusTimestamp: creditAt }),
      evidence: expect.objectContaining({ anchoredCreditPages: 1 }),
    }));
  });

  it("stays ambiguous rather than reporting NO_MATCHING_CREDIT when the index cannot identify a ledger credit", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({
      credits: [],
      ledger: [{ consensusTimestamp: creditAt, amount: 3_000_000n }],
    });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "AMBIGUOUS_CREDIT", message: expect.stringContaining("cannot identify") });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("stays undetermined when the windowed ledger walk exhausts its page budget", async () => {
    const { tracker, adoptBridgeSubmission } = fixture({
      ledgerThrows: new MirrorLedgerDepthError("too deep"),
    });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "AMBIGUOUS_CREDIT", message: expect.stringContaining("page budget") });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("stays undetermined when matching credits outrun the anchored page budget", async () => {
    const anchoredCredits = Array.from({ length: 9 }, (_, index) => credit({
      transactionId: `0.0.6319439-1785022894-99752220${index}`,
      consensusTimestamp: at(nanos(creditAt) + BigInt(index + 1) * 1_000_000_000n),
    }));
    const { tracker, adoptBridgeSubmission } = fixture({ credits: [], anchoredCredits });
    await expect(tracker.adopt(journeyId, sourceTransactionHash, await confirm()))
      .rejects.toMatchObject({ code: "AMBIGUOUS_CREDIT", message: expect.stringContaining("page budget") });
    expect(adoptBridgeSubmission).not.toHaveBeenCalled();
  });

  it("bounds the ledger scan to the adoption window", async () => {
    const { tracker, tokenTransfersSince } = fixture();
    await tracker.adopt(journeyId, sourceTransactionHash, await confirm());
    expect(tokenTransfersSince).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      accountId,
      tokenId,
      boundaryFrom,
      at(nanos(boundaryFrom) + 72n * 3_600n * 1_000_000_000n),
    );
    // The pre-credit balance replay still anchors on the matched credit, unbounded.
    expect(tokenTransfersSince).toHaveBeenNthCalledWith(2, expect.anything(), accountId, tokenId, creditAt);
  });
});
