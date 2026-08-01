import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { createSponsorExposureReader } from "../src/sponsor-exposure.js";
import { createProductDestinationActivator } from "../src/product-activation.js";
import { loadSupportCatalog } from "../src/support.js";

const CUTOFF = 1_700_000_000_000;

describe("sponsor exposure reader", () => {
  it("sums every spend path that shares the sponsor account", async () => {
    const exposureSince = createSponsorExposureReader({
      legacy: { exposureSince: async () => 100n },
      product: {
        activationExposureSince: async () => 20n,
        sponsoredIntentExposureSince: async () => 3n,
        refuelAuthorizationExposureSince: async () => 4n,
      },
    });
    await expect(exposureSince(CUTOFF)).resolves.toBe(127n);
  });

  it("passes the same cutoff to every ledger", async () => {
    const legacy = vi.fn(async () => 0n);
    const activation = vi.fn(async () => 0n);
    const intents = vi.fn(async () => 0n);
    const refuels = vi.fn(async () => 0n);
    await createSponsorExposureReader({
      legacy: { exposureSince: legacy },
      product: { activationExposureSince: activation, sponsoredIntentExposureSince: intents, refuelAuthorizationExposureSince: refuels },
    })(CUTOFF);
    expect(legacy).toHaveBeenCalledWith(CUTOFF);
    expect(activation).toHaveBeenCalledWith(CUTOFF);
    expect(intents).toHaveBeenCalledWith(CUTOFF, undefined);
    expect(refuels).toHaveBeenCalledWith(CUTOFF);
  });

  it("routes the excluded authorization only to the ledger that can hold it", async () => {
    const legacy = vi.fn(async () => 0n);
    const activation = vi.fn(async () => 0n);
    const intents = vi.fn(async () => 0n);
    await createSponsorExposureReader({
      legacy: { exposureSince: legacy },
      product: { activationExposureSince: activation, sponsoredIntentExposureSince: intents },
    })(CUTOFF, { excludeRawTransactionHash: "0xfeed" });
    expect(legacy).toHaveBeenCalledWith(CUTOFF);
    expect(activation).toHaveBeenCalledWith(CUTOFF);
    expect(intents).toHaveBeenCalledWith(CUTOFF, { excludeRawTransactionHash: "0xfeed" });
  });

  it("falls back to the legacy ledger alone when the product store is absent", async () => {
    const exposureSince = createSponsorExposureReader({
      legacy: { exposureSince: () => 7n },
      product: null,
    });
    await expect(exposureSince(CUTOFF)).resolves.toBe(7n);
  });

  it("blocks destination activation on spend the product ledger cannot see", async () => {
    const asset = loadSupportCatalog("mainnet").assets.find((candidate) => candidate.id === "axelar:mainnet:usdc")!;
    const account = getAddress("0x2222222222222222222222222222222222222222");
    const journey = { id: "journey-cap", quoteId: "b".repeat(64), mode: "mainnet", account } as any;
    const activateAlias = vi.fn();
    // Activation funding alone is 0; the cap is only reached once legacy and
    // sponsored-intent spend are counted, which is the whole point of the reader.
    const activate = createProductDestinationActivator({
      store: {
        getJourney: async () => journey,
        getQuote: async () => ({ record: { asset: { destination: { ...asset.destination, arrival: "activation_required" } } } }),
        beginDestinationActivation: vi.fn(),
      } as any,
      mirrors: {
        mainnet: {
          account: async (id: string) => (id === account ? null : { balance: { balance: 100_000_000_000, tokens: [] } }),
        } as any,
        testnet: {} as any,
      },
      sponsors: { mainnet: { operatorId: "0.0.1", activateAlias } as any },
      exposureSince: async () => BigInt(process.env.DAILY_SPONSOR_CAP_TINYBAR ?? 10_000_000_000n),
    });

    await expect(activate(journey.id)).rejects.toThrow(/daily exposure cap/);
    expect(activateAlias).not.toHaveBeenCalled();
  });
});
