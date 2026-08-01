import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashTypedData, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_ADOPTION_FIELDS,
  BRIDGE_ADOPTION_PRIMARY_TYPE,
  bridgeAdoptionDomain,
  bridgeAdoptionTypedData,
  bridgeAdoptionTypes,
} from "../src/bridge-adoption-witness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const walletPath = path.join(root, "web", "wallet.js");
const walletSource = fs.existsSync(walletPath) ? fs.readFileSync(walletPath, "utf8") : null;

// Same fixture as server/test/product-bridge-adoption-consent.test.ts: the two
// digests below are the cross-file pin between the route contract and this module.
const owner = privateKeyToAccount(`0x${"21".repeat(32)}`);
const journeyId = "journey-adoption-fixture";
const sourceTransactionHash = `0x${"12".repeat(32)}` as Hex;

const typedData = (mode: "testnet" | "mainnet") =>
  bridgeAdoptionTypedData({ journeyId, account: owner.address, sourceTransactionHash, mode });

describe("BridgeAdoption consent single source of truth", () => {
  it("keeps the field order, primary type and domain the wallet has to reproduce", () => {
    expect(BRIDGE_ADOPTION_PRIMARY_TYPE).toBe("BridgeAdoption");
    expect([...BRIDGE_ADOPTION_FIELDS]).toEqual([
      { name: "journeyId", type: "string" },
      { name: "account", type: "address" },
      { name: "sourceTransactionHash", type: "bytes32" },
      { name: "mode", type: "string" },
    ]);
    expect(bridgeAdoptionTypes()).toEqual({ BridgeAdoption: [...BRIDGE_ADOPTION_FIELDS] });
    // An off-chain consent proof: a verifyingContract would bind it to a call it is not.
    expect(bridgeAdoptionDomain("mainnet")).toEqual({ name: "Refuel402", version: "1", chainId: 295 });
    expect(bridgeAdoptionDomain("testnet")).toEqual({ name: "Refuel402", version: "1", chainId: 296 });
    expect(bridgeAdoptionDomain("mainnet")).not.toHaveProperty("verifyingContract");
  });

  it("checksums the signed account so the digest cannot vary by address casing", () => {
    const lowercase = bridgeAdoptionTypedData({
      journeyId,
      account: owner.address.toLowerCase() as `0x${string}`,
      sourceTransactionHash,
      mode: "testnet",
    });
    expect(lowercase.message.account).toBe(owner.address);
    expect(hashTypedData(lowercase)).toBe(hashTypedData(typedData("testnet")));
  });

  it("pins the digest the browser signs on both networks", () => {
    expect(hashTypedData(typedData("testnet")))
      .toBe("0xc8589bf2a276fb83e57f23e328eee4658c9620c5ab076a8994c7ddda77a210fe");
    expect(hashTypedData(typedData("mainnet")))
      .toBe("0xa2a8136d65dca066b352f7b922541117caa3bb1ad0a7fd6439c322c041fe980e");
  });

  it("recovers to the signer only for the network, journey and hash it was signed over", async () => {
    const signature = await owner.signTypedData(typedData("testnet"));
    await expect(verifyTypedData({ ...typedData("testnet"), address: owner.address, signature })).resolves.toBe(true);
    await expect(verifyTypedData({ ...typedData("mainnet"), address: owner.address, signature })).resolves.toBe(false);
    const otherJourney = bridgeAdoptionTypedData({
      journeyId: "journey-adoption-other",
      account: owner.address,
      sourceTransactionHash,
      mode: "testnet",
    });
    await expect(verifyTypedData({ ...otherJourney, address: owner.address, signature })).resolves.toBe(false);
  });

  it.skipIf(!walletSource)("pins the web/wallet.js signer copy to this module", () => {
    const source = walletSource ?? "";
    const block = source.match(/BridgeAdoption: \[([\s\S]*?)\]/)?.[1] ?? "";
    const fields = [...block.matchAll(/\{ name: "(\w+)", type: "(\w+)" \}/g)].map(([, name, type]) => ({ name, type }));
    expect(fields).toEqual([...BRIDGE_ADOPTION_FIELDS]);
    expect(source).toContain(`primaryType: "${BRIDGE_ADOPTION_PRIMARY_TYPE}"`);
    const domain = source.match(/domain: \{ name: "(\w+)", version: "(\d+)", chainId: network\.chainId \}/);
    expect(domain?.slice(1, 3)).toEqual([bridgeAdoptionDomain("mainnet").name, bridgeAdoptionDomain("mainnet").version]);
    const networks = source.match(/const HEDERA_NETWORKS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    for (const mode of ["testnet", "mainnet"] as const) {
      const chainId = networks.match(new RegExp(`${mode}: \\{\\s*chainId: (\\d+)`))?.[1];
      expect(Number(chainId)).toBe(bridgeAdoptionDomain(mode).chainId);
    }
  });
});
