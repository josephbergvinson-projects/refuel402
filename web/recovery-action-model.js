export function destinationRecoveryQuoteState({
  recovery,
  quote,
  persistedQuoteId,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const active = recovery?.nextAtomicStep === "destination_wallet_consent" && recovery?.routeMode === "bridge_plus_refuel";
  const quoteId = typeof quote?.quoteId === "string" ? quote.quoteId : null;
  const exact = Boolean(active && quoteId && persistedQuoteId === quoteId);
  const live = Boolean(exact && Number.isInteger(quote?.expiresAt) && quote.expiresAt > nowSeconds);
  return {
    active,
    exact,
    live,
    canRefresh: Boolean(active && !live),
    canApprove: live,
  };
}
