import { AmountInput, StatePill, TokenGlyph } from "../ui/index.js";

/**
 * The product's signature control: the exact HBAR you will hold on arrival, edited
 * in place. It is an output row that is also an input — the EXACT badge and the
 * accent tint are what say the number is a promise, not an estimate.
 */
export function HbarExactRow({ row, value, onInput, disabled = false, error = null, stale = false }) {
  const meta = error
    ? { text: error, tone: "danger", title: null }
    : {
        text: [row.fiat?.text ?? row.fiatPlaceholder, stale ? "needs a fresh quote" : row.detail?.text]
          .filter(Boolean).join(" · "),
        tone: stale ? "warning" : "muted",
        title: [row.fiat?.title ?? row.fiatPlaceholderTitle, row.detail?.title].filter(Boolean).join(" · "),
      };

  return (
    <div class="compose-row compose-row--exact">
      <TokenGlyph
        symbol={row.symbol}
        icon={row.icon ?? null}
        chainLabel={row.chain?.label}
        chainIcon={row.chain?.icon ?? null}
      />
      <div class="compose-row__copy">
        <p class="compose-row__title">
          {row.label}
          <StatePill tone="brand" hint="Exact output: the destination swap delivers this amount or it does not execute.">{row.badge}</StatePill>
        </p>
        <p class="compose-row__caption">{row.caption}</p>
      </div>
      <div class="compose-row__value">
        <span class="compose-row__field">
          <AmountInput
            value={value}
            onInput={onInput}
            size="md"
            align="right"
            label="Exact HBAR to receive on Hedera"
            describedBy="compose-hbar-meta"
            disabled={disabled}
            invalid={Boolean(error)}
            placeholder="0"
            class="compose-row__input"
          />
          <span class="compose-row__unit" aria-hidden="true">{row.glyph}</span>
        </span>
        <p class={`compose-row__meta no-clip compose-row__meta--${meta.tone}`} id="compose-hbar-meta" title={meta.title ?? undefined}>
          {meta.text}
        </p>
      </div>
    </div>
  );
}
