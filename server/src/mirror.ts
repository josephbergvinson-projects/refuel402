// Read-only helpers against Hedera Mirror REST and JSON-RPC upstreams.
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { quoterAbi, v1RouterAbi } from "./abi.js";

export class MirrorQuoteError extends Error {
  constructor(
    readonly code:
      | "QUOTE_MIRROR_NOT_CONFIGURED"
      | "QUOTE_MIRROR_REQUEST_FAILED"
      | "QUOTE_MIRROR_RATE_LIMITED"
      | "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export type MirrorOptions = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export type MirrorTokenCredit = {
  transactionId: string;
  transactionHash: string;
  consensusTimestamp: string;
  tokenId: string;
  accountId: string;
  amount: bigint;
};

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MirrorQuoteError("QUOTE_MIRROR_NOT_CONFIGURED", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}


export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class Mirror {
  private readonly fetcher: typeof fetch;
  private readonly sleeper: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private quoteTail: Promise<void> = Promise.resolve();
  private lastQuoteStartedAt = 0;
  private lastQuoteCompletedAt = 0;
  private quoteSpacingDoubled = false;

  constructor(
    readonly mirrorBase: string,
    readonly rpcUrl: string,
    readonly quoteMirrorBase: string | null = null,
    options: MirrorOptions = {},
  ) {
    if (quoteMirrorBase) {
      const quote = new URL(quoteMirrorBase);
      if (quote.protocol !== "https:") throw new MirrorQuoteError("QUOTE_MIRROR_NOT_CONFIGURED", "quote Mirror endpoint must use HTTPS");
    }
    this.fetcher = options.fetch ?? fetch;
    this.sleeper = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  quoteSimulationIdentity(): string {
    return (this.quoteMirrorBase ?? this.mirrorBase).replace(/\/$/, "");
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetcher(`${this.mirrorBase}${path}`);
    if (!res.ok) throw new Error(`mirror ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string; code: number } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
    return body.result as T;
  }

  /** HBAR price in USD from the network's public light-readback exchange-rate file. */
  async hbarUsd(): Promise<number> {
    const d = await this.getJson<{
      current_rate: { cent_equivalent: number; hbar_equivalent: number };
    }>("/api/v1/network/exchangerate");
    return d.current_rate.cent_equivalent / d.current_rate.hbar_equivalent / 100;
  }

  async account(idOrAlias: string): Promise<{
    account: string;
    evm_address: Address;
    ethereum_nonce: number;
    key: { _type: "ED25519" | "ECDSA_SECP256K1" | "ProtobufEncoded"; key: string } | null;
    balance: { balance: number; tokens: { token_id: string; balance: number }[] };
  } | null> {
    try {
      return await this.getJson(`/api/v1/accounts/${idOrAlias}`);
    } catch {
      return null;
    }
  }

  async tokenCreditsAfter(input: {
    accountId: string;
    tokenId: string;
    consensusTimestamp: string;
    limit?: number;
  }): Promise<MirrorTokenCredit[]> {
    if (!/^0\.0\.\d+$/.test(input.accountId)) throw new Error("mirror token-credit account id is invalid");
    if (!/^0\.0\.\d+$/.test(input.tokenId)) throw new Error("mirror token-credit token id is invalid");
    if (!/^\d+\.\d{1,9}$/.test(input.consensusTimestamp)) throw new Error("mirror token-credit timestamp is invalid");
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("mirror token-credit limit is invalid");
    const query = new URLSearchParams({
      "account.id": input.accountId,
      transactiontype: "CRYPTOTRANSFER",
      timestamp: `gt:${input.consensusTimestamp}`,
      order: "asc",
      limit: String(limit),
    });
    const body = await this.getJson<{
      transactions?: Array<{
        consensus_timestamp?: string;
        name?: string;
        nonce?: number;
        result?: string;
        transaction_hash?: string;
        transaction_id?: string;
        token_transfers?: Array<{ account?: string; amount?: number | string; token_id?: string }>;
      }>;
    }>(`/api/v1/transactions?${query.toString()}`);
    const credits: MirrorTokenCredit[] = [];
    for (const transaction of body.transactions ?? []) {
      if (transaction.name !== "CRYPTOTRANSFER" || transaction.result !== "SUCCESS") continue;
      const consensusTimestamp = String(transaction.consensus_timestamp ?? "");
      const transactionId = String(transaction.transaction_id ?? "");
      const transactionHash = String(transaction.transaction_hash ?? "");
      if (!/^\d+\.\d{1,9}$/.test(consensusTimestamp) || !transactionId || !transactionHash) continue;
      for (const transfer of transaction.token_transfers ?? []) {
        if (transfer.account !== input.accountId || transfer.token_id !== input.tokenId) continue;
        const amount = BigInt(transfer.amount ?? 0);
        if (amount <= 0n) continue;
        credits.push({
          transactionId,
          transactionHash,
          consensusTimestamp,
          tokenId: input.tokenId,
          accountId: input.accountId,
          amount,
        });
      }
    }
    return credits;
  }

  async evmNonce(evmAddress: Address): Promise<number> {
    const acct = await this.account(evmAddress);
    return acct?.ethereum_nonce ?? 0;
  }

  async isAssociated(idOrAddress: string, tokenId: string): Promise<boolean | null> {
    try {
      const d = await this.getJson<{ tokens: { token_id: string }[] }>(
        `/api/v1/accounts/${idOrAddress}/tokens?token.id=${tokenId}&limit=1`,
      );
      return (d.tokens ?? []).some((token) => token.token_id === tokenId);
    } catch {
      return null;
    }
  }

  async contractResult(evmHash: Hex): Promise<{
    from: Address;
    to: Address;
    result: string;
    status: string;
    gas_used: number;
    amount: number;
  } | null> {
    try {
      return await this.getJson(`/api/v1/contracts/results/${evmHash}`);
    } catch {
      return null;
    }
  }

  async contractExecutionResult(transactionId: string): Promise<Record<string, any> | null> {
    const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
    const key = match ? `${match[1]}-${match[2]}-${match[3]}` : transactionId;
    try {
      return await this.getJson<Record<string, any>>(`/api/v1/contracts/results/${key}`);
    } catch {
      return null;
    }
  }

  async ethCall(to: Address, data: Hex, from?: Address): Promise<Hex> {
    return this.rpc<Hex>("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);
  }

  private async requestQuoteContractCall(to: Address, data: Hex, from?: Address): Promise<Hex> {
    const quoteBase = new URL(this.quoteMirrorBase ?? this.mirrorBase);
    const normalizedQuoteBase = quoteBase.toString().replace(/\/$/, "");
    if (quoteBase.protocol !== "https:") {
      throw new MirrorQuoteError(
        "QUOTE_MIRROR_NOT_CONFIGURED",
        "quote Mirror endpoint must use HTTPS",
      );
    }
    const call = {
      method: "eth_call",
      block: "latest",
      data,
      to,
      ...(from ? { from } : {}),
      estimate: false,
      gas: boundedInteger("MIRROR_QUOTE_GAS", 10_000_000, 1_000_000, 15_000_000),
      gasPrice: boundedInteger("MIRROR_QUOTE_GAS_PRICE_TINYBAR", 100_000_000, 0, 1_000_000_000),
      value: 0,
    };
    let response: Response;
    try {
      response = await this.fetcher(`${normalizedQuoteBase}/api/v1/contracts/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call),
        signal: AbortSignal.timeout(boundedInteger("MIRROR_QUOTE_TIMEOUT_MS", 15_000, 1_000, 30_000)),
      });
    } catch (error) {
      if (error instanceof MirrorQuoteError) throw error;
      throw new MirrorQuoteError("QUOTE_MIRROR_REQUEST_FAILED", "quote Mirror contract call request failed");
    }
    const text = await response.text();
    let body: { result?: string; error_message?: string; _status?: { messages?: { message?: string }[] } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {}
    if (response.status === 429) {
      throw new MirrorQuoteError(
        "QUOTE_MIRROR_RATE_LIMITED",
        "quote Mirror rate limited the read-only simulation",
        429,
        retryAfterMilliseconds(response.headers.get("retry-after"), this.now()),
      );
    }
    const result = body.result;
    if (!response.ok || !result) {
      const message = body.error_message ?? body._status?.messages?.[0]?.message ?? `quote Mirror contract call failed (${response.status})`;
      throw new MirrorQuoteError("QUOTE_MIRROR_REQUEST_FAILED", message, response.status);
    }
    return (result.startsWith("0x") ? result : `0x${result}`) as Hex;
  }

