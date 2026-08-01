import { cx } from "./dom.js";

/**
 * Card — the surface grammar. `tone` picks the elevation token; nothing else.
 * props: { as?, tone?: "card"|"raised"|"field", padded?, interactive?, hint?, class?, children, ...rest }
 */
export function Card({
  as: Tag = "section",
  tone = "card",
  padded = true,
  interactive = false,
  hint,
  class: className,
  children,
  ...rest
}) {
  return (
    <Tag
      class={cx("ui-card", `ui-card--${tone}`, padded ? "ui-card--padded" : "", interactive ? "ui-card--interactive" : "", className)}
      title={hint}
      {...rest}
    >
      {children}
    </Tag>
  );
}
