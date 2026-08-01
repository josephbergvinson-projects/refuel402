import { cx, ringModel } from "./dom.js";

/**
 * Ring — circular countdown (quote freshness).
 * props: {
 *   remaining: number, total: number,     // same unit, usually seconds
 *   label: string,                        // accessible name, e.g. "Quote freshness"
 *   caption?: string,                     // visible text inside the ring; defaults to `remaining`
 *   size?: "sm"|"md",
 *   tone?: "brand"|"warning",
 *   hint?, class?
 * }
 * The countdown is presentation only: expiry never signs, resubmits, or
 * re-quotes anything on its own.
 */
export function Ring({ remaining, total, label, caption, size = "md", tone = "brand", hint, class: className }) {
  const model = ringModel({ remaining, total });
  return (
    <span
      class={cx("ui-ring", `ui-ring--${size}`, `ui-ring--${tone}`, model.expired ? "is-expired" : "", className)}
      style={`--ring-degrees: ${model.degrees}deg`}
      role="img"
      aria-label={`${label}: ${Math.max(0, Math.round(Number(remaining) || 0))} of ${Math.max(0, Math.round(Number(total) || 0))}`}
      title={hint}
    >
      <span class="ui-ring__center tabular">{caption ?? Math.max(0, Math.round(Number(remaining) || 0))}</span>
    </span>
  );
}
