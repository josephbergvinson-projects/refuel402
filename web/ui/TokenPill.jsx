import { useEffect, useState } from "preact/hooks";
import { cx } from "./dom.js";
import { fallbackMark, observeIcon } from "./icon-cache.js";

/**
 * TokenGlyph — the round token mark with an optional chain badge.
 * props: { icon?: string|null, symbol: string, chainIcon?: string|null,
 *          chainLabel?: string, size?: "sm"|"md" }
 * A URL that fails once is never re-fetched; the symbol fallback is used instead.
 */
export function TokenGlyph({ icon, symbol, chainIcon, chainLabel, size = "md" }) {
  const [state, setState] = useState(() => (icon ? "loading" : "none"));

  useEffect(() => {
    if (!icon) { setState("none"); return undefined; }
    const observed = observeIcon(icon, setState);
    setState(observed.state);
    return observed.unsubscribe;
  }, [icon]);

  return (
    <span class={cx("ui-token-glyph", `ui-token-glyph--${size}`)} data-symbol={symbol}>
      {state === "loaded"
        ? <img class="ui-token-glyph__image" src={icon} alt="" loading="lazy" decoding="async" />
        : <span class="ui-token-glyph__mark" aria-hidden="true">{fallbackMark(symbol)}</span>}
      {chainLabel
        ? (
          <span class="ui-token-glyph__chain" title={chainLabel}>
            {chainIcon
              ? <img src={chainIcon} alt="" loading="lazy" decoding="async" />
              : <span aria-hidden="true">{fallbackMark(chainLabel).slice(0, 1)}</span>}
          </span>
        )
        : null}
    </span>
  );
}

/**
 * TokenPill — combined token/chain selector trigger.
 * props: {
 *   symbol: string, label?: string, icon?: string|null,
 *   chainLabel?: string, chainIcon?: string|null,
 *   secondary?: string,          // small text under the label
 *   chevron?: boolean,           // defaults to true when onClick is provided
 *   onClick?: () => void, disabled?, hint?, size?: "sm"|"md",
 *   ariaLabel?: string, class?
 * }
 * Rendered as a button when it opens a selector, and as a static span otherwise,
 * so a read-only pill is never a phantom tab stop.
 */
export function TokenPill({
  symbol,
  label,
  icon = null,
  chainLabel,
  chainIcon = null,
  secondary,
  chevron,
  onClick,
  disabled = false,
  hint,
  size = "md",
  ariaLabel,
  class: className,
  ...rest
}) {
  const interactive = typeof onClick === "function";
  const showChevron = chevron === undefined ? interactive : chevron;
  const Tag = interactive ? "button" : "span";
  const body = (
    <>
      <TokenGlyph icon={icon} symbol={symbol} chainIcon={chainIcon} chainLabel={chainLabel} size={size} />
      <span class="ui-token-pill__copy">
        <span class="ui-token-pill__label">{label ?? symbol}</span>
        {secondary ? <span class="ui-token-pill__secondary">{secondary}</span> : null}
      </span>
      {showChevron ? <span class="ui-token-pill__chevron" aria-hidden="true">▾</span> : null}
    </>
  );

  return (
    <Tag
      class={cx("ui-token-pill", `ui-token-pill--${size}`, interactive ? "is-interactive" : "", className)}
      type={interactive ? "button" : undefined}
      disabled={interactive ? disabled : undefined}
      onClick={interactive ? onClick : undefined}
      aria-label={ariaLabel}
      aria-haspopup={interactive ? "listbox" : undefined}
      title={hint}
      {...rest}
    >
      {body}
    </Tag>
  );
}
