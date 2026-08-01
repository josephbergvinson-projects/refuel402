import crypto from "node:crypto";
import express from "express";
import { getAddress, isHex, keccak256, stringToHex, type Address, type Hex } from "viem";
import { REFUEL402_EXACT_PAYMENT_FIELDS } from "./exact-payment-witness.js";

export type ExactEvmPayment = {
  payer: Address;
  token: Address;
  amount: string;
  recipient: Address;
  chainId: 295 | 296;
  nonce: string;
  deadline: number;
  spender: Address;
  contextHash: Hex;
  signature: Hex;
};

export type ExactEvmPaymentRequirements = Omit<ExactEvmPayment, "payer" | "nonce" | "deadline" | "signature"> & {
  scheme: "exact";
  network: `eip155:${295 | 296}`;
  maxTimeoutSeconds: number;
};

export type FacilitatorProof = {
  schema: "refuel402.evm-facilitator-proof.v1";
  paymentId: Hex;
  contextHash: Hex;
  chainId: 295 | 296;
  payer: Address;
  token: Address;
  amount: string;
  recipient: Address;
  proxy: Address;
  verifiedAt: string;
  settledAt: string | null;
  settlementTransactionHash: Hex | null;
  state: "verified" | "settled" | "unknown";
};

export type FacilitatorSettlementAdapter = {
  settle(payment: ExactEvmPayment, paymentId: Hex): Promise<{ transactionHash: Hex }>;
};

export type FacilitatorSignatureVerifier = (
  payment: ExactEvmPayment,
  requirements: ExactEvmPaymentRequirements,
) => Promise<boolean>;

export class FacilitatorError extends Error {
  constructor(
    readonly code:
      | "FACILITATOR_NOT_READY"
      | "PAYMENT_REQUIREMENTS_MISMATCH"
      | "PAYMENT_EXPIRED"
      | "PAYMENT_SIGNATURE_INVALID"
      | "PAYMENT_REPLAY"
      | "PAYMENT_SETTLEMENT_UNKNOWN",
    message: string,
  ) {
    super(message);
  }
}

function paymentId(payment: ExactEvmPayment): Hex {
  return keccak256(stringToHex(REFUEL402_EXACT_PAYMENT_FIELDS
    .map(({ name, type }) => (type === "address" ? getAddress(String(payment[name])) : String(payment[name])))
    .join(":")));
}

function canonicalPayment(payment: ExactEvmPayment): ExactEvmPayment {
  if (!/^\d+$/.test(payment.amount) || BigInt(payment.amount) <= 0n) {
    throw new FacilitatorError("PAYMENT_REQUIREMENTS_MISMATCH", "payment amount must be a positive base-unit integer");
  }
  if (!/^\d+$/.test(payment.nonce)) {
    throw new FacilitatorError("PAYMENT_REQUIREMENTS_MISMATCH", "payment nonce must be an unsigned integer");
  }
  if (!isHex(payment.contextHash, { strict: true }) || payment.contextHash.length !== 66) {
    throw new FacilitatorError("PAYMENT_REQUIREMENTS_MISMATCH", "payment context hash must be bytes32");
  }
  if (!isHex(payment.signature, { strict: true }) || payment.signature.length < 132) {
    throw new FacilitatorError("PAYMENT_SIGNATURE_INVALID", "payment signature is malformed");
  }
  return {
    ...payment,
    payer: getAddress(payment.payer),
    token: getAddress(payment.token),
    recipient: getAddress(payment.recipient),
    spender: getAddress(payment.spender),
  };
}

export class LocalEvmFacilitator {
  private readonly proofs = new Map<Hex, FacilitatorProof>();
  private readonly idempotency = new Map<string, Hex>();
  private readonly rateBuckets = new Map<string, { start: number; count: number }>();

  constructor(readonly options: {
    chains: readonly (295 | 296)[];
    proxies: Record<295 | 296, Address>;
    verifier?: FacilitatorSignatureVerifier;
    settlement?: FacilitatorSettlementAdapter;
    rateLimitPerMinute?: number;
    logger?: (entry: Record<string, unknown>) => void;
    now?: () => number;
  }) {}

  readiness() {
    return {
      ok: !!this.options.verifier && !!this.options.settlement,
      schema: "refuel402.evm-facilitator-health.v1",
      chains: this.options.chains.map((chainId) => `eip155:${chainId}`),
      verificationReady: !!this.options.verifier,
      settlementReady: !!this.options.settlement,
      secretLogging: false,
    };
  }

  supported() {
    return {
      schema: "refuel402.evm-facilitator-supported.v1",
      kinds: this.options.chains.map((chainId) => ({
        network: `eip155:${chainId}`,
        scheme: "exact",
        transferMethod: "permit2",
        proxy: this.options.proxies[chainId],
      })),
    };
  }

  private allow(clientKey: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    const limit = this.options.rateLimitPerMinute ?? 60;
    const prior = this.rateBuckets.get(clientKey);
    if (!prior || now - prior.start >= 60_000) {
      this.rateBuckets.set(clientKey, { start: now, count: 1 });
      return true;
    }
    prior.count += 1;
    return prior.count <= limit;
  }

