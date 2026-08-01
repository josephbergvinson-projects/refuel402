import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import type { ProductMode } from "./support.js";
import type { SponsorExposureOptions } from "./sponsor-exposure.js";

export type PolicyRpcAuthorization = {
  id: string;
  mode: ProductMode;
  account: Address;
  chainId: number;
  nonce: number;
  to: Address;
  dataHash: Hex;
  value: bigint;
  gasLimitMaximum: bigint;
  maxGasAllowanceTinybar: bigint;
  expiresAt: number;
};

export type PolicyRpcTransactionCandidate = {
  mode: ProductMode;
  account: Address;
  chainId: number;
  nonce: number;
  to: Address;
  dataHash: Hex;
  value: bigint;
  gasLimit: bigint;
};

export type PolicyRpcAuthorizer = {
  consume(rawTransactionHash: Hex, candidate: PolicyRpcTransactionCandidate): Promise<PolicyRpcAuthorization | null>;
  markSubmitted?(authorizationId: string, ethereumHash: Hex): Promise<void>;
  markRejected?(authorizationId: string, reason: string): Promise<void>;
  markUnknown?(authorizationId: string, reason: string): Promise<void>;
};

export type PolicyRpcSubmitter = {
  submit(
    rawTransaction: Hex,
    maxGasAllowanceTinybar: bigint,
  ): Promise<{ ethereumHash: Hex | null }>;
};

export class PolicyRpcSubmissionRejectedError extends Error {}
export class PolicyRpcSubmissionUnknownError extends Error {}

export type PolicyRpcSubmitterPolicy = {
  chainId: number;
  allowedTargets: Address[];
  allowedSelectors: Hex[];
  perTransactionCapTinybar: bigint;
  dailyCapTinybar: bigint;
  minimumReserveTinybar: bigint;
};

/**
 * Bounded sponsor adapter used by the live policy-RPC injection point and the
 * deterministic product harness. It keeps replay/unknown state in addition to
 * the durable PostgreSQL authorization/submission authority.
 */
