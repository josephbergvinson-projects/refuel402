import { AmountInput, Chip, ChipGroup, Modal, StatePill } from "../ui/index.js";
import { deriveSettingsSummary } from "../compose-view-model.js";

const SLIPPAGE_PRESETS = ["0.50", "1.00", "2.00"];

/**
 * Provider policy and max slippage — everything that shapes the quote but is not
 * an amount. Rendered as a focus-trapped dialog rather than a floating panel so
 * it is keyboard- and touch-operable with no positioning primitive.
 */
export function SettingsPopover({
  open,
  onClose,
  providers,
  provider,
  onProvider,
  network,
  routeMode,
  mode,
  slippagePercent,
  onSlippage,
  slippageLimitPercent,
  locked = false,
}) {
  const slippageNumber = Number(slippagePercent);
  const slippageInvalid = !Number.isFinite(slippageNumber) || slippageNumber < 0.01 || slippageNumber > slippageLimitPercent;

  return (
    <Modal open={open} onClose={onClose} title="Route settings" size="sm" class="compose-settings">
      <fieldset class="compose-settings__block" disabled={locked}>
        <legend>Bridge provider</legend>
        <div class="compose-settings__providers" role="radiogroup" aria-label="Bridge provider">
          {providers.map((candidate) => {
            const active = candidate.id === provider?.id;
            const blocked = !candidate.runtime?.quoteReady;
            return (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={active ? "true" : "false"}
                class={`compose-settings__provider${active ? " is-active" : ""}`}
                onClick={() => onProvider?.(candidate)}
              >
                <span class="compose-settings__provider-copy">
                  <span class="compose-settings__provider-name">
                    {candidate.label}
                    {blocked ? <StatePill tone="warning">Not quote-ready</StatePill> : null}
                  </span>
                  <span class="compose-settings__provider-detail">{candidate.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset class="compose-settings__block" disabled={locked}>
        <legend>Maximum slippage</legend>
        <div class="compose-settings__slippage">
          <ChipGroup label="Slippage presets">
            {SLIPPAGE_PRESETS.map((value) => (
              <Chip
                key={value}
                selected={Number(value) === slippageNumber}
                onSelect={() => onSlippage?.(value)}
              >
                {value}%
              </Chip>
            ))}
          </ChipGroup>
          <span class="compose-settings__slippage-field">
            <AmountInput
              value={slippagePercent}
              onInput={onSlippage}
              size="sm"
              align="right"
              label="Maximum slippage percent"
              invalid={slippageInvalid}
              suffix="%"
            />
          </span>
        </div>
        <p class={`compose-settings__hint${slippageInvalid ? " is-invalid" : ""}`}>
          {slippageInvalid
            ? `Enter between 0.01% and ${slippageLimitPercent.toFixed(2)}% — the server refuses anything outside its policy.`
            : "A hard cap on the destination swap. The route reverts rather than exceed it."}
        </p>
      </fieldset>

      <p class="compose-settings__summary">{deriveSettingsSummary({ provider, network, slippagePercent, routeMode, mode })}</p>
      {locked ? <p class="compose-settings__hint">A journey is in progress, so its consented settings are fixed.</p> : null}
    </Modal>
  );
}
