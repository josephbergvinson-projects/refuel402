export const REFUEL_AUTHORIZATION_FIELDS = [
  { name: "owner", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmountIn", type: "uint256" },
  { name: "exactHbarTinybar", type: "uint256" },
  { name: "serviceFeeAmount", type: "uint256" },
  { name: "recipient", type: "address" },
  { name: "journeyNonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "routeHash", type: "bytes32" },
];

const HEDERA_NETWORKS = {
  testnet: {
    chainId: 296,
    chainHex: "0x128",
    name: "Hedera Testnet",
    currency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    explorer: "https://hashscan.io/testnet",
  },
  mainnet: {
    chainId: 295,
    chainHex: "0x127",
    name: "Hedera Mainnet",
    currency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    explorer: "https://hashscan.io/mainnet",
  },
};

export class MetaMaskController {
  /**
   * `ethereum` is an explicit override for tests and harnesses. Left out, the
   * provider is resolved at CALL time rather than captured here: this class is
   * constructed while the store module is evaluated, which can be before the
   * extension has injected `window.ethereum` at all, and several wallets replace
   * that object after their own injection. Holding the value from construction
   * is what made the first Connect click do nothing and only work after a reload.
   */
  constructor(ethereum = null) {
    this.injected = ethereum ?? null;
    // The EIP-6963 announced MetaMask provider, when there is one. Preferred over
    // whatever won the `window.ethereum` race, because this product asks for
    // MetaMask by name and another installed wallet may hold that property.
    this.announced = null;
    this.account = null;
    this.chainId = null;
    this.listeners = new Set();
    // The provider object the listeners below are currently attached to, so a
    // provider swap re-binds instead of leaving events on a discarded object.
    this.boundTo = null;
    this.discovering = false;
    this.watching = false;
    // Set by disconnect(). A wallet that cannot revoke site access keeps
    // announcing the account; the latch stops that from silently re-adopting a
    // connection the owner just ended.
    this.disconnected = false;
    this.handleAccountsChanged = (accounts) => {
      const account = normalizeAddress(accounts?.[0] ?? null);
      if (this.disconnected && account) return;
      this.account = account;
      this.emit();
    };
    this.handleChainChanged = (chainId) => {
      try { this.chainId = validatedChainId(chainId); }
      catch { return; }
      this.emit();
    };
  }

  get ethereum() {
    return this.injected ?? this.announced ?? globalThis.ethereum ?? null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * EIP-6963 discovery. Wallets announce themselves on request instead of racing
   * for one global property, so this is the only way to reach MetaMask reliably on
   * a machine with more than one wallet installed. A late announcement re-binds
   * and emits, which is what lets the top bar update without a reload.
   */
  discover() {
    const target = globalThis;
    if (this.injected || this.discovering || typeof target?.addEventListener !== "function") return;
    this.discovering = true;
    target.addEventListener("eip6963:announceProvider", (event) => {
      const detail = event?.detail;
      if (detail?.info?.rdns !== "io.metamask" || typeof detail?.provider?.request !== "function") return;
      if (this.announced === detail.provider) return;
      this.announced = detail.provider;
      this.bind();
      this.emit();
    });
    try {
      target.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch {
      // A host without Event construction simply keeps the window.ethereum path.
    }
  }

  /**
   * Injection can land after this module runs. MetaMask documents
   * `ethereum#initialized` for exactly that, and the bounded poll covers wallets
   * that do not fire it. Either way the arrival is restored and announced rather
   * than waiting for the owner to reload the page.
   */
  watchForProvider() {
    const target = globalThis;
    if (this.injected || this.watching || this.ethereum || typeof target?.addEventListener !== "function") return;
    this.watching = true;
    let settled = false;
    const arrived = () => {
      if (settled || !this.ethereum) return;
      settled = true;
      clearInterval(poll);
      void this.restore().catch(() => this.emit());
    };
    target.addEventListener("ethereum#initialized", arrived, { once: true });
    const poll = setInterval(() => {
      if (this.ethereum) arrived();
    }, 120);
    // Give up quietly: an owner with no wallet installed must not be polled forever.
    setTimeout(() => { settled = true; clearInterval(poll); }, 4_000);
  }

  /** Bounded wait so a click that lands during injection still opens MetaMask. */
  async waitForProvider(timeoutMs = 1_500) {
    if (this.ethereum?.request) return this.ethereum;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (this.ethereum?.request) return this.ethereum;
    }
    return null;
  }

  snapshot() {
    return {
      installed: !!this.ethereum?.request,
      account: this.account,
      chainId: this.chainId,
      connected: !!this.account,
    };
  }

  emit() {
    const value = this.snapshot();
    for (const listener of this.listeners) listener(value);
  }

  bind() {
    const provider = this.ethereum;
    if (!provider?.on || this.boundTo === provider) return;
    this.unbind();
    provider.on("accountsChanged", this.handleAccountsChanged);
    provider.on("chainChanged", this.handleChainChanged);
    this.boundTo = provider;
  }

  unbind() {
    const provider = this.boundTo;
    if (!provider) return;
    const remove = provider.removeListener?.bind(provider) ?? provider.off?.bind(provider);
    remove?.("accountsChanged", this.handleAccountsChanged);
    remove?.("chainChanged", this.handleChainChanged);
    this.boundTo = null;
  }

  destroy() {
    this.unbind();
    this.listeners.clear();
  }

  async restore() {
    this.discover();
    if (!this.ethereum?.request) this.watchForProvider();
    if (!this.ethereum?.request || this.disconnected) return this.snapshot();
    this.bind();
    const provider = this.ethereum;
    const [accounts, chainId] = await Promise.all([
      provider.request({ method: "eth_accounts" }),
      provider.request({ method: "eth_chainId" }),
    ]);
    this.account = normalizeAddress(accounts?.[0] ?? null);
    this.chainId = validatedChainId(chainId);
    this.emit();
    return this.snapshot();
  }

  /**
   * End this site's connection. Revoking the permission is what makes it survive
   * a reload; it is a MetaMask extension rather than EIP-1193, so a provider that
   * refuses it still gets the local disconnect and the caller is told revocation
   * did not happen.
   */
  async disconnect() {
    let revoked = false;
    try {
      await this.ethereum?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      revoked = true;
    } catch {
      revoked = false;
    }
    this.disconnected = true;
    this.account = null;
    this.emit();
    return { ...this.snapshot(), revoked };
  }

  async connect() {
    this.discover();
    // A click that lands while the extension is still injecting used to fail with
    // "MetaMask is not installed" and then work after a reload.
    if (!this.ethereum?.request) await this.waitForProvider();
    if (!this.ethereum?.request) throw new Error("MetaMask is not installed");
    this.bind();
    this.disconnected = false;
    const provider = this.ethereum;
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("MetaMask returned no account");
    this.account = normalizeAddress(accounts[0]);
    this.chainId = validatedChainId(await provider.request({ method: "eth_chainId" }));
    // Re-bind before announcing: a wallet that only exposes its event emitter
    // once permission is granted would otherwise never reach handleAccountsChanged.
    this.bind();
    this.emit();
    return this.snapshot();
  }

  requireAccount(expected) {
    if (!this.account) throw new Error("connect MetaMask first");
    if (expected && normalizeAddress(expected) !== this.account) {
      throw new Error("connected account changed; request a fresh quote");
    }
    return this.account;
  }

  assertSameAddress(...addresses) {
    const account = this.requireAccount();
    if (addresses.some((value) => normalizeAddress(value) !== account)) {
      throw new Error("bridge sender and Hedera destination must be the connected MetaMask account");
    }
    return account;
  }

  /**
   * Move the wallet to an origin chain before the run asks it to sign.
   *
   * MetaMask answers this request with two errors that open no window at all, and
   * both used to surface as a raw provider blob from a run that then died before
   * any prompt: 4902 when the chain is not in the wallet yet, and -32002 when a
   * switch request is already queued — which is exactly what a switch the owner
   * had just triggered themselves leaves behind. The journey was created and the
   * activation paid, then nothing happened and nothing said why.
   */
  async switchChain(chainId) {
    this.requireAccount();
    const normalizedChainId = validatedChainId(chainId);
    const chainHex = `0x${normalizedChainId.toString(16)}`;
    try {
      await this.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (error) {
      const code = Number(error?.code);
      if (code === -32002) {
        throw new Error("MetaMask already has a network request waiting. Open MetaMask, finish or dismiss it, then try again. Nothing was sent.");
      }
      if (code === 4902) {
        throw new Error(`This network is not in your MetaMask yet. Add it in MetaMask, switch to it, then try again. Nothing was sent.`);
      }
      throw normalizeWalletError(error);
    }
    // Emitting an unchanged snapshot would replay wallet-subscribe side effects
    // (journey recovery) in the middle of an active run.
    if (this.chainId !== normalizedChainId) {
      this.chainId = normalizedChainId;
      this.emit();
    }
  }

  async switchToHedera(mode, rpcBaseUrl = globalThis.location?.origin ?? "") {
    this.requireAccount();
    const network = HEDERA_NETWORKS[mode];
    if (!network) throw new Error("Hedera wallet network is invalid");
    const base = new URL(String(rpcBaseUrl || globalThis.location?.origin || ""));
    const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
      throw new Error("Refuel policy RPC must use HTTPS or a local HTTP origin");
    }
    const rpcUrl = new URL(`/rpc/${mode}`, base).toString();
    const chain = {
      chainId: network.chainHex,
      chainName: network.name,
      nativeCurrency: network.currency,
      rpcUrls: [rpcUrl],
      blockExplorerUrls: [network.explorer],
    };
    if (
      typeof chain.chainId !== "string" ||
      typeof chain.chainName !== "string" ||
      typeof chain.rpcUrls[0] !== "string" ||
      typeof chain.blockExplorerUrls[0] !== "string"
    ) throw new Error("Hedera wallet network metadata is invalid");
    // Ask MetaMask to add/update Hedera with the Refuel policy RPC before every
    // destination stage. Merely switching can silently select an existing
    // direct Hashio RPC and bypass sponsorship/one-time authorization.
    try {
      await this.ethereum.request({ method: "wallet_addEthereumChain", params: [chain] });
    } catch (error) {
      const message = String(error?.code ?? error?.message ?? error);
      if (!/already (added|exists)|duplicate|known chain/i.test(message)) {
        throw normalizeWalletError(error);
      }
    }
    await this.switchChain(network.chainId);
  }

  async sendTransaction(transaction, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    if (transaction.from && normalizeAddress(transaction.from) !== account) {
      throw new Error("transaction sender differs from the connected MetaMask account");
    }
    const params = {
      ...transaction,
      from: account,
      ...(transaction.chainId !== undefined ? { chainId: hexQuantity(transaction.chainId) } : {}),
      ...(transaction.value !== undefined ? { value: hexQuantity(transaction.value) } : {}),
      ...(transaction.gas !== undefined ? { gas: hexQuantity(transaction.gas) } : {}),
      // Every JSON-RPC quantity must be a hex string, and `nonce` is one. The
      // server builds it as a NUMBER (UnsignedProductTransaction.nonce) and it was
      // the one quantity this spread passed through untouched, so MetaMask's own
      // parameter validation called a string method on it and threw
      // "startsWith is not a function" — inside the extension, before any prompt
      // could render. That is why the sponsored activation appeared to do nothing:
      // the authorization was created server-side and the wallet never opened.
      ...(transaction.nonce !== undefined ? { nonce: hexQuantity(transaction.nonce) } : {}),
      ...(transaction.maxFeePerGas !== undefined
        ? { maxFeePerGas: hexQuantity(transaction.maxFeePerGas) }
        : {}),
      ...(transaction.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: hexQuantity(transaction.maxPriorityFeePerGas) }
        : {}),
    };
    if (
      typeof params.from !== "string" ||
      typeof params.to !== "string" ||
      typeof params.data !== "string" ||
      !params.data.startsWith("0x")
    ) throw new Error("wallet transaction payload is invalid");
    try {
      const result = await this.ethereum.request({ method: "eth_sendTransaction", params: [params] });
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
        throw new Error("wallet returned an invalid transaction hash");
      }
      return result;
    } catch (error) {
      throw normalizeWalletError(error);
    }
  }

  async transactionReceipt(ethereumHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ethereumHash ?? "")) throw new Error("invalid transaction hash");
    return this.ethereum.request({ method: "eth_getTransactionReceipt", params: [ethereumHash] });
  }

  async signTypedData(typedData, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    const { getTypesForEIP712Domain } = await import("viem");
    const payload = {
      ...typedData,
      types: {
        EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }),
        ...typedData.types,
      },
    };
    try {
      return await this.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [
          account,
          JSON.stringify(payload, (_key, value) => typeof value === "bigint" ? value.toString() : value),
        ],
      });
    } catch (error) {
      throw normalizeWalletError(error);
    }
  }

  // Off-chain owner consent to retire a journey draft. It authorizes a local
  // record change only: nothing is deleted, moved, or broadcast.
  async signJourneyAbandon({ journeyId, mode }, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    const { getAddress } = await import("viem");
    return this.signTypedData(journeyAbandonTypedData({
      journeyId,
      account: getAddress(account),
      mode,
    }), account);
  }

  /**
   * Off-chain owner consent to re-bind one replacement source quote to a journey
   * that never reached a wallet boundary. Signed on the ORIGIN chain, which is
   * where the resend has already moved the wallet for the bridge send.
   */
  async signJourneySourceLeg({ journeyId, quoteId, mode, originChainId }, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    const { getAddress } = await import("viem");
    return this.signTypedData(journeySourceLegTypedData({
      journeyId,
      quoteId,
      account: getAddress(account),
      mode,
      originChainId,
    }), account);
  }

  // Off-chain owner consent to bind an origin bridge hash the wallet already
  // broadcast. The caller must supply the hash; nothing here derives or guesses one.
  async signBridgeAdoption({ journeyId, sourceTransactionHash, mode }, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    const { getAddress } = await import("viem");
    return this.signTypedData(bridgeAdoptionTypedData({
      journeyId,
      account: getAddress(account),
      sourceTransactionHash,
      mode,
    }), account);
  }

  async nativeBalance(owner = this.account) {
    const account = this.requireAccount(owner);
    const result = await this.ethereum.request({
      method: "eth_getBalance",
      params: [account, "latest"],
    });
    return BigInt(result || "0x0");
  }

  async tokenBalance(token, owner = this.account) {
    const account = this.requireAccount(owner);
    const normalizedToken = normalizeAddress(token);
    if (!normalizedToken) throw new Error("invalid token balance target");
    const data = `0x70a08231${account.slice(2).padStart(64, "0")}`;
    const result = await this.ethereum.request({
      method: "eth_call",
      params: [{ to: normalizedToken, from: account, data }, "latest"],
    });
    return BigInt(result || "0x0");
  }

  async tokenAllowance(token, spender, owner = this.account) {
    const account = this.requireAccount(owner);
    if (!normalizeAddress(spender)) throw new Error("invalid token spender");
    const data = `0xdd62ed3e${account.slice(2).padStart(64, "0")}${spender.slice(2).padStart(64, "0")}`;
    const result = await this.ethereum.request({
      method: "eth_call",
      params: [{ to: token, data }, "latest"],
    });
    return BigInt(result || "0x0");
  }

  async approveToken(token, spender, amount, expectedAccount = this.account) {
    if (!normalizeAddress(token) || !normalizeAddress(spender)) throw new Error("invalid token approval target");
    const data = `0x095ea7b3${spender.slice(2).padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;
    return this.sendTransaction({ to: token, data, value: "0" }, expectedAccount);
  }

  async signRefuelAuthorization({ journeyId, mode, terms, deadline }, expectedAccount = this.account) {
    const account = this.requireAccount(expectedAccount);
    const network = HEDERA_NETWORKS[mode];
    if (!network || Number(this.chainId) !== network.chainId) {
      throw new Error("refuel authorization must be signed while MetaMask is on Hedera");
    }
    if (
      terms?.schema !== "refuel402.refuel-authorization-terms.v1" ||
      terms?.enabled !== true ||
      !normalizeAddress(terms.permit2) ||
      !normalizeAddress(terms.spender) ||
      !normalizeAddress(terms.token) ||
      normalizeAddress(terms.owner) !== account ||
      normalizeAddress(terms.recipient) !== account ||
      !/^\d+$/.test(String(terms.maxAmountIn ?? "")) ||
      !/^\d+$/.test(String(terms.exactHbarTinybar ?? "")) ||
      !/^\d+$/.test(String(terms.serviceFeeAmount ?? "")) ||
      !/^0x[0-9a-fA-F]{64}$/.test(String(terms.routeHash ?? ""))
    ) throw new Error("refuel authorization terms are invalid");
    const deadlineValue = BigInt(deadline);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadlineValue <= now || deadlineValue > now + BigInt(terms.authorizationTtlSeconds)) {
      throw new Error("refuel authorization deadline is outside the displayed window");
    }
    const { keccak256, stringToHex } = await import("viem");
    const nonce = BigInt(keccak256(stringToHex(journeyId)));
    const authorization = {
      owner: account,
      token: terms.token,
      maxAmountIn: BigInt(terms.maxAmountIn),
      exactHbarTinybar: BigInt(terms.exactHbarTinybar),
      serviceFeeAmount: BigInt(terms.serviceFeeAmount),
      recipient: account,
      journeyNonce: nonce,
      deadline: deadlineValue,
      routeHash: terms.routeHash,
    };
    const signature = await this.signTypedData({
      domain: { name: "Permit2", chainId: network.chainId, verifyingContract: terms.permit2 },
      types: {
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        Refuel402RefuelAuthorization: REFUEL_AUTHORIZATION_FIELDS,
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "Refuel402RefuelAuthorization" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: authorization.token, amount: authorization.maxAmountIn },
        spender: terms.spender,
        nonce,
        deadline: deadlineValue,
        witness: authorization,
      },
    }, account);
    return { signature, deadline: deadlineValue.toString(), authorization };
  }

  async createPaymentHeaders(paymentRequiredResponse) {
    const account = this.requireAccount();
    const responseBody = await paymentRequiredResponse.clone().json().catch(() => undefined);
    if (responseBody?.refuel402?.schema === "refuel402.exact-permit2-payment-required.v1") {
      const { encodePaymentSignatureHeader } = await import("@x402/core/http");
      const accepted = responseBody.accepts?.[0];
      const custom = responseBody.refuel402;
      if (
        accepted?.scheme !== "exact" ||
        accepted?.extra?.assetTransferMethod !== "permit2" ||
        !/^eip155:(295|296)$/.test(accepted?.network ?? "") ||
        !/^0x[0-9a-fA-F]{40}$/.test(accepted?.asset ?? "") ||
        !/^0x[0-9a-fA-F]{40}$/.test(accepted?.payTo ?? "") ||
        !/^0x[0-9a-fA-F]{40}$/.test(custom.permit2 ?? "") ||
        !/^0x[0-9a-fA-F]{40}$/.test(custom.spender ?? "") ||
        !/^0x[0-9a-fA-F]{64}$/.test(custom.contextHash ?? "") ||
        !/^\d+$/.test(accepted?.amount ?? "")
      ) throw new Error("Refuel402 payment requirements are invalid");
      const chainId = Number(accepted.network.split(":")[1]);
      if (chainId !== Number(custom.chainId)) throw new Error("Refuel402 payment chain mismatch");
      const now = Math.floor(Date.now() / 1000);
      const deadline = now + Math.min(Number(accepted.maxTimeoutSeconds ?? 180), 180);
      const nonce = randomUint256();
      const payment = {
        payer: account,
        token: accepted.asset,
        amount: accepted.amount,
        recipient: accepted.payTo,
        chainId,
        nonce,
        deadline,
        spender: custom.spender,
        contextHash: custom.contextHash,
      };
      const signature = await this.signTypedData({
        domain: { name: "Permit2", chainId, verifyingContract: custom.permit2 },
        types: {
          TokenPermissions: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          Refuel402ExactPayment: [
            { name: "payer", type: "address" },
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "chainId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "spender", type: "address" },
            { name: "contextHash", type: "bytes32" },
          ],
          PermitWitnessTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "spender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "witness", type: "Refuel402ExactPayment" },
          ],
        },
        primaryType: "PermitWitnessTransferFrom",
        message: {
          permitted: { token: payment.token, amount: BigInt(payment.amount) },
          spender: payment.spender,
          nonce: BigInt(payment.nonce),
          deadline: BigInt(payment.deadline),
          witness: {
            ...payment,
            amount: BigInt(payment.amount),
            chainId: BigInt(payment.chainId),
            nonce: BigInt(payment.nonce),
            deadline: BigInt(payment.deadline),
          },
        },
      }, account);
      return {
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
          x402Version: 2,
          accepted,
          payload: { payment: { ...payment, signature } },
        }),
      };
    }

    const [{ x402Client, x402HTTPClient }, { ExactEvmScheme }] = await Promise.all([
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
    ]);
    const signer = {
      address: account,
      signTypedData: (message) => this.signTypedData(message, account),
    };
    const httpClient = new x402HTTPClient(
      new x402Client().register("eip155:*", new ExactEvmScheme(signer)),
    );
    const required = httpClient.getPaymentRequiredResponse(
      (name) => paymentRequiredResponse.headers.get(name),
      responseBody,
    );
    const payload = await httpClient.createPaymentPayload(required);
    return httpClient.encodePaymentSignatureHeader(payload);
  }
}

export const ORIGIN_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

// Shared byte-for-byte with the server verifier: an off-chain consent proof, so
// the domain intentionally carries no verifyingContract.
export function bridgeAdoptionTypedData({ journeyId, account, sourceTransactionHash, mode }) {
  const network = HEDERA_NETWORKS[mode];
  if (!network) throw new Error("bridge adoption mode is invalid");
  if (!/^[0-9a-fA-F-]{16,64}$/.test(String(journeyId ?? ""))) throw new Error("bridge adoption journey is invalid");
  if (!normalizeAddress(account)) throw new Error("bridge adoption account is invalid");
  if (!ORIGIN_TRANSACTION_HASH.test(String(sourceTransactionHash ?? ""))) {
    throw new Error("origin transaction hash must be 0x followed by 64 hexadecimal characters");
  }
  return {
    domain: { name: "Refuel402", version: "1", chainId: network.chainId },
    types: {
      BridgeAdoption: [
        { name: "journeyId", type: "string" },
        { name: "account", type: "address" },
        { name: "sourceTransactionHash", type: "bytes32" },
        { name: "mode", type: "string" },
      ],
    },
    primaryType: "BridgeAdoption",
    message: { journeyId, account, sourceTransactionHash, mode },
  };
}

// Shared byte-for-byte with server/src/journey-abandon-witness.ts. Same reason
// as BridgeAdoption: a journey id is not a secret, so retiring a record needs
// owner consent the server can recover, not a claimed address.
export function journeyAbandonTypedData({ journeyId, account, mode }) {
  const network = HEDERA_NETWORKS[mode];
  if (!network) throw new Error("journey abandon mode is invalid");
  if (!/^[0-9a-fA-F-]{16,64}$/.test(String(journeyId ?? ""))) throw new Error("journey abandon journey is invalid");
  if (!normalizeAddress(account)) throw new Error("journey abandon account is invalid");
  return {
    domain: { name: "Refuel402", version: "1", chainId: network.chainId },
    types: {
      JourneyAbandon: [
        { name: "journeyId", type: "string" },
        { name: "account", type: "address" },
        { name: "mode", type: "string" },
      ],
    },
    primaryType: "JourneyAbandon",
    message: { journeyId, account, mode },
  };
}

// Shared byte-for-byte with server/src/journey-source-leg-witness.ts. Same
// reason as the two above: a journey id is not a secret, and re-binding a
// replacement source quote retires the owner's unbroadcast activation
// authorization, so it needs owner consent the server can recover.
//
// The domain chain is the journey's ORIGIN chain rather than Hedera: the resend
// must move the wallet there anyway for the bridge send, so the consent reuses
// that switch instead of forcing a round trip to Hedera and back, whose most
// likely failure is a pending-request error and no prompt at all. The caller is
// responsible for having the wallet on that chain — MetaMask refuses typed data
// whose domain chain is not active.
//
// quoteId is in the message so consent is spent on exactly the replacement quote
// the owner was shown, and cannot be replayed against the next one.
export function journeySourceLegTypedData({ journeyId, quoteId, account, mode, originChainId }) {
  if (mode !== "mainnet" && mode !== "testnet") throw new Error("source leg mode is invalid");
  if (!/^[0-9a-fA-F-]{16,64}$/.test(String(journeyId ?? ""))) throw new Error("source leg journey is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(quoteId ?? ""))) throw new Error("source leg quote id is invalid");
  if (!normalizeAddress(account)) throw new Error("source leg account is invalid");
  const chainId = Number(originChainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("source leg origin chain is invalid");
  return {
    domain: { name: "Refuel402", version: "1", chainId },
    types: {
      SourceLegConsent: [
        { name: "journeyId", type: "string" },
        { name: "quoteId", type: "string" },
        { name: "account", type: "address" },
        { name: "mode", type: "string" },
      ],
    },
    primaryType: "SourceLegConsent",
    message: { journeyId, quoteId, account, mode },
  };
}

export function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

export function sameAddress(account, ...addresses) {
  const normalized = normalizeAddress(account);
  return !!normalized && addresses.every((address) => normalizeAddress(address) === normalized);
}

function randomUint256() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return BigInt(`0x${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`).toString();
}

function quantityNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.startsWith("0x")) return Number(BigInt(value));
  return Number(value);
}

function validatedChainId(value) {
  const parsed = quantityNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("wallet chain id is invalid");
  return parsed;
}

function hexQuantity(value) {
  const number = typeof value === "bigint" ? value : BigInt(value);
  return `0x${number.toString(16)}`;
}

export function normalizeWalletError(error) {
  const errorRecord = error && typeof error === "object" ? error : null;
  const rawMessage = errorRecord?.message;
  const rawCode = errorRecord?.code;
  const message = typeof rawMessage === "string"
    ? rawMessage
    : typeof rawCode === "string" || typeof rawCode === "number"
      ? `wallet error ${String(rawCode)}`
      : typeof error === "string"
        ? error
        : "wallet request failed";
  if (/reject|denied|cancel|4001/i.test(message)) return new Error("wallet request rejected by the user");
  return new Error(message);
}

export { HEDERA_NETWORKS as WALLET_NETWORKS };
