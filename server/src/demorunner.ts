// Server-side driver for the frontend "Run the flow" button. It performs the
// exact same journey as client/src/demo.ts (a zero-HBAR account fueling itself)
// but emits structured step events so the browser can render progress live.
// The user's key stays server-side; the browser only ever sees step + HashScan.
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import {
  buildApproveCalldata,
  buildFuelSwapCalldata,
  encodeSwapPath,
  signRawTx,
  userAddress,
} from "../../client/src/txbuilder.js";
import { quoterAbi } from "./abi.js";
import { Mirror } from "./mirror.js";
import { TESTNET, TOKENS } from "./config.js";

type Emit = (step: string, data: Record<string, unknown>) => void;

export async function runFuelDemo(serverUrl: string, emit: Emit): Promise<void> {
  const mirror = new Mirror(TESTNET.mirrorBase, TESTNET.rpcUrl, TESTNET.quoteMirrorBase);
  const userKey = process.env.DEMO_USER_PRIVATE_KEY! as Hex;
  const token = TOKENS.USDC ?? Object.values(TOKENS)[0]!;
  const amountIn = BigInt(process.env.DEMO_AMOUNT_IN ?? 1_000_000n);
  const userEvm = userAddress(userKey);

  const before = await mirror.account(userEvm);
  if (!before) throw new Error("demo user not set up — run scripts/setup-demo.ts");
  emit("sign", {
    status: "active",
    account: before.account,
    hbarBefore: before.balance.balance,
    detail: `account ${before.account} has ${before.balance.balance} tinybar HBAR`,
  });

  const path = encodeSwapPath([token.evmAddress, TESTNET.whbarToken], [token.poolFee]);
  const qres = await mirror.ethCall(
    TESTNET.quoter,
    encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] }),
  );
  const [quotedOut] = decodeFunctionResult({
    abi: quoterAbi,
    functionName: "quoteExactInput",
    data: qres,
  }) as readonly [bigint, unknown, unknown, bigint];
  const minOut = (quotedOut * 97n) / 100n;

  const nonce = before.ethereum_nonce ?? 0;
  const ctx = { chainId: TESTNET.chainId, router: TESTNET.router, whbar: TESTNET.whbarToken, maxFeePerGas: 0n };
  const transactions: Hex[] = [
    await signRawTx({
      privateKey: userKey, chainId: ctx.chainId, to: token.evmAddress,
      data: buildApproveCalldata(TESTNET.router, amountIn),
      nonce, gasLimit: 1_000_000n, maxFeePerGas: 0n,
    }),
    await signRawTx({
      privateKey: userKey, chainId: ctx.chainId, to: TESTNET.router,
      data: buildFuelSwapCalldata({
        ctx, inputToken: token.evmAddress, poolFee: token.poolFee, route: token.route,
        amountIn, minWhbarOut: minOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 400), recipient: userEvm,
      }),
      nonce: nonce + 1, gasLimit: 1_400_000n, maxFeePerGas: 0n,
    }),
  ];
  emit("sign", { status: "done", detail: `signed [approve, swap→unwrapWHBAR] for ${Number(amountIn) / 10 ** token.decimals} ${token.symbol}` });

  const body = JSON.stringify({ transactions });
  const first = await fetch(`${serverUrl}/v1/fuel`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
  const challenge = (await first.clone().json()) as { sponsorship?: { fee: string } };
  emit("quote", { status: "done", detail: `402 — fee ${challenge.sponsorship?.fee}` });

  emit("pay", { status: "active", detail: "signing x402 payment (facilitator pays the fee's network cost)" });
  const signer = createClientHederaSigner(
    before.account, PrivateKey.fromStringECDSA(userKey.replace(/^0x/, "")), { network: "hedera:testnet" },
  );
  const httpClient = new x402HTTPClient(
    new x402Client().register("hedera:testnet" as never, new ExactHederaScheme(signer)),
  );
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => first.headers.get(name),
    await first.clone().json().catch(() => undefined),
  );
  const payload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);

  const paid = await fetch(`${serverUrl}/v1/fuel`, {
    method: "POST", headers: { "content-type": "application/json", ...paymentHeaders }, body,
  });
  const receipt = (await paid.json()) as {
    state: string;
    payment: { settlementId: string; hashscan: string } | null;
    execution: { hashscanLinks: string[]; sponsorFeeTinybar: string } | null;
    error: string | null;
  };
  if (receipt.payment) {
    emit("pay", { status: "done", detail: `settled ${receipt.payment.settlementId}`, hashscan: receipt.payment.hashscan });
  }
  if (receipt.state !== "completed") {
    emit("exec", { status: "fail", detail: receipt.error ?? "failed" });
    return;
  }
  emit("exec", {
    status: "done",
    detail: `sponsor paid ${receipt.execution?.sponsorFeeTinybar} tinybar gas`,
    links: receipt.execution?.hashscanLinks ?? [],
  });

  await new Promise((r) => setTimeout(r, 4000));
  const after = await mirror.account(userEvm);
  emit("done", {
    status: "done",
    hbarBefore: before.balance.balance,
    hbarAfter: after!.balance.balance,
    account: after!.account,
    hashscan: `${TESTNET.hashscanBase}/account/${after!.account}`,
  });
}