  private async scheduledQuote<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.quoteTail;
    let release!: () => void;
    this.quoteTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const spacingMs = boundedInteger("SAUCERSWAP_QUOTE_SPACING_MS", 500, 50, 5_000);
      // A completion-to-start idle gap marks a new request burst; the doubled
      // 429 backoff applies only for the remainder of the burst that saw it.
      if (this.quoteSpacingDoubled && this.lastQuoteCompletedAt > 0 && this.now() - this.lastQuoteCompletedAt > spacingMs * 4) {
        this.quoteSpacingDoubled = false;
      }
      const effectiveSpacingMs = this.quoteSpacingDoubled ? spacingMs * 2 : spacingMs;
      // Spacing is start-to-start: with ~500ms call latency the wait usually
      // collapses to zero while the per-IP rate budget stays honored.
      const remaining = this.lastQuoteStartedAt + effectiveSpacingMs - this.now();
      if (this.lastQuoteStartedAt > 0 && remaining > 0) await this.sleeper(remaining);
      this.lastQuoteStartedAt = this.now();
      return await operation();
    } finally {
      this.lastQuoteCompletedAt = this.now();
      release();
    }
  }

  async quoteContractCall(to: Address, data: Hex, from?: Address): Promise<Hex> {
    return this.scheduledQuote(async () => {
      const maximumAttempts = boundedInteger("MIRROR_QUOTE_429_MAX_ATTEMPTS", 2, 1, 2);
      const baseBackoffMs = boundedInteger("MIRROR_QUOTE_429_BASE_BACKOFF_MS", 500, 50, 5_000);
      const maximumBackoffMs = boundedInteger("MIRROR_QUOTE_429_MAX_BACKOFF_MS", 10_000, 100, 30_000);
      const jitterMs = boundedInteger("MIRROR_QUOTE_429_JITTER_MS", 250, 0, 2_000);
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          return await this.requestQuoteContractCall(to, data, from);
        } catch (error) {
          if (!(error instanceof MirrorQuoteError) || error.status !== 429) throw error;
          this.quoteSpacingDoubled = true;
          if (attempt >= maximumAttempts) {
            throw new MirrorQuoteError(
              "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
              `quote Mirror remained rate limited after ${maximumAttempts} bounded attempts`,
              429,
              error.retryAfterMs,
            );
          }
          const exponential = baseBackoffMs * 2 ** (attempt - 1);
          const retryAfter = error.retryAfterMs ?? 0;
          if (retryAfter > maximumBackoffMs) {
            throw new MirrorQuoteError(
              "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
              "quote Mirror Retry-After exceeds the bounded backoff ceiling",
              429,
              retryAfter,
            );
          }
          const jitter = Math.floor(this.random() * (jitterMs + 1));
          const delay = Math.min(maximumBackoffMs, Math.max(exponential, retryAfter) + jitter);
          await this.sleeper(delay);
          // Start-to-start spacing must anchor on the retry actually about to hit
          // the mirror, not on the attempt the 429 already rejected.
          this.lastQuoteStartedAt = this.now();
        }
      }
      throw new MirrorQuoteError("QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP", "unreachable quote retry state");
    });
  }

  async estimateGas(from: Address, to: Address, data: Hex): Promise<bigint> {
    const result = await this.rpc<Hex>("eth_estimateGas", [{ from, to, data }]);
    return BigInt(result);
  }

  async gasPriceWei(): Promise<bigint> {
    const result = await this.rpc<Hex>("eth_gasPrice", []);
    return BigInt(result);
  }

  async quoteToWhbar(
    quoter: Address,
    tokenEvm: Address,
    whbarEvm: Address,
    poolFee: number,
    amountIn: bigint,
  ): Promise<bigint | null> {
    const { encodePacked } = await import("viem");
    const path = encodePacked(
      ["address", "uint24", "address"],
      [tokenEvm, poolFee, whbarEvm],
    );
    try {
      const result = await this.quoteContractCall(
        quoter,
        encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] }),
      );
      const [amountOut] = decodeFunctionResult({
        abi: quoterAbi,
        functionName: "quoteExactInput",
        data: result,
      }) as readonly [bigint, unknown, unknown, bigint];
      return amountOut;
    } catch (error) {
      if (error instanceof MirrorQuoteError) throw error;
      return null;
    }
  }

  async quoteExactOutput(
    quoter: Address,
    reversePath: Hex,
    amountOut: bigint,
    from?: Address,
  ): Promise<{ amountIn: bigint; gasEstimate: bigint }> {
    const result = await this.quoteContractCall(
      quoter,
      encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactOutput", args: [reversePath, amountOut] }),
      from,
    );
    const [amountIn, , , gasEstimate] = decodeFunctionResult({
      abi: quoterAbi,
      functionName: "quoteExactOutput",
      data: result,
    }) as readonly [bigint, readonly bigint[], readonly number[], bigint];
    return { amountIn, gasEstimate };
  }

  async quoteV1ExactOutput(
    router: Address,
    path: Address[],
    amountOut: bigint,
    from?: Address,
  ): Promise<{ amountIn: bigint; gasEstimate: bigint }> {
    if (path.length < 2) throw new MirrorQuoteError("QUOTE_MIRROR_REQUEST_FAILED", "Saucer V1 quote path is too short");
    const result = await this.quoteContractCall(
      router,
      encodeFunctionData({ abi: v1RouterAbi, functionName: "getAmountsIn", args: [amountOut, path] }),
      from,
    );
    const amounts = decodeFunctionResult({
      abi: v1RouterAbi,
      functionName: "getAmountsIn",
      data: result,
    }) as readonly bigint[];
    const amountIn = amounts[0];
    if (amountIn === undefined || amounts.at(-1) !== amountOut) {
      throw new MirrorQuoteError("QUOTE_MIRROR_REQUEST_FAILED", "Saucer V1 exact-output quote returned an invalid amount vector");
    }
    const gasEstimate = BigInt(process.env.SAUCERSWAP_V1_SWAP_GAS_ESTIMATE ?? 500_000n);
    return { amountIn, gasEstimate };
  }
}
