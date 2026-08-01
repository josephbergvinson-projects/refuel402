/**
 * One probe per icon URL, shared by every TokenPill instance. A broken icon
 * fails once and every later render uses the deterministic symbol fallback
 * instead of re-fetching a URL that is already known to be dead.
 */
const cache = new Map();

function defaultCreateImage() {
  return new globalThis.Image();
}

export function iconState(url) {
  if (!url) return "none";
  return cache.get(url)?.state ?? "idle";
}

/**
 * Returns the current state and, while loading, registers `notify` to be called
 * once with the settled state. Returns an unsubscribe function.
 */
export function observeIcon(url, notify, { createImage = defaultCreateImage } = {}) {
  if (!url) return { state: "none", unsubscribe: () => undefined };
  const cached = cache.get(url);
  if (cached?.state === "loaded" || cached?.state === "failed") {
    return { state: cached.state, unsubscribe: () => undefined };
  }
  if (cached?.state === "loading") {
    cached.waiters.add(notify);
    return { state: "loading", unsubscribe: () => cached.waiters.delete(notify) };
  }
  const waiters = new Set([notify]);
  const entry = { state: "loading", waiters };
  cache.set(url, entry);
  const settle = (state) => {
    cache.set(url, { state });
    for (const waiter of waiters) waiter(state);
    waiters.clear();
  };
  const probe = createImage();
  probe.addEventListener?.("load", () => settle("loaded"), { once: true });
  probe.addEventListener?.("error", () => settle("failed"), { once: true });
  probe.src = url;
  return { state: "loading", unsubscribe: () => waiters.delete(notify) };
}

export function resetIconCache() {
  cache.clear();
}

/** Deterministic two-character fallback mark for a token or chain. */
export function fallbackMark(label) {
  return String(label ?? "?").slice(0, 2).toUpperCase();
}
