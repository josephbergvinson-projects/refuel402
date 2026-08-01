import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../server/src/abi.js";
import { SponsorClient } from "../server/src/hedera.js";
import { Mirror } from "../server/src/mirror.js";
import { authorizationCalldata } from "../server/src/product-refuel-executor.js";
import {
  journeyNonce,
  refuelAuthorizationId,
  refuelAuthorizationTypedData,
  refuelRouteHash,
} from "../server/src/refuel-authorization-witness.js";
import { encodeExactOutputPath } from "../client/src/txbuilder.js";
import type { RefuelAuthorizationRecord } from "../server/src/product-lifecycle-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roleEnv = process.env.REFUEL402_ROLE_ENV_FILE;
const userEnv = process.env.REFUEL402_USER_ENV_FILE;
if (!roleEnv || !userEnv) throw new Error("role and user secret routes are required");
dotenv.config({ path: roleEnv, override: false });
dotenv.config({ path: userEnv, override: false });
const execute = process.argv.includes("--execute");
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : null;
if (!outputPath) throw new Error("--out is required");

const chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
});
const rpcUrl = "https://testnet.hashio.io/api";
const mirrorBase = "https://testnet.mirrornode.hedera.com";
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }) });
const mirror = new Mirror(mirrorBase, rpcUrl, mirrorBase);
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/artifacts/Refuel402ExactPermit2Proxy.json"), "utf8")) as {
  abi: any;
  sourceSha256: string;
};
const deployments = JSON.parse(fs.readFileSync(path.join(root, "contracts/deployments.json"), "utf8"));

const proxy = getAddress(process.env.REFUEL402_TESTNET_PROXY_ADDRESS ?? "");
const permit2 = getAddress(deployments.networks.testnet.permit2);
const facilitator = getAddress(process.env.REFUEL402_TESTNET_FACILITATOR_EVM_ADDRESS ?? "");
const sponsorAddress = getAddress(process.env.REFUEL402_TESTNET_SPONSOR_EVM_ADDRESS ?? "");
const sponsorId = process.env.REFUEL402_TESTNET_SPONSOR_ACCOUNT_ID ?? "";
const sponsorKey = process.env.REFUEL402_TESTNET_SPONSOR_PRIVATE_KEY ?? "";
const facilitatorId = process.env.REFUEL402_TESTNET_FACILITATOR_ACCOUNT_ID ?? "";
const facilitatorKey = process.env.REFUEL402_TESTNET_FACILITATOR_PRIVATE_KEY ?? "";
const userId = process.env.OPENCLAW_HEDERA_TESTNET_TEST_ACCOUNT_ID ?? "";
const userKeyRaw = process.env.OPENCLAW_HEDERA_TESTNET_TEST_PRIVATE_KEY ?? "";
const userKey = PrivateKey.fromStringECDSA(userKeyRaw).toStringRaw();
const user = privateKeyToAccount(`0x${userKey}` as Hex);
const expectedUser = getAddress("0x0c56161b1de14d5ed4c5fcd4e8a04552133b2d44");
if (user.address !== expectedUser) throw new Error("testnet user key does not match the reviewed account");
if (!sponsorId || !sponsorKey || !facilitatorId || !facilitatorKey || !userId) throw new Error("testnet role identity is incomplete");

const token = getAddress("0x0000000000000000000000000000000000001549");
const tokenId = "0.0.5449";
const router = getAddress("0x0000000000000000000000000000000000159398");
const quoter = getAddress("0x00000000000000000000000000000000001535b2");
const whbar = getAddress("0x0000000000000000000000000000000000003ad2");
const feeTier = 3000;
const exactHbarTinybar = 10_000_000n;
const serviceFeeAmount = 100_000n;
const signedCap = 1_000_000n;
const sponsorFeeCapTinybar = 800_000_000n;
const route = {
  wrapper: getAddress("0x0000000000000000000000000000000000000000"),
  htsToken: token,
  router,
  whbar,
  wrapperRate: 1n,
  swapPath: encodeExactOutputPath([token, whbar], [feeTier]),
};

async function tokenBalance(accountId: string): Promise<bigint> {
  const response = await fetch(`${mirrorBase}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}&limit=1`);
  if (!response.ok) throw new Error(`token balance read failed: ${response.status}`);
  const body = await response.json() as { tokens?: { balance?: number | string }[] };
  return BigInt(body.tokens?.[0]?.balance ?? 0);
}

