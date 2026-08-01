import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { journeyAbandonable } from "../src/product-lifecycle-store.js";
import { journeyAbandonTypedData } from "../src/journey-abandon-witness.js";

/**
 * The abandon predicate is the only thing standing between an owner's click and
 * the permanent, un-reversible retirement of a journey record. There is no
 * un-abandon path, and abandoning a journey that may hold origin-chain funds
 * destroys the /bridge/adopt remedy — so these cases err hard toward refusal.
 */

const ACCOUNT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const NOW = 1_800_000_000;

function journey(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    quoteId: "a".repeat(64),
    mode: "mainnet",
    account: ACCOUNT,
    requestedProvider: "auto",
    selectedProvider: "layerzero",
    assetId: "layerzero:mainnet:wbtc",
    originChainId: "1",
    state: "ready",
    createdAt: 1000,
    updatedAt: 2000,
    payment: null,
    authorizations: [],
    submissions: [],
    events: [{ type: "journey_created" }],
    ...overrides,
  } as never;
}

const events = (...types: string[]) => ({ events: types.map((type) => ({ type })) });

describe("journeyAbandonable", () => {
  it("accepts an untouched draft", () => {
    expect(journeyAbandonable(journey(), NOW)).toBe(true);
  });

  it("accepts a draft whose authorization expired unused, activation funding included", () => {
    // The real shape of a reverted journey: sponsor HBAR already sits in the
    // owner's own Hedera account, and nothing was ever broadcast.
    expect(journeyAbandonable(journey({
      ...events(
        "journey_created",
        "destination_activation_funded",
        "authorization_created",
        "authorization_expired",
        "journey_reverted",
      ),
      authorizations: [{ intentKind: "activation", state: "expired", expiresAt: NOW - 600 }],
    }), NOW)).toBe(true);
  });

  it("refuses a journey that reached, or may have reached, the origin chain", () => {
    for (const type of [
      "bridge_submitted",
      "bridge_arrived",
      "bridge_submission_adopted",
      "bridge_only_completed",
      "payment_settled",
      "journey_reconciled",
      "intent_activation_confirmed",
      "intent_permit2_approval_confirmed",
      "intent_router_execution_confirmed",
    ]) {
      expect(journeyAbandonable(journey(events("journey_created", type)), NOW), type).toBe(false);
    }
  });

  it("refuses a wallet boundary with no bridge hash — the exact shape /bridge/adopt exists for", () => {
    // Retiring one of these would destroy the only remedy for funds that may
    // already be moving on the origin chain.
    expect(journeyAbandonable(journey(events("journey_created", "bridge_wallet_boundary")), NOW)).toBe(false);
    expect(journeyAbandonable(journey(events("journey_created", "origin_approval_wallet_boundary")), NOW)).toBe(false);
  });

  it("refuses an activation whose result was never recorded, and accepts one that was", () => {
    expect(journeyAbandonable(journey(events("journey_created", "destination_activation_started")), NOW)).toBe(false);
    expect(journeyAbandonable(journey(
      events("journey_created", "destination_activation_started", "destination_activation_funded"),
    ), NOW)).toBe(true);
  });

  it("refuses anything in flight or spent", () => {
    expect(journeyAbandonable(journey({ payment: { proofHash: "0x1" } }), NOW)).toBe(false);
    expect(journeyAbandonable(journey({ submissions: [{ state: "rejected" }] }), NOW)).toBe(false);
    for (const state of ["unknown", "consumed", "submitted"]) {
      expect(journeyAbandonable(journey({
        authorizations: [{ intentKind: "activation", state, expiresAt: NOW - 600 }],
      }), NOW), state).toBe(false);
    }
    // A pending authorization blocks only while it is still consumable.
    expect(journeyAbandonable(journey({
      authorizations: [{ intentKind: "activation", state: "pending", expiresAt: NOW + 60 }],
    }), NOW)).toBe(false);
    expect(journeyAbandonable(journey({
      authorizations: [{ intentKind: "activation", state: "pending", expiresAt: NOW - 60 }],
    }), NOW)).toBe(true);
  });

  it("refuses every state except ready", () => {
    for (const state of [
      "bridge_ready", "activation_pending", "bridge_pending", "arrival_confirmed",
      "payment_pending", "payment_settled", "authorizing", "submitting",
      "execution_pending", "completed", "review", "failed", "abandoned",
    ]) {
      expect(journeyAbandonable(journey({ state }), NOW), state).toBe(false);
    }
  });
});

describe("JourneyAbandon consent witness", () => {
  it("recovers to the journey account and nowhere else", async () => {
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const typed = journeyAbandonTypedData({
      journeyId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      account: signer.address,
      mode: "mainnet",
    });
    const signature = await signer.signTypedData(typed as never);
    const { verifyTypedData } = await import("viem");
    await expect(verifyTypedData({ ...typed, address: signer.address, signature })).resolves.toBe(true);

    // A signature for one journey must not authorize another, nor the same
    // journey on the other network.
    const otherJourney = journeyAbandonTypedData({
      journeyId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      account: signer.address,
      mode: "mainnet",
    });
    await expect(verifyTypedData({ ...otherJourney, address: signer.address, signature })).resolves.toBe(false);
    const otherMode = journeyAbandonTypedData({
      journeyId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      account: signer.address,
      mode: "testnet",
    });
    await expect(verifyTypedData({ ...otherMode, address: signer.address, signature })).resolves.toBe(false);
    await expect(verifyTypedData({ ...typed, address: ACCOUNT, signature })).resolves.toBe(false);
  });

  it("is byte-for-byte the definition the browser signs", async () => {
    const browser = await import("../../web/wallet.js" as string);
    const input = {
      journeyId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      account: ACCOUNT,
      mode: "mainnet" as const,
    };
    const server = journeyAbandonTypedData(input);
    const client = browser.journeyAbandonTypedData(input);
    expect(client.domain).toEqual(server.domain);
    expect(client.primaryType).toBe(server.primaryType);
    expect(client.types).toEqual(server.types);
    expect(client.message).toEqual(server.message);
  });
});
