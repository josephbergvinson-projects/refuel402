import { describe, expect, it } from "vitest";
import { JourneyPersistence } from "./journey-recovery.js";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const journeyId = "74191800-9d5d-4ef2-b813-6b500b8e893e";

function fixture(href = "https://refuel402.pages.dev/") {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const location = { href };
  const history = {
    state: null,
    replaceState: (_state: unknown, _title: string, url: URL) => { location.href = url.toString(); },
  };
  return { values, storage, location, history, persistence: new JourneyPersistence({ storage, location, history }) };
}

describe("minimal account-scoped journey pointer", () => {
  it("persists only pointer identity and never stores quote, form, recovery, events, or history", () => {
    const { values, persistence, location } = fixture();
    const value = persistence.persist({
      journeyId,
      account,
      mode: "mainnet",
      routeMode: "bridge_plus_refuel",
      quote: { secretLargeQuote: true },
      bridgeAmount: "3",
      desiredHbar: "10",
      recovery: { reason: "stale" },
      journey: { events: [{ type: "bridge_arrived" }] },
    } as any);
    expect(value).toMatchObject({ version: 2, journeyId, account, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    expect(Object.keys(value).sort()).toEqual(["account", "journeyId", "mode", "routeMode", "updatedAt", "version"]);
    const serialized = [...values.values()].join("\n");
    expect(serialized).not.toContain("secretLargeQuote");
    expect(serialized).not.toContain("bridgeAmount");
    expect(serialized).not.toContain("recovery");
    expect(serialized).not.toContain("events");
    // Persisting must not touch the address bar. This used to stamp
    // `?journey=<uuid>` on every checkpoint, so merely opening the site rewrote
    // the URL to advertise an internal id the owner can do nothing with.
    expect(location.href).toBe("https://refuel402.pages.dev/");
  });

  it("has no way to write a journey id into the address bar", () => {
    const { persistence } = fixture();
    expect((persistence as any).setUrl).toBeUndefined();
    const source = JourneyPersistence.toString();
    expect(source).not.toContain("searchParams.set");
  });

  it("does not auto-activate a legacy rich pointer or local history", () => {
    const { values, persistence } = fixture();
    values.set(`refuel402:journey:${account}`, JSON.stringify({ journeyId, account, quote: { stale: true } }));
    values.set(`refuel402:journey-history:${account}`, JSON.stringify([{ journeyId, account }]));
    expect(persistence.read(account)).toEqual({ journeyId: null, source: "none" });
    expect(values.has(`refuel402:journey:${account}`)).toBe(false);
    expect(values.has(`refuel402:journey-history:${account}`)).toBe(false);
  });

  // A link someone was handed still opens that journey — reading the param is how
  // a shared or bookmarked journey works at all. Only writing it was the defect.
  it("still reads an explicit link, and marks it as coming from the URL", () => {
    const explicit = "5196311e-50a5-4717-8d0e-a83f586f60a3";
    const { persistence } = fixture(`https://refuel402.pages.dev/?journey=${explicit}`);
    persistence.persist({ journeyId, account, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    expect(persistence.read(account)).toEqual({ journeyId: explicit, account, source: "url" });
  });

  it("isolates pointers by account", () => {
    const { persistence } = fixture();
    persistence.persist({ journeyId, account, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    const otherJourney = "c91992cb-dfc3-4ed3-ab76-130beda59398";
    persistence.persist({ journeyId: otherJourney, account: other, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    expect(persistence.read(account)).toMatchObject({ journeyId, account, source: "pointer" });
    expect(persistence.read(other)).toMatchObject({ journeyId: otherJourney, account: other, source: "pointer" });
  });

  it("clears only the selected account pointer and strips the link without a server mutation", () => {
    const { persistence, location } = fixture(`https://refuel402.pages.dev/?journey=${journeyId}`);
    persistence.persist({ journeyId, account, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    const otherJourney = "c91992cb-dfc3-4ed3-ab76-130beda59398";
    persistence.persist({ journeyId: otherJourney, account: other, mode: "mainnet", routeMode: "bridge_plus_refuel" });
    persistence.clear(account);
    expect(persistence.load(account)).toBeNull();
    expect(persistence.load(other)).toMatchObject({ journeyId: otherJourney });
    expect(location.href).not.toContain("journey=");
  });

  it("rejects malformed account and journey identities", () => {
    const { persistence } = fixture();
    expect(() => persistence.persist({ journeyId: "bad", account, mode: "mainnet" } as any)).toThrow("journey id");
    expect(() => persistence.persist({ journeyId, account: "bad", mode: "mainnet" } as any)).toThrow("account");
  });
});
