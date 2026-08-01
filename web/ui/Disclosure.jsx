import { cx } from "./dom.js";

/**
 * Disclosure — the single optional details expander.
 * props: {
 *   summary: preact.ComponentChildren,   // the collapsed strip content
 *   children,                            // the expanded body
 *   open?: boolean,                      // controlled; pair it with onToggle
 *   defaultOpen?: boolean,               // uncontrolled initial state
 *   onToggle?: (open: boolean) => void,
 *   tone?: "field"|"raised", hint?, id?, class?
 * }
 * Native <details>/<summary>: keyboard and screen-reader behaviour come free,
 * and the expanded evidence stays in the DOM for find-in-page.
 */
export function Disclosure({
  summary,
  children,
  open,
  defaultOpen = false,
  onToggle,
  tone = "field",
  hint,
  class: className,
  ...rest
}) {
  const controlled = typeof open === "boolean";
  return (
    <details
      class={cx("ui-disclosure", `ui-disclosure--${tone}`, className)}
      open={controlled ? open : defaultOpen}
      title={hint}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      {...rest}
    >
      <summary class="ui-disclosure__summary">
        <span class="ui-disclosure__summary-body">{summary}</span>
        <span class="ui-disclosure__chevron" aria-hidden="true">▾</span>
      </summary>
      <div class="ui-disclosure__body">{children}</div>
    </details>
  );
}
