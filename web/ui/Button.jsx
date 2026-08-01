import { cx } from "./dom.js";

/**
 * Button — one gradient primary, everything else neutral.
 * props: {
 *   variant?: "primary"|"secondary"|"ghost"|"danger",
 *   size?: "sm"|"md"|"lg",
 *   block?, loading?, disabled?, type?, hint?, onClick?, class?, children, ...rest
 * }
 * A loading button is disabled and announces aria-busy; it never swallows its
 * label, so the surface never loses the word the user clicked.
 */
export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  loading = false,
  disabled = false,
  type = "button",
  hint,
  class: className,
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      class={cx("ui-button", `ui-button--${variant}`, `ui-button--${size}`, block ? "ui-button--block" : "", loading ? "is-loading" : "", className)}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      title={hint}
      {...rest}
    >
      {loading ? <span class="ui-button__spinner" aria-hidden="true" /> : null}
      <span class="ui-button__label">{children}</span>
    </button>
  );
}
