import { describe, expect, it, vi } from "vitest";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { getAddress, hashTypedData } from "viem";
import { MetaMaskController, bridgeAdoptionTypedData, normalizeAddress, normalizeWalletError, sameAddress } from "./wallet.js";

const transactionHash = `0x${"ab".repeat(32)}`;

function provider(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, (value: unknown) => void>();
  const calls: { method: string; params?: unknown[] }[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    calls.push({ method, params });
    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return ["0x1111111111111111111111111111111111111111"];
    }
    if (method === "eth_chainId") return "0x1";
    if (method === "wallet_addEthereumChain" || method === "wallet_switchEthereumChain") return null;
    if (method === "eth_sendTransaction") return transactionHash;
    if (method === "eth_signTypedData_v4") return `0x${"12".repeat(65)}`;
    if (method === "eth_call") return "0x2a";
    if (method === "eth_getBalance") return "0x64";
    throw new Error(`unexpected ${method}`);
  });
  return {
    request,
    calls,
    on: vi.fn((event: string, listener: (value: unknown) => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string, listener: (value: unknown) => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    emit(event: string, value: unknown) { listeners.get(event)?.(value); },
    ...overrides,
  };
}

const account = "0x1111111111111111111111111111111111111111";

function typedMessage() {
  return {
    domain: { name: "Permit2", chainId: 296, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    primaryType: "PermitTransferFrom",
    types: {
      PermitTransferFrom: [
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    message: { spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001", nonce: 1n },
  };
}

describe("MetaMaskController", () => {
  it("restores one injected EVM account and tracks chain changes", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.restore();
    expect(wallet.snapshot()).toMatchObject({ account, chainId: 1, connected: true });
    injected.emit("chainChanged", "0x128");
    expect(wallet.snapshot().chainId).toBe(296);
    injected.emit("chainChanged", { malformed: true });
    expect(wallet.snapshot().chainId).toBe(296);
    await expect(wallet.switchChain(Number.NaN)).rejects.toThrow("wallet chain id is invalid");
  });

  it("disconnects by revoking site access and stays disconnected against a chatty provider", async () => {
    const injected = provider({
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_revokePermissions") return null;
        throw new Error(`unexpected ${method}`);
      }),
    });
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();

    const result = await wallet.disconnect();
    expect(result).toMatchObject({ account: null, connected: false, revoked: true });
    expect(injected.request.mock.calls.map(([payload]: [{ method: string }]) => payload.method))
      .toContain("wallet_revokePermissions");

    // A provider that keeps announcing the account must not silently re-adopt it.
    injected.emit("accountsChanged", [account]);
    expect(wallet.snapshot().account).toBeNull();
    await wallet.restore();
    expect(wallet.snapshot().account).toBeNull();

    // Connecting again is the only way back in.
    await wallet.connect();
    expect(wallet.snapshot().account).toBe(account);
  });

  it("still disconnects locally when the provider refuses to revoke", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();

    // The base fake throws on anything it does not know, wallet_revokePermissions
    // included — exactly how a non-MetaMask injected provider behaves.
    const result = await wallet.disconnect();
    expect(result).toMatchObject({ account: null, connected: false, revoked: false });
    expect(wallet.snapshot().account).toBeNull();
  });

  it("binds injected-provider listeners exactly once and removes the same callbacks on teardown", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.restore();
    await wallet.connect();
    expect(injected.on).toHaveBeenCalledTimes(2);
    wallet.destroy();
    expect(injected.removeListener).toHaveBeenCalledTimes(2);
    expect(injected.removeListener.mock.calls.map((call) => call[0])).toEqual(["accountsChanged", "chainChanged"]);
  });

  it("does not re-emit a snapshot when switchChain lands on the already-active chain", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const snapshots: unknown[] = [];
    wallet.subscribe((snapshot: unknown) => snapshots.push(snapshot));
    const baseline = snapshots.length;
    await wallet.switchChain(1);
    expect(snapshots.length).toBe(baseline);
    expect(injected.calls.filter((call) => call.method === "wallet_switchEthereumChain")).toHaveLength(1);
    await wallet.switchChain(295);
    expect(snapshots.length).toBe(baseline + 1);
    expect(wallet.snapshot().chainId).toBe(295);
  });

  it("enforces the same account across every journey identity", async () => {
    const wallet = new MetaMaskController(provider() as never);
    await wallet.connect();
    expect(wallet.assertSameAddress(account, account.toUpperCase().replace("0X", "0x"))).toBe(account);
    expect(() => wallet.assertSameAddress("0x2222222222222222222222222222222222222222"))
      .toThrow("must be the connected MetaMask account");
  });

  it("adds or updates Hedera with the Refuel policy RPC before switching", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    await wallet.switchToHedera("mainnet", "https://api.example");
    expect(injected.calls.slice(-2).map((call) => call.method)).toEqual([
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(injected.calls.at(-2)?.params?.[0]).toMatchObject({
      chainId: "0x127",
      rpcUrls: ["https://api.example/rpc/mainnet"],
    });
  });

  it("submits through eth_sendTransaction and never requests raw signing", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const hash = await wallet.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      chainId: 1,
    });
    expect(hash).toBe(transactionHash);
    expect(injected.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ chainId: "0x1", value: "0x0", gas: "0x186a0" })],
    }));
    expect(injected.calls.some((call) => call.method === "eth_signTransaction")).toBe(false);
  });

  /**
   * The server builds `nonce` as a number, and it was the one quantity this path
   * forwarded untouched. MetaMask validates transaction params itself and calls a
   * string method on them, so a numeric nonce threw "startsWith is not a function"
   * inside the extension — before any prompt could render. The sponsored
   * activation looked like it did nothing at all.
   */
  it("hex-encodes every quantity, including the server-built numeric nonce", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    await wallet.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      // Exactly the shape server/src/product-intents.ts returns.
      value: "0",
      gas: "943842",
      nonce: 1,
      maxFeePerGas: "0",
      maxPriorityFeePerGas: "0",
      chainId: 295,
    });
    const sent = injected.calls.find((call) => call.method === "eth_sendTransaction");
    const params = (sent?.params as Record<string, unknown>[])[0];
    expect(params.nonce).toBe("0x1");
    for (const field of ["chainId", "value", "gas", "nonce", "maxFeePerGas", "maxPriorityFeePerGas"]) {
      expect(typeof params[field], field).toBe("string");
      expect(String(params[field]), field).toMatch(/^0x[0-9a-f]*$/);
    }
  });

  it("rejects malformed transaction payloads and provider results before downstream string handling", async () => {
    const invalidResult = provider({ request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_sendTransaction") return { hash: transactionHash };
      throw new Error(`unexpected ${method}`);
    }) });
    const wallet = new MetaMaskController(invalidResult as never);
    await wallet.connect();
    await expect(wallet.sendTransaction({ to: account, data: "0x" }, account))
      .rejects.toThrow("invalid transaction hash");
    await expect(wallet.sendTransaction({ to: account, data: { malformed: true } as never }, account))
      .rejects.toThrow("payload is invalid");
    expect(normalizeWalletError({ message: { startsWith: false }, code: 4900 }).message).toBe("wallet error 4900");
    expect(normalizeWalletError({ message: { startsWith: false } }).message).toBe("wallet request failed");
  });

  it("uses eth_signTypedData_v4 for standard EVM x402 authorization", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const signature = await wallet.signTypedData(typedMessage());
    expect(signature).toMatch(/^0x[0-9a-f]+$/);
    const call = injected.calls.find((candidate) => candidate.method === "eth_signTypedData_v4");
    expect(call?.params?.[0]).toBe(account);
    const body = JSON.parse(call?.params?.[1] as string);
    expect(body.primaryType).toBe("PermitTransferFrom");
    expect(body.types.EIP712Domain).toBeDefined();
  });

  it("signs one Hedera Permit2 refuel witness with the exact server field order", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    injected.emit("chainChanged", "0x128");
    const deadline = Math.floor(Date.now() / 1000) + 3_600;
    const result = await wallet.signRefuelAuthorization({
      journeyId: "74191800-9d5d-4ef2-b813-6b500b8e893e",
      mode: "testnet",
      deadline,
      terms: {
        schema: "refuel402.refuel-authorization-terms.v1",
        enabled: true,
        permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        spender: "0x6666666666666666666666666666666666666666",
        token: "0x5555555555555555555555555555555555555555",
        owner: account,
        recipient: account,
        maxAmountIn: "1000000000000000",
        exactHbarTinybar: "100000000",
        serviceFeeAmount: "10000000000000",
        authorizationTtlSeconds: 7200,
        routeHash: `0x${"ab".repeat(32)}`,
      },
    }, account);
    expect(result.signature).toBe(`0x${"12".repeat(65)}`);
    const call = injected.calls.find((candidate) => candidate.method === "eth_signTypedData_v4");
    const body = JSON.parse(call?.params?.[1] as string);
    expect(body.domain).toMatchObject({ name: "Permit2", chainId: 296 });
    expect(body.primaryType).toBe("PermitWitnessTransferFrom");
    expect(body.types.Refuel402RefuelAuthorization.map((field: { name: string }) => field.name)).toEqual([
      "owner", "token", "maxAmountIn", "exactHbarTinybar", "serviceFeeAmount",
      "recipient", "journeyNonce", "deadline", "routeHash",
    ]);
    expect(body.message.witness).toMatchObject({
      owner: getAddress(account),
      maxAmountIn: "1000000000000000",
      exactHbarTinybar: "100000000",
      deadline: String(deadline),
    });
  });

  it("pins the shared bridge-adoption consent byte for byte", () => {
    const journeyId = "c91992cb-dfc3-4ed3-ab76-130beda59398";
    const sourceTransactionHash = `0x${"5d".repeat(32)}`;
    const typed = bridgeAdoptionTypedData({ journeyId, account, sourceTransactionHash, mode: "mainnet" });
    expect(typed).toEqual({
      // Off-chain consent proof: no verifyingContract by contract.
      domain: { name: "Refuel402", version: "1", chainId: 295 },
      types: {
        BridgeAdoption: [
          { name: "journeyId", type: "string" },
          { name: "account", type: "address" },
          { name: "sourceTransactionHash", type: "bytes32" },
          { name: "mode", type: "string" },
        ],
      },
      primaryType: "BridgeAdoption",
      message: { journeyId, account, sourceTransactionHash, mode: "mainnet" },
    });
    // The digest is the actual shared artifact: server verifier drift fails here.
    expect(hashTypedData(typed as never)).toBe("0x9d77b94a8fec5b990744961afef16a94580081cf9323e3b2941d2ddf954b4820");
    const testnet = bridgeAdoptionTypedData({ journeyId, account, sourceTransactionHash, mode: "testnet" });
    expect(testnet.domain.chainId).toBe(296);
    expect(hashTypedData(testnet as never)).toBe("0x44cf77c421e36e399cb06bc7e183497b6e68946cfd2baf010d7ee6e344976519");
  });

  it("rejects a malformed origin hash, journey, or mode before any wallet prompt", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const journeyId = "c91992cb-dfc3-4ed3-ab76-130beda59398";
    const sourceTransactionHash = `0x${"5d".repeat(32)}`;
    await expect(wallet.signBridgeAdoption({ journeyId, sourceTransactionHash: "0xdeadbeef", mode: "mainnet" }))
      .rejects.toThrow("64 hexadecimal characters");
    await expect(wallet.signBridgeAdoption({ journeyId, sourceTransactionHash, mode: "polygon" }))
      .rejects.toThrow("bridge adoption mode is invalid");
    await expect(wallet.signBridgeAdoption({ journeyId: "nope", sourceTransactionHash, mode: "mainnet" }))
      .rejects.toThrow("bridge adoption journey is invalid");
    expect(injected.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("signs bridge adoption with eth_signTypedData_v4 over the checksummed connected account", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const journeyId = "c91992cb-dfc3-4ed3-ab76-130beda59398";
    const sourceTransactionHash = `0x${"5d".repeat(32)}`;
    const signature = await wallet.signBridgeAdoption({ journeyId, sourceTransactionHash, mode: "testnet" });
    expect(signature).toBe(`0x${"12".repeat(65)}`);
    const call = injected.calls.find((candidate) => candidate.method === "eth_signTypedData_v4");
    expect(call?.params?.[0]).toBe(account);
    const body = JSON.parse(call?.params?.[1] as string);
    expect(body.primaryType).toBe("BridgeAdoption");
    expect(body.domain).toEqual({ name: "Refuel402", version: "1", chainId: 296 });
    expect(body.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    expect(body.message).toEqual({
      journeyId,
      account: getAddress(account),
      sourceTransactionHash,
      mode: "testnet",
    });
    for (const forbidden of ["personal_sign", "eth_sign", "eth_signTransaction", "eth_sendTransaction"]) {
      expect(injected.calls.some((candidate) => candidate.method === forbidden)).toBe(false);
    }
  });

  it("invalidates an expected-account operation after account drift", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    injected.emit("accountsChanged", ["0x2222222222222222222222222222222222222222"]);
    await expect(wallet.sendTransaction({ to: account, data: "0x" }, account))
      .rejects.toThrow("connected account changed");
  });

  it("creates a standard x402 EVM Permit2 payment header through the installed client API", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.test/v1/product/journeys/j1/payment" },
      accepts: [{
        scheme: "exact",
        network: "eip155:296",
        asset: "0x00000000000000000000000000000000008c8e9c",
        amount: "1000",
        payTo: "0x2222222222222222222222222222222222222222",
        maxTimeoutSeconds: 180,
        extra: { assetTransferMethod: "permit2" },
      }],
    };
    const response = new Response(JSON.stringify(required), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(required),
      },
    });
    const headers = await wallet.createPaymentHeaders(response);
    expect(headers).toHaveProperty("PAYMENT-SIGNATURE");
    const decoded = decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"]);
    expect(decoded.accepted).toMatchObject({
      scheme: "exact",
      network: "eip155:296",
      asset: required.accepts[0]!.asset,
      amount: "1000",
    });
    expect(decoded.payload).toMatchObject({
      permit2Authorization: {
        from: account,
        spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
      },
    });
    expect(injected.calls.some((call) => call.method === "eth_signTypedData_v4")).toBe(true);
    expect(injected.calls.some((call) => call.method === "eth_signTransaction")).toBe(false);
  });

  it("signs the deployed Refuel402 custom Permit2 witness instead of upstream hard-coded contracts", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    const required: PaymentRequired & { refuel402: Record<string, unknown> } = {
      x402Version: 2,
      resource: { url: "https://example.test/v1/product/journeys/j1/payment" },
      accepts: [{
        scheme: "exact",
        network: "eip155:295",
        asset: "0x00000000000000000000000000000000009cf1ae",
        amount: "1000",
        payTo: "0x2222222222222222222222222222222222222222",
        maxTimeoutSeconds: 180,
        extra: { assetTransferMethod: "permit2" },
      }],
      refuel402: {
        schema: "refuel402.exact-permit2-payment-required.v1",
        journeyId: "j1",
        quoteId: "a".repeat(64),
        chainId: 295,
        permit2: "0x71304d9943C9d46A18cB6238759800320540F0e4",
        spender: "0x64460b9c6Db566b0C28daf5e86945A1Fa3088667",
        contextHash: `0x${"ab".repeat(32)}`,
      },
    };
    const response = new Response(JSON.stringify(required), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(required),
      },
    });
    const headers = await wallet.createPaymentHeaders(response);
    const decoded = decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"]);
    expect(decoded.payload).toMatchObject({
      payment: {
        payer: account,
        chainId: 295,
        spender: required.refuel402.spender,
        contextHash: required.refuel402.contextHash,
      },
    });
    const call = injected.calls.find((candidate) => candidate.method === "eth_signTypedData_v4");
    const body = JSON.parse(call?.params?.[1] as string);
    expect(body.domain.verifyingContract).toBe(required.refuel402.permit2);
    expect(body.primaryType).toBe("PermitWitnessTransferFrom");
    expect(body.message.spender).toBe(required.refuel402.spender);
    expect(body.message.witness.contextHash).toBe(required.refuel402.contextHash);
  });

  it("reads native ETH and the exact Ethereum WBTC balanceOf path through the connected account", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    const wbtc = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
    await wallet.connect();
    await expect(wallet.nativeBalance()).resolves.toBe(100n);
    expect(injected.calls.at(-1)).toMatchObject({ method: "eth_getBalance", params: [account, "latest"] });
    await expect(wallet.tokenBalance(wbtc)).resolves.toBe(42n);
    expect(injected.calls.at(-1)).toEqual({
      method: "eth_call",
      params: [{
        to: wbtc.toLowerCase(),
        from: account,
        data: `0x70a08231${account.slice(2).padStart(64, "0")}`,
      }, "latest"],
    });
  });

  it("rejects a malformed ERC20 balance target before asking the wallet provider", async () => {
    const injected = provider();
    const wallet = new MetaMaskController(injected as never);
    await wallet.connect();
    await expect(wallet.tokenBalance("0x1234")).rejects.toThrow("invalid token balance target");
    expect(injected.calls.some((call) => call.method === "eth_call")).toBe(false);
  });
});

