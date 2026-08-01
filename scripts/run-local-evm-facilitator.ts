import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  verifyTypedData,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  LocalEvmFacilitator,
  type FacilitatorSettlementAdapter,
  type FacilitatorSignatureVerifier,
} from "../server/src/evm-facilitator.js";
import { exactPaymentTypes } from "../server/src/exact-payment-witness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chainId = Number(process.env.FACILITATOR_CHAIN_ID) as 295 | 296;
const rpcUrl = process.env.FACILITATOR_RPC_URL ?? "";
const proxy = process.env.FACILITATOR_PROXY_ADDRESS ?? "";
const permit2 = process.env.FACILITATOR_PERMIT2_ADDRESS ?? "";
const rawPrivateKey = process.env.FACILITATOR_PRIVATE_KEY;
const executionEnabled = process.env.FACILITATOR_EXECUTION_ENABLED === "1";
const port = Number(process.env.FACILITATOR_PORT ?? 4402);
const host = process.env.FACILITATOR_HOST ?? "0.0.0.0";
const rateLimitPerMinute = Number(process.env.FACILITATOR_RATE_LIMIT_PER_MINUTE ?? 60);
const settlementGasLimit = BigInt(process.env.FACILITATOR_SETTLEMENT_GAS_LIMIT ?? 750_000);
if (![295, 296].includes(chainId)) throw new Error("FACILITATOR_CHAIN_ID must be 295 or 296");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("FACILITATOR_PORT must be a valid TCP port");
if (!["0.0.0.0", "127.0.0.1", "localhost"].includes(host)) {
  throw new Error("FACILITATOR_HOST must be 0.0.0.0, 127.0.0.1, or localhost");
}
if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 300) {
  throw new Error("FACILITATOR_RATE_LIMIT_PER_MINUTE must be between 1 and 300");
}
if (settlementGasLimit < 100_000n || settlementGasLimit > 2_000_000n) {
  throw new Error("FACILITATOR_SETTLEMENT_GAS_LIMIT must be between 100000 and 2000000");
}
if (!/^https:\/\//.test(rpcUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(rpcUrl)) {
  throw new Error("facilitator RPC must be HTTPS or a local HTTP endpoint");
}
if (!/^0x[0-9a-fA-F]{40}$/.test(proxy) || !/^0x[0-9a-fA-F]{40}$/.test(permit2)) {
  throw new Error("facilitator proxy/Permit2 addresses are required");
}
function normalizePrivateKey(raw: string): Hex {
  const hex = raw.replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return `0x${hex}` as Hex;
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("FACILITATOR_PRIVATE_KEY must be raw or DER hexadecimal");
  const marker = hex.lastIndexOf("0420");
  const scalar = marker >= 0 && marker + 4 + 64 === hex.length
    ? hex.slice(marker + 4)
    : "";
  if (!/^[0-9a-fA-F]{64}$/.test(scalar)) {
    throw new Error("FACILITATOR_PRIVATE_KEY DER encoding is not a bounded 32-byte scalar envelope");
  }
  return `0x${scalar}` as Hex;
}
const privateKey = rawPrivateKey ? normalizePrivateKey(rawPrivateKey) : undefined;
if (executionEnabled && (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))) {
  throw new Error("FACILITATOR_PRIVATE_KEY is required when execution is enabled");
}
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "artifacts", "Refuel402ExactPermit2Proxy.json"), "utf8"));
const chain = defineChain({
  id: chainId,
  name: chainId === 296 ? "Hedera Testnet" : "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const keyAccount = privateKey ? privateKeyToAccount(privateKey) : null;
const expectedFacilitator = process.env.FACILITATOR_EXPECTED_ADDRESS;
if (keyAccount && expectedFacilitator && keyAccount.address !== getAddress(expectedFacilitator)) {
  throw new Error("FACILITATOR_PRIVATE_KEY does not match FACILITATOR_EXPECTED_ADDRESS");
}
const account = executionEnabled ? keyAccount : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(rpcUrl) }) : null;
const publicClient = account ? createPublicClient({ chain, transport: http(rpcUrl) }) : null;
const verifier: FacilitatorSignatureVerifier | undefined = account
  ? (payment) => verifyTypedData({
      address: payment.payer,
      domain: { name: "Permit2", chainId, verifyingContract: getAddress(permit2) },
      types: exactPaymentTypes(),
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: payment.token, amount: BigInt(payment.amount) },
        spender: payment.spender,
        nonce: BigInt(payment.nonce),
        deadline: BigInt(payment.deadline),
        witness: {
          payer: payment.payer,
          token: payment.token,
          amount: BigInt(payment.amount),
          recipient: payment.recipient,
          chainId: BigInt(payment.chainId),
          nonce: BigInt(payment.nonce),
          deadline: BigInt(payment.deadline),
          spender: payment.spender,
          contextHash: payment.contextHash,
        },
      },
      signature: payment.signature,
    })
  : undefined;
const settlement: FacilitatorSettlementAdapter | undefined = wallet && publicClient
  ? {
      settle: async (payment) => {
        const transactionHash = await wallet.writeContract({
          address: getAddress(proxy),
          abi: artifact.abi,
          functionName: "settle",
          args: [
            {
              payer: payment.payer,
              token: payment.token,
              amount: BigInt(payment.amount),
              recipient: payment.recipient,
              chainId: BigInt(payment.chainId),
              nonce: BigInt(payment.nonce),
              deadline: BigInt(payment.deadline),
              spender: payment.spender,
              contextHash: payment.contextHash,
            },
            {
              permitted: { token: payment.token, amount: BigInt(payment.amount) },
              nonce: BigInt(payment.nonce),
              deadline: BigInt(payment.deadline),
            },
            payment.signature,
          ],
          gas: settlementGasLimit,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 });
        if (receipt.status !== "success") throw new Error("proxy settlement transaction reverted");
        return { transactionHash };
      },
    }
  : undefined;
const service = new LocalEvmFacilitator({
  chains: [chainId],
  proxies: { 295: getAddress(proxy), 296: getAddress(proxy) },
  verifier,
  settlement,
  rateLimitPerMinute,
  logger: (entry) => console.log(JSON.stringify(entry)),
});
const app = express();
app.set("trust proxy", false);
app.use(service.router());
const server = app.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "facilitator_started",
    host,
    port,
    chainId,
    executionEnabled,
    facilitator: keyAccount?.address ?? null,
    proxy: getAddress(proxy),
    settlementGasLimit: settlementGasLimit.toString(),
    rateLimitPerMinute,
    secretLogging: false,
  }));
});
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
