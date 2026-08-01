import { cx, meterModel } from "./dom.js";

/**
 * Meter — labelled progress with an explicit overflow state.
 * props: {
 *   label: string,            // left caption
 *   limitLabel?: string,      // right caption (e.g. the server-solved maximum)
 *   value: number|bigint|string,
 *   max: number|bigint|string,
 *   valueText?: string,       // spoken value; falls back to "<label>: N%"
 *   overflowNote?: string,    // shown under the bar when value exceeds max
 *   tone?: "brand"|"neutral",
 *   hint?, class?
 * }
 * Overflow is never silently clamped: the bar fills, gains the overflow tone,
 * and the caller's real limiting constraint is announced beside it.
 */
export function Meter({
  label,
  limitLabel,
  value,
  max,
  valueText,
  overflowNote,
  tone = "brand",
  hint,
  class: className,
}) {
  const model = meterModel({ value, max });
  const rounded = Math.round(model.percent);
  return (
    <div class={cx("ui-meter", `ui-meter--${tone}`, model.overflow ? "is-overflow" : "", className)} title={hint}>
      <div class="ui-meter__captions">
        <span class="ui-meter__label">{label}</span>
        {limitLabel ? <span class="ui-meter__limit tabular">{limitLabel}</span> : null}
      </div>
      <div
        class="ui-meter__track"
        role="progressbar"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText ?? `${label}: ${rounded}%`}
      >
        <span class="ui-meter__fill" style={`width: ${model.percent}%`} />
      </div>
      {model.overflow && overflowNote
        ? <p class="ui-meter__overflow" role="status">{overflowNote}</p>
        : null}
    </div>
  );
}
