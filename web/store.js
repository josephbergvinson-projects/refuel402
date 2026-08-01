import { batch, computed, signal } from "@preact/signals";
import { ProductApiClient } from "./api-client.js";
import { JourneyOrchestrator } from "./journey-orchestrator.js";
import { JourneyPersistence } from "./journey-recovery.js";
import { destinationRecoveryQuoteState } from "./recovery-action-model.js";
import { deriveJourneyPresentation } from "./journey-view-model.js";
import { MetaMaskController } from "./wallet.js";
import {
  JOURNEY_STATES,
  buildCombinedQuoteRequest,
  formatUnits,
  networkOptionsForProvider,
  normalizeDesiredHbar,
  parseUnits,
  providerOptions,
  quoteFailureMessage,
  quoteStillValid,
  tokenOptionsForNetwork,
  transitionJourney,
} from "./product-model.js";

/**
 * The single source of app state and the only module that talks to the logic
 * modules (wallet.js, api-client.js, journey-orchestrator.js,
 * journey-recovery.js, product-model.js, journey-view-model.js,
 * recovery-action-model.js). Components read `state.*` signals and call
 * `actions.*`; they never reach into internals and never write state directly.
 */

export const RECOVERY_REPOLL_MS = 12_000;
export const ORIGIN_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const ACTIVITY_PAGE_SIZE = 8;
const MIN_SLIPPAGE_PERCENT = 0.01;
const MAX_SLIPPAGE_PERCENT = 3;

// The server hard-stops a source-wallet boundary that produced no authoritative
// bridge hash and names the adoption endpoint as the only owner-driven exit.
export function bridgeAdoptionOffered(recovery) {
  return recovery?.nextAtomicStep === "operator_review"
    && typeof recovery?.reason === "string"
    && recovery.reason.includes("/bridge/adopt");
}

/**
 * Server evidence qualifies failure copy after a partially completed source leg.
 * A sponsored activation is a real destination-chain transaction even when the
 * origin approval/bridge never happened, so the client must not repeat a generic
 * "nothing was sent" claim after re-reading the durable journey.
 */
export function orchestrationFailureMessage(error, decision) {
  const detail = String(error?.message ?? "The journey could not continue.");
  const eventTypes = new Set((decision?.journey?.events ?? []).map((event) => String(event?.type ?? "")));
  const activationConfirmed = eventTypes.has("intent_activation_confirmed");
  const originEvidence = eventTypes.has("origin_approval_wallet_boundary") ||
    eventTypes.has("bridge_wallet_boundary") ||
    eventTypes.has("bridge_submitted");
  if (activationConfirmed && !originEvidence) {
    return `Destination setup completed, but no origin approval or bridge was sent. ${detail}`;
  }
  if (originEvidence) {
    return `This journey has recorded source-side evidence. ${detail} Open Details for the authoritative next step; nothing will be replayed automatically.`;
  }
  return detail;
}

/**
 * Pure decision table for the one primary action, transcribed from the shipped
 * shell. It returns intent only — copy belongs to the surface that renders it.
 * kinds: connect_wallet | busy | accept_new_terms | rechecking | new_transfer |
 *        resend_journey | adopt_bridge | reconcile | continue_destination | refresh_destination |
 *        wait_bridge | complete | blocked | select_provider | select_network |
 *        select_token | route_unavailable | invalid_desired_hbar | quoting |
 *        request_quote | refresh_quote | launch_paused | start_journey
 */
export function derivePrimaryIntent(snapshot) {
  const intent = (kind, extra = {}) => ({
    kind,
    disabled: false,
    busy: false,
    allowNewTransfer: false,
    detail: null,
    ...extra,
  });
  if (!snapshot.account) return intent("connect_wallet");
  if (snapshot.loading) {
    return intent("busy", {
      disabled: true,
      busy: true,
      detail: snapshot.quoteRefresh ? "quote_refresh" : snapshot.journeyId ? "recovering" : "discovering",
    });
  }
  // The consent gate outranks the provisional re-check: it is a server decision
  // about this exact journey, and only an explicit click may resolve it.
  if (snapshot.quoteConsentGate && snapshot.journeyId) {
    return intent("accept_new_terms", { allowNewTransfer: true });
  }
  if (snapshot.journeyId && snapshot.recoveryProvisional) {
    return intent("rechecking", { disabled: true, allowNewTransfer: Boolean(snapshot.error) });
  }
  if (snapshot.recovery && snapshot.journeyId) {
    if (snapshot.recovery.disposition === "terminal") {
      return intent("complete", { disabled: true, allowNewTransfer: true });
    }
    if (bridgeAdoptionOffered(snapshot.recovery)) {
      return intent("adopt_bridge", {
        disabled: !ORIGIN_TRANSACTION_HASH.test(String(snapshot.bridgeAdoptionHash ?? "")),
        allowNewTransfer: true,
        detail: snapshot.bridgeAdoptionHash ? "invalid_hash" : "hash_required",
      });
    }
    if (snapshot.recovery.nextAtomicStep === "reconcile_submissions") {
      return intent("reconcile", { allowNewTransfer: true });
    }
    if (snapshot.recovery.disposition === "blocked_unknown_submit_result") {
      return intent("blocked", { disabled: true, allowNewTransfer: true });
    }
    if (snapshot.recovery.nextAtomicStep === "source_wallet_consent") {
      return snapshot.recovery.sameJourneyResendAllowed === true
        ? intent("resend_journey")
        : intent("new_transfer");
    }
    // The executor owns this arrival; offering a manual conversion here is what
    // pointed two paths at the same funds.
    if (snapshot.recovery.nextAtomicStep === "poll_refuel") {
      return intent("wait_refuel", { disabled: true });
    }
    if (snapshot.recovery.nextAtomicStep === "poll_bridge") {
      return intent("wait_bridge", { disabled: true });
    }
    if (snapshot.recovery.nextAtomicStep === "destination_wallet_consent" && snapshot.routeMode === "bridge_plus_refuel") {
      return intent(snapshot.destinationQuoteLive ? "continue_destination" : "refresh_destination", { allowNewTransfer: true });
    }
    return intent("blocked", { disabled: true, allowNewTransfer: true });
  }
  if (!snapshot.provider) return intent("select_provider", { disabled: true });
  if (!snapshot.network) return intent("select_network", { disabled: true });
  if (!snapshot.token) return intent("select_token", { disabled: true });
  if (snapshot.token.disabled) return intent("route_unavailable", { disabled: true, detail: snapshot.token.blockers?.[0] ?? "UNAVAILABLE" });
  if (snapshot.routeMode === "bridge_plus_refuel" && snapshot.desiredHbarError) {
    return intent("invalid_desired_hbar", { disabled: true, detail: snapshot.desiredHbarError });
  }
  if (snapshot.phase === "quoting") return intent("quoting", { disabled: true, busy: true });
  if (!snapshot.quote) return intent("request_quote");
  if (snapshot.quoteStale || snapshot.quoteExpired) return intent("refresh_quote");
  if (!snapshot.quote.capabilities?.execute) return intent("launch_paused", { disabled: true });
  return intent("start_journey");
}

