import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the product shell.
 *
 * The shell is now a Preact tree (app.jsx → compose/ + journey/, on the ui/
 * primitives) instead of one hand-written index.html plus app.js. Every pin in
 * this file is the same product invariant the previous DOM-string contract
 * held; only the place the guarantee lives has moved. The seven logic modules
 * are untouched and are still pinned here directly.
 */

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

const html = read("index.html");
const app = read("app.jsx");
const store = read("store.js");
const shellModel = read("shell-view-model.js");

const composeCard = read("compose", "ComposeCard.jsx");
const sendBox = read("compose", "SendBox.jsx");
const hbarRow = read("compose", "HbarExactRow.jsx");
const keptRow = read("compose", "KeptAssetRow.jsx");
const receiveGroup = read("compose", "ReceiveGroup.jsx");
const presetChips = read("compose", "PresetChips.jsx");
const feasibilityMeter = read("compose", "FeasibilityMeter.jsx");
const routeStrip = read("compose", "RouteStrip.jsx");
const assetPicker = read("compose", "AssetPicker.jsx");
const settingsPopover = read("compose", "SettingsPopover.jsx");
const composeModel = read("compose-view-model.js");

const journeyView = read("journey", "JourneyView.jsx");
const journeyChrome = read("journey", "JourneyChrome.jsx");
const journeyTimeline = read("journey", "JourneyTimeline.jsx");
const arrivalConsent = read("journey", "ArrivalConsent.jsx");
const recoveryCard = read("journey", "RecoveryCard.jsx");
const adoptCard = read("journey", "AdoptCard.jsx");
const termsCard = read("journey", "TermsChangedCard.jsx");
const activityDrawer = read("journey", "ActivityDrawer.jsx");
const walletDialog = read("WalletDialog.jsx");
const journeyModel = read("journey-presentation.js");

const orchestratorSource = read("journey-orchestrator.js");
const clientSource = read("api-client.js");
const walletSource = read("wallet.js");
const viewModelSource = read("journey-view-model.js");
const productModelSource = read("product-model.js");
const recoveryStoreSource = read("journey-recovery.js");

const tokensCss = read("styles", "tokens.css");
const baseCss = read("styles", "base.css");
const uiCss = read("styles", "ui.css");
const appCss = read("styles", "app.css");
const composeCss = read("compose", "compose.css");
const journeyCss = read("journey", "journey.css");
const css = [tokensCss, baseCss, uiCss, appCss, composeCss, journeyCss].join("\n");

const uiPrimitives = {
  Card: read("ui", "Card.jsx"),
  Button: read("ui", "Button.jsx"),
  Segmented: read("ui", "Segmented.jsx"),
  TokenPill: read("ui", "TokenPill.jsx"),
  AmountInput: read("ui", "AmountInput.jsx"),
  Chip: read("ui", "Chip.jsx"),
  Meter: read("ui", "Meter.jsx"),
  Disclosure: read("ui", "Disclosure.jsx"),
  Modal: read("ui", "Modal.jsx"),
  Timeline: read("ui", "Timeline.jsx"),
  StatePill: read("ui", "StatePill.jsx"),
  Ring: read("ui", "Ring.jsx"),
  Skeleton: read("ui", "Skeleton.jsx"),
  iconCache: read("ui", "icon-cache.js"),
  dom: read("ui", "dom.js"),
};

const surfaces = [composeCard, sendBox, hbarRow, keptRow, receiveGroup, presetChips, feasibilityMeter, routeStrip, assetPicker, settingsPopover, journeyView, journeyChrome, journeyTimeline, arrivalConsent, recoveryCard, adoptCard, termsCard, activityDrawer, app];
const everySource = [...surfaces, store, composeModel, journeyModel, shellModel, ...Object.values(uiPrimitives)];

