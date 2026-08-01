// Single source of truth for the Refuel402RefuelAuthorization Permit2 witness.
// The on-chain authority is contracts/Refuel402ExactPermit2Proxy.sol; web/wallet.js
// mirrors these fields byte-for-byte and tests pin the type strings/hash derivation.
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const REFUEL_AUTHORIZATION_PRIMARY_TYPE = "PermitWitnessTransferFrom" as const;

export const REFUEL_AUTHORIZATION_FIELDS = [
  { name: "owner", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmountIn", type: "uint256" },
  { name: "exactHbarTinybar", type: "uint256" },
  { name: "serviceFeeAmount", type: "uint256" },
  { name: "recipient", type: "address" },
  { name: "journeyNonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "routeHash", type: "bytes32" },
] as const;

export const REFUEL_ROUTE_FIELDS = [
  { name: "wrapper", type: "address" },
  { name: "htsToken", type: "address" },
  { name: "router", type: "address" },
  { name: "whbar", type: "address" },
  { name: "wrapperRate", type: "uint256" },
  { name: "swapPathHash", type: "bytes32" },
] as const;

const TOKEN_PERMISSIONS_FIELDS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

function encodeType(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(",")})`;
}

export const REFUEL_AUTHORIZATION_TYPE_STRING =
  encodeType("Refuel402RefuelAuthorization", REFUEL_AUTHORIZATION_FIELDS);
export const REFUEL_ROUTE_TYPE_STRING = encodeType("Refuel402Route", REFUEL_ROUTE_FIELDS);
export const REFUEL_WITNESS_TYPE_STRING_SUFFIX =
  `Refuel402RefuelAuthorization witness)${REFUEL_AUTHORIZATION_TYPE_STRING}${encodeType("TokenPermissions", TOKEN_PERMISSIONS_FIELDS)}`;

export type RefuelAuthorizationRoute = {
  wrapper: Address;
  htsToken: Address;
  router: Address;
  whbar: Address;
  wrapperRate: bigint;
  /**
   * Full V3 exact-output path, signed whole: output token first, input token
   * last, 3-byte fee between each pair. Any hop count. The owner authorizes ONE
   * specific route, so a relayer cannot substitute a different pool, fee tier or
   * intermediate token — and the product never hardcodes a route shape.
   */
  swapPath: Hex;
};

export type RefuelAuthorizationMessage = {
  owner: Address;
  token: Address;
  maxAmountIn: bigint;
  exactHbarTinybar: bigint;
  serviceFeeAmount: bigint;
  recipient: Address;
  journeyNonce: bigint;
  deadline: bigint;
  routeHash: Hex;
};

export function journeyNonce(journeyId: string): bigint {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(journeyId)) throw new Error("refuel authorization journey id is invalid");
  return BigInt(keccak256(stringToHex(journeyId)));
}

const REFUEL_ROUTE_TYPEHASH = keccak256(stringToHex(REFUEL_ROUTE_TYPE_STRING));
const routeParameters = parseAbiParameters("bytes32,address,address,address,address,uint256,bytes32");
const authorizationIdParameters = parseAbiParameters("address,address,uint256,uint256,uint256,address,uint256,uint256,bytes32");

export function refuelRouteHash(route: RefuelAuthorizationRoute): Hex {
  // 20-byte output token, then repeating (3-byte fee, 20-byte token): 20 + 23n.
  const pathBytes = (route.swapPath.length - 2) / 2;
  if (!/^0x[0-9a-fA-F]+$/.test(route.swapPath) || pathBytes < 43 || (pathBytes - 20) % 23 !== 0) {
    throw new Error("refuel authorization swap path is malformed");
  }
  if (route.wrapperRate <= 0n) throw new Error("refuel authorization wrapper rate is invalid");
  return keccak256(encodeAbiParameters(routeParameters, [
    REFUEL_ROUTE_TYPEHASH,
    getAddress(route.wrapper),
    getAddress(route.htsToken),
    getAddress(route.router),
    getAddress(route.whbar),
    route.wrapperRate,
    keccak256(route.swapPath),
  ]));
}

export function refuelAuthorizationId(authorization: RefuelAuthorizationMessage): Hex {
  return keccak256(encodeAbiParameters(authorizationIdParameters, [
    getAddress(authorization.owner),
    getAddress(authorization.token),
    authorization.maxAmountIn,
    authorization.exactHbarTinybar,
    authorization.serviceFeeAmount,
    getAddress(authorization.recipient),
    authorization.journeyNonce,
    authorization.deadline,
    authorization.routeHash,
  ]));
}

export function refuelAuthorizationTypes() {
  return {
    TokenPermissions: TOKEN_PERMISSIONS_FIELDS,
    Refuel402RefuelAuthorization: REFUEL_AUTHORIZATION_FIELDS,
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Refuel402RefuelAuthorization" },
    ],
  } as const;
}

export function refuelAuthorizationTypedData(input: {
  chainId: number;
  permit2: Address;
  spender: Address;
  authorization: RefuelAuthorizationMessage;
}) {
  const authorization = {
    ...input.authorization,
    owner: getAddress(input.authorization.owner),
    token: getAddress(input.authorization.token),
    recipient: getAddress(input.authorization.recipient),
  };
  if (authorization.owner !== authorization.recipient) {
    throw new Error("refuel authorization recipient must be the owner");
  }
  return {
    domain: {
      name: "Permit2",
      chainId: input.chainId,
      verifyingContract: getAddress(input.permit2),
    },
    types: refuelAuthorizationTypes(),
    primaryType: REFUEL_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      permitted: { token: authorization.token, amount: authorization.maxAmountIn },
      spender: getAddress(input.spender),
      nonce: authorization.journeyNonce,
      deadline: authorization.deadline,
      witness: authorization,
    },
  } as const;
}
