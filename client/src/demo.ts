// Refuel402 demo client — the full zero-HBAR journey, driven by the STOCK
// x402 client libraries (@x402/core + @x402/hedera), unmodified:
//   1. A complete-zero-HBAR account or explicitly gated hollow account holds HTS.
//   2. It signs [approve?, exactOutput swap->unwrapWHBAR] locally.
//   3. POST /v1/fuel -> HTTP 402 (fee quoted in USDC).
//   4. It pays the fee over x402 (facilitator submits + pays the fee transfer).
//   5. Retry with PAYMENT-SIGNATURE -> sponsor executes the bundle.
//   6. The account now holds native HBAR; its HBAR spend is exactly 0.
import "dotenv/config";
import fs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import {
  buildApproveCalldata,
  buildExactOutputFuelCalldata,
  encodeExactOutputPath,
  signRawTx,
  userAddress,
} from "./txbuilder.js";
import { erc20Abi } from "../../server/src/abi.js";
import { Mirror } from "../../server/src/mirror.js";
import { SPONSOR, TESTNET, TOKENS } from "../../server/src/config.js";

const SERVER = process.env.REFUEL_URL ?? "http://localhost:4020";
const NETWORK = "hedera:testnet";
const userKey = process.env.DEMO_USER_PRIVATE_KEY! as Hex;
const desiredHbarTinybar = BigInt(process.env.DEMO_DESIRED_HBAR_TINYBAR ?? 100_000_000n); // 1 HBAR
if (desiredHbarTinybar <= 0n || desiredHbarTinybar > 1_000_000_000n) {
  throw new Error("DEMO_DESIRED_HBAR_TINYBAR must be above 0 and at most 10 HBAR");
}
const token = TOKENS.USDC ?? Object.values(TOKENS)[0];
if (!token) throw new Error("no whitelisted tokens — run scripts/build-whitelist.ts testnet");
const scenario = process.env.PROOF_SCENARIO ?? "complete_zero_hbar";
if (!["complete_zero_hbar", "hollow"].includes(scenario)) {
  throw new Error("PROOF_SCENARIO must be complete_zero_hbar or hollow");
}

const mirror = new Mirror(TESTNET.mirrorBase, TESTNET.rpcUrl);
const userEvm = userAddress(userKey);

function hbar(tb: bigint | number): string {
  return `${(Number(tb) / 1e8).toFixed(8)} HBAR`;
}

console.log("=== Refuel402 demo: zero-HBAR account buys its own gas ===\n");

const before = await mirror.account(userEvm);
if (!before) throw new Error("demo user not created yet — fund the project alias with testnet HTS first");
const accountStateBefore = before.key ? "complete_zero_hbar" : "hollow";
if (BigInt(before.balance.balance) !== 0n) throw new Error("live acceptance requires the user to start with exactly 0 tinybar");
if (scenario !== accountStateBefore) {
  throw new Error(`PROOF_SCENARIO=${scenario} does not match observed ${accountStateBefore}`);
}
const usdcBefore =
  BigInt(before.balance.tokens.find((t) => t.token_id === token.tokenId)?.balance ?? 0);
console.log(`user account:   ${before.account} (${userEvm})`);
console.log(`HBAR balance:   ${hbar(before.balance.balance)}   <-- cannot pay for anything`);
console.log(`USDC balance:   ${(Number(usdcBefore) / 1e6).toFixed(6)} USDC`);
console.log(`account state:  ${accountStateBefore}\n`);

// --- 1. Quote the swap and sign the bundle locally ---
const route = token.route?.length
  ? token.route
  : [{ toToken: TESTNET.whbarToken, fee: token.poolFee }];
const path = encodeExactOutputPath(
  [token.evmAddress, ...route.map((hop) => hop.toToken)],
  route.map((hop) => hop.fee),
);
const exact = await mirror.quoteExactOutput(TESTNET.quoter, path, desiredHbarTinybar);
const amountInMaximum = (exact.amountIn * 103n + 99n) / 100n;
console.log(
  `SaucerSwap exact-output quote: up to ${Number(amountInMaximum) / 1e6} ${token.symbol} -> exactly ${hbar(desiredHbarTinybar)}`,
);

const allowanceData = await mirror.ethCall(
  token.evmAddress,
  encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [userEvm, TESTNET.router] }),
);
const allowanceBefore = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceData }) as bigint;
const associationBefore = await mirror.isAssociated(userEvm, token.tokenId);
const sponsorBefore = SPONSOR.operatorId ? await mirror.account(SPONSOR.operatorId) : null;
if (associationBefore !== true) throw new Error("held input HTS token is not associated");
const approvalRequired = allowanceBefore < amountInMaximum;
let nonce = before.ethereum_nonce ?? 0;
const ctx = { chainId: TESTNET.chainId, router: TESTNET.router, whbar: TESTNET.whbarToken, maxFeePerGas: 0n };
const transactions: Hex[] = [];
if (approvalRequired) {
  transactions.push(await signRawTx({
    privateKey: userKey, chainId: ctx.chainId, to: token.evmAddress,
    data: buildApproveCalldata(TESTNET.router, amountInMaximum),
    nonce: nonce++, gasLimit: 1_000_000n, maxFeePerGas: 0n,
  }));
}
transactions.push(await signRawTx({
  privateKey: userKey, chainId: ctx.chainId, to: TESTNET.router,
  data: buildExactOutputFuelCalldata({
    ctx, inputToken: token.evmAddress, poolFee: token.poolFee, route: token.route,
    amountOut: desiredHbarTinybar, amountInMaximum,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600), recipient: userEvm,
  }),
  nonce, gasLimit: 1_400_000n, maxFeePerGas: 0n,
}));
console.log(`signed locally: [${approvalRequired ? "exact approval, " : ""}exact-output swap->unwrapWHBAR] with maxFeePerGas = 0\n`);

