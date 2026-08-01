import { getAddress, type Address, type Hex } from "viem";
import type { Mirror } from "./mirror.js";
import type { ProductReceiptReconciler } from "./product-lifecycle.js";
import type { ProductJourneyRecord, StoredProductQuote } from "./product-lifecycle-store.js";

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("stored quote record is invalid");
  return value as Record<string, any>;
}

export function createRpcReceiptReconciler(options: {
  mirrors: Record<"testnet" | "mainnet", Mirror>;
  expectedTargets?: Partial<Record<"testnet" | "mainnet", Address>>;
  loadQuote?: (journey: ProductJourneyRecord) => Promise<StoredProductQuote | null>;
  balanceReadback?: (journey: ProductJourneyRecord) => Promise<{
    destinationAssetRemaining: string;
    hbarReceivedTinybar: string;
  }>;
}): ProductReceiptReconciler {
  return {
    async reconcile({ journey, ethereumHash }) {
      const receipt = await options.mirrors[journey.mode].rpc<{
        transactionHash: Hex;
        status: Hex;
        from: Address;
        to: Address | null;
        gasUsed: Hex;
        blockNumber: Hex;
      } | null>("eth_getTransactionReceipt", [ethereumHash]);
      if (!receipt) throw new Error("transaction receipt is not yet available");
      if (receipt.transactionHash.toLowerCase() !== ethereumHash.toLowerCase()) throw new Error("receipt hash mismatch");
      if (receipt.status !== "0x1") throw new Error("destination transaction did not succeed");
      if (getAddress(receipt.from) !== getAddress(journey.account)) throw new Error("receipt sender differs from the journey account");
      const finalExecution = journey.state === "execution_pending";
      const expectedTarget = finalExecution ? options.expectedTargets?.[journey.mode] : undefined;
      if (expectedTarget && (!receipt.to || getAddress(receipt.to) !== getAddress(expectedTarget))) {
        throw new Error("receipt target differs from the quoted destination Router");
      }
      const balances = finalExecution && options.balanceReadback
        ? await options.balanceReadback(journey)
        : null;
      const quote = finalExecution && options.loadQuote ? await options.loadQuote(journey) : null;
      if (balances && quote) {
        const quoteRecord = record(quote.record);
        const hbar = record(record(quoteRecord.amountLedger).hbar);
        const outcome = record(quoteRecord.outcome);
        const minimumHbar = BigInt(String(hbar.minimumOutputTinybar));
        const minimumRemaining = BigInt(String(outcome.destinationAssetRemaining));
        if (BigInt(balances.hbarReceivedTinybar) < minimumHbar) {
          throw new Error("authoritative HBAR balance delta is below the quoted minimum");
        }
        if (BigInt(balances.destinationAssetRemaining) < minimumRemaining) {
          throw new Error("authoritative destination asset remaining is below the quoted minimum");
        }
      }
      return {
        transactionHash: receipt.transactionHash,
        status: "success",
        from: getAddress(receipt.from),
        to: receipt.to ? getAddress(receipt.to) : null,
        gasUsed: BigInt(receipt.gasUsed).toString(),
        blockNumber: BigInt(receipt.blockNumber).toString(),
        destinationAssetRemaining: balances?.destinationAssetRemaining ?? null,
        hbarReceivedTinybar: balances?.hbarReceivedTinybar ?? null,
        reconciliation: balances ? "complete_with_balance_readback" : "receipt_only_balance_readback_pending",
      };
    },
  };
}
