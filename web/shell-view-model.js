/**
 * Pure derivation for the app shell (top bar, live status, focus targets).
 * No DOM, no signals, no network — everything here is a function of a plain
 * snapshot so the shell stays presentational and testable.
 */

export function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function networkLabel(mode) {
  return mode === "mainnet" ? "Hedera Mainnet" : "Hedera Testnet";
}

export function walletLabel(account) {
  return account ? shortAddress(account) : "Connect MetaMask";
}

export function walletAriaLabel(account) {
  return account ? `Connected wallet ${shortAddress(account)}` : "Connect MetaMask";
}

/**
 * The chain the WALLET is on, which is not the same question as which Hedera
 * network this transfer arrives on. Named from the origin catalog when the app
 * knows the chain, and reported as a bare id when it does not — the wallet can
 * be anywhere, and pretending otherwise is what made the top bar read as
 * "your wallet is on Hedera".
 */
export function walletChainLabel(chainId, networks = []) {
  if (!chainId) return null;
  const match = (networks ?? []).find((network) => Number(network.chainId) === Number(chainId));
  return match?.name ?? `Chain ${chainId}`;
}

export function activityLabel(count) {
  if (!count) return "Journeys";
  return `Journeys, ${count} on this account`;
}

/**
 * The single announced status. It re-states, in plain language, what the app is
 * doing right now — the surface that just took over plus any async work. Copy
 * here never claims a fund is safe or settled; that wording only comes from the
 * server-authoritative surfaces.
 */
export function shellStatus({
  surface = "compose",
  loading = false,
  error = null,
  quoteRefresh = null,
  activityOpen = false,
} = {}) {
  if (activityOpen) return "Journeys panel open.";
  if (quoteRefresh?.active) {
    return `Refreshing the route quote, attempt ${quoteRefresh.attempt} of ${quoteRefresh.maxAttempts}. No wallet action.`;
  }
  if (loading) return surface === "compose" ? "Working on your quote." : "Reading this journey from the server.";
  if (error) return error;
  return surface === "compose" ? "Ready to compose a transfer." : "Showing your journey.";
}

/**
 * A change in this key is what moves focus to the stage. It must distinguish
 * every surface the user can land on, so a recovery decision arriving while the
 * timeline is open is announced and focused like any other view change.
 */
export function surfaceFocusKey({ surface = "compose", journeySurface = null } = {}) {
  return surface === "journey" ? `journey:${journeySurface ?? "timeline"}` : "compose";
}