// --- 2. Ask Refuel402 to sponsor it -> HTTP 402 ---
const body = JSON.stringify({ transactions });
const first = await fetch(`${SERVER}/v1/fuel`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
if (first.status !== 402) {
  throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
}
const challenge = (await first.clone().json()) as {
  sponsorship?: { fee: string; bundleHash: string };
};
console.log(`HTTP 402 Payment Required`);
console.log(`  fee quoted: ${challenge.sponsorship?.fee}`);
console.log(`  bundle:     ${challenge.sponsorship?.bundleHash}\n`);

// --- 3. Pay over x402 with the STOCK client (facilitator pays the fee transfer) ---
const signer = createClientHederaSigner(
  before.account,
  PrivateKey.fromStringECDSA(userKey.replace(/^0x/, "")),
  { network: NETWORK },
);
const httpClient = new x402HTTPClient(
  new x402Client().register(NETWORK as never, new ExactHederaScheme(signer)),
);
const paymentRequired = httpClient.getPaymentRequiredResponse(
  (name) => first.headers.get(name),
  await first.clone().json().catch(() => undefined),
);
const payload = await httpClient.createPaymentPayload(paymentRequired);
const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
console.log("x402 payment payload signed (native HTS transfer, facilitator is fee payer)\n");

// --- 4. Retry with payment -> sponsored execution ---
const paid = await fetch(`${SERVER}/v1/fuel`, {
  method: "POST",
  headers: { "content-type": "application/json", ...paymentHeaders },
  body,
});
const receipt = (await paid.json()) as {
  bundleHash: string;
  rawHash: string;
  quoteId: string;
  routeId: string;
  requirementsHash: string;
  network: string;
  chainId: number;
  economicContract: string;
  state: string;
  signer: string;
  quote: {
    feeTokenId: string;
    feeAmount: string;
    perLegGasAllowanceTinybar: string[];
    maxSponsorExposureTinybar: string;
    feeComponentsTinybar: {
      gasAllowance: string;
      hapiReserve: string;
      failedAttemptReserve: string;
      operatingMargin: string;
    };
  };
  payment: { settlementId: string; hashscan: string; paymentIdentity: string } | null;
  execution: {
    transactionIds: string[];
    evmHashes: string[];
    hashscanLinks: string[];
    sponsorFeeTinybar: string;
    perLeg: unknown[];
    disposition: string;
    reconciliation: string;
    status: string;
  } | null;
  refund: unknown;
  reconciliation: string;
  error: string | null;
};
console.log(`server response: HTTP ${paid.status}, state=${receipt.state}`);
if (receipt.payment) {
  console.log(`  x402 settlement: ${receipt.payment.settlementId}`);
  console.log(`     ${receipt.payment.hashscan}`);
}
if (receipt.execution) {
  for (const [i, link] of receipt.execution.hashscanLinks.entries()) {
    console.log(`  sponsored tx ${i + 1}: ${receipt.execution.transactionIds[i]}`);
    console.log(`     ${link}`);
  }
  console.log(`  sponsor paid: ${hbar(BigInt(receipt.execution.sponsorFeeTinybar))}`);
}
if (receipt.error) console.log(`  error: ${receipt.error}`);
if (receipt.state !== "completed") process.exit(1);

// --- 5. The punchline ---
await new Promise((r) => setTimeout(r, 4000));
const after = await mirror.account(userEvm);
const usdcAfter =
  BigInt(after!.balance.tokens.find((t) => t.token_id === token.tokenId)?.balance ?? 0);
const allowanceAfterData = await mirror.ethCall(
  token.evmAddress,
  encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [userEvm, TESTNET.router] }),
);
const allowanceAfter = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceAfterData }) as bigint;
const associationAfter = await mirror.isAssociated(userEvm, token.tokenId);
const contractResults = await Promise.all(
  (receipt.execution?.evmHashes ?? []).map((hash) => mirror.contractResult(hash as Hex)),
);
const sponsorAfter = SPONSOR.operatorId ? await mirror.account(SPONSOR.operatorId) : null;
console.log(`\n=== RESULT ===`);
console.log(`user HBAR:  ${hbar(before.balance.balance)} -> ${hbar(after!.balance.balance)}  (native gas, ready to transact)`);
console.log(`user USDC:  ${(Number(usdcBefore) / 1e6).toFixed(6)} -> ${(Number(usdcAfter) / 1e6).toFixed(6)}`);
console.log(`user HBAR spent across the entire flow: 0 tinybar`);
console.log(`\nHashScan: ${TESTNET.hashscanBase}/account/${after!.account}`);

