// Refuel402Agent — a self-contained programmatic client for autonomous agents.
// It performs the whole journey against a Refuel402 server: discover -> inspect
// -> build+sign the [associate?, approve?, swap] bundle locally -> quote ->
// pay over x402 (stock @x402 libs) -> receive native HBAR. The agent's ECDSA
// key never leaves this process. Depends only on already-present deps.
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { type Address, type Hex } from "viem";
import { buildAssociateCalldata, signRawTx, userAddress } from "./txbuilder.js";

const NETWORK = "hedera:testnet";
const CHAIN_ID = 296;

export type TokenInfo = {
  symbol: string;
  tokenId: string;
  evmAddress: Address;
  decimals: number;
  poolFee: number;
  route: { toToken: Address; fee: number }[] | null;
  maxAmountIn: string;
  bridge: string | null;
};

export type FuelReceipt = {
  state: string;
  payment: { settlementId: string | null; hashscan: string | null } | null;
  execution: { transactionIds: string[]; hashscanLinks: string[]; sponsorFeeTinybar: string } | null;
  refund: unknown;
  error: string | null;
};

export class Refuel402Agent {
  private httpClient: x402HTTPClient;
  readonly evmAddress: Address;

  constructor(
    private readonly base: string,
    private readonly accountId: string,
    private readonly privateKeyHex: Hex,
    private readonly mirrorBase = "https://testnet.mirrornode.hedera.com",
    private readonly rpcUrl = "https://testnet.hashio.io/api",
  ) {
    this.evmAddress = userAddress(privateKeyHex);
    const signer = createClientHederaSigner(
      accountId,
      PrivateKey.fromStringECDSA(privateKeyHex.replace(/^0x/, "")),
      { network: NETWORK },
    );
    this.httpClient = new x402HTTPClient(
      new x402Client().register(NETWORK as never, new ExactHederaScheme(signer)),
    );
  }

  /** Discover terms + policy (well-known manifest, tokens, limits). Pass a
   * network to inspect a specific one; execution is only on the sponsor net. */
  async discover(
    network: "testnet" | "mainnet" = "testnet",
  ): Promise<{ manifest: unknown; tokens: TokenInfo[]; router: Address; whbar: Address; quoter: Address }> {
    const [manifest, tokensRes] = await Promise.all([
      fetch(`${this.base}/.well-known/x402`).then((r) => r.json()),
      fetch(`${this.base}/v1/tokens?network=${network}`).then((r) => r.json()),
    ]);
    return {
      manifest,
      tokens: tokensRes.tokens,
      router: tokensRes.router.evm,
      whbar: tokensRes.whbar.evm,
      quoter: tokensRes.quoter,
    };
  }

  private async nonce(): Promise<number> {
    const a = await fetch(`${this.mirrorBase}/api/v1/accounts/${this.evmAddress}`).then((r) =>
      r.ok ? r.json() : null,
    );
    return a?.ethereum_nonce ?? 0;
  }

  /** Ask the server for the live account-aware exact-output plan. */
  async plan(params: {
    tokenId: string;
    desiredHbar: string;
    minimumRetained?: string;
    slippageBps?: number;
  }): Promise<any> {
    const response = await fetch(`${this.base}/v1/refuel/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        network: "testnet",
        account: this.evmAddress,
        tokenId: params.tokenId,
        desiredHbar: params.desiredHbar,
        minimumRetained: params.minimumRetained,
        slippageBps: params.slippageBps,
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.message ?? body.code ?? "refuel plan unavailable");
    return body;
  }

  /**
   * Fuel to an exact native-HBAR output. The server derives live route, safe
   * token maximum, conditional approval and fee; this client signs the returned
   * exact intents locally and walks the stock Hedera x402 flow.
   */
  async fuel(params: {
    token: TokenInfo;
    desiredHbar: string;
    minimumRetained?: string;
    slippageBps?: number;
  }): Promise<FuelReceipt> {
    const plan = await this.plan({
      tokenId: params.token.tokenId,
      desiredHbar: params.desiredHbar,
      minimumRetained: params.minimumRetained,
      slippageBps: params.slippageBps,
    });
    const txs: Hex[] = [];
    for (const intent of plan.transactionIntents as { transaction: {
      chainId: number; to: Address; data: Hex; nonce: number; gas: Hex;
      maxFeePerGas: Hex; maxPriorityFeePerGas: Hex;
    } }[]) {
      const tx = intent.transaction;
      txs.push(await signRawTx({
        privateKey: this.privateKeyHex,
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data,
        nonce: tx.nonce,
        gasLimit: BigInt(tx.gas),
        maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      }));
    }
    return this.payBundle({ transactions: txs });
  }

  /** Sponsor a standalone token association (fee paid in `feeTokenId`). */
  async associate(tokenEvm: Address, feeTokenId: string): Promise<FuelReceipt> {
    const nonce = await this.nonce();
    const tx = await signRawTx({
      privateKey: this.privateKeyHex, chainId: CHAIN_ID, to: tokenEvm,
      data: buildAssociateCalldata(), nonce, gasLimit: 900_000n, maxFeePerGas: 0n,
    });
    return this.payBundle({ transactions: [tx], feeTokenId });
  }

  /** Quote a bundle without paying. */
  async quote(body: { transactions: Hex[]; feeTokenId?: string }): Promise<unknown> {
    return fetch(`${this.base}/v1/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  /** Walk the 402 flow for a prebuilt bundle. */
  async payBundle(body: { transactions: Hex[]; feeTokenId?: string }): Promise<FuelReceipt> {
    const payload = JSON.stringify(body);
    const first = await fetch(`${this.base}/v1/fuel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
    });
    if (first.status !== 402) {
      throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
    }
    const paymentRequired = this.httpClient.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await first.clone().json().catch(() => undefined),
    );
    const paid = await this.httpClient.encodePaymentSignatureHeader(
      await this.httpClient.createPaymentPayload(paymentRequired),
    );
    const res = await fetch(`${this.base}/v1/fuel`, {
      method: "POST", headers: { "content-type": "application/json", ...paid }, body: payload,
    });
    return (await res.json()) as FuelReceipt;
  }
}