export function createStore({
  apiBase = "",
  wallet = new MetaMaskController(),
  client = new ProductApiClient({ apiBase }),
  persistence = new JourneyPersistence(),
  orchestrator: providedOrchestrator = null,
  location = globalThis.location,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const requestedRouteMode = new URLSearchParams(location?.search ?? "").get("route");

  // ---------------------------------------------------------------- signals
  const modeValue = signal("mainnet");
  const routeModeValue = signal(requestedRouteMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel");
  const optionsValue = signal(null);

  const walletValue = signal({ installed: false, account: null, chainId: null, connected: false });

  const providerValue = signal(null);
  const networkValue = signal(null);
  const tokenValue = signal(null);
  const tokenBalanceValue = signal(null);
  // The gas the origin chain reserves is paid in the NATIVE asset, which is only
  // the selected token when the owner happens to be bridging it. Held separately
  // so a USDC transfer can still be told it lacks ETH.
  const nativeBalanceValue = signal(null);
  const tokenBalanceStatusValue = signal("idle");
  const tokenBalanceErrorValue = signal(null);

  // Editable draft. Never persisted to localStorage, never written to a
  // checkpoint, and never restored from anything but a server journey record.
  const sourceAmountValue = signal("");
  // 10, matching the first preset chip. At 1 HBAR the near-fixed service fee
  // dwarfs what arrives, so the default asked the product to introduce itself at
  // its worst possible ratio.
  const desiredHbarValue = signal("10");
  const desiredHbarEditedValue = signal(false);
  const slippagePercentValue = signal("1.00");
  const refuelProtectionPresetValue = signal("flexible");
  const customRefuelCapValue = signal("");

  const quoteValue = signal(null);
  const quoteStaleValue = signal(false);
  const quoteLimitValue = signal(null);
  const quoteSecondsRemainingValue = signal(0);

  const phaseValue = signal("idle");
  const journeyIdValue = signal(null);
  const journeyValue = signal(null);
  const recoveryValue = signal(null);
  // A pointer/URL selects an id only; all visible lifecycle data stays
  // provisional until the server confirms that exact journey.
  const recoveryProvisionalValue = signal(false);
  const recoveryProgressValue = signal(null);
  const destinationRecoveryQuoteIdValue = signal(null);
  // Set only by the server's QUOTE_ECONOMICS_WORSENED 409: a post-consent
  // re-quote came back worse, so execution stops until the owner accepts.
  const quoteConsentGateValue = signal(null);
  const quoteRefreshValue = signal(null);

  const activityOpenValue = signal(false);
  const activityItemsValue = signal([]);
  const activityNextBeforeValue = signal(null);
  const activityLoadingValue = signal(false);
  const activityErrorValue = signal(null);
  // Per-row, because the global loading signal would freeze every control in
  // the drawer while one row is being retired.
  const activityAbandoningValue = signal(null);

  const loadingValue = signal(false);
  const errorValue = signal(null);
  const recoveryCancellableValue = signal(false);

  // A journey the owner did not ask for on this visit. Opening the site used to
  // adopt the stored pointer outright, which replaced the compose surface with an
  // old journey before anything could be typed — and because an adopted journey
  // locks the draft, it also froze the origin network on the catalog default. Now
  // only a journey with funds genuinely in motion takes the surface; anything else
  // waits here as an offer the owner can take or dismiss.
  const resumeOfferValue = signal(null);

  // -------------------------------------------------------- imperative refs
  let quoteTimer = null;
  let recoveryController = null;
  let recoveryAttemptedFor = null;
  let recoveryPollTimer = null;
  let runInFlight = false;
  let primaryActionInFlight = false;
  let walletConnectPromise = null;
  let tokenBalanceRequestVersion = 0;
  let activityController = null;
  let recoveryRepollInFlight = false;
  let recoveryRepollSequence = 0;
  let unsubscribeWallet = null;

  const endpoint = (path) => (apiBase ? `${apiBase}${path}` : path);

  // ------------------------------------------------------------- one setter
  /**
   * The single phase-writing site. Every phase change is validated against the
   * transition map in product-model.js. `authoritative` is the server-landing
   * escape hatch; `reset` is the one out-of-graph landing (the connected
   * account changed, so the journey is abandoned rather than advanced).
   */
  function setPhase(next, options) {
    if (next === phaseValue.peek()) return;
    if (options?.reset && !JOURNEY_STATES.includes(next)) throw new Error("unknown journey state");
    phaseValue.value = options?.reset ? next : transitionJourney(phaseValue.peek(), next, options);
  }

  // ------------------------------------------------------------ persistence
  function persistJourneyCheckpoint() {
    const account = walletValue.peek().account;
    if (!account || !journeyIdValue.peek()) return null;
    try {
      return persistence.persist({
        journeyId: journeyIdValue.peek(),
        account,
        mode: modeValue.peek(),
        routeMode: routeModeValue.peek(),
      });
    } catch (error) {
      errorValue.value = `Journey remains server-safe, but its local pointer could not be saved: ${error.message}`;
      return null;
    }
  }

  // ----------------------------------------------------------- orchestrator
  const orchestrator = providedOrchestrator ?? new JourneyOrchestrator({
    apiBase,
    client,
    wallet,
    onPhase: (phase) => {
      // A live run owns the UI: any previously rendered recovery/error banner is
      // stale the moment the run progresses.
      batch(() => {
        errorValue.value = null;
        recoveryValue.value = null;
        recoveryProvisionalValue.value = false;
        recoveryProgressValue.value = null;
        quoteRefreshValue.value = null;
        setPhase(phase, { authoritative: true });
      });
      persistJourneyCheckpoint();
    },
    onJourney: (identity) => {
      journeyIdValue.value = identity.journeyId;
      // The just-created journey must never race a concurrent recovery attempt.
      recoveryAttemptedFor = identity.journeyId;
      if (identity.quote) quoteValue.value = identity.quote;
      persistJourneyCheckpoint();
    },
    onCheckpoint: (checkpoint) => {
      recoveryProgressValue.value = checkpoint;
      persistJourneyCheckpoint();
    },
    // A quote refresh mid-leg is server-only work, bounded by the orchestrator's
    // maxQuoteRefreshRetries budget; the surface says so instead of leaving the
    // journey looking frozen behind a wallet prompt.
    onQuoteRefresh: (event) => {
      quoteRefreshValue.value = event.active ? event : null;
    },
  });

  // -------------------------------------------------------------- computeds
  const draftLocked = computed(() => Boolean(journeyIdValue.value));

  const desiredHbarParsed = computed(() => {
    if (routeModeValue.value === "bridge_only") return { tinybar: 0n, error: null };
    let tinybar;
    try {
      tinybar = normalizeDesiredHbar(desiredHbarValue.value).tinybar;
    } catch (error) {
      return { tinybar: null, error: error.message };
    }
    // The configured cap is a hard server policy, so an amount above it can only
    // ever be refused. Naming it at the field as it is typed beats letting the
    // owner reach the CTA and collect a 422. The lower, route-specific maximum is
    // deliberately NOT enforced here: it moves with live liquidity, and the meter
    // plus the server's own limiting constraint already report it.
    const configured = optionsValue.value?.limits?.maximumConfiguredHbarTinybar;
    const cap = (() => {
      if (configured === undefined || configured === null || configured === "") return null;
      try { return BigInt(configured); } catch { return null; }
    })();
    if (cap !== null && cap > 0n && tinybar > cap) {
      return {
        tinybar,
        error: `That exceeds the maximum for one refuel. The most this product will deliver is ${formatUnits(cap, 8, 8)} ℏ.`,
      };
    }
    return { tinybar, error: null };
  });

  const quoteExpired = computed(() => {
    const quote = quoteValue.value;
    return Boolean(quote && quote.expiresAt <= now());
  });

  const destinationQuoteState = computed(() => destinationRecoveryQuoteState({
    recovery: recoveryValue.value,
    quote: quoteValue.value,
    persistedQuoteId: destinationRecoveryQuoteIdValue.value,
  }));

  const journeyPresentation = computed(() => deriveJourneyPresentation({
    journey: journeyValue.value,
    recovery: recoveryValue.value,
    quote: quoteValue.value,
    quoteLive: destinationQuoteState.value.live,
    routeMode: routeModeValue.value,
  }));

  const providerCatalog = computed(() => providerOptions(optionsValue.value, "", routeModeValue.value));
  const networkCatalog = computed(() => (providerValue.value
    ? networkOptionsForProvider(optionsValue.value, providerValue.value.id, "", routeModeValue.value)
    : []));
  const tokenCatalog = computed(() => (networkValue.value && providerValue.value
    ? tokenOptionsForNetwork(optionsValue.value, networkValue.value.chainId, providerValue.value.id, "", routeModeValue.value)
    : []));

  const surface = computed(() => (journeyIdValue.value ? "journey" : "compose"));

  const bridgeAdoptionHashValue = signal("");

  const primaryIntent = computed(() => derivePrimaryIntent({
    account: walletValue.value.account,
    loading: loadingValue.value,
    error: errorValue.value,
    quoteRefresh: quoteRefreshValue.value,
    quoteConsentGate: quoteConsentGateValue.value,
    journeyId: journeyIdValue.value,
    recoveryProvisional: recoveryProvisionalValue.value,
    recovery: recoveryValue.value,
    routeMode: routeModeValue.value,
    destinationQuoteLive: destinationQuoteState.value.live,
    provider: providerValue.value,
    network: networkValue.value,
    token: tokenValue.value,
    desiredHbarError: desiredHbarParsed.value.error,
    phase: phaseValue.value,
    quote: quoteValue.value,
    quoteStale: quoteStaleValue.value,
    quoteExpired: quoteExpired.value,
    bridgeAdoptionHash: bridgeAdoptionHashValue.value,
  }));

  /** Read-only view of state. Writing to any of these throws. */
  const state = {
    mode: computed(() => modeValue.value),
    routeMode: computed(() => routeModeValue.value),
    options: computed(() => optionsValue.value),
    providerCatalog,
    networkCatalog,
    tokenCatalog,

    wallet: computed(() => walletValue.value),
    account: computed(() => walletValue.value.account),
    chainId: computed(() => walletValue.value.chainId),
    walletInstalled: computed(() => walletValue.value.installed),

    provider: computed(() => providerValue.value),
    network: computed(() => networkValue.value),
    token: computed(() => tokenValue.value),
    tokenBalance: computed(() => tokenBalanceValue.value),
    nativeBalance: computed(() => nativeBalanceValue.value),
    tokenBalanceStatus: computed(() => tokenBalanceStatusValue.value),
    tokenBalanceError: computed(() => tokenBalanceErrorValue.value),

    sourceAmount: computed(() => sourceAmountValue.value),
    desiredHbar: computed(() => desiredHbarValue.value),
    desiredHbarTinybar: computed(() => desiredHbarParsed.value.tinybar),
    desiredHbarError: computed(() => desiredHbarParsed.value.error),
    slippagePercent: computed(() => slippagePercentValue.value),
    refuelProtectionPreset: computed(() => refuelProtectionPresetValue.value),
    customRefuelCap: computed(() => customRefuelCapValue.value),
    draftLocked,

    quote: computed(() => quoteValue.value),
    quoteStale: computed(() => quoteStaleValue.value),
    quoteExpired,
    quoteLimit: computed(() => quoteLimitValue.value),
    quoteSecondsRemaining: computed(() => quoteSecondsRemainingValue.value),
    quoteRefresh: computed(() => quoteRefreshValue.value),
    quoteConsentGate: computed(() => quoteConsentGateValue.value),

    phase: computed(() => phaseValue.value),
    journeyId: computed(() => journeyIdValue.value),
    journey: computed(() => journeyValue.value),
    resumeOffer: computed(() => resumeOfferValue.value),
    recovery: computed(() => recoveryValue.value),
    recoveryProvisional: computed(() => recoveryProvisionalValue.value),
    recoveryProgress: computed(() => recoveryProgressValue.value),
    recoveryCancellable: computed(() => recoveryCancellableValue.value),
    destinationQuoteState,
    journeyPresentation,
    bridgeAdoptionOffered: computed(() => bridgeAdoptionOffered(recoveryValue.value)),
    bridgeAdoptionHash: computed(() => bridgeAdoptionHashValue.value),

    activityOpen: computed(() => activityOpenValue.value),
    activityItems: computed(() => activityItemsValue.value),
    activityAbandoning: computed(() => activityAbandoningValue.value),
    activityHasMore: computed(() => Boolean(activityNextBeforeValue.value)),
    activityLoading: computed(() => activityLoadingValue.value),
    activityError: computed(() => activityErrorValue.value),

    loading: computed(() => loadingValue.value),
    error: computed(() => errorValue.value),
    surface,
    primaryIntent,
  };

  // ---------------------------------------------------------------- helpers
  function quoteContext() {
    return {
      mode: modeValue.peek(),
      routeMode: routeModeValue.peek(),
      account: walletValue.peek().account,
      network: networkValue.peek(),
      provider: providerValue.peek(),
      token: tokenValue.peek(),
      desiredHbarTinybar: desiredHbarParsed.peek().tinybar,
      refuelProtectionPreset: refuelProtectionPresetValue.peek(),
      customRefuelCap: customRefuelCapValue.peek(),
    };
  }

  function slippageBps() {
    const percent = Number(slippagePercentValue.peek() || "1");
    if (!Number.isFinite(percent) || percent < MIN_SLIPPAGE_PERCENT || percent > MAX_SLIPPAGE_PERCENT) {
      throw new Error(`maximum slippage must be between ${MIN_SLIPPAGE_PERCENT.toFixed(2)}% and ${MAX_SLIPPAGE_PERCENT.toFixed(2)}%`);
    }
    return Math.round(percent * 100);
  }

  // A post-consent re-quote may only keep or improve the consented terms. When
  // the server refuses one it writes nothing, so the only continuation is one
  // explicit acceptance from the owner: this never auto-accepts and never
  // retries silently.
  function raiseTermsGate(error) {
    const details = error?.body?.code === "QUOTE_ECONOMICS_WORSENED" ? error.body.details : null;
    if (!details?.consented || !details?.refreshed) return false;
    batch(() => {
      quoteConsentGateValue.value = { consented: details.consented, refreshed: details.refreshed };
      quoteRefreshValue.value = null;
      errorValue.value = null;
    });
    return true;
  }

  function resetTokenBalance(status = "idle", error = null) {
    tokenBalanceRequestVersion += 1;
    batch(() => {
      tokenBalanceValue.value = null;
      tokenBalanceStatusValue.value = status;
      tokenBalanceErrorValue.value = error;
    });
  }

  function resetEditableDraft() {
    batch(() => {
      sourceAmountValue.value = "";
      desiredHbarEditedValue.value = false;
      desiredHbarValue.value = optionsValue.peek()?.defaults?.desiredHbar ?? "10";
      slippagePercentValue.value = ((optionsValue.peek()?.defaults?.slippageBps ?? 100) / 100).toFixed(2);
      refuelProtectionPresetValue.value = "flexible";
      customRefuelCapValue.value = "";
    });
  }

  function invalidateQuote(message, { reset = false } = {}) {
    // Nothing to invalidate means nothing to warn about. Every one of these
    // messages describes a quote going stale ("refresh to bind the new
    // maximum"), so firing one before the first quote exists reported a problem
    // with a quote that was never taken — changing a setting while composing is
    // just composing.
    const hadQuote = Boolean(quoteValue.peek());
    if (journeyIdValue.peek() && hadQuote) {
      quoteStaleValue.value = true;
      if (message) errorValue.value = message;
      persistJourneyCheckpoint();
      return;
    }
    batch(() => {
      quoteValue.value = null;
      quoteStaleValue.value = false;
      quoteLimitValue.value = null;
      if (message && hadQuote) errorValue.value = message;
      if (phaseValue.peek() !== "idle") setPhase("discovering", reset ? { reset: true } : undefined);
    });
    stopQuoteTimer();
  }

  function stopQuoteTimer() {
    if (quoteTimer) clearInterval(quoteTimer);
    quoteTimer = null;
  }

  function startQuoteTimer() {
    stopQuoteTimer();
    const tick = () => {
      const quote = quoteValue.peek();
      if (!quote) return;
      const remaining = quote.expiresAt - now();
      quoteSecondsRemainingValue.value = Math.max(0, remaining);
      if (remaining > 0) return;
      stopQuoteTimer();
      // Only states displaying an actionable quote move to expired; terminal or
      // recovery states keep their phase and just mark the quote stale.
      const displayed = ["ready", "recovery_quote_ready"].includes(phaseValue.peek());
      const changed = !quoteStaleValue.peek() || displayed;
      if (displayed) setPhase("expired");
      quoteStaleValue.value = true;
      if (changed) persistJourneyCheckpoint();
    };
    tick();
    if (!quoteStaleValue.peek() && quoteValue.peek()?.expiresAt > now()) {
      quoteTimer = setInterval(tick, 1_000);
    }
  }

  function restoreRecoveredSelection(journey, quote) {
    if (!optionsValue.peek() || !journey || !quote) return;
    const providerId = journey.requestedProvider ?? quote.providerSelection?.requested ?? quote.bridge?.provider ?? "auto";
    const providers = providerOptions(optionsValue.peek(), "", routeModeValue.peek());
    providerValue.value = providers.find((provider) => provider.id === providerId)
      ?? providers.find((provider) => provider.id === quote.bridge?.provider)
      ?? providerValue.peek();
    const originChainId = String(journey.originChainId ?? quote.bridge?.originChainId ?? "");
    const networks = providerValue.peek()
      ? networkOptionsForProvider(optionsValue.peek(), providerValue.peek().id, "", routeModeValue.peek())
      : [];
    networkValue.value = networks.find((network) => String(network.chainId) === originChainId) ?? networkValue.peek();
    const tokens = networkValue.peek() && providerValue.peek()
      ? tokenOptionsForNetwork(optionsValue.peek(), networkValue.peek().chainId, providerValue.peek().id, "", routeModeValue.peek())
      : [];
    tokenValue.value = tokens.find((token) => token.assetId === journey.assetId && token.address?.toLowerCase() === quote.bridge?.originToken?.toLowerCase())
      ?? tokens.find((token) => token.assetId === journey.assetId)
      ?? tokenValue.peek();
    resetTokenBalance();
    // Draft fields are repopulated from the SERVER journey record only; they are
    // never read back from local storage.
    const source = quote.bridge?.normalized?.sourceAmount;
    if (source?.amount !== undefined && source?.decimals !== undefined) {
      sourceAmountValue.value = formatUnits(source.amount, source.decimals, source.decimals);
    }
    if (quote.amountLedger?.hbar?.exactOutputTinybar && routeModeValue.peek() === "bridge_plus_refuel") {
      desiredHbarValue.value = formatUnits(quote.amountLedger.hbar.exactOutputTinybar, 8, 8);
      desiredHbarEditedValue.value = true;
    }
    if (quote.destination?.slippageBps !== undefined && routeModeValue.peek() === "bridge_plus_refuel") {
      slippagePercentValue.value = (quote.destination.slippageBps / 100).toFixed(2);
    }
    if (quote.refuelCap?.preset && routeModeValue.peek() === "bridge_plus_refuel") {
      refuelProtectionPresetValue.value = quote.refuelCap.preset;
      customRefuelCapValue.value = quote.refuelCap.preset === "custom"
        ? formatUnits(quote.refuelCap.maxAmountIn, quote.asset?.destination?.decimals ?? 18, quote.asset?.destination?.decimals ?? 18)
        : "";
    }
  }

  // ---------------------------------------------------------------- catalog
  async function loadOptions(mode) {
    batch(() => {
      loadingValue.value = true;
      errorValue.value = null;
      optionsValue.value = null;
      networkValue.value = null;
      providerValue.value = null;
      tokenValue.value = null;
      quoteLimitValue.value = null;
      quoteValue.value = null;
      setPhase("discovering");
    });
    resetTokenBalance();
    try {
      const options = await client.request(`/v1/product/options?mode=${mode}`);
      batch(() => {
        optionsValue.value = options;
        const defaultDesired = options.defaults?.desiredHbar;
        if (defaultDesired && !desiredHbarEditedValue.peek()) desiredHbarValue.value = defaultDesired;
        const providers = providerOptions(options, "", routeModeValue.peek());
        // A quote-ready provider is preferred, but falling all the way to null
        // empties the network catalog and with it the asset picker — which then
        // claims "every discovered asset stays listed" while listing nothing.
        // A merely discoverable provider still names every asset and its blocker.
        providerValue.value = providers.find((provider) => provider.id === "auto" && provider.runtime.quoteReady)
          ?? providers.find((provider) => provider.runtime.quoteReady)
          ?? providers.find((provider) => provider.id === "auto" && provider.runtime.discoverable)
          ?? providers.find((provider) => provider.runtime.discoverable)
          ?? null;
        const networks = providerValue.peek()
          ? networkOptionsForProvider(options, providerValue.peek().id, "", routeModeValue.peek())
          : [];
        networkValue.value = networks.find((network) => network.providerOption?.runtime?.quoteReady) ?? networks[0] ?? null;
        const tokens = networkValue.peek() && providerValue.peek()
          ? tokenOptionsForNetwork(options, networkValue.peek().chainId, providerValue.peek().id, "", routeModeValue.peek())
          : [];
        tokenValue.value = tokens.find((token) => !token.disabled) ?? null;
        loadingValue.value = false;
        setPhase(options.assets?.length ? "idle" : "unsupported");
      });
      // The catalog just replaced provider/network/token wholesale, so this is the
      // one place re-observing the wallet cannot take a deliberate choice away.
      // Without it the origin network follows the wallet only on a chainChanged
      // edge — an edge that never fires again once the page has settled — so every
      // later catalog load (mode, route mode, fresh transfer, a recovered
      // journey's mode switch) silently re-defaulted the origin to catalog order
      // and left the balance "idle", which is the state in which the wrong-chain
      // notice and its Switch network button do not render. That is why the app
      // looked like it could not tell which network the wallet was on until the
      // asset was picked by hand. Both calls are internally gated and are no-ops
      // when the selection already matches.
      followWalletChain(walletValue.peek().chainId);
      void refreshBalance();
    } catch (error) {
      batch(() => {
        loadingValue.value = false;
        errorValue.value = error.message;
        setPhase("failed");
      });
    }
  }

  // ---------------------------------------------------------------- balance
  async function refreshBalance() {
    const requestVersion = ++tokenBalanceRequestVersion;
    const account = walletValue.peek().account;
    const token = tokenValue.peek();
    const network = networkValue.peek();
    const currentRequestStillApplies = () =>
      requestVersion === tokenBalanceRequestVersion &&
      walletValue.peek().account === account &&
      tokenValue.peek()?.id === token?.id &&
      String(networkValue.peek()?.chainId ?? "") === String(network?.chainId ?? "");

    if (!account || !token?.address || !network) {
      if (!currentRequestStillApplies()) return;
      batch(() => {
        tokenBalanceValue.value = null;
        tokenBalanceStatusValue.value = "idle";
        tokenBalanceErrorValue.value = null;
      });
      return;
    }
    if (Number(walletValue.peek().chainId) !== Number(network.chainId)) {
      if (!currentRequestStillApplies()) return;
      batch(() => {
        tokenBalanceValue.value = null;
        tokenBalanceStatusValue.value = "wrong_chain";
        tokenBalanceErrorValue.value = null;
      });
      return;
    }
    batch(() => {
      tokenBalanceValue.value = null;
      tokenBalanceStatusValue.value = "loading";
      tokenBalanceErrorValue.value = null;
    });
    try {
      const balance = token.native
        ? await wallet.nativeBalance(account)
        : await wallet.tokenBalance(token.address, account);
      // Never fatal: the token balance is what gates the amount, and a failed
      // native read only costs the owner the gas warning.
      const native = token.native ? balance : await wallet.nativeBalance(account).catch(() => null);
      if (!currentRequestStillApplies()) return;
      batch(() => {
        tokenBalanceValue.value = balance;
        nativeBalanceValue.value = native;
        tokenBalanceStatusValue.value = "ready";
      });
    } catch (error) {
      if (!currentRequestStillApplies()) return;
      batch(() => {
        tokenBalanceValue.value = null;
        tokenBalanceStatusValue.value = "error";
        tokenBalanceErrorValue.value = error instanceof Error ? error.message : "wallet RPC balance read failed";
      });
    }
  }

  // ------------------------------------------------------------------ quote
  async function requestQuote() {
    errorValue.value = null;
    try {
      const network = networkValue.peek();
      if (Number(walletValue.peek().chainId) !== Number(network?.chainId)) {
        await wallet.switchChain(Number(network.chainId));
        await refreshBalance();
      }
      const request = buildCombinedQuoteRequest({
        ...quoteContext(),
        amount: sourceAmountValue.peek(),
        desiredHbar: desiredHbarValue.peek(),
        slippageBps: slippageBps(),
      });
      batch(() => {
        loadingValue.value = true;
        setPhase("quoting");
      });
      const body = await client.request("/v1/product/quote", { method: "POST", body: request });
      // Selecting another provider/network/asset mid-flight already reset the
      // draft; that response is no longer a consent context and never lands.
      if (phaseValue.peek() !== "quoting") {
        loadingValue.value = false;
        return;
      }
      wallet.assertSameAddress(...[
        body.sameAddress.bridgeFrom,
        body.sameAddress.bridgeTo,
        body.sameAddress.hederaDestination,
        body.sameAddress.x402Payer,
        body.sameAddress.hbarRecipient,
      ].filter(Boolean));
      batch(() => {
        quoteValue.value = body;
        quoteStaleValue.value = false;
        quoteLimitValue.value = body.feasibility;
        loadingValue.value = false;
        setPhase("ready");
      });
      persistJourneyCheckpoint();
      startQuoteTimer();
    } catch (error) {
      batch(() => {
        loadingValue.value = false;
        errorValue.value = quoteFailureMessage(error);
        quoteLimitValue.value = error.body?.details ?? null;
        setPhase("failed");
      });
    }
  }

  /**
   * The best HBAR bound the SERVER has already published: the solved route
   * maximum when one exists, otherwise the configured policy cap from
   * /v1/product/options. Both are server numbers; neither is computed here.
   */
  function publishedMaximumTinybar() {
    const solved = quoteLimitValue.peek()?.maximumTinybar ?? quoteValue.peek()?.feasibility?.maximumTinybar ?? null;
    if (solved !== null && solved !== undefined && BigInt(solved) > 0n) return BigInt(solved);
    const policy = optionsValue.peek()?.limits?.maximumConfiguredHbarTinybar ?? null;
    if (policy !== null && policy !== undefined && BigInt(policy) > 0n) return BigInt(policy);
    return null;
  }

  /** A solve prices one specific draft; with no amount there is nothing to price. */
  function draftAmountEntered() {
    const token = tokenValue.peek();
    if (!token) return false;
    try {
      return parseUnits(String(sourceAmountValue.peek() ?? "").trim(), token.decimals) > 0n;
    } catch {
      return false;
    }
  }

  /**
   * Max asks the SERVER to solve the maximum; nothing is computed client-side.
   * Before that round trip it applies the best bound the server has already
   * published, so the control always moves the amount instead of failing on a
   * draft the solver cannot price yet.
   */
  async function requestMaximumHbar() {
    if (loadingValue.peek() || routeModeValue.peek() === "bridge_only") return;
    errorValue.value = null;
    const published = publishedMaximumTinybar();
    if (published !== null) {
      batch(() => {
        desiredHbarValue.value = formatUnits(published, 8, 8);
        desiredHbarEditedValue.value = true;
        invalidateQuote();
      });
    }
    if (!draftAmountEntered()) return;
    let maximum;
    let details;
    try {
      const desired = (() => {
        try { return normalizeDesiredHbar(desiredHbarValue.peek()).decimal; }
        catch { return "1"; }
      })();
      const request = buildCombinedQuoteRequest({
        ...quoteContext(),
        amount: sourceAmountValue.peek(),
        desiredHbar: desired,
        slippageBps: slippageBps(),
        solveMaximumHbar: true,
      });
      batch(() => {
        loadingValue.value = true;
        setPhase("quoting");
      });
      const quote = await client.request("/v1/product/quote", { method: "POST", body: request });
      maximum = quote.feasibility?.maximumTinybar;
      details = quote.feasibility;
    } catch (error) {
      if (["DESIRED_HBAR_EXCEEDS_MAXIMUM", "DESIRED_HBAR_ROUTE_INFEASIBLE"].includes(error.body?.code) && error.body?.details?.maximumTinybar !== undefined) {
        maximum = error.body.details.maximumTinybar;
        details = error.body.details;
      } else {
        errorValue.value = quoteFailureMessage(error);
      }
    }
    batch(() => {
      loadingValue.value = false;
      setPhase("discovering");
      if (maximum !== undefined && BigInt(maximum) > 0n) {
        desiredHbarValue.value = formatUnits(maximum, 8, 8);
        desiredHbarEditedValue.value = true;
        invalidateQuote();
        quoteLimitValue.value = details;
        errorValue.value = null;
      }
    });
  }

  // --------------------------------------------------------------- recovery
  function resetSelectedJourneyState() {
    recoveryController?.abort();
    recoveryController = null;
    recoveryCancellableValue.value = false;
    stopRecoveryPolling();
    batch(() => {
      journeyIdValue.value = null;
      journeyValue.value = null;
      recoveryValue.value = null;
      recoveryProvisionalValue.value = false;
      recoveryProgressValue.value = null;
      destinationRecoveryQuoteIdValue.value = null;
      quoteConsentGateValue.value = null;
      quoteRefreshValue.value = null;
      quoteValue.value = null;
      quoteStaleValue.value = false;
      quoteLimitValue.value = null;
      bridgeAdoptionHashValue.value = "";
      errorValue.value = null;
      loadingValue.value = false;
      setPhase("idle", { reset: true });
    });
    recoveryAttemptedFor = null;
    recoveryRepollSequence += 1;
    stopQuoteTimer();
  }

  // Applies a server journey read (or resume outcome) as the authoritative
  // decision: it unconditionally replaces local recovery state.
  function applyServerJourney(response) {
    batch(() => {
      journeyValue.value = response.journey ?? journeyValue.peek();
      recoveryValue.value = response.recovery ?? null;
      recoveryProvisionalValue.value = false;
      quoteValue.value = response.quote ?? quoteValue.peek();
      quoteStaleValue.value = Boolean(quoteValue.peek() && quoteValue.peek().expiresAt <= now());
      // A journey read before any destination quote exists has neither a refresh
      // event nor a quote; comparing the two `undefined`s would match and then
      // dereference the absent event.
      const latestDestinationRefresh = [...(journeyValue.peek()?.events ?? [])]
        .reverse()
        .find((event) => event.type === "destination_quote_refreshed");
      const refreshedQuoteId = latestDestinationRefresh?.record?.quoteId ?? null;
      destinationRecoveryQuoteIdValue.value = refreshedQuoteId && refreshedQuoteId === (quoteValue.peek()?.quoteId ?? null)
        ? refreshedQuoteId
        : null;
      routeModeValue.value = recoveryValue.peek()?.routeMode ?? quoteValue.peek()?.routeMode ?? routeModeValue.peek();
      modeValue.value = journeyValue.peek()?.mode ?? quoteValue.peek()?.mode ?? modeValue.peek();
      restoreRecoveredSelection(journeyValue.peek(), quoteValue.peek());

      // Journey GET is a pure read. An expired or absent destination quote
      // remains visible as an explicit action; only the primary button may POST
      // a refresh.
      recoveryProgressValue.value = null;
      if (journeyValue.peek()?.state === "abandoned") {
        // Terminal, but not complete: the surface must never congratulate the
        // owner for a draft they retired.
        setPhase("abandoned", { authoritative: true });
      } else if (response.status === "completed" || recoveryValue.peek()?.disposition === "terminal") {
        setPhase("completed", { authoritative: true });
      } else if (recoveryValue.peek()?.nextAtomicStep === "destination_wallet_consent" && !quoteStaleValue.peek()) {
        // The error is NOT cleared here. This landing used to wipe the message from
        // a wallet leg that had just failed, leaving only the server's next-step
        // decision on screen — which is how a run that died at its first MetaMask
        // prompt came to read as an arrival. Every user action clears it instead.
        setPhase("recovery_quote_ready", { authoritative: true });
      } else {
        setPhase("recovery_required", { authoritative: true });
        // A live failure message outranks a derived one. This used to overwrite the
        // reason a wallet leg actually failed with the presentation's generic
        // sentence, and the card then suppressed the note for matching that
        // sentence — so the app knew exactly why nothing was sent and threw it away
        // on the next poll, about twelve seconds later.
        if (!quoteConsentGateValue.peek() && !errorValue.peek()) {
          errorValue.value = journeyPresentation.peek().reason;
        }
      }
    });
    persistJourneyCheckpoint();
    startQuoteTimer();
    scheduleRecoveryRepoll();
  }

  function stopRecoveryPolling() {
    if (recoveryPollTimer) clearTimeout(recoveryPollTimer);
    recoveryPollTimer = null;
  }

  function recoveryRepollable() {
    if (!journeyIdValue.peek() || runInFlight || loadingValue.peek()) return false;
    // Nothing may re-quote over a comparison the owner is being asked to decide.
    if (quoteConsentGateValue.peek()) return false;
    if (recoveryProvisionalValue.peek()) return true;
    const recovery = recoveryValue.peek();
    if (!recovery) return false;
    if (["terminal", "blocked_unknown_submit_result"].includes(recovery.disposition)) return false;
    if (recovery.nextAtomicStep === "poll_refuel") return true;
    if (recovery.nextAtomicStep === "poll_bridge") return recovery.replaySafe === true;
    if (recovery.nextAtomicStep === "source_wallet_consent") return Number.isFinite(recovery.revalidateAfterMs);
    // Arrival-confirmed waits for an explicit primary-button quote refresh.
    // Reads never mint quotes in the background.
    return false;
  }

  function scheduleRecoveryRepoll() {
    stopRecoveryPolling();
    if (!recoveryRepollable()) return;
    const recovery = recoveryValue.peek();
    const delay = recovery?.nextAtomicStep === "source_wallet_consent" && Number.isFinite(recovery.revalidateAfterMs)
      ? recovery.revalidateAfterMs
      : RECOVERY_REPOLL_MS;
    recoveryPollTimer = setTimeout(() => { void repollRecoveryDecision(); }, delay);
  }

  async function repollRecoveryDecision() {
    recoveryPollTimer = null;
    // One poll at a time: an older server decision must never land over a newer
    // selected journey or user action.
    if (recoveryRepollInFlight) {
      scheduleRecoveryRepoll();
      return;
    }
    if (!recoveryRepollable()) return;
    const journeyId = journeyIdValue.peek();
    const sequence = ++recoveryRepollSequence;
    recoveryRepollInFlight = true;
    try {
      const recovery = recoveryValue.peek();
      if (recovery?.nextAtomicStep === "poll_bridge" && recovery.replaySafe) {
        // Replay-safe provider status read keeps long bridges progressing server-side.
        await orchestrator.request(`/v1/product/journeys/${journeyId}/bridge`);
      }
      const decision = await orchestrator.fetchJourneyDecision(journeyId);
      // A run or user-triggered flow that started mid-poll owns the UI; its own
      // completion reschedules the loop.
      if (sequence !== recoveryRepollSequence) return;
      if (journeyIdValue.peek() !== journeyId || runInFlight || loadingValue.peek()) return;
      if (decision.journey?.account && decision.journey.account.toLowerCase() !== walletValue.peek().account?.toLowerCase()) return;
      applyServerJourney(decision);
    } catch {
      if (journeyIdValue.peek() === journeyId) scheduleRecoveryRepoll();
    } finally {
      recoveryRepollInFlight = false;
    }
  }

  /**
   * Decide what a journey the owner did not ask for is allowed to do to the
   * screen. A stored pointer is not consent: it is left behind by any earlier
   * visit, so adopting it on sight is what put an old journey in front of a fresh
   * compose surface.
   *
   * A bridge with funds in the air still resumes by itself so the owner sees its
   * progress immediately. The server sweeper now materializes arrival without an
   * open browser, but this replay-safe read remains useful for prompt UI recovery.
   * Everything else becomes a dismissible offer and leaves compose alone.
   */
  async function resumeStoredJourney() {
    const account = walletValue.peek().account;
    if (!account || runInFlight || journeyIdValue.peek()) return;
    const reference = persistence.read(account);
    if (!reference.journeyId || recoveryAttemptedFor === reference.journeyId) return;
    // A link the owner opened is an explicit request; a leftover pointer is not.
    if (reference.source === "url") {
      await recoverCurrentJourney(reference.journeyId);
      return;
    }
    let decision;
    try {
      decision = await orchestrator.fetchJourneyDecision(reference.journeyId);
    } catch {
      // An unreadable pointer is not worth a banner. Activity is the way back.
      return;
    }
    if (decision.journey?.account?.toLowerCase() !== account.toLowerCase()) {
      persistence.clear(account);
      return;
    }
    if (journeyIdValue.peek() || runInFlight) return;
    const fundsInMotion = decision.recovery?.nextAtomicStep === "poll_bridge" &&
      decision.recovery?.replaySafe === true;
    if (fundsInMotion) {
      // The decision just read IS the server read, so hand it over rather than
      // asking the same question twice on every load.
      await recoverCurrentJourney(reference.journeyId, { decision });
      return;
    }
    if (decision.recovery?.disposition === "terminal") {
      // Nothing left to do on it, so it has no claim on this visit at all.
      persistence.clear(account);
      return;
    }
    resumeOfferValue.value = {
      journeyId: reference.journeyId,
      state: decision.journey?.state ?? null,
      updatedAt: decision.journey?.updatedAt ?? null,
    };
  }

  function dismissResumeOffer() {
    const offer = resumeOfferValue.peek();
    resumeOfferValue.value = null;
    if (offer) persistence.clear(walletValue.peek().account);
  }

  async function acceptResumeOffer() {
    const offer = resumeOfferValue.peek();
    if (!offer) return;
    resumeOfferValue.value = null;
    await recoverCurrentJourney(offer.journeyId);
  }

  async function recoverCurrentJourney(explicitJourneyId = null, { decision = null } = {}) {
    const account = walletValue.peek().account;
    if (!account || runInFlight) return;
    const reference = explicitJourneyId
      ? { journeyId: explicitJourneyId, source: "explicit" }
      : persistence.read(account);
    if (!reference.journeyId || recoveryAttemptedFor === reference.journeyId) return;
    recoveryAttemptedFor = reference.journeyId;
    batch(() => {
      resumeOfferValue.value = null;
      journeyIdValue.value = reference.journeyId;
      quoteValue.value = null;
      quoteStaleValue.value = false;
      journeyValue.value = null;
      recoveryValue.value = null;
      recoveryProvisionalValue.value = true;
      destinationRecoveryQuoteIdValue.value = null;
      recoveryProgressValue.value = null;
      loadingValue.value = true;
      errorValue.value = null;
    });
    recoveryController?.abort();
    recoveryController = new AbortController();
    recoveryCancellableValue.value = true;
    try {
      const recovered = decision ?? await orchestrator.fetchJourneyDecision(reference.journeyId, {
        signal: recoveryController.signal,
      });
      if (recovered.journey?.account?.toLowerCase() !== account.toLowerCase()) {
        throw new Error("connected account does not own this journey");
      }
      if (recovered.journey?.mode && recovered.journey.mode !== modeValue.peek()) {
        modeValue.value = recovered.journey.mode;
        await loadOptions(modeValue.peek());
        journeyIdValue.value = reference.journeyId;
      }
      loadingValue.value = false;
      applyServerJourney(recovered);
    } catch (error) {
      const cancelled = recoveryController?.signal.aborted === true;
      batch(() => {
        loadingValue.value = false;
        recoveryProvisionalValue.value = true;
        setPhase("recovery_required", { authoritative: true });
        errorValue.value = cancelled
          ? "Journey read cancelled."
          : `${error.message} The server record remains unchanged; start a new transfer or retry Activity.`;
      });
    } finally {
      recoveryController = null;
      recoveryCancellableValue.value = false;
    }
  }

  async function refreshRecoveryDestinationQuote() {
    if (recoveryValue.peek()?.nextAtomicStep !== "destination_wallet_consent" || !journeyIdValue.peek()) return;
    const journeyId = journeyIdValue.peek();
    batch(() => {
      errorValue.value = null;
      loadingValue.value = true;
      setPhase("quoting");
    });
    try {
      const quote = await orchestrator.refreshDestinationQuote({ journeyId });
      loadingValue.value = false;
      // The journey can be abandoned mid-flight (account switch reset the phase
      // out of the graph); its landing edges no longer exist.
      if (journeyIdValue.peek() !== journeyId) return;
      batch(() => {
        quoteValue.value = quote;
        quoteStaleValue.value = false;
        destinationRecoveryQuoteIdValue.value = quote.quoteId;
        setPhase("recovery_quote_ready");
      });
      persistJourneyCheckpoint();
      startQuoteTimer();
    } catch (error) {
      loadingValue.value = false;
      if (journeyIdValue.peek() !== journeyId) return;
      setPhase("recovery_required");
      if (!raiseTermsGate(error)) errorValue.value = error.message;
      persistJourneyCheckpoint();
    }
    scheduleRecoveryRepoll();
  }

  // ------------------------------------------------------------- execution
  async function executeJourney() {
    if (runInFlight) return;
    // Accepting the displayed comparison is itself the consent for this leg: it
    // resumes the surviving journey and never re-quotes the origin side.
    const acceptedNewTerms = Boolean(quoteConsentGateValue.peek() && journeyIdValue.peek());
    const recovery = recoveryValue.peek();
    const sourceResend = recovery?.nextAtomicStep === "source_wallet_consent";
    // Held across the re-bind and the leg that follows: one owner decision, one prompt.
    let sourceLegConfirmation = null;
    if (!acceptedNewTerms) {
      // Every refusal below states itself. These used to be bare returns, so a
      // press that could not proceed changed nothing at all on screen — no error,
      // no phase, no spinner, and no wallet prompt. A button that does nothing and
      // says nothing is indistinguishable from a broken app.
      if (recovery?.disposition === "blocked_unknown_submit_result") {
        errorValue.value = "Nothing was sent. An earlier submission has an unknown outcome, so no further step will run until that is resolved — nothing extra was spent.";
        return;
      }
      if (sourceResend && recovery.sameJourneyResendAllowed !== true) {
        errorValue.value = "Nothing was sent. This journey has source-side evidence that forbids a resend; start a separate transfer or inspect the recorded evidence.";
        return;
      }
      if (!sourceResend) {
        // Re-pricing is checked BEFORE the execute capability. A quote that is not
        // executable but has aged out is offered as "Refresh quote", and testing
        // capability first turned that press into a permanent dead click.
        const driftedQuote = !recovery && !quoteStillValid(quoteValue.peek(), quoteContext());
        const stale = Boolean(quoteValue.peek()) &&
          (quoteStaleValue.peek() || driftedQuote || quoteValue.peek().expiresAt <= now());
        if (stale) {
          if (recovery?.nextAtomicStep === "destination_wallet_consent") await refreshRecoveryDestinationQuote();
          else await requestQuote();
          // Say what the press bought. It re-prices instead of sending, and the label
          // does not always change, so silence here reads as a click that did nothing.
          if (!errorValue.peek()) {
            errorValue.value = "Nothing was sent yet: these numbers were no longer current, so they have been re-priced. Review them and press again to send.";
          }
          return;
        }
        if (!quoteValue.peek()?.capabilities?.execute) {
          errorValue.value = quoteValue.peek()
            ? "Nothing was sent: the server has not cleared this route for execution. The route disclosure names what is blocking it."
            : "Nothing was sent: there is no live quote yet. Request one first.";
          return;
        }
        if (recovery && recovery.nextAtomicStep !== "destination_wallet_consent") {
          errorValue.value = `Nothing was sent. This journey's next step is decided by the server, and it is not a send: ${recovery.reason ?? "open Details for what it recorded."}`;
          return;
        }
        // Checked here, before a journey exists. The orchestrator used to discover a
        // missing provider transaction only after creating the journey and paying for
        // the Hedera activation, which burned both and left the journey permanently
        // unsendable with no prompt ever raised.
        if (!recovery && !quoteValue.peek()?.bridge?.transaction) {
          errorValue.value = "Nothing was sent: the bridge provider returned no executable transaction for this route. Refresh the quote, or choose a different asset.";
          return;
        }
      }
    }
    batch(() => {
      quoteConsentGateValue.value = null;
      errorValue.value = null;
      loadingValue.value = true;
    });
    runInFlight = true;
    stopRecoveryPolling();
    try {
      if (sourceResend) {
        const journeyId = journeyIdValue.peek();
        const network = networkValue.peek();
        // Guarded, not optional-chained past. The comparison below used `?.` while
        // the switch dereferenced `network.chainId` outright, so a resend attempted
        // before the catalog resolved an origin network threw a raw TypeError at
        // the owner instead of saying anything they could act on.
        if (!network?.chainId) {
          throw new Error("Nothing was sent: the origin network for this transfer is not loaded yet. Try again in a moment.");
        }
        // ONE origin chain, taken from the server journey record, used for the
        // switch, the quote and the consent domain alike. The consent used to be
        // signed with the journey's chain while the wallet had been switched to
        // the SELECTED network, and those can differ — a restored selection falls
        // back to the previous network when the catalog no longer lists the
        // journey's chain. MetaMask refuses eth_signTypedData_v4 whose domain
        // chain is not active, so the mismatch produced no prompt at all: the same
        // class of silent pre-prompt failure this whole feature exists to remove.
        const consentChainId = Number(journeyValue.peek()?.originChainId);
        if (!Number.isSafeInteger(consentChainId) || consentChainId <= 0) {
          throw new Error("Nothing was sent: this journey's origin network has not been read from the server yet. Try again in a moment.");
        }
        if (consentChainId !== Number(network.chainId)) {
          throw new Error("Nothing was sent: this journey's origin network is not the one selected here. Reopen it from Activity and try again.");
        }
        if (Number(walletValue.peek().chainId) !== consentChainId) {
          await wallet.switchChain(consentChainId);
          await refreshBalance();
        }
        setPhase("quoting");
        const request = buildCombinedQuoteRequest({
          ...quoteContext(),
          amount: sourceAmountValue.peek(),
          desiredHbar: desiredHbarValue.peek(),
          slippageBps: slippageBps(),
        });
        const quote = await client.request("/v1/product/quote", { method: "POST", body: request });
        wallet.assertSameAddress(...[
          quote.sameAddress.bridgeFrom,
          quote.sameAddress.bridgeTo,
          quote.sameAddress.hederaDestination,
          quote.sameAddress.x402Payer,
          quote.sameAddress.hbarRecipient,
        ].filter(Boolean));
        if (!quote.capabilities?.execute || !quote.bridge?.transaction) {
          throw new Error("Nothing was sent: the live replacement quote has no executable bridge transaction.");
        }
        // Owner consent for this one replacement quote. A journey id is not a
        // secret, and re-binding retires the unbroadcast activation authorization,
        // so the server will not do it on an id alone. It is a signature, not a
        // transaction: nothing is sent and nothing is spent.
        //
        // The domain is the origin chain because the resend has to put the wallet
        // there anyway for the bridge send, so the consent reuses that switch
        // instead of a round trip to Hedera and back. Re-asserted here rather than
        // assumed: the quote request above is a network call, and the wallet can be
        // moved by the owner or another tab while it is in flight — the same reason
        // the abandon and adopt paths switch on the line before they sign.
        if (Number(walletValue.peek().chainId) !== consentChainId) {
          await wallet.switchChain(consentChainId);
        }
        sourceLegConfirmation = await wallet.signJourneySourceLeg({
          journeyId,
          quoteId: quote.quoteId,
          mode: modeValue.peek(),
          originChainId: consentChainId,
        }, walletValue.peek().account).catch((error) => {
          // A declined signature is a purely local refusal with no server effect.
          // Tagged so the failure handler leaves the journey offered instead of
          // marking the server decision provisional and greying the button for the
          // revalidate window — which would claim the app is waiting on the server
          // when it is waiting on the owner.
          error.walletDeclined = /rejected|declined|denied|cancel/i.test(String(error?.message ?? ""));
          throw error;
        });
        const rebound = await orchestrator.refreshSourceQuote({
          journeyId,
          quoteId: quote.quoteId,
          confirmation: sourceLegConfirmation,
        });
        batch(() => {
          journeyValue.value = rebound.journey;
          quoteValue.value = quote;
          quoteStaleValue.value = false;
          quoteLimitValue.value = quote.feasibility;
        });
      }
      if (acceptedNewTerms) {
        // The click consented to re-quoting at the live price, so mint that quote
        // first and continue on it. The server still refuses anything worse than
        // the originally consented terms, so acceptance can only end equal or better.
        const quote = await orchestrator.refreshDestinationQuote({ journeyId: journeyIdValue.peek() });
        batch(() => {
          quoteValue.value = quote;
          quoteStaleValue.value = false;
          destinationRecoveryQuoteIdValue.value = quote.quoteId;
        });
      } else if (recovery?.nextAtomicStep === "destination_wallet_consent") {
        if (!destinationQuoteState.peek().canApprove) throw new Error("refresh the exact destination quote before consent");
      }
      const continuing = acceptedNewTerms || recovery?.nextAtomicStep === "destination_wallet_consent";
      const outcome = continuing
        ? await orchestrator.continueRefuel({
            journeyId: journeyIdValue.peek(),
            quote: quoteValue.peek(),
            mode: modeValue.peek(),
            account: walletValue.peek().account,
          })
        : await orchestrator.run({
            quote: quoteValue.peek(),
            mode: modeValue.peek(),
            account: walletValue.peek().account,
            journeyId: sourceResend ? journeyIdValue.peek() : null,
            // The resend already took the owner's consent to re-bind this quote,
            // and it covers the leg that follows — so the whole resend stays one
            // prompt instead of asking again for the same decision.
            confirmation: sourceResend ? sourceLegConfirmation : null,
          });

      batch(() => {
        journeyIdValue.value = outcome.journeyId;
        quoteValue.value = outcome.quote;
        quoteStaleValue.value = false;
        loadingValue.value = false;
        if (outcome.status === "action_required") {
          recoveryValue.value = outcome.recovery;
          journeyValue.value = outcome.result?.journey ?? journeyValue.peek();
          destinationRecoveryQuoteIdValue.value = outcome.quote.quoteId;
          setPhase("recovery_quote_ready", { authoritative: true });
        } else {
          setPhase("completed", { authoritative: true });
          recoveryValue.value = {
            schema: "refuel402.product-recovery.v1",
            journeyId: outcome.journeyId,
            routeMode: routeModeValue.peek(),
            state: "completed",
            disposition: "terminal",
            status: "terminal",
            nextAtomicStep: "none",
            replaySafe: true,
            walletActionRequired: false,
            autoSignAllowed: false,
            autoSubmitAllowed: false,
            sameJourneyResendAllowed: false,
            reason: "Journey completed and its immutable server record remains available in Activity.",
          };
        }
      });
      persistJourneyCheckpoint();
      startQuoteTimer();
    } catch (error) {
      let failureDecision = null;
      if (journeyIdValue.peek() && !error?.walletDeclined) {
        // Read the durable event chain before choosing copy. This is a pure GET:
        // it neither advances nor retries the journey, and failure falls back to
        // the original error while the normal bounded recovery re-poll remains.
        failureDecision = await orchestrator.fetchJourneyDecision(journeyIdValue.peek()).catch(() => null);
      }
      const failureMessage = orchestrationFailureMessage(error, failureDecision);
      batch(() => {
        loadingValue.value = false;
        quoteRefreshValue.value = null;
        // A declined wallet consent is the one failure the server never heard
        // about: nothing was signed, nothing was sent, and the decision on screen
        // is still the one the server gave us. Re-reading it would grey the button
        // for the revalidate window and tell the owner we are waiting on the
        // server, when we are waiting on them. Everything else is provisional:
        // onPhase cleared the last server-confirmed decision on the way in, and
        // marking it provisional keeps the checkpoint from persisting recovery:null
        // over it and makes the server, not this failure, decide the next safe step.
        if (journeyIdValue.peek() && !error?.walletDeclined) recoveryProvisionalValue.value = true;
        if (raiseTermsGate(error)) {
          setPhase("recovery_required", { authoritative: true });
        } else if (error?.walletDeclined) {
          errorValue.value = "Nothing was sent: you declined the consent signature for this replacement quote. Press again when you are ready — nothing was signed and nothing was spent.";
          setPhase("recovery_required", { authoritative: true });
        } else {
          errorValue.value = failureMessage;
          setPhase("failed");
        }
      });
      persistJourneyCheckpoint();
    } finally {
      runInFlight = false;
    }
    scheduleRecoveryRepoll();
  }

  async function reconcileSubmissions() {
    if (!journeyIdValue.peek() || loadingValue.peek() || runInFlight) return;
    batch(() => {
      errorValue.value = null;
      loadingValue.value = true;
    });
    try {
      const outcome = await client.reconcileSubmissions(journeyIdValue.peek());
      loadingValue.value = false;
      applyServerJourney(outcome);
    } catch (error) {
      batch(() => {
        loadingValue.value = false;
        errorValue.value = error.message;
      });
      scheduleRecoveryRepoll();
    }
  }

  async function adoptBridge(sourceTransactionHash = bridgeAdoptionHashValue.peek()) {
    if (!journeyIdValue.peek() || loadingValue.peek() || runInFlight || !bridgeAdoptionOffered(recoveryValue.peek())) return;
    // Only the hash the owner typed is ever bound: never auto-filled, never
    // guessed, and never submitted without this explicit click.
    const hash = String(sourceTransactionHash ?? "").trim();
    if (!ORIGIN_TRANSACTION_HASH.test(hash)) {
      errorValue.value = "Enter the origin bridge transaction hash as 0x followed by 64 hexadecimal characters.";
      return;
    }
    batch(() => {
      errorValue.value = null;
      loadingValue.value = true;
    });
    stopRecoveryPolling();
    try {
      // MetaMask refuses eth_signTypedData_v4 whose domain chain is not active.
      await wallet.switchToHedera(modeValue.peek(), apiBase || location?.origin || "");
      const confirmation = await wallet.signBridgeAdoption({
        journeyId: journeyIdValue.peek(),
        sourceTransactionHash: hash,
        mode: modeValue.peek(),
      }, walletValue.peek().account);
      const adopted = await client.adoptBridge(journeyIdValue.peek(), { sourceTransactionHash: hash, confirmation });
      loadingValue.value = false;
      // The adoption response is a journey mutation; the authoritative next step
      // comes from the recovery decision.
      applyServerJourney(adopted.recovery ? adopted : await orchestrator.fetchJourneyDecision(journeyIdValue.peek()));
      bridgeAdoptionHashValue.value = "";
    } catch (error) {
      batch(() => {
        loadingValue.value = false;
        errorValue.value = error.message;
      });
      persistJourneyCheckpoint();
      scheduleRecoveryRepoll();
    }
  }

  /**
   * Retire a draft from the drawer. The server decides eligibility — this only
   * offers the control on rows it already marked `abandonable` — and the record
   * is never deleted, only hidden from the default list.
   *
   * A journey the owner is currently looking at is dropped from the local
   * selection afterwards, so the surface cannot keep showing a retired draft as
   * if it were live.
   */
  async function abandonJourney(journeyId) {
    const account = walletValue.peek().account;
    const row = activityItemsValue.peek().find((item) => item.journeyId === journeyId);
    if (!account || !journeyId || runInFlight || activityAbandoningValue.peek()) return null;
    if (row && row.abandonable !== true) return null;
    batch(() => {
      activityAbandoningValue.value = journeyId;
      activityErrorValue.value = null;
    });
    try {
      // MetaMask refuses eth_signTypedData_v4 whose domain chain is not active.
      await wallet.switchToHedera(modeValue.peek(), apiBase || location?.origin || "");
      const confirmation = await wallet.signJourneyAbandon({
        journeyId,
        mode: modeValue.peek(),
      }, account);
      const result = await client.abandonJourney(journeyId, { confirmation });
      if (journeyIdValue.peek() === journeyId) {
        persistence.clear(account);
        resetSelectedJourneyState();
      }
      activityItemsValue.value = activityItemsValue.peek().filter((item) => item.journeyId !== journeyId);
      return result;
    } catch (error) {
      activityErrorValue.value = error.message;
      return null;
    } finally {
      activityAbandoningValue.value = null;
    }
  }

  async function startNewTransfer() {
    const account = walletValue.peek().account;
    if (!account) return;
    if (loadingValue.peek()) {
      // Another silent no-op click. The button stays enabled while a read is in
      // flight, so pressing it looked like nothing happened.
      errorValue.value = "Still reading this journey from the server — try again in a moment.";
      return;
    }
    resumeOfferValue.value = null;
    // Detaching is local presentation only. The server journey, hashes and
    // append-only events are neither deleted nor replayed.
    persistence.clear(account);
    resetSelectedJourneyState();
    batch(() => {
      modeValue.value = "mainnet";
      routeModeValue.value = "bridge_plus_refuel";
    });
    resetEditableDraft();
    await loadOptions(modeValue.peek());
  }

  // --------------------------------------------------------------- activity
  async function loadActivity({ append = false } = {}) {
    const account = walletValue.peek().account;
    if (!account) return;
    activityController?.abort();
    const controller = new AbortController();
    activityController = controller;
    batch(() => {
      activityLoadingValue.value = true;
      activityErrorValue.value = null;
    });
    try {
      const cursor = append ? activityNextBeforeValue.peek() : null;
      const before = cursor
        ? `&before=${encodeURIComponent(cursor.updatedAt)}&beforeJourneyId=${encodeURIComponent(cursor.journeyId)}&beforeActive=${encodeURIComponent(cursor.active)}`
        : "";
      const page = await client.request(
        `/v1/product/journeys?account=${encodeURIComponent(account)}&limit=${ACTIVITY_PAGE_SIZE}${before}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || walletValue.peek().account !== account) return;
      batch(() => {
        activityItemsValue.value = append
          ? [...activityItemsValue.peek(), ...page.items.filter((row) => !activityItemsValue.peek().some((existing) => existing.journeyId === row.journeyId))]
          : page.items;
        activityNextBeforeValue.value = page.nextBefore ?? null;
      });
    } catch (error) {
      if (!controller.signal.aborted && walletValue.peek().account === account) activityErrorValue.value = error.message;
    } finally {
      if (activityController === controller) activityController = null;
      if (walletValue.peek().account === account) activityLoadingValue.value = false;
    }
  }

  async function openActivity() {
    if (activityOpenValue.peek() && activityLoadingValue.peek()) return;
    activityOpenValue.value = true;
    if (walletValue.peek().account) await loadActivity();
  }

  function closeActivity() {
    activityOpenValue.value = false;
  }

  async function selectActivityJourney(journeyId) {
    const account = walletValue.peek().account;
    if (!account || loadingValue.peek() || runInFlight) return;
    activityController?.abort();
    closeActivity();
    resetSelectedJourneyState();
    persistence.persist({
      journeyId,
      account,
      mode: modeValue.peek(),
      routeMode: routeModeValue.peek(),
    });
    await recoverCurrentJourney(journeyId);
  }

  // ----------------------------------------------------------------- wallet
  async function connectWallet() {
    if (walletConnectPromise) return walletConnectPromise;
    errorValue.value = null;
    walletConnectPromise = wallet.connect();
    try {
      return await walletConnectPromise;
    } catch (error) {
      errorValue.value = error.message;
      return null;
    } finally {
      walletConnectPromise = null;
    }
  }

  /**
   * End the session locally and, where the wallet supports it, revoke this
   * site's access so the disconnect survives a reload. Every account-scoped
   * thing goes with it — the stored journey pointer included, or reconnecting
   * would silently re-adopt the journey the owner just walked away from.
   *
   * It refuses mid-run: a journey that has begun signing keeps running on the
   * server, so tearing down the UI underneath it would only hide it.
   */
  async function disconnectWallet() {
    if (runInFlight || walletConnectPromise) return null;
    const account = walletValue.peek().account;
    activityController?.abort();
    activityController = null;
    batch(() => {
      activityItemsValue.value = [];
      activityNextBeforeValue.value = null;
      activityLoadingValue.value = false;
      activityErrorValue.value = null;
      activityOpenValue.value = false;
    });
    persistence.clear(account);
    resetSelectedJourneyState();
    resetEditableDraft();
    resetTokenBalance();
    orchestrator.forget();
    return wallet.disconnect();
  }

  function onWalletSnapshot(snapshot) {
    const previous = walletValue.peek();
    walletValue.value = snapshot;
    if (previous.account !== snapshot.account || Number(previous.chainId) !== Number(snapshot.chainId)) {
      resetTokenBalance();
    }
    if (Number(previous.chainId) !== Number(snapshot.chainId)) followWalletChain(snapshot.chainId);
    if (previous.account && snapshot.account !== previous.account) {
      activityController?.abort();
      activityController = null;
      batch(() => {
        activityItemsValue.value = [];
        activityNextBeforeValue.value = null;
        activityLoadingValue.value = false;
        activityErrorValue.value = null;
        activityOpenValue.value = false;
      });
      persistence.clearUrl();
      resumeOfferValue.value = null;
      resetSelectedJourneyState();
      // A disconnect is not an account swap, and the swap notice is false there.
      errorValue.value = snapshot.account
        ? "Connected account changed. Activity and journey selection now belong only to the new account."
        : null;
    } else if (!draftLocked.peek() && quoteValue.peek() && !quoteStaleValue.peek() && !quoteStillValid(quoteValue.peek(), quoteContext())) {
      // Wallet drift outside a journey invalidates the displayed consent context.
      invalidateQuote("Wallet state changed; the displayed quote is stale and must be refreshed.");
    }
    void refreshBalance();
    if (snapshot.account) {
      void resumeStoredJourney();
      // Read Activity as soon as there is an account. It used to load only when
      // the drawer was opened, so the Journeys badge was always absent on a fresh
      // visit — leaving a page with a transfer in flight looking completely idle.
      if (snapshot.account !== previous.account) void loadActivity();
    }
  }

  /**
   * This is a one-directional bridge, so the origin chain is whatever chain the
   * connected wallet is already on. Following it is what makes "switch networks
   * to read your balance" a rare, explicit event instead of the default state.
   *
   * It deliberately does nothing when the chain is not an origin network in the
   * current catalog — Hedera 295/296 is exactly that case, and the orchestrator
   * moves the wallet there and back on every leg of a live journey. A locked
   * draft, an in-flight run, and a recovered journey all keep their
   * server-derived origin network: the journey record is always authoritative.
   */
  function followWalletChain(chainId) {
    if (draftLocked.peek() || runInFlight || recoveryValue.peek()) return;
    if (!chainId || !optionsValue.peek() || !providerValue.peek()) return;
    if (Number(networkValue.peek()?.chainId) === Number(chainId)) return;
    const networks = networkOptionsForProvider(
      optionsValue.peek(),
      providerValue.peek().id,
      "",
      routeModeValue.peek(),
    );
    const match = networks.find((network) => Number(network.chainId) === Number(chainId));
    if (!match) return;
    const tokens = tokenOptionsForNetwork(
      optionsValue.peek(),
      match.chainId,
      providerValue.peek().id,
      "",
      routeModeValue.peek(),
    );
    // Keep the asset the owner chose whenever it also bridges from the new
    // chain; switching networks is not a request to change what is being sent.
    const assetId = tokenValue.peek()?.assetId;
    const token = tokens.find((candidate) => !candidate.disabled && candidate.assetId === assetId)
      ?? tokens.find((candidate) => !candidate.disabled)
      ?? null;
    // Nothing here is bridgeable, so following would replace a working selection
    // with an empty one. Leave it, and let the explicit switch control answer.
    if (!token) return;
    selectNetwork(match);
    selectToken(token);
  }

  /**
   * The explicit escape hatch for the remaining case: the wallet is on a chain
   * this asset does not bridge from. One click, one MetaMask prompt, no quote.
   */
  async function switchToOriginNetwork() {
    const network = networkValue.peek();
    if (!network || !walletValue.peek().account) return;
    errorValue.value = null;
    try {
      await wallet.switchChain(Number(network.chainId));
      await refreshBalance();
    } catch (error) {
      errorValue.value = error instanceof Error ? error.message : "wallet network switch failed";
    }
  }

  // ---------------------------------------------------------------- actions
  function selectProvider(provider) {
    if (draftLocked.peek()) return;
    batch(() => {
      providerValue.value = provider;
      networkValue.value = null;
      tokenValue.value = null;
      errorValue.value = null;
      invalidateQuote();
    });
    resetTokenBalance();
  }

  function selectNetwork(network) {
    if (draftLocked.peek()) return;
    batch(() => {
      networkValue.value = network;
      tokenValue.value = null;
      errorValue.value = null;
      invalidateQuote();
    });
    resetTokenBalance();
  }

  function selectToken(token) {
    if (draftLocked.peek()) return;
    batch(() => {
      tokenValue.value = token;
      errorValue.value = null;
      invalidateQuote();
    });
    resetTokenBalance();
    void refreshBalance();
  }

  function setAmount(value) {
    if (draftLocked.peek()) return;
    batch(() => {
      sourceAmountValue.value = String(value ?? "");
      errorValue.value = null;
      invalidateQuote();
    });
  }

  function setMaxAmount() {
    const balance = tokenBalanceValue.peek();
    const token = tokenValue.peek();
    if (draftLocked.peek() || balance === null || !token) return;
    batch(() => {
      sourceAmountValue.value = formatUnits(balance, token.decimals, token.decimals);
      invalidateQuote();
    });
  }

  function setDesiredHbar(value) {
    if (draftLocked.peek()) return;
    batch(() => {
      desiredHbarValue.value = String(value ?? "");
      desiredHbarEditedValue.value = true;
      errorValue.value = null;
      invalidateQuote();
    });
  }

  function setSlippage(value) {
    if (draftLocked.peek()) return;
    batch(() => {
      slippagePercentValue.value = String(value ?? "");
      errorValue.value = null;
      invalidateQuote("Maximum slippage changed; the displayed quote is stale and must be refreshed.");
    });
  }

  function setRefuelProtectionPreset(value) {
    if (draftLocked.peek() || !["flexible", "balanced", "strict", "custom"].includes(value)) return;
    batch(() => {
      refuelProtectionPresetValue.value = value;
      if (value !== "custom") customRefuelCapValue.value = "";
      errorValue.value = null;
      invalidateQuote("Price protection changed; refresh to bind the new maximum.");
    });
  }

  function setCustomRefuelCap(value) {
    if (draftLocked.peek()) return;
    batch(() => {
      refuelProtectionPresetValue.value = "custom";
      customRefuelCapValue.value = String(value ?? "");
      errorValue.value = null;
      invalidateQuote("Custom price protection changed; refresh to bind the new maximum.");
    });
  }

  function setBridgeAdoptionHash(value) {
    bridgeAdoptionHashValue.value = String(value ?? "");
  }

  async function setMode(mode) {
    if (draftLocked.peek() || mode === modeValue.peek()) return;
    modeValue.value = mode;
    invalidateQuote();
    await loadOptions(mode);
  }

  async function setRouteMode(routeMode) {
    if (draftLocked.peek() || routeMode === routeModeValue.peek()) return;
    batch(() => {
      routeModeValue.value = routeMode;
      recoveryValue.value = null;
      desiredHbarEditedValue.value = false;
      desiredHbarValue.value = optionsValue.peek()?.defaults?.desiredHbar ?? "10";
      slippagePercentValue.value = ((optionsValue.peek()?.defaults?.slippageBps ?? 100) / 100).toFixed(2);
      refuelProtectionPresetValue.value = "flexible";
      customRefuelCapValue.value = "";
      invalidateQuote();
    });
    await loadOptions(modeValue.peek());
  }

  async function startJourney() {
    if (recoveryValue.peek()) return;
    await executeJourney();
  }

  async function continueJourney() {
    if (recoveryValue.peek()?.nextAtomicStep !== "destination_wallet_consent") return;
    await executeJourney();
  }

  async function acceptNewTerms() {
    if (!quoteConsentGateValue.peek() || !journeyIdValue.peek()) return;
    await executeJourney();
  }

  /**
   * The one primary-action entry point. Its dispatch order mirrors the intent
   * table exactly: the worsened-terms gate outranks the provisional re-check,
   * and no branch signs or submits without the click that reached it.
   */
  async function submitPrimary() {
    if (primaryActionInFlight) return;
    primaryActionInFlight = true;
    try {
      const intent = primaryIntent.peek();
      if (intent.disabled) return;
      switch (intent.kind) {
        case "connect_wallet": return void await connectWallet();
        case "accept_new_terms": return void await executeJourney();
        case "new_transfer": return void await startNewTransfer();
        case "resend_journey": return void await executeJourney();
        case "adopt_bridge": return void await adoptBridge(bridgeAdoptionHashValue.peek());
        case "reconcile": return void await reconcileSubmissions();
        case "continue_destination": return void await executeJourney();
        case "refresh_destination": return void await refreshRecoveryDestinationQuote();
        case "request_quote": return void await requestQuote();
        case "refresh_quote": return void await executeJourney();
        case "start_journey": return void await executeJourney();
        default: return;
      }
    } finally {
      primaryActionInFlight = false;
    }
  }

  function cancelRecovery() {
    recoveryController?.abort();
  }

  async function init() {
    // Options initialize before wallet recovery. The prior ordering let an eager
    // wallet snapshot start rehydration while loadOptions simultaneously cleared
    // quote/journey state, producing an apparent mid-transaction page refresh.
    await loadOptions(modeValue.peek());
    unsubscribeWallet = wallet.subscribe(onWalletSnapshot);
    await wallet.restore().catch(() => undefined);
    // The restored snapshot carries the chain, but onWalletSnapshot follows it
    // only on a CHANGE edge, and the chain never changes again. A first load that
    // missed that single edge would otherwise keep a catalog-default origin
    // network for the life of the page. Idempotent: both calls return immediately
    // when the selection already matches the wallet.
    followWalletChain(walletValue.peek().chainId);
    void refreshBalance();
  }

  function dispose() {
    unsubscribeWallet?.();
    unsubscribeWallet = null;
    stopQuoteTimer();
    stopRecoveryPolling();
    recoveryController?.abort();
    activityController?.abort();
    wallet.destroy?.();
  }

  const actions = {
    init,
    dispose,
    endpoint,
    connectWallet,
    disconnectWallet,
    switchToOriginNetwork,
    setMode,
    setRouteMode,
    selectProvider,
    selectNetwork,
    selectToken,
    setAmount,
    setMaxAmount,
    setDesiredHbar,
    setSlippage,
    setRefuelProtectionPreset,
    setCustomRefuelCap,
    setBridgeAdoptionHash,
    requestQuote,
    requestMaximumHbar,
    refreshDestinationQuote: refreshRecoveryDestinationQuote,
    startJourney,
    continueJourney,
    acceptNewTerms,
    submitPrimary,
    reconcileSubmissions,
    adoptBridge,
    abandonJourney,
    startNewTransfer,
    cancelRecovery,
    openActivity,
    closeActivity,
    loadMoreActivity: () => loadActivity({ append: true }),
    selectActivityJourney,
    acceptResumeOffer,
    dismissResumeOffer,
    refreshBalance,
  };

  return { state, actions, orchestrator, wallet, client, persistence };
}

const store = createStore({ apiBase: (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "") });

export const { state, actions } = store;
export default store;
