import { describe, expect, it, vi } from "vitest";
import { Client } from "@hiero-ledger/sdk";
import { createRefuel402Plugin, Refuel402FuelTool } from "./refuel402-tool.js";

describe("Hedera Agent Kit v4 Refuel402 tool", () => {
  it("registers a real BaseTool and executes the bounded public lifecycle adapter", async () => {
    const executor = vi.fn(async (params, context) => ({
      state: "completed",
      tokenId: params.tokenId,
      desiredHbar: params.desiredHbar,
      accountId: context.accountId,
    }));
    const plugin = createRefuel402Plugin(executor);
    const [tool] = plugin.tools({ accountId: "0.0.7001" });
    expect(tool).toBeInstanceOf(Refuel402FuelTool);
    expect(tool?.method).toBe("refuel402_fuel");

    const client = Client.forTestnet();
    try {
      const result = await tool!.execute(client, { accountId: "0.0.7001" }, {
        tokenId: "0.0.5449",
        desiredHbar: "0.5",
        slippageBps: 100,
      });
      expect(result).toMatchObject({
        state: "completed",
        tokenId: "0.0.5449",
        desiredHbar: "0.5",
        accountId: "0.0.7001",
      });
      expect(executor).toHaveBeenCalledOnce();
    } finally {
      client.close();
    }
  });

  it("fails closed above the bounded testnet HBAR limit", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = new Refuel402FuelTool(vi.fn());
    const client = Client.forTestnet();
    try {
      const result = await tool.execute(client, { accountId: "0.0.7001" }, {
        tokenId: "0.0.5449",
        desiredHbar: "2",
      });
      expect(result).toMatchObject({
        raw: { error: expect.stringContaining("at most 1 HBAR") },
      });
    } finally {
      log.mockRestore();
      client.close();
    }
  });
});