async function hbarBalance(accountId: string): Promise<bigint> {
  const response = await fetch(`${mirrorBase}/api/v1/accounts/${accountId}`);
  if (!response.ok) throw new Error(`HBAR balance read failed: ${response.status}`);
  const body = await response.json() as { balance?: { balance?: number | string } };
  return BigInt(body.balance?.balance ?? 0);
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    last = await read();
  }
  if (!accept(last)) throw new Error("authoritative readback did not converge before timeout");
  return last;
}

const proxyCode = await publicClient.getCode({ address: proxy });
const [userTokenBeforeSetup, userHbarBeforeSetup, facilitatorTokenBefore, sponsorHbarBefore, allowanceBefore] = await Promise.all([
  tokenBalance(userId),
  hbarBalance(userId),
  tokenBalance(facilitatorId),
  hbarBalance(sponsorId),
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [user.address, permit2] }) as Promise<bigint>,
]);
const quote = await mirror.quoteExactOutput(
  quoter,
  encodeExactOutputPath([token, whbar], [feeTier]),
  exactHbarTinybar,
  user.address,
);
const tradeAmountInMaximum = (quote.amountIn * 10_500n + 9_999n) / 10_000n;
if (serviceFeeAmount + tradeAmountInMaximum > signedCap) throw new Error("testnet route exceeds the reviewed signed cap");
const facilitatorAssociated = facilitatorTokenBefore > 0n || await fetch(
  `${mirrorBase}/api/v1/accounts/${facilitatorId}/tokens?token.id=${tokenId}&limit=1`,
).then(async (response) => ((await response.json()) as { tokens?: unknown[] }).tokens?.length === 1);

const baseProof: Record<string, unknown> = {
  schema: "refuel402.refuel-authorization-testnet-e2e.v1",
  checkedAt: new Date().toISOString(),
  executeRequested: execute,
  sourceSha256: artifact.sourceSha256,
  network: { mode: "testnet", chainId: 296 },
  contracts: { proxy, proxyRuntimePresent: !!proxyCode && proxyCode !== "0x", permit2, facilitator, router, quoter, whbar },
  user: { accountId: userId, address: user.address, tokenId, tokenBalanceBeforeSetup: userTokenBeforeSetup.toString(), hbarBalanceBeforeSetup: userHbarBeforeSetup.toString() },
  sponsor: { accountId: sponsorId, address: sponsorAddress, hbarBalanceBefore: sponsorHbarBefore.toString(), maximumExposureTinybar: sponsorFeeCapTinybar.toString() },
  setup: { facilitatorAssociated, permit2AllowanceBefore: allowanceBefore.toString() },
  authorization: {
    exactHbarTinybar: exactHbarTinybar.toString(),
    serviceFeeAmount: serviceFeeAmount.toString(),
    signedCap: signedCap.toString(),
    deadlineSeconds: 7_200,
    routeHash: refuelRouteHash(route),
  },
  liveQuote: { amountIn: quote.amountIn.toString(), tradeAmountInMaximum: tradeAmountInMaximum.toString(), gasEstimate: quote.gasEstimate.toString() },
  transactionBudget: { proxyExecution: 1, facilitatorAssociationMaximum: facilitatorAssociated ? 0 : 1, permit2ApprovalMaximum: allowanceBefore >= signedCap ? 0 : 1, replayTransactions: 0 },
};

function writeProof(proof: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(outputPath!), { recursive: true });
  fs.writeFileSync(outputPath!, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
}

if (!proxyCode || proxyCode === "0x") {
  const proof = { ...baseProof, state: "blocked_proxy_not_deployed" };
  writeProof(proof);
  console.log(JSON.stringify(proof, null, 2));
  process.exit(execute ? 2 : 0);
}
if (!execute) {
  const proof = { ...baseProof, state: "planned_not_submitted" };
  writeProof(proof);
  console.log(JSON.stringify(proof, null, 2));
  process.exit(0);
}

