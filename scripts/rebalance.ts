// Sponsor treasury rebalance: swap collected USDC fees back to HBAR on
// SaucerSwap, closing the economic loop (fees in tokens -> gas inventory).
// Manual/cron-run by the operator; deliberately not automatic in the MVP.
import "dotenv/config";
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { routerAbi } from "../server/src/abi.js";
import { encodeSwapPath } from "../client/src/txbuilder.js";
import { TESTNET, TOKENS } from "../server/src/config.js";

const sponsorId = process.env.SPONSOR_ACCOUNT_ID!;
const sponsorKey = process.env.SPONSOR_PRIVATE_KEY!;
const sponsorEvm = (process.env.SPONSOR_EVM_ADDRESS ?? "") as Address;
const amountIn = BigInt(process.env.REBALANCE_USDC ?? 1_000_000n); // 1 USDC default

const client = Client.forTestnet().setOperator(
  AccountId.fromString(sponsorId),
  PrivateKey.fromStringECDSA(sponsorKey),
);

// USDC -> WHBAR -> native HBAR back to the sponsor. The sponsor HAS HBAR, so it
// can use plain HAPI allowance + ContractExecute; no sponsorship needed here.
const { AccountAllowanceApproveTransaction, TokenId } = await import("@hiero-ledger/sdk");
const approve = await (
  await new AccountAllowanceApproveTransaction()
    .approveTokenAllowance(
      TokenId.fromString(TOKENS.USDC!.tokenId),
      AccountId.fromString(sponsorId),
      AccountId.fromString(TESTNET.routerId),
      Number(amountIn),
    )
    .execute(client)
).getReceipt(client);
console.log(`router allowance: ${approve.status.toString()}`);

const path = encodeSwapPath([TOKENS.USDC!.evmAddress, TESTNET.whbarToken], [TOKENS.USDC!.poolFee]);
const swap = encodeFunctionData({
  abi: routerAbi,
  functionName: "exactInput",
  args: [
    {
      path,
      recipient: TESTNET.router,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      amountIn,
      amountOutMinimum: 1n,
    },
  ],
});
const unwrap = encodeFunctionData({
  abi: routerAbi,
  functionName: "unwrapWHBAR",
  args: [1n, sponsorEvm],
});
const multicall = encodeFunctionData({
  abi: routerAbi,
  functionName: "multicall",
  args: [[swap, unwrap]],
});

const tx = await new ContractExecuteTransaction()
  .setContractId(ContractId.fromString(TESTNET.routerId))
  .setGas(1_200_000)
  .setFunctionParameters(Buffer.from((multicall as Hex).slice(2), "hex"))
  .execute(client);
const rec = await tx.getRecord(client);
console.log(
  `rebalanced ${Number(amountIn) / 1e6} USDC -> HBAR: ${rec.receipt.status.toString()} (${tx.transactionId.toString()})`,
);
client.close();