export function createBoundedPolicyRpcSubmitter(options: {
  policy: PolicyRpcSubmitterPolicy;
  sponsor: { submitSponsored(raw: Hex, allowance: bigint): Promise<{ ethereumHash: Hex | null }> };
  estimateGas(raw: Hex): Promise<bigint>;
  reserveTinybar(): Promise<bigint>;
  exposureSince(cutoffMs: number, options?: SponsorExposureOptions): Promise<bigint>;
  gasTinybarPerUnit?: bigint;
  now?: () => number;
}): PolicyRpcSubmitter {
  const outcomes = new Map<Hex, { state: "submitted" | "unknown"; ethereumHash: Hex | null }>();
  const targets = new Set(options.policy.allowedTargets.map((target) => getAddress(target)));
  const selectors = new Set(options.policy.allowedSelectors.map((selector) => selector.toLowerCase()));
  // Nothing has been broadcast yet, so a failed pre-flight read is a refusal -
  // never an unknown submission that pushes the journey to review for a
  // transaction that never left this process.
  const preflight = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch {
      throw new PolicyRpcSubmissionRejectedError("sponsor policy pre-flight reads are unavailable");
    }
  };
  return {
    async submit(rawTransaction, maxGasAllowanceTinybar) {
      const rawHash = keccak256(rawTransaction);
      const prior = outcomes.get(rawHash);
      if (prior?.state === "submitted") return { ethereumHash: prior.ethereumHash };
      if (prior?.state === "unknown") throw new PolicyRpcSubmissionUnknownError("submission outcome is unknown; reconcile before retry");
      const transaction = parseTransaction(rawTransaction as TransactionSerialized);
      if (Number(transaction.chainId) !== options.policy.chainId) throw new PolicyRpcSubmissionRejectedError("submitter chain is not allowed");
      if (!transaction.to || !targets.has(getAddress(transaction.to))) throw new PolicyRpcSubmissionRejectedError("submitter target is not allowed");
      const data = (transaction.data ?? "0x") as Hex;
      const selector = data.slice(0, 10).toLowerCase();
      if (data !== "0x" && !selectors.has(selector)) throw new PolicyRpcSubmissionRejectedError("submitter selector is not allowed");
      if (maxGasAllowanceTinybar <= 0n || maxGasAllowanceTinybar > options.policy.perTransactionCapTinybar) {
        throw new PolicyRpcSubmissionRejectedError("submitter allowance exceeds the per-transaction cap");
      }
      const estimatedGas = await preflight(() => options.estimateGas(rawTransaction));
      const estimatedAllowance = estimatedGas * (options.gasTinybarPerUnit ?? 1n);
      if (estimatedAllowance > maxGasAllowanceTinybar) throw new PolicyRpcSubmissionRejectedError("estimated gas exceeds the authorized allowance");
      const [reserve, exposure] = await preflight(() => Promise.all([
        options.reserveTinybar(),
        // The durable authorization is already state='consumed' by the time this
        // runs, so counting it here would charge this transaction's allowance
        // against itself and refuse legitimate spend after the x402 payment has
        // already settled.
        options.exposureSince((options.now?.() ?? Date.now()) - 86_400_000, {
          excludeRawTransactionHash: rawHash,
        }),
      ]));
      if (reserve - maxGasAllowanceTinybar < options.policy.minimumReserveTinybar) {
        throw new PolicyRpcSubmissionRejectedError("sponsor reserve would fall below policy");
      }
      if (exposure + maxGasAllowanceTinybar > options.policy.dailyCapTinybar) {
        throw new PolicyRpcSubmissionRejectedError("daily sponsor exposure cap reached");
      }
      try {
        const submitted = await options.sponsor.submitSponsored(rawTransaction, maxGasAllowanceTinybar);
        if (!submitted.ethereumHash) throw new PolicyRpcSubmissionUnknownError("sponsor returned no EVM hash");
        outcomes.set(rawHash, { state: "submitted", ethereumHash: submitted.ethereumHash });
        return submitted;
      } catch {
        outcomes.set(rawHash, { state: "unknown", ethereumHash: null });
        throw new PolicyRpcSubmissionUnknownError("submission result is unknown; reconcile before retry");
      }
    },
  };
}

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown[];
};

const readMethods = new Set([
  "web3_clientVersion",
  "net_version",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt",
  "eth_syncing",
]);