describe("address helpers", () => {
  it("normalizes valid EVM addresses only", () => {
    expect(normalizeAddress("0xA111111111111111111111111111111111111111")).toBe(
      "0xa111111111111111111111111111111111111111",
    );
    expect(normalizeAddress("0.0.123")).toBeNull();
  });

  it("compares every address to one account", () => {
    expect(sameAddress(account, account, account)).toBe(true);
    expect(sameAddress(account, "0x2222222222222222222222222222222222222222")).toBe(false);
  });
});

/**
 * The reported symptom was "I had to reload the page for it to appear connected".
 * The controller is constructed while store.js is evaluated, which can precede
 * extension injection, and a provider captured at that moment is either absent or
 * a stale object another wallet has since replaced.
 */
describe("provider resolution survives late injection", () => {
  const withGlobalEthereum = async (value: unknown, run: () => Promise<void>) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, "ethereum");
    const previous = (globalThis as Record<string, unknown>).ethereum;
    (globalThis as Record<string, unknown>).ethereum = value;
    try {
      await run();
    } finally {
      if (had) (globalThis as Record<string, unknown>).ethereum = previous;
      else delete (globalThis as Record<string, unknown>).ethereum;
    }
  };

  it("connects against a provider injected after construction", async () => {
    const wallet = new MetaMaskController();
    expect(wallet.snapshot().installed).toBe(false);
    const injected = provider();
    await withGlobalEthereum(injected, async () => {
      expect(wallet.snapshot().installed).toBe(true);
      const snapshot = await wallet.connect();
      expect(snapshot.account).toBe(account);
      expect(snapshot.connected).toBe(true);
    });
  });

  it("announces the account to subscribers without a second read", async () => {
    const wallet = new MetaMaskController();
    const seen: Array<string | null> = [];
    wallet.subscribe((snapshot: { account: string | null }) => seen.push(snapshot.account));
    await withGlobalEthereum(provider(), async () => { await wallet.connect(); });
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe(account);
  });

  it("re-binds its listeners when the injected provider object is replaced", async () => {
    const first = provider();
    const second = provider();
    const wallet = new MetaMaskController();
    await withGlobalEthereum(first, async () => { await wallet.restore(); });
    expect(first.on).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
    await withGlobalEthereum(second, async () => { await wallet.restore(); });
    expect(first.removeListener).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
    expect(second.on).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
  });

  it("keeps an explicitly supplied provider authoritative over the global", async () => {
    const explicit = provider();
    const wallet = new MetaMaskController(explicit as never);
    await withGlobalEthereum(provider(), async () => { await wallet.connect(); });
    expect(explicit.request).toHaveBeenCalled();
  });
});
