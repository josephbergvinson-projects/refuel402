import { useRef } from "preact/hooks";
import { cx, rovingIndex } from "./dom.js";

/**
 * Segmented — the Bridge | Bridge+Refuel and Testnet | Mainnet control.
 * props: {
 *   options: Array<{ value: string, label: string, hint?: string, disabled?: boolean }>,
 *   value: string,
 *   onChange: (value: string) => void,
 *   label: string,          // accessible group name (required)
 *   size?: "sm"|"md",
 *   disabled?: boolean,     // locks the whole group
 *   class?: string,
 * }
 * radiogroup semantics: exactly one tab stop, arrows/Home/End move and select.
 */
export function Segmented({ options = [], value, onChange, label, size = "md", disabled = false, class: className }) {
  const groupRef = useRef(null);

  const select = (option) => {
    if (disabled || option.disabled || option.value === value) return;
    onChange?.(option.value);
  };

  const onKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const enabled = options.filter((option) => !option.disabled);
    if (!enabled.length) return;
    event.preventDefault();
    const current = enabled.findIndex((option) => option.value === value);
    const next = enabled[rovingIndex(current, enabled.length, event.key)];
    if (!next) return;
    select(next);
    const buttons = [...(groupRef.current?.querySelectorAll("[role='radio']") ?? [])];
    buttons[options.indexOf(next)]?.focus();
  };

  return (
    <div
      ref={groupRef}
      class={cx("ui-segmented", `ui-segmented--${size}`, disabled ? "is-disabled" : "", className)}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active ? "true" : "false"}
            tabIndex={active ? 0 : -1}
            class={cx("ui-segmented__option", active ? "is-active" : "")}
            disabled={disabled || option.disabled === true}
            title={option.hint}
            onClick={() => select(option)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
