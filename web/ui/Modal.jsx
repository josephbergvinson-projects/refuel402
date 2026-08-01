import { useEffect, useId, useRef } from "preact/hooks";
import { cx, focusableWithin } from "./dom.js";

/**
 * Modal — focus-trapped dialog / right-side drawer.
 * props: {
 *   open: boolean,
 *   onClose: () => void,
 *   title: string,                 // rendered in the header and used as the a11y name
 *   children,
 *   footer?: preact.ComponentChildren,
 *   placement?: "center"|"right",  // "right" is the Activity drawer
 *   size?: "sm"|"md"|"lg",
 *   describedBy?: string, class?
 * }
 * Escape closes, Tab cycles inside, body scroll is locked while open, and focus
 * returns to whatever opened it.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  placement = "center",
  size = "md",
  describedBy,
  class: className,
}) {
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    const body = document.body;
    const hadLock = body.classList.contains("scroll-locked");
    body.classList.add("scroll-locked");
    const panel = panelRef.current;
    (focusableWithin(panel)[0] ?? panel)?.focus?.();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(panelRef.current);
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (!hadLock) body.classList.remove("scroll-locked");
      openerRef.current?.focus?.();
      openerRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div class={cx("ui-modal", `ui-modal--${placement}`)}>
      <div class="ui-modal__backdrop" onClick={() => onClose?.()} />
      <div
        ref={panelRef}
        class={cx("ui-modal__panel", `ui-modal__panel--${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <header class="ui-modal__header">
          <h2 id={titleId} class="ui-modal__title">{title}</h2>
          <button type="button" class="ui-modal__close" aria-label={`Close ${title}`} onClick={() => onClose?.()}>×</button>
        </header>
        <div class="ui-modal__body">{children}</div>
        {footer ? <footer class="ui-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
