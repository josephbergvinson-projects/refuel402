// Single source of truth for the Refuel402ExactPayment Permit2 witness.
// The on-chain authority is contracts/Refuel402ExactPermit2Proxy.sol; tests pin byte-equality.
export const REFUEL402_EXACT_PAYMENT_FIELDS = [
  { name: "payer", type: "address" },
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "recipient", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "spender", type: "address" },
  { name: "contextHash", type: "bytes32" },
] as const;

const TOKEN_PERMISSIONS_FIELDS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

function encodeType(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(",")})`;
}

export const REFUEL402_EXACT_PAYMENT_TYPE_STRING = encodeType("Refuel402ExactPayment", REFUEL402_EXACT_PAYMENT_FIELDS);

// Permit2 witness stub suffix: closes "...,Refuel402ExactPayment witness)" then appends the referenced subtypes.
export const WITNESS_TYPE_STRING_SUFFIX =
  `Refuel402ExactPayment witness)${REFUEL402_EXACT_PAYMENT_TYPE_STRING}${encodeType("TokenPermissions", TOKEN_PERMISSIONS_FIELDS)}`;

export function exactPaymentTypes() {
  return {
    TokenPermissions: TOKEN_PERMISSIONS_FIELDS,
    Refuel402ExactPayment: REFUEL402_EXACT_PAYMENT_FIELDS,
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Refuel402ExactPayment" },
    ],
  } as const;
}

// Field order of the facilitator's off-chain paymentId preimage; its ":"-joined string
// hash is intentionally distinct from the contract's abi.encode paymentId.
export const paymentIdPreimageFields = REFUEL402_EXACT_PAYMENT_FIELDS.map(({ name }) => name);
