import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { resolveUnknownSubmission, type SubmissionEvidenceReader } from "../src/product-lifecycle.js";
import type { ProductAuthorizationRecord, ProductJourneyRecord } from "../src/product-lifecycle-store.js";

const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const target = getAddress("0x2222222222222222222222222222222222222222");
const rawTransactionHash = `0x${"ab".repeat(32)}` as Hex;
const calldata = "0x0a754de6" as Hex;
const nowSec = 1_785_022_894;

function journey(): ProductJourneyRecord {
  return {
    id: "journey-reconcile-1",
    quoteId: "a".repeat(64),
    mode: "testnet",
    account,
    requestedProvider: "auto",
    selectedProvider: "axelar",
    assetId: "axelar:testnet:usdc",
    originChainId: "11155111",
    state: "review",
    createdAt: nowSec * 1_000,
    updatedAt: nowSec * 1_000,
    payment: null,
    authorizations: [],
    submissions: [],
    events: [],
  };
}

function authorization(overrides: Partial<ProductAuthorizationRecord> = {}): ProductAuthorizationRecord {
  return {
    id: "auth-1",
    mode: "testnet",
    account,
    chainId: 296,
    nonce: 7,
    to: target,
    dataHash: keccak256(calldata),
    value: 0n,
    gasLimitMaximum: 100_000n,
    maxGasAllowanceTinybar: 1_000_000n,
    expiresAt: nowSec - 700,
    journeyId: "journey-reconcile-1",
    intentKind: "activation",
    rawTransactionHash,
    state: "unknown",
    ethereumHash: null,
    createdAt: nowSec * 1_000,
    updatedAt: nowSec * 1_000,
    ...overrides,
  };
}

function minedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: rawTransactionHash,
    from: account.toLowerCase(),
    to: target.toLowerCase(),
    nonce: 7,
    function_parameters: calldata,
    amount: 0,
    status: "0x1",
    ...overrides,
  };
}

function reader(overrides: Partial<SubmissionEvidenceReader> = {}): SubmissionEvidenceReader {
  return {
    contractResult: async () => null,
    account: async () => ({ ethereum_nonce: 0 }),
    contractResultByNonce: async () => null,
    ...overrides,
  };
}

function resolve(input: {
  authorization?: ProductAuthorizationRecord;
  reader?: SubmissionEvidenceReader;
  nowSec?: number;
}) {
  return resolveUnknownSubmission({
    journey: journey(),
    authorization: input.authorization ?? authorization(),
    reader: input.reader ?? reader(),
    nowSec: input.nowSec ?? nowSec,
  });
}