const mainnetCatalog = JSON.parse(read("..", "config", "support.mainnet.json"));
const section = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("legacy view is retired, not layered over", () => {
  it("deletes the pre-rebuild shell and its stylesheet", () => {
    expect(fs.existsSync(path.join(root, "app.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "styles.css"))).toBe(false);
    for (const source of everySource) {
      expect(source).not.toContain("styles.css");
      expect(source).not.toMatch(/from "\.\/app\.js"/);
    }
    expect(html).not.toContain('src="/app.js"');
    expect(read("developer.html")).not.toContain("/styles.css");
  });

  it("removes the retired nested amount and duplicated output grammars", () => {
    for (const marker of [
      "amount-panel", "field-grid", "destination-output-stack", "quote-output-stack",
      "journey-history", "Previous journeys", "slippageConsent", "slippageAccepted",
      "advancedSettings", "routeDisclosure",
    ]) {
      expect(css).not.toContain(marker);
      for (const source of everySource) expect(source).not.toContain(marker);
    }
  });

  it("keeps index.html a mount point with no product markup", () => {
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/app.jsx"></script>');
    expect(html).toContain('name="color-scheme" content="dark light"');
    expect(html).not.toContain("data-card-role");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});

describe("logic modules stay plain ESM and framework-free", () => {
  const logicModules = {
    "api-client.js": clientSource,
    "journey-orchestrator.js": orchestratorSource,
    "journey-recovery.js": recoveryStoreSource,
    "product-model.js": productModelSource,
    "recovery-action-model.js": read("recovery-action-model.js"),
    "wallet.js": walletSource,
    "journey-view-model.js": viewModelSource,
  };

  it("never imports a framework or a UI module into a logic module", () => {
    for (const [name, source] of Object.entries(logicModules)) {
      expect(name.endsWith(".js"), name).toBe(true);
      expect(source).not.toContain("preact");
      expect(source).not.toContain("@preact/signals");
      expect(source).not.toMatch(/from "\.\/(ui|compose|journey)\//);
      expect(source).not.toContain("</");
    }
  });

  it("keeps the two harness-imported modules importable from node scripts", () => {
    expect(fs.existsSync(path.join(root, "product-model.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "journey-view-model.js"))).toBe(true);
    const productHarness = read("..", "scripts", "run-product-e2e-harness.ts");
    const browserHarness = read("..", "scripts", "run-browser-ui-harness.ts");
    expect(productHarness).toContain("../web/product-model.js");
    expect(browserHarness).toContain("../web/journey-view-model.js");
  });
});

describe("one send, two receives", () => {
  it("keeps route mode and network mode above the composition", () => {
    expect(composeCard).toContain('label="Route mode"');
    expect(composeCard).toContain('{ value: "bridge_only", label: "Bridge"');
    expect(composeCard).toContain('{ value: "bridge_plus_refuel", label: "Bridge + Refuel"');
    // The toggle carries its subject in its accessible name and in each option's
    // hint. The visible "To Hedera" label is deliberately gone: it repeated what
    // both options already say, in the most crowded row of the page.
    expect(app).toContain('label="Hedera destination network"');
    expect(app).not.toContain(">To Hedera<");
    expect(app).toContain('{ value: "testnet", label: "Testnet", hint: "Arrive on Hedera Testnet" }');
    expect(app).toContain('{ value: "mainnet", label: "Mainnet", hint: "Arrive on Hedera Mainnet" }');
    expect(app).not.toContain('tone="success"');
    expect(composeCard.indexOf('label="Route mode"')).toBeLessThan(composeCard.indexOf("<SendBox"));
    expect(store).toContain('requestedRouteMode === "bridge_only" ? "bridge_only" : "bridge_plus_refuel"');
  });

  it("renders exactly one input and one receive group in that order, with no decorative fork", () => {
    expect(composeCard.match(/<SendBox/g)).toHaveLength(1);
    expect(composeCard.match(/<ReceiveGroup/g)).toHaveLength(1);
    expect(composeCard.match(/<HbarExactRow/g)).toHaveLength(1);
    expect(composeCard.match(/<KeptAssetRow/g)).toHaveLength(1);
    // The ⑂ beam graphic between send and receive was decoration that read as a
    // control; the group heading and row count already say what it said.
    for (const source of everySource) expect(source).not.toContain("SplitNode");
    expect(css).not.toContain(".compose-split");
    const order = [
      composeCard.indexOf("<SendBox"),
      composeCard.indexOf("<ReceiveGroup"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(composeCard.indexOf("<HbarExactRow")).toBeLessThan(composeCard.indexOf("<KeptAssetRow"));
    expect(receiveGroup).toContain('class="compose-receive__rows"');
    expect(css).toContain(".compose-row + .compose-row");
  });

  it("puts amount, combined token/chain pill, fiat, balance, and Max in the source box", () => {
    expect(sendBox).toContain("<AmountInput");
    expect(sendBox).toContain('label="Amount to bridge"');
    expect(sendBox).toContain("<TokenPill");
    expect(sendBox).toContain("chainLabel={network?.name}");
    expect(sendBox).toContain("chainIcon={network?.icon ?? null}");
    expect(sendBox).toContain("fiat?.text");
    expect(sendBox).toContain("balanceLine");
    expect(sendBox).toContain(">MAX<");
    expect(sendBox.indexOf("<AmountInput")).toBeLessThan(sendBox.indexOf(">MAX<"));
    expect(composeCard).toContain("onMax={() => actions.setMaxAmount()}");
  });

  it("makes the exact HBAR output a first-class editable primary control", () => {
    // Previously desired HBAR lived inside a collapsed <details id="advancedSettings">.
    // It is now an editable output row inside the receive group, so the pin is on
    // the new location rather than on the retired disclosure.
    expect(composeCard).toContain("<ReceiveGroup");
    expect(hbarRow).toContain("<AmountInput");
    expect(hbarRow).toContain('label="Exact HBAR to receive on Hedera"');
    expect(hbarRow).toContain("<StatePill");
    expect(hbarRow).toContain("{row.badge}");
    expect(composeModel).toContain('badge: "EXACT"');
    expect(composeCard).toContain("onInput={(value) => actions.setDesiredHbar(value)}");
    expect(css).toContain(".compose-row--exact");
    // The derived side stays read-only, and it reads as the expected amount at
    // the quoted rate; the slippage floor is a row in the route disclosure.
    expect(keptRow).not.toContain("AmountInput");
    expect(keptRow).toContain("row.prefix");
    expect(composeModel).toContain("const expected = ledger?.remainingExpected ?? null");
    expect(composeModel).toContain('prefix: retained === null || expected !== null ? null : "≥"');
    expect(composeModel).toContain('label: "Minimum received"');
  });

  it("keeps provider and slippage in one settings dialog and no slippage checkbox anywhere", () => {
    expect(composeCard).toContain("<SettingsPopover");
    expect(settingsPopover).toContain("<legend>Bridge provider</legend>");
    expect(settingsPopover).toContain("<legend>Maximum slippage</legend>");
    expect(settingsPopover).toContain('role="radiogroup"');
    expect(settingsPopover).not.toContain("desiredHbar");
    expect(settingsPopover).not.toContain('type="checkbox"');
    for (const source of everySource) {
      expect(source).not.toContain('type="checkbox"');
      expect(source).not.toContain("slippageAccepted");
    }
    expect(composeCard).toContain("onSlippage={(value) => actions.setSlippage(value)}");
  });

  it("recomposes bridge_only to one input and one output with no refuel controls", () => {
    expect(composeCard).toContain('const refuel = routeMode !== "bridge_only"');
    expect(composeCard).toContain("{refuel && receive.hbar");
    expect(composeCard).toMatch(/\{refuel\s*\?\s*\(\s*<>\s*<PresetChips/);
    expect(composeCard).toContain("<FeasibilityMeter");
    expect(composeModel).toContain('const refuel = routeMode !== "bridge_only"');
    expect(composeModel).toContain('applicable: mode !== "bridge_only"');
    expect(feasibilityMeter).toContain("if (!feasibility.applicable) return null");
    expect(journeyModel).toContain('routeMode === "bridge_only"');
    // bridge_only still shows exactly the first three steps; which list the
    // refuel modes use is decided separately, by whether the refuel was
    // pre-authorized.
    expect(viewModelSource).toContain('routeMode === "bridge_only"\n    ? STEPS.slice(0, 3)');
  });
});

describe("one optional quote disclosure holding every fee and evidence row", () => {
  it("uses exactly one Disclosure on the compose surface", () => {
    const composeSurface = [composeCard, sendBox, hbarRow, keptRow, receiveGroup, presetChips, feasibilityMeter, routeStrip, assetPicker, settingsPopover].join("\n");
    expect(composeSurface.match(/<Disclosure/g)).toHaveLength(1);
    expect(routeStrip).toContain("<Disclosure");
    expect(routeStrip).toContain("route.legs.map");
    expect(routeStrip).toContain("route.eta");
    expect(routeStrip).toContain("route.total.label");
    expect(routeStrip).toContain("route.total.text");
  });

  it("keeps hops, every fee row, slippage, and the fair-value check inside it", () => {
    expect(routeStrip).toContain('aria-label="Route hops"');
    expect(routeStrip).toContain("route.rows.map");
    // The mixed-venue/price-impact/max-slippage recital, the quote id and the
    // expiry timestamp are gone from this surface: every one of those gates is
    // enforced whether or not it is recited, and the expiry is the countdown
    // under the CTA. The liquidity figure stays, as one short line.
    expect(routeStrip).not.toContain("route.disclosure");
    expect(routeStrip).not.toContain("route.quoteId");
    expect(routeStrip).not.toContain("route.expiresAt");
    expect(routeStrip).toContain("route.liquidityUsd");
    expect(composeModel).not.toContain("Sponsored ·");
    expect(composeModel).toContain('label: "Max slippage"');
    expect(composeModel).toContain('id: "fair-value"');
    expect(composeModel).toContain('label: "Refuel service fee (x402)"');
    expect(composeModel).toContain('label: "HBAR purchase, at most"');
    expect(composeModel).toContain("minimumLiquidityUsd");
  });

  it("relocates blockers into the disclosure as plain text and never renders the code", () => {
    expect(routeStrip).toContain("blockers.map");
    // The code used to ride along as the row's tooltip. It stays on the object as
    // a React key and reaches no rendered attribute.
    expect(routeStrip).not.toContain("title={blocker.title}");
    expect(routeStrip).not.toContain("blocker.code}>{blocker.code");
    expect(composeModel).toContain("deriveQuoteBlockers");
    expect(composeModel).toContain("blockerLabel(code)");
    expect(productModelSource).toContain("export function blockerLabel(code)");
  });
});

describe("Max is a server figure", () => {
  it("routes the Max control to the server solver and never computes one client-side", () => {
    expect(presetChips).toContain("onMax?.()");
    expect(composeCard).toContain("await actions.requestMaximumHbar()");
    const maxHandler = section(store, "async function requestMaximumHbar()", "// --------------------------------------------------------------- recovery");
    expect(maxHandler).toContain("solveMaximumHbar: true");
    expect(maxHandler).toContain('client.request("/v1/product/quote"');
    expect(maxHandler).toContain("quote.feasibility?.maximumTinybar");
    expect(maxHandler).not.toContain("wallet.");
    expect(productModelSource).toContain("solveMaximumHbar = false");
    expect(read("..", "server", "src", "combined-quote.ts")).toContain("deferMaximumFeasibleHbar");
  });

  it("applies the published bound before the solve, so Max is never a dead control", () => {
    // The solver prices one draft; with no amount entered there is nothing to
    // price, and the control used to fail there. The configured policy cap is a
    // server number from /v1/product/options, not a client computation.
    const published = section(store, "function publishedMaximumTinybar()", "/** A solve prices one specific draft");
    expect(published).toContain("quoteLimitValue.peek()?.maximumTinybar");
    expect(published).toContain("optionsValue.peek()?.limits?.maximumConfiguredHbarTinybar");
    const maxHandler = section(store, "async function requestMaximumHbar()", "// --------------------------------------------------------------- recovery");
    expect(maxHandler).toContain("const published = publishedMaximumTinybar()");
    expect(maxHandler.indexOf("const published")).toBeLessThan(maxHandler.indexOf("solveMaximumHbar: true"));
    expect(maxHandler).toContain("if (!draftAmountEntered()) return");
    expect(composeCard).toContain("options?.limits?.maximumConfiguredHbarTinybar");
  });

  it("takes the ceiling from a server figure, labelled as the plain amount it is", () => {
    expect(composeModel).toContain("derivePresets");
    // The ceiling is a chip like any other. "Max 50 ℏ" beside "10 ℏ" and "25 ℏ"
    // read as a different kind of control; re-solving on click is behaviour.
    expect(composeModel).toContain('source: known ? "solved_route_maximum" : "configured_policy_cap"');
    expect(composeModel).not.toContain("`Max ${");
    expect(presetChips).toContain('const ceiling = chip.kind === "bound"');
    expect(presetChips).toContain("matchesPreset(chip.hbar, value)");
    expect(presetChips).toContain("ceiling ? onMax?.() : onSelect?.(chip.hbar)");
    expect(composeModel).toContain('limitCaption');
    // No caption at all without a verified figure — the solver's status is not
    // something the owner can act on.
    expect(composeModel).not.toContain('"Max not solved yet"');
    expect(composeModel).not.toContain("`Policy cap ${");
    expect(composeModel).toContain("const limitCaption = maximumAmount");
    // The meter still measures against the SOLVED bound only; the policy cap is
    // caption text, never the denominator.
    expect(composeModel).toContain('max: known ? maximumTinybar.toString() : "0"');
  });

  it("reads an infeasible request as a meter overflow carrying the server constraint", () => {
    expect(composeModel).toContain("const overflow = Boolean(known && desired !== null && desired > maximumTinybar)");
    expect(composeModel).toContain("Server maximum for this bridge is");
    expect(composeModel).toContain("constraintText(limitingConstraint)");
    expect(uiPrimitives.Meter).toContain("model.overflow");
    expect(uiPrimitives.Meter).toContain("overflowNote");
    expect(uiPrimitives.dom).toContain("overflow: ratio > 1");
    expect(css).toContain(".ui-meter.is-overflow .ui-meter__fill");
    // An unsolved bound is an empty track, not a false overflow.
    expect(composeModel).toContain('value: known && desired !== null ? desired.toString() : "0"');
  });
});

describe("one primary action per surface", () => {
  it("renders a single CTA on compose and a single CTA on every journey surface", () => {
    expect(composeCard.match(/variant="primary"/g)).toHaveLength(1);
    expect(composeCard).toContain("onClick={() => { void actions.submitPrimary(); }}");
    expect(journeyChrome).toContain("export function PrimaryAction");
    expect(journeyChrome).toContain("void actions.submitPrimary()");
    for (const surface of [journeyTimeline, arrivalConsent, recoveryCard, adoptCard, termsCard]) {
      expect(surface.match(/<PrimaryAction/g)).toHaveLength(1);
      expect(surface).not.toContain('variant="primary"');
    }
    expect(store).toContain("async function submitPrimary()");
    expect(store).toContain("if (primaryActionInFlight) return");
  });

  it("derives every label from the pure intent table, never from a component branch", () => {
    expect(composeCard).toContain("derivePrimaryAction({");
    expect(composeCard).toContain("intent: state.primaryIntent.value");
    expect(journeyChrome).toContain("primaryActionCopy(intent, {");
    expect(composeModel).toContain("export function derivePrimaryAction({");
    expect(journeyModel).toContain("export function primaryActionCopy(intent, context = {})");
    expect(store).toContain("export function derivePrimaryIntent(snapshot)");
  });

  it("never navigates destructively and never signs without the click that reached it", () => {
    for (const source of everySource) {
      expect(source).not.toMatch(/location\.(reload|assign|replace)/);
    }
    const dispatch = section(store, "async function submitPrimary()", "function cancelRecovery()");
    expect(dispatch).toContain("if (intent.disabled) return");
    expect(dispatch).toContain('case "connect_wallet"');
    expect(dispatch).toContain('case "accept_new_terms"');
    expect(dispatch).toContain('case "adopt_bridge"');
    expect(dispatch).toContain('case "refresh_destination"');
    expect(dispatch).toContain("default: return;");
  });
});

describe("phase discipline and draft separation", () => {
  it("writes the journey phase from exactly one validated site", () => {
    expect(store.match(/phaseValue\.value\s*=(?!=)/g)).toHaveLength(1);
    expect(store).toContain("phaseValue.value = options?.reset ? next : transitionJourney(phaseValue.peek(), next, options)");
    expect(store).toContain('if (options?.reset && !JOURNEY_STATES.includes(next)) throw new Error("unknown journey state")');
    expect(store).toContain("phase: computed(() => phaseValue.value)");
    for (const surface of surfaces) {
      expect(surface).not.toContain("setPhase");
      expect(surface).not.toMatch(/\.phase\s*=(?!=)/);
    }
  });

  it("persists only a server-authoritative pointer and never an editable draft field", () => {
    const persisted = section(store, "function persistJourneyCheckpoint()", "// ----------------------------------------------------------- orchestrator");
    expect(persisted).toContain("journeyId: journeyIdValue.peek()");
    expect(persisted).toContain("account,");
    for (const leak of ["quote:", "journey:", "recovery:", "events", "sourceAmount", "desiredHbar", "slippage", "draft"]) {
      expect(persisted).not.toContain(leak);
    }
    expect(recoveryStoreSource).toContain("const value = {");
    const record = section(recoveryStoreSource, "const value = {", "this.storage.setItem");
    for (const leak of ["quote", "checkpoint", "sourceTransactionHash", "bridgeAmount", "desiredHbar", "maxSlippage", "draft"]) {
      expect(record).not.toContain(leak);
    }
    // Draft fields only ever come back from a server journey record.
    expect(store).toContain("function restoreRecoveredSelection(journey, quote)");
    const restore = section(store, "function restoreRecoveredSelection(journey, quote)", "// ---------------------------------------------------------------- catalog");
    expect(restore).toContain("quote.bridge?.normalized?.sourceAmount");
    expect(restore).toContain("quote.amountLedger?.hbar?.exactOutputTinybar");
    expect(restore).not.toContain("persistence.");
    expect(restore).not.toContain("localStorage");
    // journey-recovery.js is the ONLY module allowed to touch web storage.
    for (const source of everySource) expect(source).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(recoveryStoreSource).toContain("globalThis.localStorage");
  });

  it("keeps a selected journey's draft locked and separate from the editable one", () => {
    expect(store).toContain("const draftLocked = computed(() => Boolean(journeyIdValue.value))");
    for (const setter of ["function setAmount(value)", "function setDesiredHbar(value)", "function setSlippage(value)", "function selectToken(token)", "function setMaxAmount()"]) {
      expect(section(store, setter, "\n  }\n"), setter).toContain("draftLocked.peek()");
    }
    expect(composeCard).toContain("const locked = state.draftLocked.value");
    expect(sendBox).toContain("disabled={disabled}");
    expect(app).toContain("disabled={state.draftLocked.value}");
  });

  it("uses one local reset path for account detach, Activity selection, and new transfer", () => {
    expect(store).toContain("function resetSelectedJourneyState()");
    expect(store).toContain('setPhase("idle", { reset: true })');
    // clearUrl only ever DELETES the journey param. The store has no way to add
    // one: setUrl is gone, so no code path can stamp an id into the address bar.
    expect(store).toContain("persistence.clearUrl()");
    expect(store).not.toContain("persistence.setUrl");
    expect(store).toContain("activityController?.abort()");
    expect(store).toContain("function resetEditableDraft()");
  });
});

describe("recovery reads stay authoritative, bounded, and never mutate", () => {
  it("re-polls only safe server reads and never hides a destination-quote POST inside a GET", () => {
    expect(store).toContain("export const RECOVERY_REPOLL_MS = 12_000");
    expect(store).toContain("function recoveryRepollable()");
    expect(store).toContain("Number.isFinite(recovery.revalidateAfterMs)");
    const apply = section(store, "function applyServerJourney(response)", "function stopRecoveryPolling()");
    expect(apply).not.toContain("refreshDestinationQuote");
    const read = section(orchestratorSource, "async fetchJourneyDecision", "async resume");
    expect(read).toContain("this.request(`/v1/product/journeys/${journeyId}`");
    expect(read).not.toContain("destination-quote");
  });

  it("runs one re-poll at a time and never applies an older decision over a newer one", () => {
    expect(store).toContain("let recoveryRepollInFlight = false");
    expect(store).toContain("if (recoveryRepollInFlight) {");
    expect(store).toContain("const sequence = ++recoveryRepollSequence");
    const repoll = section(store, "async function repollRecoveryDecision()", "async function recoverCurrentJourney(");
    expect(repoll).toContain("} finally {");
    expect(repoll).toContain("recoveryRepollInFlight = false");
    expect(repoll.indexOf("if (sequence !== recoveryRepollSequence) return")).toBeLessThan(repoll.indexOf("applyServerJourney(decision)"));
  });

  it("never refreshes a destination quote from a timer or an unattended read", () => {
    expect(store).not.toContain("MAX_UNATTENDED_QUOTE_REFRESHES");
    expect(store).not.toContain("bridgeConsentAwaitingQuote");
    const timer = section(store, "function startQuoteTimer()", "function restoreRecoveredSelection(");
    expect(timer).not.toContain("refreshDestinationQuote");
    expect(timer).not.toContain("scheduleRecoveryRepoll");
    const explicit = section(store, "async function refreshRecoveryDestinationQuote()", "// ------------------------------------------------------------- execution");
    expect(explicit).toContain("orchestrator.refreshDestinationQuote({ journeyId })");
  });

  it("marks an already-expired recovered quote stale once without recursive rendering", () => {
    expect(store).toContain('const displayed = ["ready", "recovery_quote_ready"].includes(phaseValue.peek())');
    expect(store).toContain("const changed = !quoteStaleValue.peek() || displayed");
    expect(store).toContain("if (!quoteStaleValue.peek() && quoteValue.peek()?.expiresAt > now())");
  });

  it("keeps a live run authoritative over stale recovery banners and immune to concurrency", () => {
    expect(store).toContain("let runInFlight = false");
    expect(store).toContain("let primaryActionInFlight = false");
    expect(store).toContain("let walletConnectPromise = null");
    expect(store).toContain("if (walletConnectPromise) return walletConnectPromise");
    expect(store).toContain("recoveryAttemptedFor = identity.journeyId");
    const onPhase = section(store, "onPhase: (phase)", "onJourney:");
    expect(onPhase).toContain("errorValue.value = null");
    expect(onPhase).toContain("recoveryValue.value = null");
    expect(onPhase).toContain("setPhase(phase, { authoritative: true })");
    expect(onPhase).not.toContain("quoteConsentGate");
  });

  it("treats a local id as provisional until the server confirms that exact journey", () => {
    expect(store).toContain("recoveryProvisionalValue.value = true");
    expect(journeyModel).toContain('if (recoveryProvisional) return "rechecking"');
    expect(journeyView).toContain('if (surface === "rechecking") return <RecheckingCard />');
    expect(journeyView).toContain("provisional");
    expect(journeyModel).toContain("export function journeySurface({");
  });

  it("keeps a failed selected-journey read provisional with no replay or local fallback", () => {
    const recover = section(store, "async function recoverCurrentJourney(", "async function refreshRecoveryDestinationQuote()");
    const failure = recover.slice(recover.indexOf("} catch (error) {"));
    expect(failure).toContain("recoveryProvisionalValue.value = true");
    expect(failure).toContain("The server record remains unchanged");
    expect(failure).not.toContain("reference.recovery");
    expect(failure).not.toContain("scheduleRecoveryRepoll");
  });

  it("bounds every recovery read and lets the owner stop one", () => {
    expect(clientSource).toContain("const DEFAULT_REQUEST_TIMEOUT_MS = 15_000");
    expect(clientSource).toContain("AbortSignal.timeout(effectiveTimeoutMs)");
    expect(store).toContain("recoveryController = new AbortController()");
    expect(store).toContain("function cancelRecovery()");
    expect(journeyChrome).toContain("state.recoveryCancellable.value");
    expect(journeyChrome).toContain("Stop reading this journey");
  });
});

describe("new transfer archives, never cancels or replays", () => {
  it("detaches locally without deleting, replaying, or mutating the server journey", () => {
    const detach = section(store, "async function startNewTransfer()", "// --------------------------------------------------------------- activity");
    expect(detach).toContain("persistence.clear(account)");
    expect(detach).toContain("resetSelectedJourneyState()");
    expect(detach).toContain("resetEditableDraft()");
    expect(detach).not.toContain("orchestrator.");
    expect(detach).not.toContain("client.");
    expect(detach).not.toContain("fetch(");
    expect(store).not.toContain("newTransferDetachArmed");
    expect(journeyChrome).toContain("void actions.startNewTransfer()");
    expect(journeyChrome).toContain("The server record, hashes, and events are never deleted or replayed.");
  });
});

describe("worsened post-consent terms need one explicit acceptance", () => {
  it("raises the gate only from the server's own refusal and never auto-accepts", () => {
    expect(store).toContain("function raiseTermsGate(error)");
    expect(store).toContain('error?.body?.code === "QUOTE_ECONOMICS_WORSENED" ? error.body.details : null');
    expect(store).toContain("if (!details?.consented || !details?.refreshed) return false");
    const gate = section(store, "function raiseTermsGate(error)", "function resetTokenBalance(");
    expect(gate).not.toContain("executeJourney");
    expect(gate).not.toContain("orchestrator.");
    expect(gate).not.toContain("wallet.");
    expect(store.match(/quoteConsentGateValue\.value = null/g)).toHaveLength(2);
    const repollable = section(store, "function recoveryRepollable()", "function scheduleRecoveryRepoll()");
    expect(repollable).toContain("if (quoteConsentGateValue.peek()) return false");
    const apply = section(store, "function applyServerJourney(response)", "function stopRecoveryPolling()");
    expect(apply).not.toContain("raiseTermsGate");
  });

  it("outranks the provisional re-check in both routing and dispatch", () => {
    expect(store.indexOf("if (snapshot.quoteConsentGate && snapshot.journeyId) {"))
      .toBeLessThan(store.indexOf("if (snapshot.journeyId && snapshot.recoveryProvisional) {"));
    expect(journeyModel.indexOf('return "terms_changed"')).toBeLessThan(journeyModel.indexOf('return "rechecking"'));
    expect(journeyView.indexOf('surface === "terms_changed"')).toBeLessThan(journeyView.indexOf('surface === "rechecking"'));
  });

  it("shows the exact before/after comparison and re-quotes only on the accepting click", () => {
    expect(termsCard).toContain("termsChangeRows(gate, state.quote.value)");
    expect(journeyModel).toContain("destinationTermsComparison(gate, quote)");
    expect(productModelSource).toContain('["swapInputMaximum", "Most of your bridged asset that can be spent", "asset"]');
    expect(productModelSource).toContain('["minimumRetained", "Least bridged asset you keep", "asset"]');
    expect(productModelSource).toContain('["desiredHbarTinybar", "Exact HBAR you receive", "hbar"]');
    expect(termsCard).toContain("Nothing was signed, submitted, or charged.");
    expect(journeyModel).toContain("Accept the new terms and continue");
    const execute = section(store, "async function executeJourney()", "async function reconcileSubmissions()");
    expect(execute).toContain("const acceptedNewTerms = Boolean(quoteConsentGateValue.peek() && journeyIdValue.peek())");
    expect(execute).toContain("if (acceptedNewTerms) {");
    expect(execute).toContain("orchestrator.refreshDestinationQuote({ journeyId: journeyIdValue.peek() })");
    expect(execute).toContain("if (raiseTermsGate(error)) {");
  });
});

describe("owner-signed bridge adoption", () => {
  it("offers adoption only where the server names that endpoint", () => {
    expect(store).toContain("export function bridgeAdoptionOffered(recovery)");
    expect(store).toContain('recovery?.nextAtomicStep === "operator_review"');
    expect(store).toContain('recovery.reason.includes("/bridge/adopt")');
    expect(journeyModel).toContain('return "adopt"');
    expect(journeyView).toContain('if (surface === "adopt") return <AdoptCard />');
  });

  it("binds only the hash the owner typed, behind one explicit signature", () => {
    expect(store).toContain("export const ORIGIN_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/");
    const adopt = section(store, "async function adoptBridge(", "async function startNewTransfer()");
    expect(adopt).toContain("ORIGIN_TRANSACTION_HASH.test(hash)");
    expect(adopt).toContain("wallet.signBridgeAdoption");
    expect(adopt).toContain("client.adoptBridge(journeyIdValue.peek(), { sourceTransactionHash: hash, confirmation })");
    expect(adopt).toContain("applyServerJourney(");
    // The only default is the owner-typed signal; nothing derives a hash from
    // the journey record, a submission, or a provider response.
    expect(store).toContain("async function adoptBridge(sourceTransactionHash = bridgeAdoptionHashValue.peek())");
    expect(adopt).not.toMatch(/journeyValue\.peek\(\)\?\.(submissions|authorizations)/);
    expect(adopt).not.toContain("evidence");
    expect(adoptCard).toContain("actions.setBridgeAdoptionHash(event.currentTarget.value)");
    expect(adoptCard).toContain("Nothing is filled in or guessed for you");
    expect(adoptCard).not.toMatch(/value=\{(?!state\.bridgeAdoptionHash\.value)/);

    expect(clientSource).toContain("/bridge/adopt");
    expect(clientSource).toContain('"idempotency-key": `adopt-${journeyId}`');
    expect(clientSource).toContain("body: { sourceTransactionHash, confirmation }");
    expect(clientSource).not.toContain("confirm: true");

    expect(walletSource).toContain('primaryType: "BridgeAdoption"');
    expect(walletSource).toContain('domain: { name: "Refuel402", version: "1", chainId: network.chainId }');
    expect(walletSource).not.toMatch(/personal_sign|eth_sign"/);
  });
});

describe("orchestrator guarantees the surfaces depend on", () => {
  it("refreshes and retries a thin-runway leg without a wallet prompt", () => {
    const authorize = section(orchestratorSource, "async authorizeIntent(", "async submitAuthorizedIntent(");
    expect(authorize).toContain('conflictCode(error) !== "QUOTE_EXPIRES_TOO_SOON"');
    expect(authorize).toContain("refreshes >= this.maxQuoteRefreshRetries");
    expect(authorize).toContain("await this.refreshDestinationQuote({ journeyId })");
    expect(authorize).toContain("if (boundQuoteId) boundQuoteId = refreshed.quoteId");
    expect(authorize).not.toContain("this.wallet");
    expect(orchestratorSource).toContain("maxQuoteRefreshRetries = 2");
    expect(orchestratorSource).toContain("this.destinationQuote = refreshed.quote");
  });

  it("never re-runs a durable destination leg or re-charges a settled x402 payment", () => {
    expect(orchestratorSource).toContain("async completedDestinationLegs(journeyId)");
    expect(orchestratorSource).toContain('if (current.journey?.payment) done.add("payment")');
    expect(orchestratorSource).toContain('if (!completed.has("permit2_approval"))');
    expect(orchestratorSource).toContain("if (!paid) await this.settlePayment(journeyId)");
    expect(orchestratorSource).toContain("if (settled.payment) return settled");
  });

  it("surfaces a mid-leg quote refresh as honest, wallet-free work", () => {
    expect(store).toContain("onQuoteRefresh: (event)");
    expect(store).toContain("quoteRefreshValue.value = event.active ? event : null");
    expect(journeyChrome).toContain("quoteRefresh: state.quoteRefresh.value");
    expect(journeyModel).toContain('label: "Refreshing the quote…"');
    expect(journeyModel).toContain("No wallet action, payment, or submission happens while it refreshes.");
    expect(shellModel).toContain("No wallet action.");
  });

  it("offers precise reconciliation for review journeys through the safe endpoint", () => {
    expect(store).toContain("client.reconcileSubmissions(journeyIdValue.peek())");
    expect(store).toContain('snapshot.recovery.nextAtomicStep === "reconcile_submissions"');
    expect(viewModelSource).toContain("Authorization expired before broadcast");
    expect(viewModelSource).toContain("No payment, raw transaction hash, or submission exists");
    expect(clientSource).toContain("/reconcile-submissions");
    expect(clientSource).toContain('"idempotency-key": `reconcile-${journeyId}`');
    expect(journeyModel).toContain("reconcile_submissions");
    expect(recoveryCard).toContain("recoveryFraming(recovery)");
  });
});

describe("journey surfaces read as one calm grammar", () => {
  it("gives every post-start surface a header, a progress-or-summary body, and Details", () => {
    for (const surface of [journeyTimeline, arrivalConsent, recoveryCard, adoptCard, termsCard]) {
      expect(surface).toContain("<JourneyHeader");
      expect(surface.match(/<Evidence/g)).toHaveLength(1);
      expect(surface).toContain('class="journey-surface');
    }
    expect(journeyChrome).toContain("export function Evidence");
    expect(journeyChrome).toContain("<Disclosure");
    expect(journeyChrome).toContain("technical evidence");
    expect(journeyModel).toContain("export function evidenceRows({");
  });

  it("frames arrival as a moment, not an error", () => {
    expect(arrivalConsent).toContain("Your funds arrived");
    expect(arrivalConsent).toContain('tone="success"');
    expect(arrivalConsent).toContain("<Ring");
    expect(arrivalConsent).toContain("arrivalSummary(quote)");
    expect(arrivalConsent).toContain("walletPromptPlan({ journey, quote })");
    expect(journeyModel).toContain("expired");
    expect(arrivalConsent).toContain("freshness.expired");
    expect(arrivalConsent).not.toContain('tone="danger"');
  });

  // The seven-row checklist is gone. Its shape promised to walk the owner through
  // seven interactions when every signature happens up front in MetaMask, so the
  // surface folds to origin → transit → destination and lists the transactions.
  it("orients the journey with three phases, one status line, and real transaction links", () => {
    expect(journeyTimeline).toContain("Safe to close this tab.");
    expect(journeyTimeline).toContain("bridgeEta({ journey, quote: state.quote.value })");
    expect(journeyChrome).toContain("deriveJourneyPhases(state.journeyPresentation.value.progress, state.journey.value)");
    expect(journeyChrome).toContain('class="journey-phases__track"');
    expect(journeyChrome).toContain("journey-receipt");
    // No step is ever linked without a reference the server actually recorded.
    expect(journeyChrome).toContain("steps.filter((step) => step.link && step.reference)");
    expect(journeyChrome).toContain('rel="noreferrer"');
    expect(journeyChrome).not.toContain("<TimelineStep");
    expect(journeyModel).toContain("export function hederaTransactionUrl(mode, reference)");
    expect(journeyModel).toContain("export function originTransactionUrl(journey, { networks = [], chainId = null } = {})");
    // A link is only ever built from an explorer the support catalog declares.
    expect(journeyModel).toContain('base.startsWith("https://") ? `${base}/tx/${hash}` : null');
  });

  it("keeps orientation visible on every recovery surface", () => {
    expect(recoveryCard).toContain("<JourneyProgress");
    expect(journeyChrome).toContain("export function JourneyProgress");
    expect(journeyChrome).toContain("journeySteps({");
    expect(recoveryCard).toContain("framing.plain");
    expect(recoveryCard).toContain("<ServerReason");
    expect(journeyModel).toContain("export function recoveryFraming(recovery)");
  });
});

describe("Activity stays secondary, server-bounded, and account-scoped", () => {
  it("reads one bounded page per account and cancels in flight on account change", () => {
    const load = section(store, "async function loadActivity(", "async function openActivity()");
    expect(load).toContain("/v1/product/journeys?account=");
    expect(load).toContain("limit=${ACTIVITY_PAGE_SIZE}");
    expect(load).toContain("activityController?.abort()");
    expect(load).toContain("walletValue.peek().account !== account");
    expect(load).not.toContain("quoteValue.value =");
    expect(load).not.toContain("journeyIdValue.value =");
    expect(store).toContain("const ACTIVITY_PAGE_SIZE = 8");
    expect(store).not.toContain("persistence.historyFor");
    const onWallet = section(store, "function onWalletSnapshot(snapshot)", "// ---------------------------------------------------------------- actions");
    expect(onWallet).toContain("activityItemsValue.value = []");
    expect(onWallet).toContain("persistence.clearUrl()");
    expect(onWallet).toContain("resetSelectedJourneyState()");
  });

  it("opens a row as an explicit server read that never touches another journey", () => {
    const select = section(store, "async function selectActivityJourney(journeyId)", "// ----------------------------------------------------------------- wallet");
    expect(select).toContain("resetSelectedJourneyState()");
    expect(select).toContain("persistence.persist({");
    expect(select).toContain("await recoverCurrentJourney(journeyId)");
    expect(select).not.toContain("orchestrator.run");
    expect(select).not.toContain("continueRefuel");
    expect(activityDrawer).toContain("void actions.selectActivityJourney(row.journeyId)");
    expect(activityDrawer).toContain("Opening one never changes another journey.");
    expect(activityDrawer).toContain("Connect MetaMask to view this account’s journeys.");
  });

  it("renders the drawer as a focus-trapped dialog with a named action per row", () => {
    expect(activityDrawer).toContain("<Modal");
    expect(activityDrawer).toContain('placement="right"');
    // Rows are named by asset and time, not by a truncated journey uuid.
    expect(activityDrawer).toContain("aria-label={`${activityActionLabel(row.action)} ${name}`}");
    expect(activityDrawer).not.toContain("facts.reference");
    expect(uiPrimitives.Modal).toContain('role="dialog"');
    expect(uiPrimitives.Modal).toContain('aria-modal="true"');
    expect(uiPrimitives.Modal).toContain("aria-labelledby={titleId}");
    expect(uiPrimitives.Modal).toContain('if (event.key !== "Tab") return');
    expect(uiPrimitives.Modal).toContain('if (event.key === "Escape")');
    expect(uiPrimitives.Modal).toContain("openerRef.current?.focus?.()");
    expect(uiPrimitives.Modal).toContain('body.classList.add("scroll-locked")');
    expect(css).toContain(".ui-modal--right .ui-modal__panel");
    expect(app).toContain("<ActivityDrawer />");
    expect(app).toContain('aria-haspopup="dialog"');
  });
});

describe("quote freshness warns and never acts", () => {
  it("guards a start on quote validity and re-quotes instead of consenting on stale terms", () => {
    const execute = section(store, "async function executeJourney()", "async function reconcileSubmissions()");
    expect(execute).toContain("!quoteStillValid(quoteValue.peek(), quoteContext())");
    expect(execute).toContain("quoteStaleValue.peek() || driftedQuote || quoteValue.peek().expiresAt <= now()");
    expect(execute).toContain("await requestQuote()");
    expect(productModelSource).toContain("export function quoteStillValid(quote, state,");
  });

  // The re-price check must be tested BEFORE the execute capability. A quote that
  // is not executable but has aged out is offered as "Refresh quote", and testing
  // capability first made that press a permanent dead click: it returned in total
  // silence, with no request, no message, and no wallet prompt.
  it("offers a re-price before it refuses on execute capability", () => {
    const execute = section(store, "async function executeJourney()", "async function reconcileSubmissions()");
    const reprice = execute.indexOf("const stale = Boolean(quoteValue.peek())");
    const capability = execute.indexOf("!quoteValue.peek()?.capabilities?.execute");
    expect(reprice).toBeGreaterThan(-1);
    expect(capability).toBeGreaterThan(reprice);
  });

  // Every refusal states itself. A press that cannot proceed used to change
  // nothing observable at all, which is indistinguishable from a broken app.
  it("never refuses to start a journey in silence", () => {
    const execute = section(store, "async function executeJourney()", "async function reconcileSubmissions()");
    const guards = execute.split("\n").filter((line) => /^\s+(if|} else if)\b.*\breturn;\s*$/.test(line));
    // Only the re-entrancy guard may be silent: a second click during a live run
    // already has the CTA spinning.
    expect(guards).toHaveLength(1);
    expect(guards[0]).toContain("runInFlight");
    for (const message of [
      "an unknown outcome",
      "no live quote yet",
      "not cleared this route for execution",
      "no executable transaction for this route",
    ]) expect(execute, message).toContain(message);
  });

  it("renders freshness as a countdown that states nothing signs on expiry", () => {
    expect(composeCard).toContain("deriveQuoteFreshness({");
    expect(composeModel).toContain("export function deriveQuoteFreshness({");
    expect(composeModel).toContain("No wallet action");
    expect(journeyModel).toContain("nothing signs or resubmits automatically");
    expect(uiPrimitives.Ring).toContain("The countdown is presentation only");
    expect(uiPrimitives.Ring).toContain('role="img"');
    expect(css).toContain(".compose__freshness.is-warning");
    expect(css).toContain(".ui-ring.is-expired");
  });
});

describe("amounts never clip and never lie", () => {
  it("never clips amount text with a visual ellipsis and keeps full precision on hover", () => {
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(baseCss).toContain(".no-clip");
    expect(baseCss).toContain("overflow-wrap: anywhere");
    expect(baseCss).toContain("text-overflow: clip");
    expect(composeModel).toContain("formatTokenAmount");
    expect(composeModel).toContain("title: `${amount.full} ${symbol}`");
    expect(productModelSource).toContain("export function formatTokenAmount(");
    for (const source of [sendBox, hbarRow, keptRow, routeStrip, arrivalConsent, termsCard, activityDrawer]) {
      expect(source).toContain("no-clip");
    }
  });

  it("renders sub-precision non-zero amounts as a bound rather than as zero", () => {
    expect(productModelSource).toContain("display: `<${formatUnits(10n ** BigInt(decimals - precision), decimals, precision)}`");
    expect(productModelSource).toContain('if (amount > 0n && display === "0" && precision > 0)');
    expect(composeModel).toContain("amountText");
    expect(composeCard).toContain("amountText(state.tokenBalance.value, token.decimals, token.symbol)");
  });

  it("keeps every amount and state derivation in a pure module, never inline in a component", () => {
    const components = [...surfaces, ...Object.values(uiPrimitives)].filter((source) => source.includes("jsx") || source.includes("class="));
    for (const source of components) {
      expect(source).not.toMatch(/BigInt\(/);
      expect(source).not.toMatch(/\b\d+n\b/);
      expect(source).not.toMatch(/\b(formatUnits|parseUnits|formatTokenAmount|normalizeDesiredHbar)\(/);
    }
    // The pure modules are where that math is allowed to live, and they are
    // unit-tested on their own.
    expect(composeModel).toMatch(/\bformatTokenAmount\(/);
    expect(journeyModel).toMatch(/\bformatTokenAmount\(/);
    for (const model of ["compose-view-model.test.ts", "journey-presentation.test.ts", "shell-view-model.test.ts", "store.test.ts", "store-journey.test.ts", "ui/dom.test.ts"]) {
      expect(fs.existsSync(path.join(root, model)), model).toBe(true);
    }
  });

  it("uses tabular numerals wherever amounts are compared column-wise", () => {
    expect(baseCss).toContain("font-variant-numeric: tabular-nums");
    expect(tokensCss).toContain("--text-amount: 30px");
    expect(uiPrimitives.AmountInput).toContain('class="ui-amount__input tabular no-clip"');
    for (const source of [keptRow, routeStrip, arrivalConsent, termsCard, activityDrawer]) {
      expect(source).toContain("tabular");
    }
    // The editable HBAR row inherits it from AmountInput rather than repeating it.
    expect(hbarRow).toContain("<AmountInput");
  });

  it("only prices a quote in fiat where the server published verified evidence", () => {
    expect(composeModel).toContain("export function quotePriceEvidence(quote)");
    expect(composeModel).toContain("quote?.destination?.fairValue ?? null");
    expect(composeModel).toContain('fair.status === "verified"');
    expect(composeModel).toContain("x402?.marketEvidence");
    expect(composeModel).toContain("USD —");
  });
});

describe("balance reads stay keyed and honest", () => {
  it("keys balance reads to the current account, token, and network", () => {
    expect(store).toContain("let tokenBalanceRequestVersion = 0");
    expect(store).toContain("requestVersion === tokenBalanceRequestVersion");
    expect(store).toContain('tokenBalanceStatusValue.value = "wrong_chain"');
    expect(store).toContain('tokenBalanceStatusValue.value = "loading"');
    expect(store).toContain('tokenBalanceStatusValue.value = "ready"');
    expect(store).toContain('tokenBalanceStatusValue.value = "error"');
    expect(store).toContain("token.native");
    expect(store).toContain("wallet.nativeBalance(account)");
    expect(store).toContain("wallet.tokenBalance(token.address, account)");
  });

  it("names every non-ready balance state instead of rendering a zero", () => {
    expect(sendBox).toContain("wrong_chain:");
    expect(sendBox).toContain("bridges from ${network?.name");
    expect(sendBox).toContain('error: balanceError ?? "Balance unavailable"');
    expect(sendBox).toContain('loading: "Balance…"');
    expect(composeCard).toContain('state.tokenBalanceStatus.value === "ready" && state.tokenBalance.value !== null');
  });

  it("gives the wrong-chain state a control instead of an instruction", () => {
    expect(sendBox).toContain('const wrongChain = balanceStatus === "wrong_chain"');
    expect(sendBox).toContain("Switch network");
    expect(sendBox).toContain("onClick={onSwitchNetwork}");
    expect(composeCard).toContain("onSwitchNetwork={() => { void switchNetwork(); }}");
    expect(store).toContain("async function switchToOriginNetwork()");
    expect(store).toContain("switchToOriginNetwork,");
  });

  it("follows the wallet's own chain, and refuses to do so where the journey record rules", () => {
    // One-directional bridge: the origin chain is wherever the wallet already is.
    const follow = section(store, "function followWalletChain(chainId)", "  /**\n   * The explicit escape hatch");
    expect(follow).toContain("if (draftLocked.peek() || runInFlight || recoveryValue.peek()) return");
    // Hedera 295/296 is not an origin network in either catalog, and the
    // orchestrator moves the wallet there and back on every leg.
    expect(follow).toContain("if (!match) return");
    expect(store).toContain("if (Number(previous.chainId) !== Number(snapshot.chainId)) followWalletChain(snapshot.chainId)");
  });
});

describe("selection, keyboard, and programmatic names", () => {
  it("binds roving focus to every group selector", () => {
    expect(uiPrimitives.dom).toContain("export function rovingIndex(currentIndex, count, key)");
    expect(uiPrimitives.Segmented).toContain("rovingIndex(current, enabled.length, event.key)");
    expect(uiPrimitives.Chip).toContain("rovingIndex(index, chips.length, event.key)");
    expect(assetPicker).toContain("rovingIndex(index, rows.length, event.key)");
    expect(uiPrimitives.Segmented).toContain('role="radiogroup"');
    expect(uiPrimitives.Segmented).toContain('aria-checked={active ? "true" : "false"}');
    expect(uiPrimitives.Segmented).toContain("tabIndex={active ? 0 : -1}");
  });

  it("keeps unavailable routes readable rather than hidden or unreachable", () => {
    expect(assetPicker).toContain('aria-disabled={row.disabled ? "true" : undefined}');
    expect(assetPicker).toContain("row.reasons.map");
    expect(assetPicker).toContain("Every discovered asset stays listed");
    expect(composeModel).toContain("export function derivePickerGroups({");
    expect(composeModel).toContain("disabled");
    expect(settingsPopover).toContain("Not quote-ready");
  });

  it("makes the connected wallet chip a real control with a way out", () => {
    // Clicking it while connected used to re-run connect() and change nothing.
    expect(app).toContain("if (account) setWalletOpen(true); else void actions.connectWallet();");
    expect(app).toContain("<WalletDialog");
    expect(walletDialog).toContain("<Modal");
    expect(walletDialog).toContain('variant="danger"');
    expect(walletDialog).toContain("Disconnect");
    expect(walletDialog).toContain("onDisconnect");
    // The wallet's own chain is stated, and it is not the destination network.
    expect(app).toContain("walletChainLabel(state.chainId.value, state.networkCatalog.value)");
    expect(walletDialog).toContain("Wallet network");
    expect(walletDialog).toContain("Bridging to");
    expect(store).toContain("async function disconnectWallet()");
    expect(store).toContain("disconnectWallet,");
    // A journey that has begun signing keeps running server-side; hiding it is
    // not disconnecting from it.
    expect(store).toContain("if (runInFlight || walletConnectPromise) return null");
    expect(store).toContain("persistence.clear(account)");
    expect(store).toContain("orchestrator.forget()");
    expect(walletSource).toContain("async disconnect()");
    expect(walletSource).toContain("wallet_revokePermissions");
    expect(walletSource).toContain("if (this.disconnected && account) return");
  });

  it("gives every control a programmatic name", () => {
    expect(app).toContain("walletAriaLabel(account)");
    expect(shellModel).toContain('return account ? `Connected wallet ${shortAddress(account)}` : "Connect MetaMask"');
    expect(app).toContain("activityLabel(activityCount)");
    expect(sendBox).toContain("ariaLabel={token ?");
    expect(hbarRow).toContain('label="Exact HBAR to receive on Hedera"');
    expect(assetPicker).toContain('<span class="sr-only">Search assets and chains</span>');
    expect(uiPrimitives.Skeleton).toContain("aria-label={label}");
  });
});

describe("shell landmarks, focus, and live status", () => {
  it("uses one banner, one main, one footer, and a single h1", () => {
    expect(app.match(/<header class="top-bar">/g)).toHaveLength(1);
    expect(app.match(/<main /g)).toHaveLength(1);
    expect(app.match(/<footer /g)).toHaveLength(1);
    expect(app.match(/<h1 /g)).toHaveLength(1);
    for (const source of surfaces) {
      if (source === app) continue;
      expect(source).not.toContain("<h1");
    }
    expect(journeyChrome).toContain("<h2");
    expect(uiPrimitives.Modal).toContain("<h2 id={titleId}");
    expect(activityDrawer).toContain("<h3>");
  });

  it("moves focus to the stage on a view change without stealing it on load", () => {
    expect(app).toContain("const stageRef = useRef(null)");
    expect(app).toContain('tabIndex={-1}');
    expect(app).toContain("surfaceFocusKey({");
    expect(app).toContain("if (firstRender.current)");
    expect(app).toContain("stageRef.current?.focus?.({ preventScroll: true })");
    expect(shellModel).toContain("export function surfaceFocusKey({");
    expect(appCss).toContain(".stage:focus { outline: none; }");
  });

  it("announces async status politely from one live region", () => {
    expect(app).toContain('role="status" aria-live="polite"');
    expect(app).toContain("shellStatus({");
    expect(shellModel).toContain("export function shellStatus({");
    expect(composeCard).toContain('aria-live="polite"');
    expect(composeCard).toContain('role="alert"');
    expect(activityDrawer).toContain('aria-live="polite"');
    expect(uiPrimitives.Meter).toContain('role="status"');
    expect(uiPrimitives.Button).toContain('aria-busy={loading ? "true" : undefined}');
  });
});

describe("design system", () => {
  it("keeps one card, token, state, focus, disabled, and loading grammar", () => {
    for (const marker of [
      ".ui-card {", ".ui-button--primary {", ".ui-button--primary:disabled {", ".ui-button:disabled {",
      ".ui-token-glyph {", ".ui-state-pill--success", ".ui-state-pill--warning", ".ui-chip {",
      ".ui-meter__track {", ".ui-disclosure__summary {", ".ui-timeline__step {", ".ui-ring {",
      ".ui-skeleton__line {", ":focus-visible",
    ]) expect(css).toContain(marker);
    expect(tokensCss).toContain("--gradient-primary");
    // Exactly one gradient call to action; everything else is neutral.
    expect(section(uiCss, ".ui-button--primary {", ".ui-button--secondary {")).toContain("background: var(--gradient-primary)");
    for (const variant of ["secondary", "ghost", "danger"]) {
      expect(section(uiCss, `.ui-button--${variant} {`, "}")).not.toContain("gradient");
    }
  });

  it("uses a system font stack and loads nothing from the network", () => {
    expect(tokensCss).toContain("--font-sans: system-ui,");
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toContain("url(http");
    expect(css).not.toContain("fonts.googleapis");
    expect(css).not.toContain("@font-face");
    expect(html).not.toContain("<link rel=\"preconnect\"");
    for (const source of everySource) {
      expect(source).not.toMatch(/https?:\/\/(?!localhost)[a-z]+\.(googleapis|gstatic|jsdelivr|unpkg|cdn)/);
    }
  });

  it("is responsive from desktop to 360px with no page-level horizontal scroll", () => {
    expect(baseCss).toContain("overflow-x: hidden");
    expect(tokensCss).toContain("--card-width: 480px");
    expect(appCss).toContain("@media (max-width: 860px)");
    expect(appCss).toContain("@media (max-width: 720px)");
    expect(appCss).toContain("@media (max-width: 440px)");
    expect(composeCss).toContain("@media (max-width: 420px)");
    expect(journeyCss).toContain("@media (max-width: 440px)");
    expect(appCss).toContain("max-width: var(--card-width)");
    expect(css).not.toMatch(/\.compose\s*\{[^}]*(?<!max-|min-)width:\s*\d+px/);
    expect(css).not.toMatch(/\.journey-surface\s*\{[^}]*(?<!max-|min-)width:\s*\d+px/);
    // Wide content scrolls inside its own container, never the page.
    expect(baseCss).toContain(".scroll-x");
    expect(routeStrip).toContain("scroll-x");
    expect(composeCss).toContain("@media (pointer: coarse)");
    expect(composeCss).toContain("min-height: 44px");
  });

  it("honours prefers-reduced-motion on every animated affordance", () => {
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(baseCss).toContain("animation-duration: 0.001ms !important");
    expect(baseCss).toContain("animation-iteration-count: 1 !important");
    // compose.css declares no animation of its own any more, so the global
    // base.css reduction is the whole contract for that surface.
    expect(composeCss).not.toContain("animation:");
    expect(journeyCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(journeyCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,320}animation: none !important/);
  });

  it("supports light theme by preference and by explicit override in both directions", () => {
    expect(tokensCss).toContain("@media (prefers-color-scheme: light)");
    expect(tokensCss).toContain(':root:not([data-theme="dark"])');
    expect(tokensCss).toContain(':root[data-theme="light"]');
    expect(tokensCss).toContain("color-scheme: dark");
    expect(tokensCss).toContain("color-scheme: light");
    expect(html).toContain('content="dark light"');
  });

  it("deduplicates broken token-icon fetches and falls back deterministically", () => {
    expect(uiPrimitives.iconCache).toContain("const cache = new Map()");
    expect(uiPrimitives.iconCache).toContain('cached?.state === "loading"');
    expect(uiPrimitives.iconCache).toContain('cached?.state === "loaded" || cached?.state === "failed"');
    expect(uiPrimitives.iconCache).toContain('probe.addEventListener?.("error", () => settle("failed"), { once: true })');
    expect(uiPrimitives.iconCache).toContain("export function fallbackMark(label)");
    expect(uiPrimitives.TokenPill).toContain("observeIcon(icon, setState)");
  });

  it("serves LCX artwork from the product release instead of a missing external icon", () => {
    const lcx = mainnetCatalog.assets.find((asset: any) => asset.id === "axelar:mainnet:lcx");
    expect(lcx.icon).toBe("/tokens/lcx.svg");
    expect(lcx.originTokens[0].icon).toBe("/tokens/lcx.svg");
    expect(fs.existsSync(path.join(root, "public", "tokens", "lcx.svg"))).toBe(true);
  });
});

describe("copy discipline", () => {
  it("speaks plain language on the surface and keeps evidence behind Details", () => {
    expect(journeyModel).toContain("Approve the conversion allowance");
    expect(journeyModel).toContain("Waiting for arrival");
    expect(composeModel).toContain("Refuel service fee (x402)");
    for (const surface of [journeyTimeline, arrivalConsent, recoveryCard, termsCard]) {
      expect(surface).not.toContain("Permit2");
      expect(surface).not.toContain("x402");
    }
    expect(journeyModel).toContain("permit2");
    expect(journeyModel).toContain("x402 payment identity");
    expect(journeyModel).toContain("export function evidenceRows({");
  });

  it("never claims funds are safe or guaranteed beyond what the server states", () => {
    for (const source of surfaces) {
      expect(source).not.toMatch(/guaranteed|funds are safe|risk-free|instant(ly)? settled/i);
    }
    expect(journeyTimeline).toContain("nothing signs without you");
    expect(journeyChrome).toContain("What the server says");
  });
});
