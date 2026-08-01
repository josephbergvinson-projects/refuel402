import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { JourneyPersistence } from "../web/journey-recovery.js";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { JourneyOrchestrator } from "../web/journey-orchestrator.js";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { ProductApiClient } from "../web/api-client.js";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { MetaMaskController, normalizeWalletError } from "../web/wallet.js";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { deriveJourneyPresentation } from "../web/journey-view-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = (...parts: string[]) => fs.readFileSync(path.join(root, "web", ...parts), "utf8");
const html = web("index.html");
// The shell is a Preact tree now; the source-text contract reads the modules
// that own each guarantee instead of one app.js/styles.css pair.
const app = web("app.jsx");
const store = web("store.js");
const shellModel = web("shell-view-model.js");
const composeCard = web("compose", "ComposeCard.jsx");
const composeModel = web("compose-view-model.js");
const sendBox = web("compose", "SendBox.jsx");
const hbarRow = web("compose", "HbarExactRow.jsx");
const routeStrip = web("compose", "RouteStrip.jsx");
const presetChips = web("compose", "PresetChips.jsx");
const settingsPopover = web("compose", "SettingsPopover.jsx");
const journeyView = web("journey", "JourneyView.jsx");
const journeyChrome = web("journey", "JourneyChrome.jsx");
const journeyTimeline = web("journey", "JourneyTimeline.jsx");
const activityDrawerSource = web("journey", "ActivityDrawer.jsx");
const journeyModel = web("journey-presentation.js");
const modalSource = web("ui", "Modal.jsx");
const meterSource = web("ui", "Meter.jsx");
const baseCss = web("styles", "base.css");
const tokensCss = web("styles", "tokens.css");
const appCss = web("styles", "app.css");
const composeCss = web("compose", "compose.css");
const journeyCss = web("journey", "journey.css");
const css = [tokensCss, baseCss, web("styles", "ui.css"), appCss, composeCss, journeyCss].join("\n");
const surfaceSources = [app, composeCard, sendBox, hbarRow, routeStrip, presetChips, settingsPopover, journeyView, journeyChrome, journeyTimeline, activityDrawerSource];
const everySource = [...surfaceSources, store, composeModel, journeyModel, shellModel];
const recoveryStoreSource = web("journey-recovery.js");
// Derived from the filesystem, not hand-listed. `everySource` omits half the web
// modules, so an invariant asserted only over it ("no source writes the URL") was
// vacuously true and would have proved nothing.
const allWebSources = fs.readdirSync(path.join(root, "web"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(js|jsx)$/.test(entry.name) && !entry.name.includes(".test."))
  .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
const combinedQuote = fs.readFileSync(path.join(root, "server", "src", "combined-quote.ts"), "utf8");
const support = JSON.parse(fs.readFileSync(path.join(root, "config", "support.mainnet.json"), "utf8"));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const journeyId = "c91992cb-dfc3-4ed3-ab76-130beda59398";
const storage = new MemoryStorage();
const location = { href: "https://refuel402.pages.dev/" };
const history = { state: null, replaceState(_state: unknown, _title: string, url: URL) { location.href = url.toString(); } };
const persistence = new JourneyPersistence({ storage, location, history });
persistence.persist({
  journeyId,
  quoteId: "a".repeat(64),
  account,
  mode: "mainnet",
  routeMode: "bridge_plus_refuel",
  phase: "bridge_pending",
  quote: {
    quoteId: "a".repeat(64),
    bridge: { route: "squid-v2", transaction: { to: "0xce16F69375520ab01377ce7B88f5BA8C48F8D666", value: "68419747331071" } },
    outcome: { minimumArrival: "3000000", destinationAssetRemaining: "2313113" },
  },
  sourceTransactionHash: `0x${"5d".repeat(32)}`,
  checkpoint: { providerStatus: "ongoing", pollAttempt: 2, nextPollAt: "2026-07-26T20:00:00.000Z" },
  bridgeAmount: "2",
  desiredHbar: "10",
  maxSlippage: "1.00",
  draft: { bridgeAmount: "2" },
});
const reloaded = new JourneyPersistence({ storage, location, history });
const recovered = reloaded.read(account);
assert(recovered.journeyId === journeyId, "synthetic reload lost the explicit journey pointer");
assert(recovered.quote === undefined && recovered.checkpoint === undefined, "authoritative quote or checkpoint leaked into local pointer storage");
assert(recovered.bridgeAmount === undefined && recovered.desiredHbar === undefined && recovered.maxSlippage === undefined && recovered.draft === undefined, "editable draft inputs leaked into journey pointer storage");
const serializedPointer = [...storage.values.values()].join("\n");
assert(!serializedPointer.includes("68419747331071") && !serializedPointer.includes("sourceTransactionHash"), "rich lifecycle payload leaked into local pointer storage");
// Persisting must never touch the address bar. It used to stamp `?journey=<uuid>`
// on every checkpoint, so opening the site rewrote the URL to advertise an id.
assert(!location.href.includes("journey="), "persisting a pointer wrote a journey id into the URL");
assert(!allWebSources.some((source) => /searchParams\.set/.test(source)), "a web source can still write a URL parameter");
assert(!recoveryStoreSource.includes("setUrl"), "the recovery store can still write a journey id into the URL");
// Web storage stays owned by exactly one module. Anything else reaching for it is
// a second source of persisted state the server does not know about. Matches real
// use, not the word in a comment.
const storageUse = /(globalThis|window)\.(localStorage|sessionStorage)|\b(localStorage|sessionStorage)\.(get|set|remove)Item/;
assert(
  allWebSources.filter((source) => storageUse.test(source)).length === 1,
  "more than one web module now touches web storage",
);
reloaded.clear(account);
assert(reloaded.read(account).journeyId === null, "new-transfer detach retained an active pointer");
assert(!location.href.includes("journey="), "new-transfer detach retained the URL pointer");
storage.setItem(`refuel402:journey:${account.toLowerCase()}`, JSON.stringify({ journeyId, account, quote: { stale: true } }));
assert(reloaded.read(account).journeyId === null, "legacy rich record auto-selected a prior journey");
assert(storage.getItem(`refuel402:journey:${account.toLowerCase()}`) === null, "legacy rich record was not retired");

const calls: Array<{ method: string; params?: unknown[] }> = [];
const ethereum = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    calls.push({ method, params });
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBalance") return "0x64";
    if (method === "eth_call") return "0x1e33";
    throw new Error(`unexpected wallet method ${method}`);
  },
  on: () => undefined,
};
const wallet = new MetaMaskController(ethereum as never);
await wallet.connect();
assert(await wallet.nativeBalance() === 100n, "native ETH balance did not use native semantics");
assert(calls.some((call) => call.method === "eth_getBalance"), "native ETH did not call eth_getBalance");
assert(!calls.some((call) => call.method === "eth_call"), "native ETH balance incorrectly used ERC20 eth_call");
const wbtcToken = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
assert(await wallet.tokenBalance(wbtcToken) === 7_731n, "Ethereum WBTC balance was not detected");
const wbtcBalanceCall = calls.at(-1);
assert(wbtcBalanceCall?.method === "eth_call", "WBTC balance did not use eth_call");
assert((wbtcBalanceCall?.params?.[0] as any)?.to === wbtcToken.toLowerCase(), "WBTC balance used the wrong token contract");
assert((wbtcBalanceCall?.params?.[0] as any)?.from === account.toLowerCase(), "WBTC balance did not bind the connected account");

