import { useEffect, useState } from "preact/hooks";
import { actions, state } from "../store.js";
import { Button, Card, Segmented, Skeleton } from "../ui/index.js";
import { tokenOptionsForNetwork } from "../product-model.js";
import {
  amountText,
  deriveFeasibility,
  derivePresets,
  derivePrimaryAction,
  derivePriceProtection,
  deriveQuoteBlockers,
  deriveQuoteFreshness,
  deriveReceiveRows,
  deriveRouteSummary,
  deriveSendFiat,
  deriveSettingsSummary,
} from "../compose-view-model.js";
import { SendBox } from "./SendBox.jsx";
import { ReceiveGroup } from "./ReceiveGroup.jsx";
import { HbarExactRow } from "./HbarExactRow.jsx";
import { KeptAssetRow } from "./KeptAssetRow.jsx";
import { PriceProtectionRow } from "./PriceProtectionRow.jsx";
import { PresetChips } from "./PresetChips.jsx";
import { FeasibilityMeter } from "./FeasibilityMeter.jsx";
import { RouteStrip } from "./RouteStrip.jsx";
import { AssetPicker } from "./AssetPicker.jsx";
import { SettingsPopover } from "./SettingsPopover.jsx";
import "./compose.css";

/**
 * The compose surface: one send, two receives.
 *
 * Every number rendered here comes from compose-view-model.js; this component
 * only wires store signals to presentational parts. No wallet call happens
 * without a click, and nothing on this surface writes the journey phase.
 */