describe("mirror-evidence submission reconciliation", () => {
  it("resolves a mined matching success as submitted", async () => {
    const outcome = await resolve({ reader: reader({ contractResult: async () => minedResult() }) });
    expect(outcome).toMatchObject({ resolution: "submitted", ethereumHash: rawTransactionHash });
  });

  it("resolves a mined revert as rejected", async () => {
    const outcome = await resolve({ reader: reader({ contractResult: async () => minedResult({ status: "0x0" }) }) });
    expect(outcome).toMatchObject({ resolution: "rejected", reason: "mined_reverted" });
  });

  it.each([
    ["sender", { from: "0x9999999999999999999999999999999999999999" }],
    ["target", { to: "0x9999999999999999999999999999999999999999" }],
    ["nonce", { nonce: 8 }],
    ["calldata", { function_parameters: "0xdeadbeef" }],
    ["value", { amount: 1 }],
    ["unreadable value", { amount: { tinybar: "0" } }],
  ])("conflicts on a mined %s mismatch without any resolution", async (_label, overrides) => {
    const outcome = await resolve({ reader: reader({ contractResult: async () => minedResult(overrides) }) });
    expect(outcome.resolution).toBe("conflict");
  });

  it("treats missing or unprefixed mirror calldata as empty instead of throwing", async () => {
    for (const parameters of [undefined, "", "1234"]) {
      const outcome = await resolve({
        reader: reader({ contractResult: async () => minedResult({ function_parameters: parameters }) }),
      });
      expect(outcome.resolution).toBe("conflict");
    }
    const empty = authorization({ dataHash: keccak256("0x") });
    const outcome = await resolve({
      authorization: empty,
      reader: reader({ contractResult: async () => minedResult({ function_parameters: "" }) }),
    });
    expect(outcome.resolution).toBe("submitted");
  });

  it("stays ambiguous while the post-expiry grace window has not elapsed", async () => {
    const outcome = await resolve({ authorization: authorization({ expiresAt: nowSec - 500 }) });
    expect(outcome.resolution).toBe("ambiguous");
  });

  it("stays ambiguous when the mirror account state is unavailable", async () => {
    const outcome = await resolve({ reader: reader({ account: async () => null }) });
    expect(outcome.resolution).toBe("ambiguous");
  });

  it("rejects definitively when the account nonce proves nothing was broadcast", async () => {
    const outcome = await resolve({ reader: reader({ account: async () => ({ ethereum_nonce: 7 }) }) });
    expect(outcome).toMatchObject({ resolution: "rejected", reason: "expired_never_broadcast" });
  });

  it("stays ambiguous when the nonce occupier cannot be fetched", async () => {
    const outcome = await resolve({ reader: reader({ account: async () => ({ ethereum_nonce: 8 }) }) });
    expect(outcome.resolution).toBe("ambiguous");
  });

  it("rejects when the nonce was consumed by a provably different transaction", async () => {
    const outcome = await resolve({
      reader: reader({
        account: async () => ({ ethereum_nonce: 8 }),
        contractResultByNonce: async () => minedResult({ hash: `0x${"cd".repeat(32)}`, function_parameters: "0xdeadbeef" }),
      }),
    });
    expect(outcome).toMatchObject({ resolution: "rejected", reason: "nonce_occupied_by_different_transaction" });
  });

  it("adopts a nonce occupier only when it is the same raw transaction", async () => {
    const outcome = await resolve({
      reader: reader({
        account: async () => ({ ethereum_nonce: 8 }),
        contractResultByNonce: async () => minedResult(),
      }),
    });
    expect(outcome).toMatchObject({ resolution: "submitted", ethereumHash: rawTransactionHash });
  });

  it("never adopts a same-intent sibling transaction that occupies the nonce", async () => {
    // Same to/nonce/calldata, different raw transaction: adopting it would mark
    // two authorizations submitted under one hash and wedge the journey.
    const outcome = await resolve({
      reader: reader({
        account: async () => ({ ethereum_nonce: 8 }),
        contractResultByNonce: async () => minedResult({ hash: `0x${"cd".repeat(32)}` }),
      }),
    });
    expect(outcome).toMatchObject({ resolution: "rejected", reason: "nonce_occupied_by_different_transaction" });
  });

  it("does not throw when the nonce occupier has empty calldata", async () => {
    const outcome = await resolve({
      reader: reader({
        account: async () => ({ ethereum_nonce: 8 }),
        contractResultByNonce: async () => minedResult({ hash: `0x${"cd".repeat(32)}`, function_parameters: "" }),
      }),
    });
    expect(outcome.resolution).toBe("rejected");
  });

  it("never resolves from request-supplied evidence: only reader calls decide", async () => {
    const calls: string[] = [];
    const outcome = await resolve({
      reader: {
        contractResult: async (hash: Hex) => { calls.push(`result:${hash}`); return null; },
        account: async (idOrAlias: string) => { calls.push(`account:${idOrAlias}`); return null; },
        contractResultByNonce: async (from: Address, nonce: number) => { calls.push(`occupier:${from}:${nonce}`); return null; },
      },
    });
    expect(outcome.resolution).toBe("ambiguous");
    expect(calls).toEqual([`result:${rawTransactionHash}`, `account:${account}`]);
  });
});