const recoveryRequests: string[] = [];
const recoveryWallet = { sendTransaction: () => { throw new Error("wallet must not run during pre-source recovery"); } };
const recoveryOrchestrator = new JourneyOrchestrator({
  apiBase: "https://api.example",
  wallet: recoveryWallet,
  fetcher: async (url: string) => {
    recoveryRequests.push(new URL(url).pathname);
    return new Response(JSON.stringify({
      journey: { id: "b3a6711e-9199-4868-aa40-7e04bbf7d863", account, state: "ready", events: [{ type: "journey_created" }] },
      quote: { quoteId: "b".repeat(64), expiresAt: 1, routeMode: "bridge_plus_refuel" },
      recovery: {
        disposition: "action_required",
        nextAtomicStep: "source_wallet_consent",
        replaySafe: false,
        routeMode: "bridge_plus_refuel",
        reason: "No source transaction hash is durable.",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
const wbtc = await recoveryOrchestrator.resume({ journeyId: "b3a6711e-9199-4868-aa40-7e04bbf7d863", account });
assert(wbtc.recovery.nextAtomicStep === "source_wallet_consent", "pre-source WBTC recovery classification changed");
assert(recoveryRequests.length === 1, "pre-source WBTC recovery entered an unnecessary poll loop");

const boundedClient = new ProductApiClient({
  fetcher: async (_url: string, init: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response("{}", { status: 200 });
  },
});
const timeoutStarted = Date.now();
await boundedClient.request("/never", { timeoutMs: 20 }).then(
  () => { throw new Error("bounded request unexpectedly resolved"); },
  (error: any) => assert(/timed out/.test(String(error.message)), "bounded recovery did not report a timeout"),
);
assert(Date.now() - timeoutStarted < 1_000, "bounded recovery exceeded its test window");

const weth = support.assets.find((asset: any) => asset.id === "layerzero:mainnet:weth");
assert(weth.originTokens.length === 1 && weth.originTokens[0].symbol === "ETH" && weth.originTokens[0].native === true, "ETH→WETH selector is not native on Ethereum");
assert(weth.originTokens[0].address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "ETH→WETH source token is not the official native marker");
assert(weth.destination.address.toLowerCase() === "0xca367694cdac8f152e33683bb36cc9d6a73f1ef2", "Hedera destination WETH identity changed");
// ---------------------------------------------------------------------------
// Source-text contract for the rebuilt shell. Each assertion below is the same
// product invariant the pre-rebuild DOM contract held; only the module that
// owns the guarantee has moved.
// ---------------------------------------------------------------------------

// index.html is a mount point: app.js and styles.css are retired, not layered over.
assert(!fs.existsSync(path.join(root, "web", "app.js")) && !fs.existsSync(path.join(root, "web", "styles.css")), "retired legacy shell files still exist");
assert(html.includes('<div id="root"></div>') && html.includes('src="/app.jsx"') && !html.includes("data-card-role"), "index.html is no longer a bare mount point");
assert(!everySource.some((source) => source.includes("styles.css")), "a module still references the retired stylesheet");

// One send, two receives — and the order is the product. The ⑂ beam graphic that
// used to sit between them was decoration that read as a control; the group
// heading and the row count already carry what it said.
assert((composeCard.match(/<SendBox/g) ?? []).length === 1, "compose does not have exactly one source box");
assert((composeCard.match(/<HbarExactRow/g) ?? []).length === 1 && (composeCard.match(/<KeptAssetRow/g) ?? []).length === 1, "compose does not have exactly two output rows");
assert(composeCard.indexOf("<SendBox") < composeCard.indexOf("<ReceiveGroup"), "one-to-two order changed");
assert(!everySource.some((source) => source.includes("SplitNode")) && !css.includes(".compose-split"), "the retired fork graphic came back");
assert(composeCard.includes("{refuel && receive.hbar"), "bridge-only does not recompose to one input and one output");
assert(composeModel.includes('applicable: mode !== "bridge_only"') && composeCard.includes("<FeasibilityMeter"), "bridge-only still prices a refuel it did not request");

// Desired HBAR is a PRIMARY control now, not a field inside advanced settings.
// The old harness asserted `id="advancedSettings"` held desiredHbar and Max;
// that premise is gone, so this asserts the new correct behaviour instead.
assert(!everySource.some((source) => source.includes("advancedSettings")), "the retired advanced-settings disclosure came back");
assert(hbarRow.includes('label="Exact HBAR to receive on Hedera"') && hbarRow.includes("<AmountInput"), "exact HBAR is not a first-class editable control");
assert(composeCard.includes("onInput={(value) => actions.setDesiredHbar(value)}"), "the exact HBAR row is not wired to the draft");
assert(settingsPopover.includes("<legend>Bridge provider</legend>") && settingsPopover.includes("<legend>Maximum slippage</legend>") && !settingsPopover.includes("desiredHbar"), "route settings no longer hold provider and slippage alone");

// Exactly one optional quote disclosure on the compose surface.
const composeSurface = [composeCard, sendBox, hbarRow, routeStrip, presetChips, settingsPopover].join("\n");
assert((composeSurface.match(/<Disclosure/g) ?? []).length === 1 && routeStrip.includes("<Disclosure"), "quote details are split across duplicate disclosures");
assert(composeModel.includes("Sponsored · $0") && composeModel.includes('label: "Max slippage"') && composeModel.includes('id: "fair-value"'), "the route disclosure lost sponsored gas, slippage, or the fair-value check");

// Amounts never clip and carry their full precision.
assert(!/text-overflow:\s*ellipsis/.test(css) && baseCss.includes("overflow-wrap: anywhere"), "amount rendering still clips with visual ellipsis");
assert(composeModel.includes("formatTokenAmount") && composeModel.includes("title: `${amount.full} ${symbol}`"), "amount text lost its full-precision title");

// Responsive contract, reduced motion, and the light theme.
assert(appCss.includes("@media (max-width: 860px)") && appCss.includes("@media (max-width: 720px)") && appCss.includes("@media (max-width: 440px)") && composeCss.includes("@media (max-width: 420px)"), "responsive desktop/laptop/tablet/mobile contract is incomplete");
assert(baseCss.includes("overflow-x: hidden") && baseCss.includes(".scroll-x") && routeStrip.includes("scroll-x"), "wide content is not confined to its own scroll container");
// compose.css declares no animation of its own any more, so base.css's global
// reduction is the whole contract for that surface.
assert(baseCss.includes("@media (prefers-reduced-motion: reduce)") && !composeCss.includes("animation:") && journeyCss.includes("@media (prefers-reduced-motion: reduce)"), "reduced motion is not honoured on every animated surface");
assert(tokensCss.includes("@media (prefers-color-scheme: light)") && tokensCss.includes(':root:not([data-theme="dark"])') && tokensCss.includes(':root[data-theme="light"]'), "light theme is missing its preference or override path");

// Retired grammars are removed, not restyled.
for (const retired of ["amount-panel", "field-grid", "destination-output-stack", "quote-output-stack", "Previous journeys", "journey-history"]) {
  assert(!css.includes(retired) && !everySource.some((source) => source.includes(retired)), `retired grammar ${retired} remains layered into the design`);
}
assert(!everySource.some((source) => source.includes("slippageAccepted") || source.includes('type="checkbox"')), "slippage checkbox lifecycle still exists");

// Max is solved by the SERVER.
const maxHandler = store.slice(store.indexOf("async function requestMaximumHbar()"), store.indexOf("function resetSelectedJourneyState()"));
assert(presetChips.includes("onMax?.()") && composeCard.includes("await actions.requestMaximumHbar()"), "the Max control is not wired to the server solver");
assert(maxHandler.includes("solveMaximumHbar: true") && maxHandler.includes('client.request("/v1/product/quote"') && maxHandler.includes("quote.feasibility?.maximumTinybar"), "server-solved Max HBAR control is missing");
assert(!maxHandler.includes("wallet."), "clicking Max HBAR crosses a wallet boundary");
assert(store.includes("solveMaximumHbar: true") && combinedQuote.includes("deferMaximumFeasibleHbar"), "ordinary quote and explicit Max paths are not separated");
assert(composeModel.includes("const overflow = Boolean(known && desired !== null && desired > maximumTinybar)") && composeModel.includes("Server maximum for this bridge is") && meterSource.includes("overflowNote"), "an infeasible request does not read as a meter overflow with the server constraint");

// A journey is archived locally, never cancelled or replayed.
const detach = store.slice(store.indexOf("async function startNewTransfer()"), store.indexOf("async function loadActivity("));
assert(detach.includes("persistence.clear(account)") && detach.includes("resetSelectedJourneyState()") && !detach.includes("orchestrator.") && !detach.includes("fetch("), "safe new-transfer flow is missing");
assert(journeyChrome.includes("void actions.startNewTransfer()") && journeyChrome.includes("never deleted or replayed"), "the new-transfer action no longer states what it preserves");
assert(!store.includes("newTransferDetachArmed"), "new transfer still uses a blocking double-confirmation path");

// The selected journey is separate from the editable draft.
assert(store.includes("const draftLocked = computed(() => Boolean(journeyIdValue.value))") && composeCard.includes("const locked = state.draftLocked.value"), "selected journey is not separated from the editable draft");
assert(store.includes('snapshot.recovery.nextAtomicStep === "destination_wallet_consent"'), "destination consent is no longer an explicit recovery step");
const persisted = store.slice(store.indexOf("function persistJourneyCheckpoint()"), store.indexOf("// ----------------------------------------------------------- orchestrator"));
assert(!["quote:", "journey:", "recovery:", "desiredHbar", "sourceAmount", "slippage"].some((leak) => persisted.includes(leak)), "editable draft or lifecycle data leaked into the local checkpoint");

// Activity stays secondary, server-bounded, account-scoped, and keyboard-safe.
assert(app.includes("<ActivityDrawer />") && app.includes('aria-haspopup="dialog"'), "secondary Activity drawer is missing");
const loadActivity = store.slice(store.indexOf("async function loadActivity("), store.indexOf("async function openActivity()"));
assert(loadActivity.includes("/v1/product/journeys?account=") && loadActivity.includes("limit=${ACTIVITY_PAGE_SIZE}") && loadActivity.includes("activityController?.abort()"), "account-scoped abortable Activity flow is incomplete");
assert(store.includes("const ACTIVITY_PAGE_SIZE = 8"), "the Activity page is no longer server-bounded");
assert(modalSource.includes('role="dialog"') && modalSource.includes('aria-modal="true"') && modalSource.includes('if (event.key !== "Tab") return') && modalSource.includes("openerRef.current?.focus?.()"), "Activity keyboard/focus/ARIA contract is incomplete");
// Rows are named by what they are — asset and time — rather than by a truncated
// journey uuid, which named the record instead of the transfer.
assert(activityDrawerSource.includes("aria-label={`${activityActionLabel(row.action)} ${name}`}"), "Activity rows lost their programmatic action names");
assert(!activityDrawerSource.includes("facts.reference"), "an internal journey id came back to the Activity rows");
assert(store.includes("persistence.clearUrl()") && store.includes("resetSelectedJourneyState()"), "account changes do not detach selected journey UI");
assert(!store.includes("persistence.setUrl"), "the store can still write a journey id into the URL");
assert(!store.includes("persistence.historyFor"), "local history still competes with server Activity authority");

// A stored pointer is not consent. Only a journey the server says has funds in
// motion may take the compose surface on its own; everything else is offered.
const resume = store.slice(store.indexOf("async function resumeStoredJourney()"), store.indexOf("function dismissResumeOffer()"));
assert(resume.includes('decision.recovery?.nextAtomicStep === "poll_bridge"') && resume.includes("decision.recovery?.replaySafe === true"), "auto-resume is no longer restricted to a bridge with funds in flight");
assert(resume.includes("resumeOfferValue.value = {"), "a non-urgent stored journey no longer waits as a dismissible offer");
assert(app.includes("<ResumeOffer />") && app.includes("<ComposeCard />"), "the resume offer no longer sits above an untouched compose card");

// Journey reads never mutate; the phase has exactly one writer; nothing navigates.
const applyServerJourneySource = store.slice(store.indexOf("function applyServerJourney(response)"), store.indexOf("function stopRecoveryPolling()"));
assert(!applyServerJourneySource.includes("refreshDestinationQuote"), "journey reads still auto-mutate destination quotes");
assert((store.match(/phaseValue\.value\s*=(?!=)/g) ?? []).length === 1, "the journey phase is written from more than one site");
assert(store.includes("phaseValue.value = options?.reset ? next : transitionJourney(phaseValue.peek(), next, options)"), "phase writes bypass the enforced transition map");
assert(!surfaceSources.some((source) => source.includes("setPhase")), "a surface writes the journey phase directly");
assert(!everySource.some((source) => /location\.(reload|assign|replace)/.test(source)), "application contains destructive navigation/reload");
assert(store.indexOf("await loadOptions(modeValue.peek())") < store.indexOf("wallet.subscribe"), "wallet recovery can race option initialization");

// The shell announces and focuses a view change without stealing the first paint.
assert(app.includes("surfaceFocusKey({") && app.includes("stageRef.current?.focus?.({ preventScroll: true })") && app.includes("if (firstRender.current)"), "view changes do not move focus to the stage");
assert(app.includes('role="status" aria-live="polite"') && shellModel.includes("export function shellStatus({"), "async status is not announced from one live region");
assert((app.match(/<h1 /g) ?? []).length === 1 && (app.match(/<main /g) ?? []).length === 1, "the shell lost its single h1 or main landmark");

const arrivalPresentation = deriveJourneyPresentation({
  journey: { state: "arrival_confirmed", payment: null, authorizations: [], submissions: [], events: [{ type: "destination_activation_funded" }, { type: "bridge_submitted" }, { type: "bridge_arrived" }] },
  recovery: { disposition: "action_required", status: "action_required", nextAtomicStep: "destination_wallet_consent", reason: "Arrival is durable" },
  quoteLive: false,
});
assert(arrivalPresentation.progress.slice(0, 3).every((row: any) => row.status === "done"), "authoritative bridge/arrival progress regressed to pending");
assert(arrivalPresentation.progress[3].status === "pending", "payment approval became current before an explicit destination quote exists");
assert(arrivalPresentation.action.kind === "refresh_destination", "arrival-confirmed action is not an explicit destination quote refresh");
const malformed = normalizeWalletError({ message: { startsWith: false }, code: 4900 });
assert(malformed.message === "wallet error 4900", "malformed provider error was not typed before string handling");

const proof = {
  schema: "refuel402.browser-faithful-ui-harness.v1",
  generatedAt: new Date().toISOString(),
  passed: true,
  checks: {
    noNavigationOrReload: true,
    minimalPointerAcrossSyntheticReload: true,
    authoritativeLifecycleNotPersisted: true,
    cleanDetachPreservesServerAuthority: true,
    legacyHistoryDoesNotAutoActivate: true,
    noJourneyIdWrittenToTheUrl: true,
    webStorageOwnedByOneModule: true,
    autoResumeLimitedToFundsInFlight: true,
    serverSolvedMaxHbarControl: true,
    infeasibleRequestReadsAsMeterOverflow: true,
    slippageCheckboxAbsent: true,
    nativeEthToHederaWethSemantics: true,
    ethereumWbtcBalanceRead: true,
    boundedWbtcRecovery: true,
    oneInputTwoOutputSymmetry: true,
    bridgeOnlyOneInputOneOutput: true,
    exactHbarIsAPrimaryControl: true,
    singleOptionalQuoteDisclosure: true,
    amountFormattingWithoutEllipsis: true,
    serverBoundedActivityDrawer: true,
    accountScopedActivityCancellation: true,
    authoritativeRecoveryProgress: true,
    typedMalformedProviderError: true,
    responsiveBreakpoints: true,
    reducedMotionHonoured: true,
    lightThemeAndExplicitOverride: true,
    retiredNestedGrammarRemoved: true,
    legacyShellRetired: true,
    singlePhaseWriteSite: true,
    viewChangeFocusAndLiveStatus: true,
  },
};
const output = path.join(root, "proofs", "local", "browser-ui-harness.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ ...proof, output }, null, 2));
