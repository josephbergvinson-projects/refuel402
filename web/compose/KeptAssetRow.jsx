import { TokenGlyph } from "../ui/index.js";

/**
 * The derived output: what the owner expects to keep at the quoted rate, after
 * the protocol fee and the HBAR purchase. The slippage floor behind it is the
 * "Minimum received" row in the route disclosure. `row.prefix` stays supported
 * because a server that has not published the expected figure is rendered as its
 * own floor with the `≥` that makes a floor honest.
 */
export function KeptAssetRow({ row, icon = null, stale = false }) {
  const meta = [row.fiat?.text ?? row.fiatPlaceholder, stale ? "needs a fresh quote" : row.detail?.text]
    .filter(Boolean)
    .join(" · ");
  return (
    <div class="compose-row compose-row--kept">
      <TokenGlyph
        symbol={row.symbol}
        icon={icon}
        chainLabel={row.chain?.label}
        chainIcon={row.chain?.icon ?? null}
      />
      <div class="compose-row__copy">
        <p class="compose-row__title">{row.label}</p>
        <p class="compose-row__caption">{row.caption}</p>
      </div>
      <div class="compose-row__value">
        <p class="compose-row__amount tabular no-clip" title={row.amount?.title}>
          {row.amount ? `${row.prefix ?? ""} ${row.amount.display}`.trim() : row.placeholder}
        </p>
        <p
          class={`compose-row__meta no-clip compose-row__meta--${stale ? "warning" : "muted"}`}
          title={[row.fiat?.title ?? row.fiatPlaceholderTitle, row.detail?.title].filter(Boolean).join(" · ")}
        >
          {meta}
        </p>
      </div>
    </div>
  );
}
