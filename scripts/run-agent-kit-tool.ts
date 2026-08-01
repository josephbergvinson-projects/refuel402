import "dotenv/config";
import { Client } from "@hiero-ledger/sdk";
import { Refuel402Agent } from "../client/src/agent.js";
import { createRefuel402Plugin } from "../agent-kit/refuel402-tool.js";
import type { Hex } from "viem";

if (process.env.LIVE_AGENT_KIT !== "1") {
  throw new Error("LIVE_AGENT_KIT=1 is required; the Agent Kit runner can settle x402 and submit testnet transactions");
}
if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
  throw new Error("the Agent Kit runner is testnet-only");
}

const base = process.env.REFUEL_URL;
const accountId = process.env.DEMO_USER_ACCOUNT_ID;
const privateKey = process.env.DEMO_USER_PRIVATE_KEY as Hex | undefined;
const tokenId = process.env.AGENT_FUEL_TOKEN_ID ?? "0.0.5449";
const desiredHbar = process.env.AGENT_DESIRED_HBAR ?? "0.5";
if (!base || !accountId || !privateKey) {
  throw new Error("REFUEL_URL, DEMO_USER_ACCOUNT_ID, and DEMO_USER_PRIVATE_KEY are required in the local agent runtime");
}

const agent = new Refuel402Agent(base, accountId, privateKey);
const plugin = createRefuel402Plugin(async (params) => {
  const discovery = await agent.discover("testnet");
  const token = discovery.tokens.find((candidate) => candidate.tokenId === params.tokenId);
  if (!token) throw new Error(`token ${params.tokenId} is not on the public Refuel402 whitelist`);
  return agent.fuel({
    token,
    desiredHbar: params.desiredHbar,
    minimumRetained: params.minimumRetained,
    slippageBps: params.slippageBps,
  });
});
const tool = plugin.tools({ accountId })[0];
if (!tool) throw new Error("Refuel402 Agent Kit tool was not registered");

const client = Client.forTestnet();
try {
  const result = await tool.execute(client, { accountId }, {
    tokenId,
    desiredHbar,
    slippageBps: 100,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  client.close();
}
