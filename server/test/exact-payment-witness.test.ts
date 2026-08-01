import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  REFUEL402_EXACT_PAYMENT_FIELDS,
  REFUEL402_EXACT_PAYMENT_TYPE_STRING,
  WITNESS_TYPE_STRING_SUFFIX,
  exactPaymentTypes,
  paymentIdPreimageFields,
} from "../src/exact-payment-witness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const soliditySource = fs.readFileSync(path.join(root, "contracts", "Refuel402ExactPermit2Proxy.sol"), "utf8");
const walletSource = fs.readFileSync(path.join(root, "web", "wallet.js"), "utf8");
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "artifacts", "Refuel402ExactPermit2Proxy.json"), "utf8"));

describe("Refuel402ExactPayment witness single source of truth", () => {
  it("derives the exact PAYMENT_TYPEHASH preimage committed on-chain", () => {
    const preimage = soliditySource.match(/PAYMENT_TYPEHASH = keccak256\(\s*"([^"]+)"\s*\)/)?.[1];
    expect(preimage).toBe(REFUEL402_EXACT_PAYMENT_TYPE_STRING);
  });

  it("derives the exact Permit2 WITNESS_TYPE_STRING committed on-chain", () => {
    const witnessTypeString = soliditySource.match(/WITNESS_TYPE_STRING =\s*"([^"]+)"/)?.[1];
    expect(witnessTypeString).toBe(WITNESS_TYPE_STRING_SUFFIX);
  });

  it("matches the typehash constant embedded in the compiled artifact", () => {
    // The artifact exposes PAYMENT_TYPEHASH only as an ABI getter, not a JSON value;
    // the compile-time constant survives as a PUSH32 word in the deployed bytecode.
    const typehash = keccak256(stringToHex(REFUEL402_EXACT_PAYMENT_TYPE_STRING));
    expect(artifact.deployedBytecode).toContain(typehash.slice(2));
  });

  it("pins the web/wallet.js witness copy to the shared field order", () => {
    const block = walletSource.match(/Refuel402ExactPayment: \[([\s\S]*?)\]/)?.[1] ?? "";
    const fields = [...block.matchAll(/\{ name: "(\w+)", type: "(\w+)" \}/g)]
      .map(([, name, type]) => ({ name, type }));
    expect(fields).toEqual([...REFUEL402_EXACT_PAYMENT_FIELDS]);
  });

  it("builds the PermitWitnessTransferFrom envelope the facilitator scripts sign", () => {
    const types = exactPaymentTypes();
    expect(types.TokenPermissions).toEqual([
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ]);
    expect(types.Refuel402ExactPayment).toEqual([...REFUEL402_EXACT_PAYMENT_FIELDS]);
    expect(types.PermitWitnessTransferFrom).toEqual([
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Refuel402ExactPayment" },
    ]);
  });

  it("orders the off-chain paymentId preimage by the shared witness fields", () => {
    expect(paymentIdPreimageFields).toEqual([
      "payer", "token", "amount", "recipient", "chainId", "nonce", "deadline", "spender", "contextHash",
    ]);
  });
});
