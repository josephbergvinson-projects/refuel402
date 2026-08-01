import type { SponsorClient } from "./hedera.js";
import type { Mirror } from "./mirror.js";
import type { ProductLifecycleStore } from "./product-lifecycle-store.js";
import type { SponsorExposureReader } from "./sponsor-exposure.js";

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("stored quote record is invalid");
  return value as Record<string, any>;
}

export function createProductDestinationActivator(options: {
  store: ProductLifecycleStore;
  mirrors: Record<"testnet" | "mainnet", Mirror>;
  sponsors: Partial<Record<"testnet" | "mainnet", SponsorClient>>;
  // Required: activation shares one sponsor account and one daily cap with the
  // legacy API and every policy-RPC sponsored intent, so it must not gate on its
  // own funding alone. See sponsor-exposure.ts.
  exposureSince: SponsorExposureReader;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return async (journeyId: string) => {
    const journey = await options.store.getJourney(journeyId);
    if (!journey) throw new Error("journey does not exist");
    const quote = await options.store.getQuote(journey.quoteId);
    if (!quote) throw new Error("journey quote does not exist");
    const destination = record(record(quote.record).asset).destination as Record<string, any>;
    if (destination.arrival !== "activation_required") {
      return { required: false, funded: false, associated: true, journey };
    }
    const wrapper = destination.wrapper ? record(destination.wrapper) : null;
    const tokenId = typeof destination.tokenId === "string"
      ? destination.tokenId
      : typeof wrapper?.htsTokenId === "string"
        ? wrapper.htsTokenId
        : null;
    if (!tokenId) throw new Error("activation-required destination token id is missing");
    const mirror = options.mirrors[journey.mode];
    const existing = await mirror.account(journey.account);
    let funded = false;
    let transactionId = "account-already-exists";
    let amountTinybar = "0";
    let status = "SUCCESS";
    if (!existing) {
      const sponsor = options.sponsors[journey.mode];
      if (!sponsor) throw new Error("destination activation sponsor is not available for this network");
      const amount = BigInt(process.env.DESTINATION_ACTIVATION_TINYBAR ?? 10_000_000n);
      const reserveFloor = BigInt(process.env.SPONSOR_MIN_RESERVE_TINYBAR ?? 500_000_000n);
      const dailyCap = BigInt(process.env.DAILY_SPONSOR_CAP_TINYBAR ?? 10_000_000_000n);
      const [sponsorAccount, recentExposure] = await Promise.all([
        mirror.account(sponsor.operatorId.toString()),
        options.exposureSince(Date.now() - 86_400_000),
      ]);
      const balance = BigInt(sponsorAccount?.balance.balance ?? 0);
      if (balance - amount < reserveFloor) throw new Error("destination activation would breach the sponsor reserve floor");
      if (recentExposure + amount > dailyCap) throw new Error("destination activation would breach the sponsor daily exposure cap");
      // The amount goes into the write-ahead marker: everything between here and
      // recordDestinationActivation can throw after the HBAR has already moved.
      const claim = await options.store.beginDestinationActivation(journeyId, amount.toString());
      if (claim === "complete") {
        const completed = await options.store.getJourney(journeyId);
        const associated = (await mirror.isAssociated(journey.account, tokenId)) === true;
        return { required: true, funded: true, associated, journey: completed };
      }
      const activation = await sponsor.activateAlias(journey.account, amount);
      funded = true;
      transactionId = activation.transactionId;
      amountTinybar = amount.toString();
      status = activation.status;
      if (status !== "SUCCESS") throw new Error("destination activation transfer did not succeed");
      let found = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (await mirror.account(journey.account)) {
          found = true;
          break;
        }
        await sleep(1_000);
      }
      if (!found) throw new Error("destination activation account readback did not converge");
    } else {
      // A visible account does not prove the sponsor never paid for it. Attempt 1
      // can transfer and then die on the bounded readback loop, and the account it
      // funded becomes visible once mirror lag clears; the retry lands here. The
      // write-ahead marker is the only durable record of that spend, so a funded
      // event of "0" would erase it from the daily-cap ledger permanently.
      // This branch also swallows the opposite story - a marker whose transfer
      // never happened, with the account funded by someone else - and charges the
      // cap for it, clearing a state that previously demanded manual reconciliation.
      // Deliberate: the account exists either way, and over-charging the cap for at
      // most one activation is the safe direction when the two are indistinguishable
      // from here. A marker predating this field records "0"; that spend stays
      // invisible until it ages out of the window.
      const marker = journey.events?.find((event) => event.type === "destination_activation_started");
      if (marker) {
        const claimed = marker.record?.amountTinybar;
        funded = true;
        transactionId = "recovered-from-activation-marker";
        amountTinybar = typeof claimed === "string" ? claimed : "0";
      }
    }
    const associated = (await mirror.isAssociated(journey.account, tokenId)) === true;
    const updated = await options.store.recordDestinationActivation({
      journeyId,
      transactionId,
      amountTinybar,
      status,
    });
    return { required: true, funded, associated, transactionId, amountTinybar, journey: updated };
  };
}
