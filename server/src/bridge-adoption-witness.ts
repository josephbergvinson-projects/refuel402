// Single source of truth for the off-chain BridgeAdoption consent proof: the
// owner signs it with eth_signTypedData_v4 and the server recovers it against
// the journey account before any adoption evidence is read or written.
// The domain carries no verifyingContract on purpose - this proves owner intent
// to bind an origin hash, it is not a contract call. web/wallet.js keeps a
// byte-for-byte copy for the browser; tests pin the two against each other.
import { getAddress, type Address, type Hex } from "viem";

export type BridgeAdoptionMode = "testnet" | "mainnet";

export const BRIDGE_ADOPTION_PRIMARY_TYPE = "BridgeAdoption" as const;

export const BRIDGE_ADOPTION_FIELDS = [
  { name: "journeyId", type: "string" },
  { name: "account", type: "address" },
  { name: "sourceTransactionHash", type: "bytes32" },
  { name: "mode", type: "string" },
] as const;

export function bridgeAdoptionTypes() {
  return { BridgeAdoption: BRIDGE_ADOPTION_FIELDS } as const;
}

export function bridgeAdoptionDomain(mode: BridgeAdoptionMode) {
  return { name: "Refuel402", version: "1", chainId: mode === "mainnet" ? 295 : 296 } as const;
}

export function bridgeAdoptionTypedData(input: {
  journeyId: string;
  account: Address;
  sourceTransactionHash: Hex;
  mode: BridgeAdoptionMode;
}) {
  return {
    domain: bridgeAdoptionDomain(input.mode),
    types: bridgeAdoptionTypes(),
    primaryType: BRIDGE_ADOPTION_PRIMARY_TYPE,
    message: {
      journeyId: input.journeyId,
      account: getAddress(input.account),
      sourceTransactionHash: input.sourceTransactionHash,
      mode: input.mode,
    },
  } as const;
}
