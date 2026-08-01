/**
 * Pure helpers shared by the UI primitives. Nothing here knows about journeys,
 * quotes, or wallets; everything is deterministic and unit-tested.
 */

export function cx(...parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join(" ");
}

function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Roving-focus index for Segmented/Chip groups. Wraps on both ends and honours
 * Home/End. Horizontal and vertical arrows are both accepted because the same
 * grammar is used for a row of chips and a stacked list.
 */
export function rovingIndex(currentIndex, count, key) {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return currentIndex <= 0 ? count - 1 : currentIndex - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return (currentIndex + 1) % count;
  return currentIndex;
}

/**
 * Labelled progress geometry. `overflow` is the meaningful state: a request that
 * exceeds the server-solved maximum reads as a full bar plus an overflow flag
 * rather than a silently clamped one.
 */
export function meterModel({ value, max } = {}) {
  const numericValue = Math.max(0, toNumber(value));
  const numericMax = Math.max(0, toNumber(max));
  if (numericMax === 0) {
    const overflow = numericValue > 0;
    return { ratio: overflow ? Infinity : 0, percent: overflow ? 100 : 0, overflow };
  }
  const ratio = numericValue / numericMax;
  return {
    ratio,
    percent: Math.max(0, Math.min(100, ratio * 100)),
    overflow: ratio > 1,
  };
}

/** Circular countdown geometry for the quote-freshness ring. */
export function ringModel({ remaining, total } = {}) {
  const numericTotal = toNumber(total);
  const numericRemaining = toNumber(remaining);
  if (numericTotal <= 0) return { ratio: 0, percent: 0, degrees: 0, expired: true };
  const ratio = Math.max(0, Math.min(1, numericRemaining / numericTotal));
  return {
    ratio,
    percent: ratio * 100,
    degrees: ratio * 360,
    expired: numericRemaining <= 0,
  };
}

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function focusableWithin(root) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (element) => element.offsetParent !== null || element === root,
  );
}
