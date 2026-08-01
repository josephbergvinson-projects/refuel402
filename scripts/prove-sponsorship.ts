// KILL-GATE PROOF: on Hedera testnet, against the REAL SaucerSwap V2 router,
// a user with ZERO HBAR signs [approve, swap->unwrap] locally; a DISTINCT
// sponsor account submits both via native EthereumTransaction and pays all
// fees; the router sees the USER as EVM sender; the user ends with native HBAR.
//
// Every assertion below must be green or the Refuel402 concept is dead.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import {
  buildApproveCalldata,
  buildFuelSwapCalldata,
  signRawTx,
  userAddress,
} from "../client/src/txbuilder.js";
import { SponsorClient } from "../server/src/hedera.js";
import { Mirror } from "../server/src/mirror.js";
import { TESTNET, TOKENS } from "../server/src/config.js";

const sponsorId = process.env.SPONSOR_ACCOUNT_ID!;
const sponsorKey = process.env.SPONSOR_PRIVATE_KEY!;
const userKey = process.env.DEMO_USER_PRIVATE_KEY! as Hex;
if (!sponsorId || !sponsorKey || !userKey) throw new Error("missing .env values");

const mirror = new Mirror(TESTNET.mirrorBase, TESTNET.rpcUrl, TESTNET.quoteMirrorBase);
const userEvm = userAddress(userKey);
const token = TOKENS.USDC!;
const amountIn = BigInt(process.env.PROOF_AMOUNT_IN ?? 1_000_000n); // 1 USDC

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name} — ${detail}`);
}

console.log("=== Refuel402 kill-gate proof ===");
console.log(`user (EVM signer): ${userEvm}`);
console.log(`sponsor (HAPI payer): ${sponsorId}`);

// ---- Preconditions ----
const userBefore = await mirror.account(userEvm);
if (!userBefore) throw new Error("demo user account missing — run scripts/setup-demo.ts");
const hbarBefore = BigInt(userBefore.balance.balance);
const usdcBefore = BigInt(
  userBefore.balance.tokens.find((t) => t.token_id === token.tokenId)?.balance ?? 0,
);
check("user starts with ZERO HBAR", hbarBefore === 0n, `balance=${hbarBefore} tinybar`);
check("user holds input token", usdcBefore >= amountIn, `${usdcBefore} ${token.symbol} units`);
const nonce0 = userBefore.ethereum_nonce ?? 0;

// ---- Quote (for a sane minOut) ----
const { encodeFunctionData, decodeFunctionResult } = await import("viem");
const { quoterAbi } = await import("../server/src/abi.js");
const { encodeSwapPath } = await import("../client/src/txbuilder.js");
const path_ = encodeSwapPath([token.evmAddress, TESTNET.whbarToken], [TOKENS.USDC!.poolFee]);
const qres = await mirror.ethCall(
  TESTNET.quoter,
  encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path_, amountIn] }),
);
const [quotedOut] = decodeFunctionResult({
  abi: quoterAbi,
  functionName: "quoteExactInput",
  data: qres,
}) as readonly [bigint, unknown, unknown, bigint];
const minOut = (quotedOut * 97n) / 100n; // 3% slippage guard
console.log(`quote: ${amountIn} ${token.symbol} -> ${quotedOut} WHBAR units (minOut ${minOut})`);

// ---- User signs locally (zero gas price: cannot pay, will not pay) ----
const ctx = {
  chainId: TESTNET.chainId,
  router: TESTNET.router,
  whbar: TESTNET.whbarToken,
  maxFeePerGas: 0n,
};
const rawApprove = await signRawTx({
  privateKey: userKey,
  chainId: ctx.chainId,
  to: token.evmAddress,
  data: buildApproveCalldata(TESTNET.router, amountIn),
  nonce: nonce0,
  gasLimit: 1_000_000n,
  maxFeePerGas: 0n,
});
const rawSwap = await signRawTx({
  privateKey: userKey,
  chainId: ctx.chainId,
  to: TESTNET.router,
  data: buildFuelSwapCalldata({
    ctx,
    inputToken: token.evmAddress,
    poolFee: TOKENS.USDC!.poolFee,
    amountIn,
    minWhbarOut: minOut,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    recipient: userEvm,
  }),
  nonce: nonce0 + 1,
  gasLimit: 1_400_000n,
  maxFeePerGas: 0n,
});

// ---- Sponsor submits both (the ONLY entity paying anything) ----
const sponsor = new SponsorClient("testnet", sponsorId, sponsorKey);
console.log("\nsubmitting sponsored approve...");
const r1 = await sponsor.submitSponsored(rawApprove, 2_000_000_000n);
console.log(`  ${r1.hederaTransactionId} -> ${r1.status}, sponsor paid ${r1.sponsorPaidTinybar} tb`);
console.log("submitting sponsored swap...");
const r2 = await sponsor.submitSponsored(rawSwap, 3_000_000_000n);
console.log(`  ${r2.hederaTransactionId} -> ${r2.status}, sponsor paid ${r2.sponsorPaidTinybar} tb`);
await sponsor.close();

check("sponsored approve SUCCESS", r1.status === "SUCCESS", r1.hederaTransactionId);
check("sponsored swap SUCCESS", r2.status === "SUCCESS", r2.hederaTransactionId);

// ---- msg.sender proof via mirror contract results ----
async function contractFrom(h: Hex | null): Promise<Address | null> {
  if (!h) return null;
  for (let i = 0; i < 15; i++) {
    const cr = await mirror.contractResult(h);
    if (cr) return cr.from.toLowerCase() as Address;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const from1 = await contractFrom(r1.ethereumHash);
const from2 = await contractFrom(r2.ethereumHash);
check(
  "approve EVM sender == user (not sponsor)",
  from1 === userEvm.toLowerCase(),
  `from=${from1}`,
);
check("swap EVM sender == user (not sponsor)", from2 === userEvm.toLowerCase(), `from=${from2}`);

// ---- Post-state: user gained native HBAR while paying nothing ----
await new Promise((r) => setTimeout(r, 3000));
const userAfter = await mirror.account(userEvm);
const hbarAfter = BigInt(userAfter!.balance.balance);
const usdcAfter = BigInt(
  userAfter!.balance.tokens.find((t) => t.token_id === token.tokenId)?.balance ?? 0,
);
check(
  "user received native HBAR from the swap",
  hbarAfter >= minOut,
  `HBAR balance ${hbarBefore} -> ${hbarAfter} tinybar`,
);
check(
  "user spent exactly amountIn of the token",
  usdcBefore - usdcAfter === amountIn,
  `${token.symbol} ${usdcBefore} -> ${usdcAfter}`,
);
const userDebited = [...r1.transfers, ...r2.transfers].some(
  (t) => t.account === userAfter!.account && BigInt(t.tinybar) < 0n,
);
check(
  "user never paid a single tinybar of fees",
  !userDebited,
  "no negative HBAR transfer against the user in either record",
);
check(
  "sponsor paid all fees",
  r1.sponsorPaidTinybar > 0n && r2.sponsorPaidTinybar > 0n,
  `total ${r1.sponsorPaidTinybar + r2.sponsorPaidTinybar} tinybar`,
);

// ---- Verdict + proof artifact ----
const pass = checks.every((c) => c.pass);
const proof = {
  verdict: pass ? "KILL_GATE_GREEN" : "KILL_GATE_RED",
  generatedAt: new Date().toISOString(),
  network: "hedera:testnet",
  user: { evm: userEvm, account: userAfter?.account, hbarBefore: hbarBefore.toString(), hbarAfter: hbarAfter.toString() },
  sponsor: sponsorId,
  router: { evm: TESTNET.router, id: TESTNET.routerId },
  transactions: [
    { ...r1, sponsorPaidTinybar: r1.sponsorPaidTinybar.toString(), hashscan: `${TESTNET.hashscanBase}/transaction/${r1.hederaTransactionId}` },
    { ...r2, sponsorPaidTinybar: r2.sponsorPaidTinybar.toString(), hashscan: `${TESTNET.hashscanBase}/transaction/${r2.hederaTransactionId}` },
  ],
  checks,
};
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "proofs");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `kill-gate-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(proof, null, 2));
console.log(`\n${proof.verdict} — proof written to ${outFile}`);
process.exit(pass ? 0 : 1);
