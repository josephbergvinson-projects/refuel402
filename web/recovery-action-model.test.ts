import { describe, expect, it } from "vitest";
import { destinationRecoveryQuoteState } from "./recovery-action-model.js";

const recovery = {
  nextAtomicStep: "destination_wallet_consent",
  routeMode: "bridge_plus_refuel",
};

describe("destination recovery quote action state", () => {
  it("allows refresh but not consent before a destination quote is persisted", () => {
    expect(destinationRecoveryQuoteState({ recovery, quote: null, persistedQuoteId: null, nowSeconds: 100 }))
      .toEqual({ active: true, exact: false, live: false, canRefresh: true, canApprove: false });
  });

  it("enables the normal consent action only for the exact persisted live quote without a checkbox boolean", () => {
    const quote = { quoteId: "a".repeat(64), expiresAt: 200 };
    expect(destinationRecoveryQuoteState({ recovery, quote, persistedQuoteId: quote.quoteId, nowSeconds: 100 }))
      .toEqual({ active: true, exact: true, live: true, canRefresh: false, canApprove: true });
    expect(destinationRecoveryQuoteState({ recovery, quote, persistedQuoteId: "b".repeat(64), nowSeconds: 100 }).canApprove)
      .toBe(false);
  });

  it("disables consent on expiry and requires another refresh", () => {
    const quote = { quoteId: "a".repeat(64), expiresAt: 100 };
    expect(destinationRecoveryQuoteState({ recovery, quote, persistedQuoteId: quote.quoteId, nowSeconds: 100 }))
      .toEqual({ active: true, exact: true, live: false, canRefresh: true, canApprove: false });
  });
});
