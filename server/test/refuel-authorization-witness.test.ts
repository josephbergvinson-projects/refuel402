import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  REFUEL_AUTHORIZATION_FIELDS,
  REFUEL_AUTHORIZATION_TYPE_STRING,
  REFUEL_WITNESS_TYPE_STRING_SUFFIX,
  journeyNonce,
  refuelAuthorizationId,
  refuelAuthorizationTypedData,
  refuelRouteHash,
} from "../src/refuel-authorization-witness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const solidity = fs.readFileSync(path.join(root, "contracts", "Refuel402ExactPermit2Proxy.sol"), "utf8");
const wallet = fs.readFileSync(path.join(root, "web", "wallet.js"), "utf8");
const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const permit2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const spender = getAddress("0x3333333333333333333333333333333333333333");
const route = {
  wrapper: getAddress("0x4444444444444444444444444444444444444444"),
  htsToken: getAddress("0x5555555555555555555555555555555555555555"),
  router: getAddress("0x6666666666666666666666666666666666666666"),
  whbar: getAddress("0x7777777777777777777777777777777777777777"),
  wrapperRate: 10_000_000_000n,
  swapPath: "0x77777777777777777777777777777777777777770005dc5555555555555555555555555555555555555555" as `0x${string}`,
};

function authorization() {
  return {
    owner,
    token,
    maxAmountIn: 900n,
    exactHbarTinybar: 100n,
    serviceFeeAmount: 50n,
    recipient: owner,
    journeyNonce: journeyNonce("74191800-9d5d-4ef2-b813-6b500b8e893e"),
    deadline: 1_900_000_000n,
    routeHash: refuelRouteHash(route),
  };
}

describe("signed swap path", () => {
  const whbar = "0x7777777777777777777777777777777777777777";
  const hts = "0x5555555555555555555555555555555555555555";
  const mid = "0x8888888888888888888888888888888888888888";
  const base = {
    wrapper: "0x4444444444444444444444444444444444444444",
    htsToken: hts,
    router: "0x6666666666666666666666666666666666666666",
    whbar,
    wrapperRate: 10_000_000_000n,
  } as const;
  const single = `0x${whbar.slice(2)}0005dc${hts.slice(2)}` as `0x${string}`;
  const multi = `0x${whbar.slice(2)}0001f4${mid.slice(2)}0005dc${hts.slice(2)}` as `0x${string}`;

  // The product must never assume a route shape — SaucerSwap picks whatever
  // quotes best, and both must be signable.
  it("accepts any hop count", () => {
    expect(() => refuelRouteHash({ ...base, swapPath: single } as any)).not.toThrow();
    expect(() => refuelRouteHash({ ...base, swapPath: multi } as any)).not.toThrow();
  });

  // The whole route is bound, so a relayer cannot swap in a different pool, fee
  // tier, or intermediate token after the owner has signed.
  it("binds every hop, fee tier and intermediate token", () => {
    const one = refuelRouteHash({ ...base, swapPath: single } as any);
    expect(refuelRouteHash({ ...base, swapPath: multi } as any)).not.toBe(one);
    const otherFee = `0x${whbar.slice(2)}000bb8${hts.slice(2)}` as `0x${string}`;
    expect(refuelRouteHash({ ...base, swapPath: otherFee } as any)).not.toBe(one);
    const otherMid = `0x${whbar.slice(2)}0001f4${"9".repeat(40)}0005dc${hts.slice(2)}` as `0x${string}`;
    expect(refuelRouteHash({ ...base, swapPath: otherMid } as any)).not.toBe(refuelRouteHash({ ...base, swapPath: multi } as any));
  });

  it("rejects a malformed path before anything is signed", () => {
    for (const bad of ["0x", "0x1234", `0x${whbar.slice(2)}0005dc`, `0x${whbar.slice(2)}0005dc${hts.slice(2)}ff`]) {
      expect(() => refuelRouteHash({ ...base, swapPath: bad } as any), bad).toThrow(/swap path/);
    }
  });
});

describe("Refuel402RefuelAuthorization witness parity", () => {
  it("pins the exact Solidity type and Permit2 witness strings", () => {
    const type = solidity.match(/REFUEL_AUTHORIZATION_TYPEHASH = keccak256\(\s*"([^"]+)"\s*\)/)?.[1];
    const witness = solidity.match(/REFUEL_WITNESS_TYPE_STRING =\s*"([^"]+)"/)?.[1];
    expect(type).toBe(REFUEL_AUTHORIZATION_TYPE_STRING);
    expect(witness).toBe(REFUEL_WITNESS_TYPE_STRING_SUFFIX);
  });

  it("keeps browser field order byte-for-byte with the server", () => {
    const block = wallet.match(/REFUEL_AUTHORIZATION_FIELDS = \[([\s\S]*?)\];/)?.[1] ?? "";
    const fields = [...block.matchAll(/\{ name: "(\w+)", type: "(\w+)" \}/g)]
      .map(([, name, type]) => ({ name, type }));
    expect(fields).toEqual([...REFUEL_AUTHORIZATION_FIELDS]);
  });

  it("binds the exact cap, fee, output, owner, deadline, nonce, and route in the Permit2 envelope", () => {
    const value = authorization();
    const typed = refuelAuthorizationTypedData({ chainId: 296, permit2, spender, authorization: value });
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 296, verifyingContract: permit2 });
    expect(typed.message).toMatchObject({
      permitted: { token, amount: 900n },
      spender,
      nonce: value.journeyNonce,
      deadline: 1_900_000_000n,
      witness: value,
    });
    expect(refuelAuthorizationId(value)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes route identity when any executable fee tier changes", () => {
    expect(refuelRouteHash(route)).not.toBe(refuelRouteHash({ ...route, swapPath: "0x77777777777777777777777777777777777777770001f45555555555555555555555555555555555555555" as `0x${string}` }));
  });
});