  async verify(paymentInput: ExactEvmPayment, requirements: ExactEvmPaymentRequirements): Promise<FacilitatorProof> {
    if (!this.options.verifier || !this.options.settlement) {
      throw new FacilitatorError("FACILITATOR_NOT_READY", "facilitator verification/settlement adapters are not configured");
    }
    const payment = canonicalPayment(paymentInput);
    if (
      !this.options.chains.includes(payment.chainId) ||
      requirements.scheme !== "exact" ||
      requirements.network !== `eip155:${payment.chainId}` ||
      getAddress(requirements.token) !== payment.token ||
      requirements.amount !== payment.amount ||
      getAddress(requirements.recipient) !== payment.recipient ||
      requirements.chainId !== payment.chainId ||
      getAddress(requirements.spender) !== payment.spender ||
      requirements.contextHash !== payment.contextHash ||
      getAddress(this.options.proxies[payment.chainId]) !== payment.spender
    ) {
      throw new FacilitatorError("PAYMENT_REQUIREMENTS_MISMATCH", "payment fields do not match the exact requirements");
    }
    const nowSec = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    if (payment.deadline <= nowSec || payment.deadline > nowSec + requirements.maxTimeoutSeconds) {
      throw new FacilitatorError("PAYMENT_EXPIRED", "payment deadline is expired or exceeds the quoted window");
    }
    if (!(await this.options.verifier(payment, requirements))) {
      throw new FacilitatorError("PAYMENT_SIGNATURE_INVALID", "payment signature did not verify against the payer and Permit2 witness");
    }
    const id = paymentId(payment);
    const existing = this.proofs.get(id);
    if (existing?.state === "settled") {
      throw new FacilitatorError("PAYMENT_REPLAY", "exact payment was already settled");
    }
    if (existing?.state === "unknown") {
      throw new FacilitatorError("PAYMENT_SETTLEMENT_UNKNOWN", "settlement result is unknown; reconcile before retry");
    }
    const proof: FacilitatorProof = existing ?? {
      schema: "refuel402.evm-facilitator-proof.v1",
      paymentId: id,
      contextHash: payment.contextHash,
      chainId: payment.chainId,
      payer: payment.payer,
      token: payment.token,
      amount: payment.amount,
      recipient: payment.recipient,
      proxy: payment.spender,
      verifiedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      settledAt: null,
      settlementTransactionHash: null,
      state: "verified",
    };
    this.proofs.set(id, proof);
    this.options.logger?.({ event: "payment_verified", paymentId: id, chainId: payment.chainId, contextHash: payment.contextHash });
    return proof;
  }

  async settle(
    payment: ExactEvmPayment,
    requirements: ExactEvmPaymentRequirements,
    idempotencyKey: string,
  ): Promise<FacilitatorProof> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new FacilitatorError("PAYMENT_REQUIREMENTS_MISMATCH", "settlement idempotency key is invalid");
    }
    const canonical = canonicalPayment(payment);
    const candidatePaymentId = paymentId(canonical);
    const priorPaymentId = this.idempotency.get(idempotencyKey);
    if (priorPaymentId && priorPaymentId !== candidatePaymentId) {
      throw new FacilitatorError("PAYMENT_REPLAY", "idempotency key is bound to a different payment");
    }
    const existing = this.proofs.get(candidatePaymentId);
    if (priorPaymentId === candidatePaymentId && existing?.state === "settled") return existing;
    if (existing?.state === "unknown") {
      throw new FacilitatorError("PAYMENT_SETTLEMENT_UNKNOWN", "settlement result is unknown; reconcile before retry");
    }
    const verified = await this.verify(canonical, requirements);
    this.idempotency.set(idempotencyKey, verified.paymentId);
    try {
      const result = await this.options.settlement!.settle(canonicalPayment(payment), verified.paymentId);
      const proof: FacilitatorProof = {
        ...verified,
        settledAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        settlementTransactionHash: result.transactionHash,
        state: "settled",
      };
      this.proofs.set(verified.paymentId, proof);
      this.options.logger?.({ event: "payment_settled", paymentId: verified.paymentId, chainId: payment.chainId, transactionHash: result.transactionHash });
      return proof;
    } catch {
      this.proofs.set(verified.paymentId, { ...verified, state: "unknown" });
      this.options.logger?.({ event: "payment_settlement_unknown", paymentId: verified.paymentId, chainId: payment.chainId });
      throw new FacilitatorError("PAYMENT_SETTLEMENT_UNKNOWN", "settlement result is unknown; reconcile before retry");
    }
  }

  router() {
    const router = express.Router();
    router.use(express.json({ limit: "64kb" }));
    router.use((req, res, next) => {
      const key = crypto.createHash("sha256").update(req.ip || req.socket.remoteAddress || "unknown").digest("hex");
      if (!this.allow(key)) return res.status(429).json({ code: "FACILITATOR_RATE_LIMITED", retriable: true });
      next();
    });
    router.get("/live", (_req, res) => res.json({ ok: true, schema: "refuel402.evm-facilitator-liveness.v1" }));
    router.get("/health", (_req, res) => res.status(this.readiness().ok ? 200 : 503).json(this.readiness()));
    router.get("/supported", (_req, res) => res.json(this.supported()));
    router.post("/verify", async (req, res) => {
      try {
        res.json(await this.verify(req.body.payment, req.body.requirements));
      } catch (error) {
        const known = error instanceof FacilitatorError ? error : new FacilitatorError("PAYMENT_SIGNATURE_INVALID", "payment verification failed");
        res.status(known.code === "FACILITATOR_NOT_READY" ? 503 : 422).json({ code: known.code, message: known.message, retriable: false });
      }
    });
    router.post("/settle", async (req, res) => {
      try {
        const key = req.header("idempotency-key") ?? "";
        res.json(await this.settle(req.body.payment, req.body.requirements, key));
      } catch (error) {
        const known = error instanceof FacilitatorError ? error : new FacilitatorError("PAYMENT_SETTLEMENT_UNKNOWN", "payment settlement failed");
        res.status(known.code === "FACILITATOR_NOT_READY" ? 503 : known.code === "PAYMENT_SETTLEMENT_UNKNOWN" ? 502 : 409)
          .json({ code: known.code, message: known.message, retriable: known.code === "PAYMENT_SETTLEMENT_UNKNOWN" });
      }
    });
    return router;
  }
}
