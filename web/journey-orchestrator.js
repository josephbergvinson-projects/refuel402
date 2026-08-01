import { ProductApiClient } from "./api-client.js";

function idempotency(prefix, identity) {
  return `${prefix}-${identity}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128).padEnd(16, "0");
}

function conflictCode(error) {
  return error?.response?.status === 409 ? error.body?.code ?? null : null;
}

export class JourneyOrchestrator {
  constructor({
    apiBase = "",
    wallet,
    client,
    fetcher,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onPhase = () => undefined,
    onJourney = () => undefined,
    onCheckpoint = () => undefined,
    onQuoteRefresh = () => undefined,
    maxQuoteRefreshRetries = 2,
    receiptPollMs = 2_000,
    bridgePollMs = 5_000,
    maxReceiptPolls = 120,
    maxBridgePolls = 240,
    // Real bridges settle in 15-20+ minutes: recovery polls every 5s for the
    // first minute, then every 15s up to ~45 minutes.
    maxRecoveryBridgePolls = 188,
    maxBridgeFetchFailures = 5,
  }) {
    this.apiBase = String(apiBase).replace(/\/$/, "");
    this.wallet = wallet;
    this.client = client ?? new ProductApiClient({ apiBase: this.apiBase, fetcher });
    this.sleep = sleep;
    this.onPhase = onPhase;
    this.onJourney = onJourney;
    this.onCheckpoint = onCheckpoint;
    this.onQuoteRefresh = onQuoteRefresh;
    this.maxQuoteRefreshRetries = maxQuoteRefreshRetries;
    // The live destination quote for the current continuation; every refresh
    // replaces it so later legs bind the same record the server now holds.
    this.destinationQuote = null;
    this.receiptPollMs = receiptPollMs;
    this.bridgePollMs = bridgePollMs;
    this.maxReceiptPolls = maxReceiptPolls;
    this.maxBridgePolls = maxBridgePolls;
    this.maxRecoveryBridgePolls = maxRecoveryBridgePolls;
    this.maxBridgeFetchFailures = maxBridgeFetchFailures;
  }

  /**
   * Drop the cached continuation. A quote minted for one session must never be
   * reachable from the next one, so every local session teardown calls this.
   */
  forget() {
    this.destinationQuote = null;
  }

  async request(path, options) {
    return this.client.request(path, options);
  }

  async waitForWalletReceipt(ethereumHash) {
    for (let attempt = 0; attempt < this.maxReceiptPolls; attempt += 1) {
      const receipt = await this.wallet.transactionReceipt(ethereumHash);
      if (receipt) {
        if (receipt.status !== "0x1") throw new Error("transaction reverted");
        return receipt;
      }
      await this.sleep(this.receiptPollMs);
    }
    throw new Error("transaction receipt did not arrive before the bounded wait expired");
  }

  async waitForAuthorizedSubmission(journeyId, kind, ethereumHash) {
    for (let attempt = 0; attempt < this.maxReceiptPolls; attempt += 1) {
      const current = await this.request(`/v1/product/journeys/${journeyId}`);
      const authorization = current.journey?.authorizations?.find((candidate) =>
        candidate.intentKind === kind && candidate.ethereumHash?.toLowerCase() === ethereumHash.toLowerCase(),
      );
      if (authorization?.state === "submitted") return current.journey;
      if (["unknown", "rejected", "expired"].includes(authorization?.state)) {
        // This message reaches the owner verbatim through state.error, so it names
        // no intent kind and no internal authorization state.
        throw new Error("The wallet transaction for this step did not complete. Nothing was replayed and nothing extra was spent; open Details for the hashes the server recorded.");
      }
      await this.sleep(this.receiptPollMs);
    }
    throw new Error("MetaMask did not submit through the Refuel policy RPC; update the Hedera network RPC and retry with a fresh authorization");
  }

  // A destination quote lives ~60s while a leg needs 30s of runway, so the server
  // answers a thin quote with 409 QUOTE_EXPIRES_TOO_SOON and expects a refresh.
  // Only this server call is replayed — the wallet is never prompted for a retry —
  // and a refreshed quote gets its own idempotency key because it authorizes a
  // different transaction than the one the expired attempt would have.
  async authorizeIntent(journeyId, kind, boundQuoteId = null, confirmation = null) {
    for (let refreshes = 0; ; refreshes += 1) {
      try {
        const authorizationIdentity = boundQuoteId ? `${journeyId}:${boundQuoteId}` : journeyId;
        return await this.request(`/v1/product/journeys/${journeyId}/intents/${kind}/authorize`, {
          method: "POST",
          headers: {
            "idempotency-key": idempotency(refreshes ? `authorize-${kind}-r${refreshes}` : `authorize-${kind}`, authorizationIdentity),
          },
          // The same consent is replayed across every retry of this leg on
          // purpose: the loop below re-authorizes after a quote refresh, and a
          // message carrying a nonce would cost the owner a fresh prompt each time.
          body: {
            ...(boundQuoteId ? { quoteId: boundQuoteId } : {}),
            ...(confirmation ? { confirmation } : {}),
          },
        });
      } catch (error) {
        if (conflictCode(error) !== "QUOTE_EXPIRES_TOO_SOON") throw error;
        if (refreshes >= this.maxQuoteRefreshRetries) {
          throw new Error(`sponsored ${kind} still had too little quote runway after ${this.maxQuoteRefreshRetries} destination-quote refreshes; continue again to retry with a fresh quote`);
        }
        const progress = { journeyId, kind, attempt: refreshes + 1, maxAttempts: this.maxQuoteRefreshRetries };
        this.onQuoteRefresh({ ...progress, active: true });
        try {
          const refreshed = await this.refreshDestinationQuote({ journeyId });
          if (boundQuoteId) boundQuoteId = refreshed.quoteId;
        } finally {
          this.onQuoteRefresh({ ...progress, active: false });
        }
      }
    }
  }

  async submitAuthorizedIntent(journeyId, kind, mode, account, final = false, quoteId = null, networkReady = false, confirmation = null) {
    const built = await this.authorizeIntent(journeyId, kind, quoteId, confirmation);
    if (!networkReady) await this.wallet.switchToHedera(mode, this.apiBase || globalThis.location?.origin || "");
    const ethereumHash = await this.wallet.sendTransaction(built.transaction, account);
    await this.waitForWalletReceipt(ethereumHash);
    await this.waitForAuthorizedSubmission(journeyId, kind, ethereumHash);
    const path = final
      ? `/v1/product/journeys/${journeyId}/reconcile`
      : `/v1/product/journeys/${journeyId}/intents/${kind}/confirm`;
    return this.request(path, { method: "POST", body: { ethereumHash } });
  }

  async submitBridge(journeyId, quote, account, confirmation) {
    await this.wallet.switchChain(Number(quote.bridge.originChainId));
    const approval = quote.bridge.originApproval;
    if (approval) {
      const current = await this.wallet.tokenAllowance(approval.token, approval.spender, account);
      if (current < BigInt(approval.amount)) {
        await this.request(`/v1/product/journeys/${journeyId}/wallet-boundary`, {
          method: "POST",
          body: { kind: "origin_approval", confirmation },
        });
        const approvalHash = await this.wallet.approveToken(approval.token, approval.spender, approval.amount, account);
        await this.waitForWalletReceipt(approvalHash);
      }
    }
    if (!quote.bridge.transaction) throw new Error("bridge provider returned no executable transaction");
    await this.request(`/v1/product/journeys/${journeyId}/wallet-boundary`, {
      method: "POST",
      body: { kind: "bridge", confirmation },
    });
    const sourceTransactionHash = await this.wallet.sendTransaction({
      ...quote.bridge.transaction,
      from: account,
    }, account);
    this.onCheckpoint({
      journeyId,
      phase: "source_transaction_returned",
      sourceTransactionHash,
      replaySafe: false,
      note: "Wallet returned a source hash; the server binding below is what makes it durable.",
    });
    await this.request(`/v1/product/journeys/${journeyId}/bridge`, {
      method: "POST",
      body: { sourceTransactionHash, confirmation },
    });
    return sourceTransactionHash;
  }

  async waitForBridge(journeyId, { signal, maxPolls = this.maxBridgePolls, pollDelayMs = () => this.bridgePollMs } = {}) {
    const startedAt = Date.now();
    let fetchFailures = 0;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (signal?.aborted) throw new Error("bridge recovery cancelled; the durable source hash remains safe to poll later");
      const delayMs = pollDelayMs(attempt);
      let status;
      try {
        status = await this.request(`/v1/product/journeys/${journeyId}/bridge`, { signal });
        fetchFailures = 0;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A transient status-read failure must not abandon a durable in-flight bridge.
        fetchFailures += 1;
        if (fetchFailures > this.maxBridgeFetchFailures) throw error;
        if (attempt + 1 < maxPolls) await this.sleep(delayMs);
        continue;
      }
      this.onCheckpoint({
        journeyId,
        phase: "bridge_pending",
        providerStatus: status.transfer?.providerStatus ?? "unknown",
        providerState: status.transfer?.state ?? "unknown",
        arrival: status.arrival ?? null,
        pollAttempt: attempt + 1,
        maxPolls,
        elapsedMs: Date.now() - startedAt,
        nextPollAt: attempt + 1 < maxPolls ? new Date(Date.now() + delayMs).toISOString() : null,
        replaySafe: true,
      });
      if (status.transfer?.state === "arrived" && status.arrival?.confirmed) return status;
      if (status.transfer?.state === "failed" || status.transfer?.state === "unknown") {
        throw new Error(`bridge stopped with provider status ${status.transfer.providerStatus}`);
      }
      if (attempt + 1 < maxPolls) await this.sleep(delayMs);
    }
    throw new Error(`bridge remains pending after ${maxPolls} bounded polls; the durable source hash was not replayed and can be checked again`);
  }

  async settlePayment(journeyId) {
    let challenge;
    try {
      const settled = await this.request(`/v1/product/journeys/${journeyId}/payment`, {
        method: "POST",
        headers: { "idempotency-key": idempotency("payment", journeyId) },
        body: {},
      });
      // The x402 payment is journey-scoped: a refreshed destination quote never
      // implies a second charge, so a replayed settlement is the durable answer.
      if (settled.payment) return settled;
      throw new Error("payment endpoint returned success without a payment signature");
    } catch (error) {
      if (error.response?.status !== 402) throw error;
      challenge = error.response;
    }
    const paymentHeaders = await this.wallet.createPaymentHeaders(challenge);
    return this.request(`/v1/product/journeys/${journeyId}/payment`, {
      method: "POST",
      headers: {
        "idempotency-key": idempotency("payment", journeyId),
        ...paymentHeaders,
      },
      body: {},
    });
  }

  async createJourney({ quote, mode, account }) {
    const created = await this.request("/v1/product/journeys", {
      method: "POST",
      headers: { "idempotency-key": idempotency("journey", quote.quoteId) },
      body: { mode, quoteId: quote.quoteId, account },
    });
    this.onJourney({
      journeyId: created.journey.id,
      quoteId: quote.quoteId,
      account,
      mode,
      routeMode: quote.routeMode ?? "bridge_plus_refuel",
      quote,
      phase: "journey_created",
    });
    return created.journey;
  }

  // Pure read: viewing, recovering, polling, and opening Activity never mints a
  // quote. POST /destination-quote remains an explicit user action.
  async fetchJourneyDecision(journeyId, { signal } = {}) {
    return this.request(`/v1/product/journeys/${journeyId}`, { signal, timeoutMs: 45_000 });
  }

  async resume({ journeyId, account, signal }) {
    const current = await this.fetchJourneyDecision(journeyId, { signal });
    if (!current.journey || !current.recovery) throw new Error("journey recovery payload is incomplete");
    if (current.journey.account?.toLowerCase() !== account?.toLowerCase()) {
      throw new Error("connected account does not own the recoverable journey");
    }
    if (current.recovery.disposition === "blocked_unknown_submit_result") {
      return { journeyId, status: "blocked_unknown_submit_result", ...current };
    }
    if (current.recovery.disposition === "terminal") {
      this.onPhase("completed");
      return { journeyId, status: "completed", ...current };
    }
    if (current.recovery.nextAtomicStep !== "poll_bridge" || !current.recovery.replaySafe) {
      return { journeyId, status: "action_required", ...current };
    }
    this.onPhase("bridge_pending");
    const arrival = await this.waitForBridge(journeyId, {
      signal,
      maxPolls: this.maxRecoveryBridgePolls,
      pollDelayMs: (attempt) => (attempt < 12 ? 5_000 : 15_000),
    });
    const refreshed = await this.fetchJourneyDecision(journeyId, { signal });
    if (refreshed.recovery?.disposition === "terminal") {
      this.onPhase("completed");
      return { journeyId, status: "completed", arrival, ...refreshed };
    }
    this.onPhase("arrival_confirmed");
    return {
      journeyId,
      status: "action_required",
      arrival,
      ...refreshed,
    };
  }

  async refreshSourceQuote({ journeyId, quoteId, confirmation }) {
    const refreshed = await this.request(`/v1/product/journeys/${journeyId}/source-quote`, {
      method: "POST",
      body: { quoteId, confirmation },
      timeoutMs: 45_000,
    });
    if (refreshed.journey?.id !== journeyId || refreshed.quote?.quoteId !== quoteId) {
      throw new Error("same-journey source quote refresh is incomplete");
    }
    return refreshed;
  }

  async refreshDestinationQuote({ journeyId }) {
    const refreshed = await this.request(`/v1/product/journeys/${journeyId}/destination-quote`, { method: "POST", body: {}, timeoutMs: 45_000 });
    if (!refreshed.quote?.quoteId || !Number.isInteger(refreshed.quote?.expiresAt)) {
      throw new Error("refreshed destination quote is incomplete");
    }
    this.destinationQuote = refreshed.quote;
    return refreshed.quote;
  }

  // Server evidence, never local memory, decides which destination legs are
  // durable: re-authorizing a confirmed intent conflicts on its stored receipt.
  async completedDestinationLegs(journeyId) {
    const current = await this.request(`/v1/product/journeys/${journeyId}`);
    const done = new Set(
      (current.journey?.events ?? [])
        .map((event) => /^intent_(.+)_confirmed$/.exec(String(event.type ?? ""))?.[1])
        .filter(Boolean),
    );
    if (current.journey?.payment) done.add("payment");
    return done;
  }

  async continueRefuel({ journeyId, quote, mode, account }) {
    if (!quote?.quoteId || !Number.isInteger(quote?.expiresAt)) {
      throw new Error("destination consent requires an exact refreshed quote");
    }
    if (quote.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error("destination quote expired; refresh it before consent");
    }
    this.destinationQuote = quote;
    const completed = await this.completedDestinationLegs(journeyId);
    const paid = completed.has("payment");
    // One explicit continuation action owns exactly one add/switch request. Each
    // sponsored leg reuses the validated policy-RPC network and never registers
    // another provider path.
    await this.wallet.switchToHedera(mode, this.apiBase || globalThis.location?.origin || "");

    this.onPhase("approving_payment_asset");
    if (!completed.has("permit2_approval")) {
      await this.submitAuthorizedIntent(journeyId, "permit2_approval", mode, account, false, this.destinationQuote.quoteId, true);
    }
    this.onPhase("authorizing_x402");
    this.onPhase("settling_x402");
    if (!paid) await this.settlePayment(journeyId);

    this.onPhase("executing_refuel");
    if (this.destinationQuote.asset.destination.wrapper) {
      if (!completed.has("wrapper_approval")) await this.submitAuthorizedIntent(journeyId, "wrapper_approval", mode, account, false, null, true);
      if (!completed.has("wrapper_execution")) await this.submitAuthorizedIntent(journeyId, "wrapper_execution", mode, account, false, null, true);
    }
    if (!completed.has("router_approval")) await this.submitAuthorizedIntent(journeyId, "router_approval", mode, account, false, null, true);
    this.onPhase("reconciling");
    const result = await this.submitAuthorizedIntent(journeyId, "router_execution", mode, account, true, null, true);
    this.onPhase("completed");
    return { journeyId, quote: this.destinationQuote, result };
  }

  /**
   * One consent for the whole source leg.
   *
   * Every source-side mutation the server accepts — activate, the activation
   * authorization, both wallet boundaries, and the bridge binding — needs the
   * owner's SourceLegConsent, because a journey id alone used to be enough for a
   * stranger to spend sponsor HBAR or permanently brick the journey. They are the
   * mechanics of ONE owner decision ("run this journey on this quote"), so they
   * share one signature rather than costing four prompts.
   *
   * Signed on the origin chain, which the leg has to reach anyway for the bridge
   * send, so this adds no chain switch. `confirmation` may be supplied by a caller
   * that already took it — the resend signs to re-bind the quote and hands the
   * same consent straight through, so a resend is also one prompt in total.
   */
  async sourceLegConsent({ journeyId, quote, mode, account, confirmation = null }) {
    if (confirmation) return confirmation;
    const originChainId = Number(quote.bridge.originChainId);
    if (Number(this.wallet.chainId) !== originChainId) await this.wallet.switchChain(originChainId);
    return this.wallet.signJourneySourceLeg({
      journeyId,
      quoteId: quote.quoteId,
      mode,
      originChainId,
    }, account);
  }

  async run({ quote, mode, account, journeyId = null, confirmation = null }) {
    if (!journeyId) {
      journeyId = (await this.createJourney({ quote, mode, account })).id;
    } else {
      this.onJourney({ journeyId, quoteId: quote.quoteId, account, mode, routeMode: quote.routeMode ?? "bridge_plus_refuel" });
    }
    // Taken before the first mutation, so nothing on this leg runs unconsented.
    const consent = await this.sourceLegConsent({ journeyId, quote, mode, account, confirmation });

    if (quote.asset.destination.arrival === "activation_required") {
      this.onPhase("activating_destination");
      const activation = await this.request(`/v1/product/journeys/${journeyId}/activate`, {
        method: "POST",
        body: { confirmation: consent },
      });
      if (!activation.associated) {
        const alreadyConfirmed = activation.journey?.events?.some((event) => event.type === "intent_activation_confirmed");
        if (alreadyConfirmed) {
          throw new Error("Destination setup was already confirmed and is still indexing. Nothing was sent again; retry after the account association is visible.");
        }
        await this.submitAuthorizedIntent(journeyId, "activation", mode, account, false, quote.quoteId, false, consent);
      }
    }

    // One-time-per-token Permit2 allowance, taken while the wallet is already on
    // Hedera for activation. It is a SPONSORED intent because an approve costs
    // HBAR gas and the owner has none yet — that is the whole reason they are
    // refuelling. Both this and the witness below key off the same terms object:
    // `enabled` is about the route and the flag, `prerequisite` is setup this
    // visit completes. They used to be mutually exclusive, so the account that
    // needed the approval could never sign the witness.
    if (quote.routeMode !== "bridge_only" &&
        quote.refuelAuthorization?.enabled === true &&
        quote.refuelAuthorization?.prerequisite === "permit2_allowance") {
      this.onPhase("approving_refuel_allowance");
      await this.submitAuthorizedIntent(journeyId, "permit2_approval", mode, account, false, quote.quoteId, false, consent);
    }

    // The witness replaces every post-arrival prompt. When activation was needed
    // MetaMask is already on Hedera; otherwise this one explicit round trip is the
    // only added switch. The source bridge below switches back to origin exactly once.
    if (quote.routeMode !== "bridge_only" && quote.refuelAuthorization?.enabled === true) {
      this.onPhase("authorizing_refuel");
      const hederaChainId = mode === "mainnet" ? 295 : 296;
      if (Number(this.wallet.chainId) !== hederaChainId) {
        await this.wallet.switchToHedera(mode, this.apiBase || globalThis.location?.origin || "");
      }
      const deadline = Math.floor(Date.now() / 1000) + Number(quote.refuelAuthorization.authorizationTtlSeconds);
      const signed = await this.wallet.signRefuelAuthorization({
        journeyId,
        mode,
        terms: quote.refuelAuthorization,
        deadline,
      }, account);
      await this.request(`/v1/product/journeys/${journeyId}/refuel-authorization`, {
        method: "POST",
        body: {
          confirmation: consent,
          deadline: signed.deadline,
          signature: signed.signature,
        },
      });
    }

    this.onPhase("submitting_bridge");
    await this.submitBridge(journeyId, quote, account, consent);
    this.onPhase("bridge_pending");
    const bridgeStatus = await this.waitForBridge(journeyId);
    this.onPhase("arrival_confirmed");
    if (quote.routeMode === "bridge_only") {
      this.onPhase("completed");
      return { journeyId, quote, result: { journey: bridgeStatus.journey, arrival: bridgeStatus.arrival } };
    }
    const refreshedQuote = await this.refreshDestinationQuote({ journeyId });
    this.onPhase("arrival_confirmed");
    return {
      journeyId,
      quote: refreshedQuote,
      status: "action_required",
      recovery: {
        schema: "refuel402.product-recovery.v1",
        journeyId,
        routeMode: "bridge_plus_refuel",
        state: "arrival_confirmed",
        disposition: "action_required",
        status: "action_required",
        nextAtomicStep: "destination_wallet_consent",
        replaySafe: false,
        walletActionRequired: true,
        autoSignAllowed: false,
        autoSubmitAllowed: false,
        sameJourneyResendAllowed: false,
        reason: "Bridge arrival and a fresh destination quote are durable. Review the displayed quote, then continue with explicit wallet consent.",
      },
      result: { journey: bridgeStatus.journey, arrival: bridgeStatus.arrival },
    };
  }
}
