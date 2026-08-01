import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import {
  activityLabel,
  networkLabel,
  shellStatus,
  shortAddress,
  surfaceFocusKey,
  walletAriaLabel,
  walletChainLabel,
  walletLabel,
} from "./shell-view-model.js";

const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("shell identity copy", () => {
  it("shortens an address without ever losing the ends", () => {
    expect(shortAddress(ACCOUNT)).toBe("0x7099…79C8");
    expect(shortAddress(null)).toBe(null);
    expect(walletLabel(ACCOUNT)).toBe("0x7099…79C8");
    expect(walletLabel(null)).toBe("Connect MetaMask");
  });

  it("names the wallet control for assistive tech in both states", () => {
    expect(walletAriaLabel(ACCOUNT)).toBe("Connected wallet 0x7099…79C8");
    expect(walletAriaLabel(null)).toBe("Connect MetaMask");
  });

  it("names the destination network from the mode", () => {
    expect(networkLabel("mainnet")).toBe("Hedera Mainnet");
    expect(networkLabel("testnet")).toBe("Hedera Testnet");
  });

  it("names the wallet's own chain separately from the destination", () => {
    const networks = [{ chainId: "1", name: "Ethereum" }, { chainId: "42161", name: "Arbitrum" }];
    expect(walletChainLabel(1, networks)).toBe("Ethereum");
    expect(walletChainLabel("42161", networks)).toBe("Arbitrum");
    // The wallet can be on any chain, including Hedera mid-journey and chains
    // this product does not bridge from. Reporting the id beats inventing a name.
    expect(walletChainLabel(295, networks)).toBe("Chain 295");
    expect(walletChainLabel(null, networks)).toBeNull();
    expect(walletChainLabel(1)).toBe("Chain 1");
  });

  it("puts the journey count in the accessible name, not only the badge", () => {
    expect(activityLabel(0)).toBe("Journeys");
    expect(activityLabel(3)).toBe("Journeys, 3 on this account");
  });
});

describe("announced status", () => {
  it("prefers the open panel, then live server work, then the error", () => {
    expect(shellStatus({ activityOpen: true, loading: true, error: "boom" })).toBe("Journeys panel open.");
    expect(shellStatus({ quoteRefresh: { active: true, attempt: 1, maxAttempts: 2 }, loading: true }))
      .toBe("Refreshing the route quote, attempt 1 of 2. No wallet action.");
    expect(shellStatus({ loading: true, surface: "compose" })).toBe("Working on your quote.");
    expect(shellStatus({ loading: true, surface: "journey" })).toBe("Reading this journey from the server.");
    expect(shellStatus({ error: "The server record remains unchanged." })).toBe("The server record remains unchanged.");
  });

  it("falls back to a calm description of the surface", () => {
    expect(shellStatus({})).toBe("Ready to compose a transfer.");
    expect(shellStatus({ surface: "journey" })).toBe("Showing your journey.");
  });

  it("never claims a wallet action is under way", () => {
    const every = [
      shellStatus({}),
      shellStatus({ surface: "journey" }),
      shellStatus({ loading: true }),
      shellStatus({ loading: true, surface: "journey" }),
      shellStatus({ quoteRefresh: { active: true, attempt: 2, maxAttempts: 2 } }),
    ];
    for (const line of every) {
      expect(line).not.toMatch(/sign|approve|submit|guaranteed/i);
    }
  });
});

describe("focus key", () => {
  it("changes on every surface the user can land on", () => {
    expect(surfaceFocusKey({ surface: "compose" })).toBe("compose");
    expect(surfaceFocusKey({ surface: "journey", journeySurface: "timeline" })).toBe("journey:timeline");
    expect(surfaceFocusKey({ surface: "journey", journeySurface: "arrival_consent" })).toBe("journey:arrival_consent");
    expect(surfaceFocusKey({ surface: "journey", journeySurface: null })).toBe("journey:timeline");
    const keys = ["rechecking", "terms_changed", "adopt", "recovery", "arrival_consent", "timeline"]
      .map((journeySurface) => surfaceFocusKey({ surface: "journey", journeySurface }));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("compose");
  });
});
