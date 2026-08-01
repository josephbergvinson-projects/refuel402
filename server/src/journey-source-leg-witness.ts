// Single source of truth for the off-chain SourceLegConsent proof: the owner
// signs it once with eth_signTypedData_v4 and the server recovers it against the
// journey account before ANY source-leg mutation.
//
// A journey id is not a secret. `GET /journeys?account=` and `GET /journeys/:id`
// are unauthenticated, so ids and full quote records are enumerable, and every
// mutation that trusted an id alone was actionable by a stranger:
//   - /wallet-boundary appended an append-only event that no route can remove and
//     that three separate predicates read as "blocked", permanently making a
//     journey unresumable, un-requotable AND unretirable — with no escape hatch,
//     because /bridge/adopt needs a real broadcast hash the victim never made.
//   - /bridge bound an arbitrary hash, foreclosing abandon and adoption and making
//     the owner's own later real submission conflict.
//   - /activate made the sponsor spend real HBAR, and a failed readback left a
//     wedge that blocks abandon forever.
//   - /intents/activation/authorize reserved sponsor exposure and retired the
//     owner's live authorization.
//
// ONE consent covers the whole leg on purpose. These calls are not four owner
// decisions; they are the mechanics of one decision — "run this journey on this
// quote" — so splitting them into four prompts would buy no safety and would add
// three more chances to hit MetaMask's -32002 and prompt nothing at all. The
// message pins `quoteId`, so consent is spent on exactly the quote the owner was
// shown and cannot be replayed onto a re-priced one.
//
// The domain chain is the journey's ORIGIN chain. The leg has to put the wallet
// there anyway to send the bridge transaction, so the consent reuses that switch
// instead of a round trip to Hedera and back. The caller must have the wallet ON
// that chain when it signs: MetaMask refuses eth_signTypedData_v4 whose domain
// chain is not active, so a domain taken from anything other than the chain the
// wallet was switched to opens no prompt at all — the same silent pre-prompt
// failure this consent exists alongside.
//
// Deliberately NOT covered: /reconcile-submissions is the documented escape hatch
// that blocked journeys are pointed at, and every write it makes derives from
// mirror evidence rather than the request body — gating it would strand exactly
// the owners who need it. /reconcile, /intents/:kind/confirm and /payment are
// already bound to the journey account by chain receipt or x402 payer identity.
//
// The domain carries no verifyingContract on purpose: this proves owner intent,
// it is not a contract call. web/wallet.js keeps a byte-for-byte copy for the
// browser; tests pin the two against each other.
import { getAddress, type Address } from "viem";

export type JourneySourceLegMode = "testnet" | "mainnet";

export const SOURCE_LEG_PRIMARY_TYPE = "SourceLegConsent" as const;

export const SOURCE_LEG_FIELDS = [
  { name: "journeyId", type: "string" },
  { name: "quoteId", type: "string" },
  { name: "account", type: "address" },
  { name: "mode", type: "string" },
] as const;

export function journeySourceLegTypes() {
  return { SourceLegConsent: SOURCE_LEG_FIELDS } as const;
}

/** Origin chain of the journey the leg runs on — see the note above. */
export function journeySourceLegDomain(originChainId: string | number) {
  const chainId = Number(originChainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("source leg consent origin chain is invalid");
  }
  return { name: "Refuel402", version: "1", chainId } as const;
}

export function journeySourceLegTypedData(input: {
  journeyId: string;
  quoteId: string;
  account: Address;
  mode: JourneySourceLegMode;
  originChainId: string | number;
}) {
  return {
    domain: journeySourceLegDomain(input.originChainId),
    types: journeySourceLegTypes(),
    primaryType: SOURCE_LEG_PRIMARY_TYPE,
    message: {
      journeyId: input.journeyId,
      quoteId: input.quoteId,
      account: getAddress(input.account),
      mode: input.mode,
    },
  } as const;
}
