// Single source of truth for the off-chain JourneyAbandon consent proof: the
// owner signs it with eth_signTypedData_v4 and the server recovers it against
// the journey account before the journey is marked abandoned.
//
// A journey id alone must never be enough to retire somebody else's record —
// the per-journey reads are not account-scoped, so an id is not a secret. The
// domain carries no verifyingContract on purpose: this proves owner intent to
// retire a local record, it is not a contract call. web/wallet.js keeps a
// byte-for-byte copy for the browser; tests pin the two against each other.
import { getAddress, type Address } from "viem";

export type JourneyAbandonMode = "testnet" | "mainnet";

export const JOURNEY_ABANDON_PRIMARY_TYPE = "JourneyAbandon" as const;

export const JOURNEY_ABANDON_FIELDS = [
  { name: "journeyId", type: "string" },
  { name: "account", type: "address" },
  { name: "mode", type: "string" },
] as const;

export function journeyAbandonTypes() {
  return { JourneyAbandon: JOURNEY_ABANDON_FIELDS } as const;
}

export function journeyAbandonDomain(mode: JourneyAbandonMode) {
  return { name: "Refuel402", version: "1", chainId: mode === "mainnet" ? 295 : 296 } as const;
}

export function journeyAbandonTypedData(input: {
  journeyId: string;
  account: Address;
  mode: JourneyAbandonMode;
}) {
  return {
    domain: journeyAbandonDomain(input.mode),
    types: journeyAbandonTypes(),
    primaryType: JOURNEY_ABANDON_PRIMARY_TYPE,
    message: {
      journeyId: input.journeyId,
      account: getAddress(input.account),
      mode: input.mode,
    },
  } as const;
}