if (!after!.key || after!.key._type !== "ECDSA_SECP256K1") {
  throw new Error("acceptance failed: account did not end complete ECDSA");
}
if (BigInt(after!.balance.balance) < desiredHbarTinybar) {
  throw new Error("acceptance failed: exact native HBAR output was not delivered");
}
const maximumTokenDebit = amountInMaximum + BigInt(receipt.quote.feeAmount);
if (usdcBefore - usdcAfter > maximumTokenDebit) {
  throw new Error("acceptance failed: token debit exceeded immutable swap maximum + x402 fee");
}
if (receipt.execution && BigInt(receipt.execution.sponsorFeeTinybar) > BigInt(receipt.quote.maxSponsorExposureTinybar)) {
  throw new Error("acceptance failed: actual sponsor cost exceeded quoted exposure");
}
if (contractResults.some((result) => !result || result.from.toLowerCase() !== userEvm.toLowerCase())) {
  throw new Error("acceptance failed: mirror sender evidence does not preserve the user EVM sender");
}

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const proof = {
  schema: "refuel402.live-proof.v1",
  acceptanceLevel: "live_proof",
  liveChain: true,
  scenario,
  network: receipt.network,
  chainId: receipt.chainId,
  account: {
    id: before.account,
    evmAddress: userEvm,
    stateBefore: accountStateBefore,
    keyTypeBefore: before.key?._type ?? null,
    stateAfter: after!.key ? "complete" : "hollow",
    keyTypeAfter: after!.key?._type ?? null,
    associationBefore,
    associationAfter,
    allowanceBefore: allowanceBefore.toString(),
    allowanceAfter: allowanceAfter.toString(),
    approvalRequired,
  },
  route: {
    mode: "exactOutput",
    tokens: [token.evmAddress, ...route.map((hop) => hop.toToken)],
    fees: route.map((hop) => hop.fee),
    desiredHbarTinybar: desiredHbarTinybar.toString(),
    quotedTokenIn: exact.amountIn.toString(),
    amountInMaximum: amountInMaximum.toString(),
  },
  bundle: {
    semanticHash: receipt.bundleHash,
    rawHash: receipt.rawHash,
    quoteId: receipt.quoteId,
    routeId: receipt.routeId,
    requirementsHash: receipt.requirementsHash,
    feeTokenId: receipt.quote.feeTokenId,
    feeAmount: receipt.quote.feeAmount,
  },
  feeLedger: receipt.quote.feeComponentsTinybar,
  payment: receipt.payment,
  legs: receipt.execution?.perLeg.map((leg, index) => ({
    ...(leg as Record<string, unknown>),
    transactionId: receipt.execution?.transactionIds[index] ?? null,
    evmHash: receipt.execution?.evmHashes[index] ?? null,
    hashscan: receipt.execution?.hashscanLinks[index] ?? null,
    senderEvidence: {
      recoveredSigner: receipt.signer,
      mirrorFrom: contractResults[index]?.from ?? null,
      source: "server-policy-plus-mirror-contract-result",
    },
  })) ?? [],
  exposure: {
    quotedAggregateTinybar: receipt.quote.maxSponsorExposureTinybar,
    quotedPerLegGasTinybar: receipt.quote.perLegGasAllowanceTinybar,
    actualAggregateTinybar: receipt.execution?.sponsorFeeTinybar ?? null,
    sponsorBalanceBeforeTinybar: sponsorBefore?.balance.balance?.toString() ?? null,
    sponsorBalanceAfterTinybar: sponsorAfter?.balance.balance?.toString() ?? null,
    limits: {
      perTransactionTinybar: SPONSOR.perTxAllowanceCapTinybar.toString(),
      perRequestTinybar: SPONSOR.perRequestExposureCapTinybar.toString(),
      dailyTinybar: SPONSOR.dailyExposureCapTinybar.toString(),
      minimumReserveTinybar: SPONSOR.minReserveTinybar.toString(),
    },
  },
  lifecycle: {
    economicContract: receipt.economicContract,
    state: receipt.state,
    disposition: receipt.execution?.disposition ?? null,
    refund: receipt.refund,
    reconciliation: receipt.reconciliation,
  },
  balances: {
    hbarBeforeTinybar: String(before.balance.balance),
    hbarAfterTinybar: String(after!.balance.balance),
    feeTokenBefore: usdcBefore.toString(),
    feeTokenAfter: usdcAfter.toString(),
  },
  prohibitedSideEffects: {
    mainnetActions: 0,
    sourcePublication: 0,
    userKeyPersistedInProof: false,
  },
  versions: { refuel402: "0.1.0", node: process.version, commit, generatedAt: new Date().toISOString() },
};
const proofDir = nodePath.join(root, "proofs", "live");
fs.mkdirSync(proofDir, { recursive: true });
const proofPath = nodePath.join(proofDir, `testnet-${Date.now()}.json`);
fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
console.log(`proof written: ${proofPath}`);
