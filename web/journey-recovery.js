const PARAM = "journey";
const POINTER_PREFIX = "refuel402:active-journey:v2:";
const LEGACY_POINTER_PREFIX = "refuel402:journey:";
const LEGACY_HISTORY_PREFIX = "refuel402:journey-history:";
const POINTER_VERSION = 2;

function validJourneyId(value) {
  return /^[0-9a-fA-F-]{16,64}$/.test(String(value ?? ""));
}

function validAccount(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ""));
}

/**
 * Local storage owns only one explicit active pointer per account. Journey,
 * quote, recovery, event, form and Activity data are always read from the
 * server. Legacy rich records are discarded rather than silently re-activated.
 *
 * This store never writes the address bar. It used to stamp `?journey=<uuid>`
 * on every checkpoint, so simply opening the site rewrote the URL to advertise
 * an internal id — a uuid is not something an owner can check or act on, and
 * the rewrite made a plain visit look like a redirect. The param is still READ,
 * so a link someone was given still opens that journey, and `clearUrl` still
 * strips it; the only direction this class moves a URL is toward a clean one.
 */
export class JourneyPersistence {
  constructor({ storage = globalThis.localStorage, location = globalThis.location, history = globalThis.history } = {}) {
    this.storage = storage;
    this.location = location;
    this.history = history;
  }

  key(account) {
    if (!validAccount(account)) throw new Error("journey owner account is invalid");
    return `${POINTER_PREFIX}${account.toLowerCase()}`;
  }

  legacyKey(account) {
    if (!validAccount(account)) throw new Error("journey owner account is invalid");
    return `${LEGACY_POINTER_PREFIX}${account.toLowerCase()}`;
  }

  legacyHistoryKey(account) {
    if (!validAccount(account)) throw new Error("journey owner account is invalid");
    return `${LEGACY_HISTORY_PREFIX}${account.toLowerCase()}`;
  }

  discardLegacy(account) {
    if (!validAccount(account)) return;
    this.storage.removeItem(this.legacyKey(account));
    this.storage.removeItem(this.legacyHistoryKey(account));
  }

  fromUrl() {
    const id = new URL(this.location.href).searchParams.get(PARAM);
    return validJourneyId(id) ? id : null;
  }

  load(account) {
    if (!validAccount(account)) return null;
    this.discardLegacy(account);
    try {
      const parsed = JSON.parse(this.storage.getItem(this.key(account)) ?? "null");
      return parsed?.version === POINTER_VERSION &&
        validJourneyId(parsed.journeyId) &&
        parsed.account?.toLowerCase() === account.toLowerCase()
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  persist(record) {
    if (!validJourneyId(record.journeyId)) throw new Error("journey id is invalid");
    if (!validAccount(record.account)) throw new Error("journey owner account is invalid");
    this.discardLegacy(record.account);
    const value = {
      version: POINTER_VERSION,
      journeyId: record.journeyId,
      account: record.account.toLowerCase(),
      mode: record.mode === "testnet" ? "testnet" : "mainnet",
      routeMode: record.routeMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel",
      updatedAt: new Date().toISOString(),
    };
    this.storage.setItem(this.key(record.account), JSON.stringify(value));
    return value;
  }

  /**
   * Strip the journey param if a link put one there. Only ever deletes, so the
   * address bar can never gain an id it did not already carry.
   */
  clearUrl() {
    const url = new URL(this.location.href);
    if (!url.searchParams.has(PARAM)) return;
    url.searchParams.delete(PARAM);
    this.history.replaceState(this.history.state, "", url);
  }

  clear(account) {
    if (validAccount(account)) {
      this.storage.removeItem(this.key(account));
      this.discardLegacy(account);
    }
    this.clearUrl();
  }

  read(account) {
    const fromUrl = this.fromUrl();
    if (fromUrl) return { journeyId: fromUrl, account, source: "url" };
    const pointer = this.load(account);
    return pointer ? { ...pointer, source: "pointer" } : { journeyId: null, source: "none" };
  }
}
