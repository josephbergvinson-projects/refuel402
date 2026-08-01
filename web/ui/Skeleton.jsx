import { cx } from "./dom.js";

/**
 * Skeleton — loading placeholder.
 * props: { width?: string, height?: string, radius?: string, lines?: number,
 *          label?: string, class? }
 * aria-hidden by default: a spinner-shaped div is noise for screen readers, so
 * pass `label` only when the skeleton is the sole announcement of loading.
 */
export function Skeleton({ width = "100%", height = "14px", radius = "var(--radius-small)", lines = 1, label, class: className }) {
  const rows = Array.from({ length: Math.max(1, lines) });
  return (
    <span
      class={cx("ui-skeleton", className)}
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
    >
      {rows.map((_, index) => (
        <span
          key={index}
          class="ui-skeleton__line"
          style={`width: ${index === rows.length - 1 && rows.length > 1 ? "62%" : width}; height: ${height}; border-radius: ${radius}`}
        />
      ))}
    </span>
  );
}
