import { describe, expect, it } from "vitest";
import { runtimeExecutionEnabled } from "../src/execution-gate.js";

const credentials = {
  SPONSOR_ACCOUNT_ID: "0.0.123",
  SPONSOR_PRIVATE_KEY: "present-but-not-exercised-in-this-pure-test",
};

describe("runtime execution gate", () => {
  it("stays disabled when credentials are present but the explicit product flag is off", () => {
    expect(runtimeExecutionEnabled({ ...credentials, SAME_WALLET_EXECUTION_ENABLED: "0" }, "testnet")).toBe(false);
    expect(runtimeExecutionEnabled({ ...credentials }, "testnet")).toBe(false);
  });

  it("requires both the product flag and credentials on testnet", () => {
    expect(runtimeExecutionEnabled({ ...credentials, SAME_WALLET_EXECUTION_ENABLED: "1" }, "testnet")).toBe(true);
    expect(runtimeExecutionEnabled({ SAME_WALLET_EXECUTION_ENABLED: "1" }, "testnet")).toBe(false);
  });

  it("requires the independent mainnet flag in addition to the product gate", () => {
    expect(runtimeExecutionEnabled({ ...credentials, SAME_WALLET_EXECUTION_ENABLED: "1" }, "mainnet")).toBe(false);
    expect(runtimeExecutionEnabled({
      ...credentials,
      SAME_WALLET_EXECUTION_ENABLED: "1",
      MAINNET_EXECUTION_ENABLED: "1",
    }, "mainnet")).toBe(true);
  });
});
