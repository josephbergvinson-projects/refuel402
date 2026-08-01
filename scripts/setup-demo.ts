// Demo environment setup, run once after resolve-accounts.ts:
//   1. Sponsor swaps a little HBAR -> USDC (and SAUCE) on SaucerSwap V2 so it
//      holds tokens to seed the demo user with.
//   2. Sponsor transfers tokens to the demo user's EVM alias. This AUTO-CREATES
//      the user's Hedera account with ZERO HBAR and unlimited auto-association —
//      the purest possible "I have tokens but no gas" starting state.
import "dotenv/config";
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { routerAbi } from "../server/src/abi.js";
import { encodeSwapPath } from "../client/src/txbuilder.js";
import { TESTNET, TOKENS } from "../server/src/config.js";

const sponsorId = process.env.SPONSOR_ACCOUNT_ID!;
const sponsorKey = process.env.SPONSOR_PRIVATE_KEY!;
const userEvm = process.env.DEMO_USER_EVM_ADDRESS! as Address;
if (!sponsorId || !sponsorKey || !userEvm) throw new Error("missing .env values");

const client = Client.forTestnet().setOperator(
  AccountId.fromString(sponsorId),
  PrivateKey.fromStringECDSA(sponsorKey),
);

const sponsorEvm = (process.env.SPONSOR_EVM_ADDRESS ?? "").toLowerCase() as Address;

async function swapHbarForToken(tokenSymbol: "USDC" | "SAUCE", hbarIn: number) {
  const token = TOKENS[tokenSymbol]!;
  const fee = token.poolFee;
  const path = encodeSwapPath([TESTNET.whbarToken, token.evmAddress], [fee]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [
      {
        path,
        recipient: sponsorEvm,
        deadline,
        amountIn: BigInt(Math.round(hbarIn * 1e8)), // WHBAR units == tinybar
        amountOutMinimum: 1n,
      },
    ],
  });
  const refund = encodeFunctionData({ abi: routerAbi, functionName: "refundETH", args: [] });
  const multicall = encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [[swap, refund]],
  });
  const tx = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(TESTNET.routerId))
    .setGas(1_200_000)
    .setPayableAmount(new Hbar(hbarIn))
    .setFunctionParameters(Buffer.from((multicall as Hex).slice(2), "hex"))
    .execute(client);
  const rec = await tx.getRecord(client);
  console.log(
    `HBAR->${tokenSymbol} swap: ${rec.receipt.status.toString()} (tx ${tx.transactionId.toString()})`,
  );
}

async function sendTokenToUser(tokenSymbol: "USDC" | "SAUCE", amount: bigint) {
  const token = TOKENS[tokenSymbol]!;
  const userAlias = AccountId.fromEvmAddress(0, 0, userEvm);
  const tx = await new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(token.tokenId), AccountId.fromString(sponsorId), -Number(amount))
    .addTokenTransfer(TokenId.fromString(token.tokenId), userAlias, Number(amount))
    .execute(client);
  const receipt = await tx.getReceipt(client);
  console.log(
    `Sent ${amount} ${tokenSymbol} units to user alias ${userEvm}: ${receipt.status.toString()} (tx ${tx.transactionId.toString()})`,
  );
}

// Defaults sized for one 10-HBAR faucet drip.
const hbarForUsdc = Number(process.env.SETUP_HBAR_TO_USDC ?? 4);
const usdcForUser = BigInt(process.env.SETUP_USDC_TO_USER ?? 2_500_000n); // 2.5 USDC

await swapHbarForToken("USDC", hbarForUsdc);
await sendTokenToUser("USDC", usdcForUser);

const mirrorUser = await fetch(
  `https://testnet.mirrornode.hedera.com/api/v1/accounts/${userEvm}`,
).then((r) => (r.ok ? r.json() : null));
console.log(
  "Demo user account:",
  mirrorUser
    ? `${(mirrorUser as { account: string }).account} (auto-created, HBAR balance ${(mirrorUser as { balance: { balance: number } }).balance.balance})`
    : "not visible on mirror yet (wait a few seconds)",
);
client.close();
