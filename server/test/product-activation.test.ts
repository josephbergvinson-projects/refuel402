import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { createProductDestinationActivator } from "../src/product-activation.js";
import { loadSupportCatalog } from "../src/support.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const AMOUNT = "12345678";

// Funds a hollow account: the mirror reports no account until the readback loop
// (optionally) converges, so the sponsor transfer path is the one under test.
function fundingFixture(options: {
  activateAlias: () => Promise<{ transactionId: string; status: string }>;
  readbackConverges?: boolean;
}) {
  const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "axelar:mainnet:usdc")!;
  const journey = { id: "journey-activation-crash", quoteId: "c".repeat(64), mode: "mainnet", account } as any;
  const order: string[] = [];
  let accountReads = 0;
  const beginDestinationActivation = vi.fn(async (_journeyId: string, amountTinybar: string) => {
    order.push(`begin:${amountTinybar}`);
    return "proceed" as const;
  });
  const recordDestinationActivation = vi.fn(async () => journey);
  const activateAlias = vi.fn(async () => {
    order.push("transfer");
    return options.activateAlias();
  });
  const activate = createProductDestinationActivator({
    store: {
      getJourney: async () => journey,
      getQuote: async () => ({ record: { asset: { destination: asset.destination } } }),
      beginDestinationActivation,
      recordDestinationActivation,
    } as any,
    mirrors: {
      mainnet: {
        account: async (id: string) => {
          if (id !== account) return { balance: { balance: 100_000_000_000, tokens: [] } };
          accountReads += 1;
          return accountReads > 1 && options.readbackConverges ? { balance: { balance: 0, tokens: [] } } : null;
        },
        isAssociated: async () => true,
      } as any,
      testnet: {} as any,
    },
    sponsors: { mainnet: { operatorId: "0.0.1", activateAlias } as any },
    exposureSince: async () => 0n,
    sleep: async () => undefined,
  });
  return { activate, journey, order, beginDestinationActivation, recordDestinationActivation };
}

describe("product destination activation", () => {
  it("associates the HTS wrapper output for an ERC20 LayerZero arrival", async () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "layerzero:mainnet:wbtc")!;
    const journey = {
      id: "journey-wbtc",
      quoteId: "a".repeat(64),
      mode: "mainnet",
      account,
    } as any;
    const quote = {
      record: { asset: { destination: asset.destination } },
    } as any;
    const isAssociated = vi.fn(async () => false);
    const recordDestinationActivation = vi.fn(async () => journey);
    const activate = createProductDestinationActivator({
      store: {
        getJourney: async () => journey,
        getQuote: async () => quote,
        recordDestinationActivation,
      } as any,
      mirrors: {
        mainnet: {
          account: async () => ({ balance: { balance: 1, tokens: [] } }),
          isAssociated,
        } as any,
        testnet: {} as any,
      },
      sponsors: {},
      exposureSince: async () => 0n,
    });

    const result = await activate(journey.id);
    expect(isAssociated).toHaveBeenCalledWith(account, asset.destination.wrapper!.htsTokenId);
    expect(result).toMatchObject({ required: true, funded: false, associated: false });
    expect(recordDestinationActivation).toHaveBeenCalledWith(expect.objectContaining({
      journeyId: journey.id,
      transactionId: "account-already-exists",
    }));
  });

  it("records the marker amount when a retry finds the account a prior attempt funded", async () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "axelar:mainnet:usdc")!;
    const journey = {
      id: "journey-activation-recovered",
      quoteId: "d".repeat(64),
      mode: "mainnet",
      account,
      events: [
        { id: 1, type: "destination_activation_started", record: { state: "started", amountTinybar: AMOUNT }, createdAt: 1 },
      ],
    } as any;
    const recordDestinationActivation = vi.fn(async () => journey);
    const activateAlias = vi.fn();
    const activate = createProductDestinationActivator({
      store: {
        getJourney: async () => journey,
        getQuote: async () => ({ record: { asset: { destination: asset.destination } } }),
        recordDestinationActivation,
      } as any,
      mirrors: {
        mainnet: {
          account: async () => ({ balance: { balance: 1, tokens: [] } }),
          isAssociated: async () => true,
        } as any,
        testnet: {} as any,
      },
      sponsors: { mainnet: { operatorId: "0.0.1", activateAlias } as any },
      exposureSince: async () => 0n,
    });

    await expect(activate(journey.id)).resolves.toMatchObject({
      required: true,
      funded: true,
      transactionId: "recovered-from-activation-marker",
      amountTinybar: AMOUNT,
    });
    expect(activateAlias).not.toHaveBeenCalled();
    expect(recordDestinationActivation).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: "recovered-from-activation-marker",
      amountTinybar: AMOUNT,
    }));
  });

  describe("crash window between the transfer and the funded event", () => {
    const original = process.env.DESTINATION_ACTIVATION_TINYBAR;
    afterEach(() => {
      if (original === undefined) delete process.env.DESTINATION_ACTIVATION_TINYBAR;
      else process.env.DESTINATION_ACTIVATION_TINYBAR = original;
    });

    it("records the amount before the transfer when the status check throws", async () => {
      process.env.DESTINATION_ACTIVATION_TINYBAR = AMOUNT;
      const fixture = fundingFixture({
        activateAlias: async () => ({ transactionId: "0.0.1@1.2", status: "INSUFFICIENT_PAYER_BALANCE" }),
      });

      await expect(fixture.activate(fixture.journey.id)).rejects.toThrow(/did not succeed/);
      // The HBAR may already have moved, so the amount must be durable before it does.
      expect(fixture.order).toEqual([`begin:${AMOUNT}`, "transfer"]);
      expect(fixture.beginDestinationActivation).toHaveBeenCalledWith(fixture.journey.id, AMOUNT);
      expect(fixture.recordDestinationActivation).not.toHaveBeenCalled();
    });

    it("records the amount before the transfer when the mirror readback never converges", async () => {
      process.env.DESTINATION_ACTIVATION_TINYBAR = AMOUNT;
      const fixture = fundingFixture({
        activateAlias: async () => ({ transactionId: "0.0.1@1.3", status: "SUCCESS" }),
        readbackConverges: false,
      });

      await expect(fixture.activate(fixture.journey.id)).rejects.toThrow(/readback did not converge/);
      expect(fixture.order).toEqual([`begin:${AMOUNT}`, "transfer"]);
      expect(fixture.beginDestinationActivation).toHaveBeenCalledWith(fixture.journey.id, AMOUNT);
      expect(fixture.recordDestinationActivation).not.toHaveBeenCalled();
    });

    it("still funds and records the amount on the happy path", async () => {
      process.env.DESTINATION_ACTIVATION_TINYBAR = AMOUNT;
      const fixture = fundingFixture({
        activateAlias: async () => ({ transactionId: "0.0.1@1.4", status: "SUCCESS" }),
        readbackConverges: true,
      });

      await expect(fixture.activate(fixture.journey.id)).resolves.toMatchObject({
        required: true,
        funded: true,
        amountTinybar: AMOUNT,
      });
      expect(fixture.recordDestinationActivation).toHaveBeenCalledWith(expect.objectContaining({
        journeyId: fixture.journey.id,
        amountTinybar: AMOUNT,
        status: "SUCCESS",
      }));
    });
  });
});
