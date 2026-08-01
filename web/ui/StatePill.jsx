import { cx } from "./dom.js";

/**
 * StatePill — a small status token.
 * props: { children, tone?: "neutral"|"success"|"warning"|"danger"|"brand",
 *          dot?: boolean, hint?, live?: "off"|"polite", class?, ...rest }
 * Set live="polite" when the pill's text changes as a background check resolves.
 */
export function StatePill({ children, tone = "neutral", dot = false, hint, live = "off", class: className, ...rest }) {
  return (
    <span
      class={cx("ui-state-pill", `ui-state-pill--${tone}`, className)}
      title={hint}
      aria-live={live === "off" ? undefined : live}
      {...rest}
    >
      {dot ? <span class="ui-state-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
