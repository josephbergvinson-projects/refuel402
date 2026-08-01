import { decodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { REFUEL402_EXACT_PAYMENT_FIELDS } from "./exact-payment-witness.js";
import type { ProductPaymentVerifier } from "./product-lifecycle.js";
import type { ProductJourneyRecord, StoredProductQuote } from "./product-lifecycle-store.js";
import type {
  ExactEvmPayment,
  ExactEvmPaymentRequirements,
  FacilitatorProof,
} from "./evm-facilitator.js";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function facilitatorUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid facilitator URL");
  const privateRailway = parsed.hostname.endsWith(".railway.internal");
  if (parsed.protocol === "http:" && !privateRailway && !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("non-private facilitator must use HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

async function postJson(url: string, body: unknown, idempotencyKey?: string): Promise<FacilitatorProof> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.length > 256_000) throw new Error("facilitator response exceeded size limit");
  const parsed = JSON.parse(text) as FacilitatorProof & { code?: string; message?: string };
  if (!response.ok) throw new Error(parsed.code ?? "facilitator request failed");
  return parsed;
}

export function requirementsFromQuote(quote: StoredProductQuote): ExactEvmPaymentRequirements {
  const record = quote.record;
  const x402 = asObject(record.x402);
  const asset = asObject(record.asset);
  const destination = asObject(asset.destination);
  const contract = asObject(x402.contract);
  const chainId = quote.mode === "mainnet" ? 295 : 296;
  const amount = String(x402.feeAmount ?? "");
  const token = String(x402.asset ?? destination.address ?? "");
  const recipient = String(x402.payTo ?? process.env.X402_PAYMENT_RECIPIENT ?? "");
  const spender = String(contract.proxy ?? x402.proxy ?? "");
  const contextHash = String(x402.contextHash ?? keccak256(stringToHex(quote.quoteId)));
  if (!/^\d+$/.test(amount) || !/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
    throw new Error("stored quote is missing exact EVM payment requirements");
  }
  return {
    scheme: "exact",
    network: `eip155:${chainId}`,
    chainId,
    token: getAddress(token),
    amount,
    recipient: getAddress(recipient),
    spender: getAddress(spender),
    contextHash: contextHash as Hex,
    maxTimeoutSeconds: Number(x402.maxTimeoutSeconds ?? 180),
  };
}

function parsePaymentHeader(paymentSignature: string): { payment: ExactEvmPayment; accepted?: unknown } {
  const decoded = asObject(decodePaymentSignatureHeader(paymentSignature));
  const payload = asObject(decoded.payload);
  const raw = asObject(payload.payment ?? payload);
  // chainId/deadline travel as JSON numbers; the other uint256 fields stay decimal strings.
  const witness = Object.fromEntries(REFUEL402_EXACT_PAYMENT_FIELDS.map(({ name, type }) => [
    name,
    type === "address"
      ? getAddress(String(raw[name]))
      : name === "chainId" || name === "deadline" ? Number(raw[name]) : String(raw[name]),
  ])) as Omit<ExactEvmPayment, "signature">;
  return {
    accepted: decoded.accepted,
    payment: { ...witness, signature: String(raw.signature) as Hex },
  };
}

export function createFacilitatorProductPaymentVerifier(options: {
  url: string;
  loadQuote: (journey: ProductJourneyRecord) => Promise<StoredProductQuote | null>;
}): ProductPaymentVerifier {
  const base = facilitatorUrl(options.url);
  return {
    async verify({ journey, paymentSignature }) {
      const quote = await options.loadQuote(journey);
      if (!quote || quote.quoteId !== journey.quoteId) throw new Error("stored journey quote is unavailable");
      const requirements = requirementsFromQuote(quote);
      const { payment } = parsePaymentHeader(paymentSignature);
      if (
        payment.payer !== journey.account ||
        payment.chainId !== requirements.chainId ||
        payment.contextHash !== requirements.contextHash
      ) throw new Error("payment identity does not match the journey");
      const proof = await postJson(
        `${base}/settle`,
        { payment, requirements },
        `settle-${journey.id}-${keccak256(stringToHex(payment.nonce)).slice(2, 18)}`,
      );
      if (proof.state !== "settled" || !proof.settlementTransactionHash) {
        throw new Error("facilitator returned no settled receipt");
      }
      return {
        paymentIdentity: proof.paymentId,
        payer: proof.payer,
        network: `eip155:${proof.chainId}`,
        asset: proof.token,
        amount: proof.amount,
        settlementReference: proof.settlementTransactionHash,
        proofHash: keccak256(stringToHex(JSON.stringify(proof))),
      };
    },
  };
}