const transactions: Record<string, unknown>[] = [];
try {
  if (!facilitatorAssociated) {
    const client = Client.forTestnet().setOperator(
      AccountId.fromString(facilitatorId),
      PrivateKey.fromStringECDSA(facilitatorKey),
    );
    const response = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(facilitatorId))
      .setTokenIds([TokenId.fromString(tokenId)])
      .setMaxTransactionFee(new Hbar(2))
      .execute(client);
    const receipt = await response.getReceipt(client);
    transactions.push({ kind: "facilitator_token_association", transactionId: response.transactionId.toString(), status: receipt.status.toString() });
    client.close();
    if (receipt.status.toString() !== "SUCCESS") throw new Error("facilitator token association failed");
    await waitFor(() => fetch(`${mirrorBase}/api/v1/accounts/${facilitatorId}/tokens?token.id=${tokenId}&limit=1`).then((response) => response.json() as Promise<{ tokens?: unknown[] }>), (value) => value.tokens?.length === 1);
  }

  if (allowanceBefore < signedCap) {
    const wallet = createWalletClient({ account: user, chain, transport: http(rpcUrl, { timeout: 20_000 }) });
    const approvalHash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [permit2, signedCap] });
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1, timeout: 120_000 });
    } catch {
      throw new Error(`PERMIT2_APPROVAL_OUTCOME_UNKNOWN:${approvalHash}`);
    }
    transactions.push({ kind: "permit2_allowance_prerequisite", hash: approvalHash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
    if (receipt.status !== "success") throw new Error(`PERMIT2_APPROVAL_REVERTED:${approvalHash}`);
    await waitFor(
      () => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [user.address, permit2] }) as Promise<bigint>,
      (value) => value >= signedCap,
    );
  }

  const journeyId = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1_000);
  const authorization = {
    owner: user.address,
    token,
    maxAmountIn: signedCap,
    exactHbarTinybar,
    serviceFeeAmount,
    recipient: user.address,
    journeyNonce: journeyNonce(journeyId),
    deadline: BigInt(nowSec + 7_200),
    routeHash: refuelRouteHash(route),
  };
  const signature = await user.signTypedData(refuelAuthorizationTypedData({
    chainId: 296,
    permit2,
    spender: proxy,
    authorization,
  }));
  const record: RefuelAuthorizationRecord = {
    id: refuelAuthorizationId(authorization),
    journeyId,
    state: "executing",
    owner: authorization.owner,
    token,
    maxAmountIn: signedCap.toString(),
    exactHbarTinybar: exactHbarTinybar.toString(),
    serviceFeeAmount: serviceFeeAmount.toString(),
    maxSponsorExposureTinybar: sponsorFeeCapTinybar.toString(),
    recipient: authorization.recipient,
    journeyNonce: authorization.journeyNonce.toString(),
    deadline: Number(authorization.deadline),
    routeHash: authorization.routeHash,
    signature,
    permit2,
    spender: proxy,
    route: { ...route, wrapperRate: route.wrapperRate.toString() },
    attemptCount: 1,
    nextAttemptAt: 0,
    executionReference: null,
    lastErrorCode: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const calldata = authorizationCalldata(record, tradeAmountInMaximum);
  await publicClient.call({ account: sponsorAddress, to: proxy, data: calldata });

  const [userTokenBefore, userHbarBefore, facilitatorBefore, sponsorBefore] = await Promise.all([
    tokenBalance(userId),
    hbarBalance(userId),
    tokenBalance(facilitatorId),
    hbarBalance(sponsorId),
  ]);
  const sponsor = new SponsorClient("testnet", sponsorId, sponsorKey);
  const submission = await sponsor.executeContractCall({
    contract: proxy,
    calldata,
    gas: 3_500_000n,
    maxTransactionFeeTinybar: sponsorFeeCapTinybar,
    memo: `Refuel402 auth ${journeyId}`,
  });
  sponsor.close();
  transactions.push({ kind: "authorized_refuel", hederaTransactionId: submission.hederaTransactionId, ethereumHash: submission.ethereumHash, status: submission.status });
  if (submission.status !== "SUCCESS") throw new Error("authorized refuel did not return a successful HAPI receipt");
  const transactionMatch = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(submission.hederaTransactionId);
  if (!transactionMatch) throw new Error("authorized refuel transaction id is malformed");
  const mirrorTransactionId = `${transactionMatch[1]}-${transactionMatch[2]}-${transactionMatch[3]}`;
  const contractResult = await waitFor(
    () => fetch(`${mirrorBase}/api/v1/contracts/results/${mirrorTransactionId}`).then(async (response) => response.ok ? response.json() as Promise<Record<string, any>> : null),
    (value) => value !== null,
    120_000,
  );
  if (!contractResult || contractResult.error_message !== null || !Array.isArray(contractResult.logs)) {
    throw new Error("authorized refuel contract result is unavailable or reverted");
  }
  const eventLog = contractResult.logs.map((log: any): any => {
    try { return decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics }); } catch { return null; }
  }).find((log: any) => log?.eventName === "RefuelExecuted") as { args?: Record<string, any> } | undefined;
  if (!eventLog?.args) throw new Error("RefuelExecuted event is absent");

  const [userTokenAfter, userHbarAfter, facilitatorAfter, sponsorAfter, proxyTokenAfter] = await Promise.all([
    waitFor(() => tokenBalance(userId), (value) => value < userTokenBefore),
    waitFor(() => hbarBalance(userId), (value) => value >= userHbarBefore + exactHbarTinybar),
    waitFor(() => tokenBalance(facilitatorId), (value) => value >= facilitatorBefore + serviceFeeAmount),
    waitFor(() => hbarBalance(sponsorId), (value) => value < sponsorBefore),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [proxy] }) as Promise<bigint>,
  ]);
  const event = eventLog.args;
  const spent = BigInt(event.spent);
  const refunded = BigInt(event.refunded);
  const sponsorDebit = sponsorBefore - sponsorAfter;
  const predicates = {
    owner: getAddress(event.owner) === user.address,
    authorizationId: String(event.authorizationId).toLowerCase() === record.id.toLowerCase(),
    routeHash: String(event.routeHash).toLowerCase() === authorization.routeHash.toLowerCase(),
    exactHbar: userHbarAfter - userHbarBefore === exactHbarTinybar && BigInt(event.hbarDelivered) === exactHbarTinybar,
    fixedFee: facilitatorAfter - facilitatorBefore === serviceFeeAmount && BigInt(event.serviceFeeAmount) === serviceFeeAmount,
    tokenDebit: userTokenBefore - userTokenAfter === spent,
    capReconciled: spent + refunded === signedCap && spent <= signedCap,
    zeroProxyDust: proxyTokenAfter === 0n,
    sponsorBounded: sponsorDebit > 0n && sponsorDebit <= sponsorFeeCapTinybar,
    sponsorReserve: sponsorAfter >= 2_500_000_000n,
  };
  let replayRejected = false;
  try { await publicClient.call({ account: sponsorAddress, to: proxy, data: calldata }); } catch { replayRejected = true; }
  Object.assign(predicates, { replayRejected });
  if (Object.values(predicates).some((value) => value !== true)) throw new Error("testnet refuel acceptance predicate failed");
  const proof = {
    ...baseProof,
    state: "completed",
    journeyId,
    authorizationId: record.id,
    transactions,
    contractResult: {
      hash: contractResult.hash,
      transactionId: submission.hederaTransactionId,
      consensusTimestamp: contractResult.timestamp,
      blockNumber: String(contractResult.block_number),
      gasUsed: String(contractResult.gas_used),
    },
    event: Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
    balances: {
      userTokenBefore: userTokenBefore.toString(), userTokenAfter: userTokenAfter.toString(),
      userHbarBefore: userHbarBefore.toString(), userHbarAfter: userHbarAfter.toString(),
      facilitatorTokenBefore: facilitatorBefore.toString(), facilitatorTokenAfter: facilitatorAfter.toString(),
      sponsorHbarBefore: sponsorBefore.toString(), sponsorHbarAfter: sponsorAfter.toString(), sponsorDebit: sponsorDebit.toString(),
      proxyTokenAfter: proxyTokenAfter.toString(),
    },
    predicates,
    reconciliation: "complete",
  };
  writeProof(proof);
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  const proof = {
    ...baseProof,
    state: String((error as Error).message).includes("OUTCOME_UNKNOWN") ? "unknown" : "failed",
    error: error instanceof Error ? error.message : String(error),
    transactions,
    reconciliation: "incomplete",
  };
  writeProof(proof);
  console.log(JSON.stringify(proof, null, 2));
  process.exit(2);
}