function response(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

export async function authorizedRawTransactionCandidate(
  mode: ProductMode,
  rawTransaction: Hex,
): Promise<PolicyRpcTransactionCandidate> {
  const serialized = rawTransaction as TransactionSerialized;
  const transaction = parseTransaction(serialized);
  const account = getAddress(await recoverTransactionAddress({ serializedTransaction: serialized }));
  if (!transaction.to) throw new Error("target missing");
  return {
    mode,
    account,
    chainId: Number(transaction.chainId),
    nonce: Number(transaction.nonce),
    to: getAddress(transaction.to),
    dataHash: keccak256((transaction.data ?? "0x") as Hex),
    value: transaction.value ?? 0n,
    gasLimit: transaction.gas ?? 0n,
  };
}

export async function verifyAuthorizedRawTransaction(
  rawTransaction: Hex,
  authorization: PolicyRpcAuthorization,
): Promise<void> {
  const serialized = rawTransaction as TransactionSerialized;
  const transaction = parseTransaction(serialized);
  const sender = getAddress(await recoverTransactionAddress({ serializedTransaction: serialized }));
  const gas = transaction.gas ?? 0n;
  const data = (transaction.data ?? "0x") as Hex;
  if (authorization.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("authorization expired");
  if (sender !== getAddress(authorization.account)) throw new Error("sender mismatch");
  if (Number(transaction.chainId) !== authorization.chainId) throw new Error("chain mismatch");
  if (Number(transaction.nonce) !== authorization.nonce) throw new Error("nonce mismatch");
  if (!transaction.to || getAddress(transaction.to) !== getAddress(authorization.to)) {
    throw new Error("target mismatch");
  }
  if (keccak256(data) !== authorization.dataHash) throw new Error("calldata mismatch");
  if ((transaction.value ?? 0n) !== authorization.value) throw new Error("value mismatch");
  if (gas > authorization.gasLimitMaximum) throw new Error("gas limit exceeds authorization");
  const effectiveFee = transaction.type === "eip1559"
    ? (transaction.maxFeePerGas ?? 0n) + (transaction.maxPriorityFeePerGas ?? 0n)
    : (transaction.gasPrice ?? 0n);
  if (effectiveFee !== 0n) throw new Error("sponsored transaction must have zero inner gas price");
}

export function createPolicyRpcProcessor(options: {
  upstreams: Record<ProductMode, string>;
  authorizer?: PolicyRpcAuthorizer;
  submitter?: Partial<Record<ProductMode, PolicyRpcSubmitter>>;
}) {
  return async function processPolicyRpc(mode: ProductMode, request: JsonRpcRequest) {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return error(request.id, -32600, "Invalid Request");
    }
    if (request.method !== "eth_sendRawTransaction") {
      if (!readMethods.has(request.method)) return error(request.id, -32601, "Method not supported");
      try {
        const upstream = await fetch(options.upstreams[mode], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id ?? null,
            method: request.method,
            params: request.params ?? [],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok) return error(request.id, -32000, "Upstream RPC unavailable");
        const text = await upstream.text();
        if (text.length > 2_000_000) return error(request.id, -32000, "Upstream RPC response too large");
        return JSON.parse(text);
      } catch {
        return error(request.id, -32000, "Upstream RPC unavailable");
      }
    }

    const raw = request.params?.[0];
    if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) {
      return error(request.id, -32602, "Invalid raw transaction");
    }
    const rawTransaction = raw as Hex;
    const submitter = options.submitter?.[mode];
    if (!options.authorizer || !submitter) {
      return error(request.id, -32004, "Policy RPC sponsorship is not enabled");
    }
    const hash = keccak256(rawTransaction);
    let candidate: PolicyRpcTransactionCandidate;
    try {
      candidate = await authorizedRawTransactionCandidate(mode, rawTransaction);
    } catch {
      return error(request.id, -32602, "Invalid raw transaction");
    }
    const authorization = await options.authorizer.consume(hash, candidate);
    if (!authorization) {
      return error(request.id, -32003, "No matching transaction authorization");
    }
    if (authorization.mode !== mode) {
      await options.authorizer.markRejected?.(
        authorization.id,
        "policy-RPC network mode did not match the consumed authorization",
      ).catch(() => undefined);
      return error(request.id, -32003, "No matching transaction authorization");
    }
    try {
      await verifyAuthorizedRawTransaction(rawTransaction, authorization);
    } catch {
      await options.authorizer.markRejected?.(
        authorization.id,
        "raw transaction did not match the consumed immutable authorization",
      ).catch(() => undefined);
      return error(request.id, -32003, "Transaction does not match its authorization");
    }

    try {
      const submitted = await submitter.submit(rawTransaction, authorization.maxGasAllowanceTinybar);
      if (!submitted.ethereumHash) throw new Error("sponsored transaction produced no EVM hash");
      await options.authorizer.markSubmitted?.(authorization.id, submitted.ethereumHash);
      return response(request.id, submitted.ethereumHash);
    } catch (submissionError) {
      if (submissionError instanceof PolicyRpcSubmissionRejectedError) {
        await options.authorizer.markRejected?.(
          authorization.id,
          "bounded submitter rejected the transaction before any sponsor submission",
        ).catch(() => undefined);
        return error(request.id, -32007, "Sponsored submission was rejected before broadcast");
      }
      await options.authorizer.markUnknown?.(
        authorization.id,
        "submission result is unknown; reconcile by transaction hash before any retry",
      ).catch(() => undefined);
      return error(
        request.id,
        -32006,
        "Sponsored submission result is unknown; do not retry until reconciled",
      );
    }
  };
}

export const policyRpcReadMethods = [...readMethods].sort();
