import { cx } from "./dom.js";

const MARKERS = { done: "✓", current: "●", action_required: "!", pending: null };

/**
 * Timeline — vertical journey rail.
 * props: { label: string, children: TimelineStep[], class? }
 * Rendered as an ordered list so assistive tech announces position and count.
 */
export function Timeline({ label, children, class: className }) {
  return (
    <ol class={cx("ui-timeline", className)} aria-label={label}>
      {children}
    </ol>
  );
}

/**
 * TimelineStep — one node on the rail.
 * props: {
 *   status: "done"|"current"|"pending"|"action_required",
 *   title: string,
 *   detail?: preact.ComponentChildren,   // one line of plain-language context
 *   statusLabel?: string,                // spoken status; defaults per status
 *   index?: number,                      // shown inside a pending node
 *   marker?: preact.ComponentChildren,   // overrides the default glyph
 *   link?: { href: string, label: string },   // per-step explorer link
 *   children?,                            // extra body content (notes, chips)
 *   class?
 * }
 */
export function TimelineStep({
  status = "pending",
  title,
  detail,
  statusLabel,
  index,
  marker,
  link,
  children,
  class: className,
}) {
  const spoken = statusLabel ?? {
    done: "Done",
    current: "Current",
    action_required: "Action needed",
    pending: "Pending",
  }[status];
  return (
    <li class={cx("ui-timeline__step", `is-${status}`, className)}>
      <span class="ui-timeline__rail" aria-hidden="true">
        <span class="ui-timeline__node">{marker ?? MARKERS[status] ?? (index === undefined ? "" : index)}</span>
        <span class="ui-timeline__bar" />
      </span>
      <div class="ui-timeline__body">
        <p class="ui-timeline__title">
          {title}
          <span class="sr-only">{` — ${spoken}`}</span>
        </p>
        {detail ? <p class="ui-timeline__detail">{detail}</p> : null}
        {link
          ? <a class="ui-timeline__link" href={link.href} target="_blank" rel="noreferrer">{link.label} ↗</a>
          : null}
        {children}
      </div>
    </li>
  );
}
