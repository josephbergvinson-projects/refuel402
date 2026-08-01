import { cx } from "./dom.js";

/** Keeps a controlled decimal string free of spinner/exponent/sign noise. */
export function sanitizeDecimal(raw) {
  const cleaned = String(raw ?? "").replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}

/**
 * AmountInput — the large tabular numeral field.
 * props: {
 *   value: string, onInput: (value: string) => void,
 *   size?: "lg"|"md"|"sm",     // lg = 30px hero numeral, md = 22px inline
 *   placeholder?, disabled?, readOnly?, invalid?, id?, name?,
 *   label?: string,            // accessible name when no visible <label> exists
 *   describedBy?: string, hint?, align?: "left"|"right", suffix?, sanitize?,
 *   onFocus?, onBlur?, class?
 * }
 * type="text" with inputMode="decimal": no spinner, no locale-dependent parsing,
 * and the value stays exactly the string the caller owns.
 */
export function AmountInput({
  value,
  onInput,
  size = "lg",
  placeholder = "0",
  disabled = false,
  readOnly = false,
  invalid = false,
  label,
  describedBy,
  hint,
  align = "left",
  suffix,
  sanitize = true,
  class: className,
  ...rest
}) {
  const handleInput = (event) => {
    const next = sanitize ? sanitizeDecimal(event.currentTarget.value) : event.currentTarget.value;
    if (sanitize && next !== event.currentTarget.value) event.currentTarget.value = next;
    onInput?.(next);
  };

  return (
    <span class={cx("ui-amount", `ui-amount--${size}`, `ui-amount--${align}`, invalid ? "is-invalid" : "", className)}>
      <input
        class="ui-amount__input tabular no-clip"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellcheck={false}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={label}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
        title={hint}
        onInput={handleInput}
        {...rest}
      />
      {suffix ? <span class="ui-amount__suffix" aria-hidden="true">{suffix}</span> : null}
    </span>
  );
}
