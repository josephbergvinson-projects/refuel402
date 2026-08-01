import { useRef } from "preact/hooks";
import { cx, rovingIndex } from "./dom.js";

/**
 * Chip — one selectable preset (1 / 10 / 25 HBAR, Max, …).
 * props: { children, selected?, disabled?, hint?, tone?: "neutral"|"brand",
 *          onSelect?: () => void, class?, ...rest }
 * Standalone chips are toggle buttons (aria-pressed). Inside a ChipGroup the
 * group owns arrow-key movement.
 */
export function Chip({ children, selected = false, disabled = false, hint, tone = "neutral", onSelect, class: className, ...rest }) {
  return (
    <button
      type="button"
      class={cx("ui-chip", `ui-chip--${tone}`, selected ? "is-selected" : "", className)}
      aria-pressed={selected ? "true" : "false"}
      disabled={disabled}
      title={hint}
      onClick={() => { if (!disabled) onSelect?.(); }}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * ChipGroup — arrow-key roving focus over a row of chips.
 * props: { label: string, children, class? }
 */
export function ChipGroup({ label, children, class: className }) {
  const ref = useRef(null);

  const onKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const chips = [...(ref.current?.querySelectorAll("button:not(:disabled)") ?? [])];
    if (!chips.length) return;
    event.preventDefault();
    const index = chips.indexOf(document.activeElement);
    chips[rovingIndex(index, chips.length, event.key)]?.focus();
  };

  return (
    <div ref={ref} class={cx("ui-chip-group", className)} role="group" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
