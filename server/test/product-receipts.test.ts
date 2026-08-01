import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { createRpcReceiptReconciler } from "../src/product-receipts.js";
import type { ProductJourneyRecord, StoredProductQuote } from "../src/product-lifecycle-store.js";

const account = "0x1111111111111111111111111111111111111111" as const;
const router = "0x2222222222222222222222222222222222222222" as const;
const token = "0x3333333333333333333333333333333333333333" as const;
const hash = `0x${"ab".repeat(32)}` as const;

function journey(state: ProductJourneyRecord["state"]): ProductJourneyRecord {
  return {
    id: "journey",
    quoteId: "a".repeat(64),
    mode: "mainnet",
    account,
    requestedProvider: "axelar",
    selectedProvider: "axelar",
    assetId: "asset",
    originChainId: "1",
    state,
    createdAt: 1,
    updatedAt: 1,
    payment: null,
    authorizations: [],
    submissions: [],
    events: [],
  };
}

const quote: StoredProductQuote = {
  quoteId: "a".repeat(64),
  mode: "mainnet",
  account,
  requestedProvider: "axelar",
  selectedProvider: "axelar",
  assetId: "asset",
  originChainId: "1",
  expiresAt: 2_000_000_000,
  executable: true,
  record: {
    amountLedger: { hbar: { minimumOutputTinybar: "100" } },
    outcome: { destinationAssetRemaining: "900" },
  },
};

function mirror(to: Address = router) {
  return {
    rpc: vi.fn(async () => ({
      transactionHash: hash,
      status: "0x1",
      from: account,
      to,
      gasUsed: "0x10",
      blockNumber: "0x20",
    })),
  } as never;
}

describe("product receipt reconciliation", () => {
  it("requires the final Router target and authoritative HBAR/retained-asset minima", async () => {
    const reconciler = createRpcReceiptReconciler({
      mirrors: { testnet: mirror(), mainnet: mirror() },
      expectedTargets: { mainnet: router },
      loadQuote: async () => quote,
      balanceReadback: async () => ({ destinationAssetRemaining: "900", hbarReceivedTinybar: "100" }),
    });
    await expect(reconciler.reconcile({ journey: journey("execution_pending"), ethereumHash: hash })).resolves.toMatchObject({
      to: router,
      destinationAssetRemaining: "900",
      hbarReceivedTinybar: "100",
      reconciliation: "complete_with_balance_readback",
    });
  });

  it("rejects a final receipt with the wrong target or insufficient authoritative output", async () => {
    const wrongTarget = createRpcReceiptReconciler({
      mirrors: { testnet: mirror(token), mainnet: mirror(token) },
      expectedTargets: { mainnet: router },
    });
    await expect(wrongTarget.reconcile({ journey: journey("execution_pending"), ethereumHash: hash }))
      .rejects.toThrow("target differs");

    const insufficient = createRpcReceiptReconciler({
      mirrors: { testnet: mirror(), mainnet: mirror() },
      expectedTargets: { mainnet: router },
      loadQuote: async () => quote,
      balanceReadback: async () => ({ destinationAssetRemaining: "899", hbarReceivedTinybar: "99" }),
    });
    await expect(insufficient.reconcile({ journey: journey("execution_pending"), ethereumHash: hash }))
      .rejects.toThrow("HBAR balance delta is below");
  });

  it("uses receipt-only confirmation for non-terminal activation/approval intents", async () => {
    const balanceReadback = vi.fn(async () => ({ destinationAssetRemaining: "0", hbarReceivedTinybar: "0" }));
    const reconciler = createRpcReceiptReconciler({
      mirrors: { testnet: mirror(token), mainnet: mirror(token) },
      expectedTargets: { mainnet: router },
      loadQuote: async () => quote,
      balanceReadback,
    });
    await expect(reconciler.reconcile({ journey: journey("activation_pending"), ethereumHash: hash })).resolves.toMatchObject({
      to: token,
      reconciliation: "receipt_only_balance_readback_pending",
    });
    expect(balanceReadback).not.toHaveBeenCalled();
  });
});