export function ComposeCard() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [solvingMaximum, setSolvingMaximum] = useState(false);
  const [switchingNetwork, setSwitchingNetwork] = useState(false);

  const quote = state.quote.value;
  const routeMode = state.routeMode.value;
  const refuel = routeMode !== "bridge_only";
  const token = state.token.value;
  const network = state.network.value;
  const locked = state.draftLocked.value;
  const options = state.options.value;

  const secondsRemaining = state.quoteSecondsRemaining.value;

  useEffect(() => {
    if (!quote) setRouteOpen(false);
  }, [quote?.quoteId]);

  const receive = deriveReceiveRows(quote, routeMode, token?.asset
    ? { symbol: token.asset.symbol, decimals: token.asset.destination?.decimals ?? token.decimals }
    : null);
  const policyMaximum = options?.limits?.maximumConfiguredHbarTinybar ?? null;
  const feasibility = deriveFeasibility({
    quote,
    desiredHbarTinybar: state.desiredHbarTinybar.value,
    maximum: state.quoteLimit.value,
    routeMode,
    policyMaximum,
  });
  const presets = derivePresets({
    maximum: state.quoteLimit.value ?? quote?.feasibility ?? null,
    policyMaximum,
  });
  const route = deriveRouteSummary(quote);
  const priceProtection = derivePriceProtection(quote);
  const blockers = deriveQuoteBlockers(quote);
  const freshness = quote
    ? deriveQuoteFreshness({
        secondsRemaining,
        stale: state.quoteStale.value || state.quoteExpired.value,
      })
    : null;
  const balanceReady = state.tokenBalanceStatus.value === "ready" && state.tokenBalance.value !== null;
  const primary = derivePrimaryAction({
    intent: state.primaryIntent.value,
    routeMode,
    sourceAmount: state.sourceAmount.value,
    token,
    desiredHbarError: state.desiredHbarError.value,
    quote,
    quoteExpired: state.quoteExpired.value,
    balance: state.tokenBalance.value,
    balanceStatus: state.tokenBalanceStatus.value,
  });

  const solveMaximum = async () => {
    setSolvingMaximum(true);
    try {
      await actions.requestMaximumHbar();
    } finally {
      setSolvingMaximum(false);
    }
  };

  const switchNetwork = async () => {
    setSwitchingNetwork(true);
    try {
      await actions.switchToOriginNetwork();
    } finally {
      setSwitchingNetwork(false);
    }
  };

  const selectAsset = (pickedNetwork, row) => {
    if (String(pickedNetwork.chainId) !== String(network?.chainId)) actions.selectNetwork(pickedNetwork);
    actions.selectToken(row);
    setPickerOpen(false);
  };

  return (
    <Card class="compose" aria-label="Bridge to Hedera">
      <div class="compose__head">
        <Segmented
          label="Route mode"
          value={routeMode}
          disabled={locked}
          options={[
            { value: "bridge_only", label: "Bridge", hint: "Bridge your asset to Hedera with no HBAR purchase" },
            { value: "bridge_plus_refuel", label: "Bridge + Refuel", hint: "Bridge and arrive with an exact amount of HBAR for gas" },
          ]}
          onChange={(next) => { void actions.setRouteMode(next); }}
        />
        <Button
          variant="ghost"
          size="md"
          class="compose__settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen ? "true" : "false"}
          aria-label="Route settings"
          hint={deriveSettingsSummary({ provider: state.provider.value, network, slippagePercent: state.slippagePercent.value, routeMode, mode: state.mode.value })}
          onClick={() => setSettingsOpen(true)}
        >
          <span aria-hidden="true">⚙</span>
        </Button>
      </div>

      {options
        ? (
          <>
            <SendBox
              amount={state.sourceAmount.value}
              onAmount={(value) => actions.setAmount(value)}
              token={token}
              network={network}
              fiat={deriveSendFiat(quote)}
              balance={balanceReady && token ? amountText(state.tokenBalance.value, token.decimals, token.symbol) : null}
              balanceStatus={state.tokenBalanceStatus.value}
              balanceError={state.tokenBalanceError.value}
              disabled={locked}
              switching={switchingNetwork}
              onPickAsset={() => setPickerOpen(true)}
              onMax={() => actions.setMaxAmount()}
              onSwitchNetwork={() => { void switchNetwork(); }}
            />

            <div class="compose-gap" />

            <ReceiveGroup title="You receive on Hedera">
              {refuel && receive.hbar
                ? (
                  <HbarExactRow
                    row={receive.hbar}
                    value={state.desiredHbar.value}
                    onInput={(value) => actions.setDesiredHbar(value)}
                    disabled={locked}
                    error={state.desiredHbarError.value}
                    stale={Boolean(quote && (state.quoteStale.value || state.quoteExpired.value))}
                  />
                )
                : null}
              {/*
                Rendered without a live quote too. Changing the band invalidates
                the quote, and this row used to be derived purely FROM the quote,
                so editing the setting unmounted the control that edits it — the
                selection vanished mid-change with no way back except a refresh.
                A quote that exists and carries no protection terms (the asset
                cannot pre-authorize) still hides it.
              */}
              {refuel && (priceProtection || !quote)
                ? (
                  <PriceProtectionRow
                    model={priceProtection}
                    preset={state.refuelProtectionPreset.value}
                    customCap={state.customRefuelCap.value}
                    symbol={token?.asset?.symbol ?? token?.symbol ?? "asset"}
                    disabled={locked}
                    onPreset={(value) => actions.setRefuelProtectionPreset(value)}
                    onCustomCap={(value) => actions.setCustomRefuelCap(value)}
                  />
                )
                : null}
              <KeptAssetRow
                row={receive.kept}
                icon={token?.icon ?? null}
                stale={Boolean(quote && (state.quoteStale.value || state.quoteExpired.value))}
              />
            </ReceiveGroup>

            {refuel
              ? (
                <>
                  <PresetChips
                    presets={presets}
                    value={state.desiredHbar.value}
                    onSelect={(hbar) => actions.setDesiredHbar(hbar)}
                    onMax={() => { void solveMaximum(); }}
                    disabled={locked}
                    solving={solvingMaximum}
                  />
                  <FeasibilityMeter feasibility={feasibility} />
                </>
              )
              : null}

            <RouteStrip route={route} blockers={blockers} open={routeOpen} onToggle={setRouteOpen} />
          </>
        )
        : (
          <div class="compose__loading">
            <Skeleton lines={4} height="46px" label="Loading routes" />
          </div>
        )}

      {state.error.value
        ? <p class="compose__alert" role="alert">{state.error.value}</p>
        : null}

      {/* One indicator, not two. The countdown ring and the sentence beside it were
          the same number twice; the sentence is the one that says what to do when
          it runs out, so the ring is gone rather than the text. */}
      {freshness
        ? (
          <p class={`compose__freshness${freshness.warning || freshness.expired ? " is-warning" : ""}`} aria-live="polite">
            {freshness.text}
          </p>
        )
        : null}

      <Button
        variant="primary"
        size="lg"
        block
        class="compose__cta"
        disabled={primary.disabled}
        loading={primary.busy}
        hint={primary.reason ?? undefined}
        onClick={() => { void actions.submitPrimary(); }}
      >
        {primary.label}
      </Button>

      <p class="compose__under-cta" aria-live="polite">
        {primary.reason
          ? <span class="compose__reason">{primary.reason}</span>
          : <span>{primary.note ?? "You approve every step in MetaMask."}</span>}
      </p>

      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        networks={state.networkCatalog.value}
        tokensFor={(candidate, search) => tokenOptionsForNetwork(
          options,
          candidate.chainId,
          state.provider.value?.id ?? "auto",
          search,
          routeMode,
        )}
        selectedTokenId={token?.id ?? null}
        balances={balanceReady && token ? { [token.id]: state.tokenBalance.value } : {}}
        onSelect={selectAsset}
      />

      <SettingsPopover
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={state.providerCatalog.value}
        provider={state.provider.value}
        onProvider={(candidate) => actions.selectProvider(candidate)}
        network={network}
        routeMode={routeMode}
        mode={state.mode.value}
        slippagePercent={state.slippagePercent.value}
        onSlippage={(value) => actions.setSlippage(value)}
        slippageLimitPercent={(options?.limits?.maximumSlippageBps ?? 300) / 100}
        locked={locked}
      />
    </Card>
  );
}
