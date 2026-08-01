import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { cx, meterModel, ringModel, rovingIndex, FOCUSABLE_SELECTOR } from "./dom.js";

describe("cx", () => {
  it("keeps only non-empty strings", () => {
    expect(cx("a", "", null, undefined, false as never, "b")).toBe("a b");
    expect(cx()).toBe("");
  });
});

describe("rovingIndex", () => {
  it("wraps in both directions and honours Home/End", () => {
    expect(rovingIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(rovingIndex(0, 3, "ArrowUp")).toBe(2);
    expect(rovingIndex(2, 3, "ArrowRight")).toBe(0);
    expect(rovingIndex(2, 3, "ArrowDown")).toBe(0);
    expect(rovingIndex(1, 3, "Home")).toBe(0);
    expect(rovingIndex(1, 3, "End")).toBe(2);
  });

  it("treats an unselected group as a move to the last item on backwards keys", () => {
    expect(rovingIndex(-1, 3, "ArrowLeft")).toBe(2);
    expect(rovingIndex(-1, 3, "ArrowRight")).toBe(0);
  });

  it("returns -1 for an empty group and ignores unrelated keys", () => {
    expect(rovingIndex(0, 0, "ArrowRight")).toBe(-1);
    expect(rovingIndex(1, 3, "Enter")).toBe(1);
  });
});

describe("meterModel", () => {
  it("reports a clamped percentage below the maximum", () => {
    const model = meterModel({ value: 25, max: 100 });
    expect(model.percent).toBe(25);
    expect(model.overflow).toBe(false);
  });

  it("flags overflow instead of silently clamping the ratio", () => {
    const model = meterModel({ value: 150, max: 100 });
    expect(model.percent).toBe(100);
    expect(model.ratio).toBeCloseTo(1.5);
    expect(model.overflow).toBe(true);
  });

  it("treats any positive request against a zero maximum as overflow", () => {
    expect(meterModel({ value: 1, max: 0 }).overflow).toBe(true);
    expect(meterModel({ value: 0, max: 0 })).toEqual({ ratio: 0, percent: 0, overflow: false });
  });

  it("accepts bigint base units", () => {
    expect(meterModel({ value: 138_000_000n, max: 1_380_000_000n }).percent).toBeCloseTo(10);
  });

  it("never returns a negative percentage", () => {
    expect(meterModel({ value: -5, max: 100 }).percent).toBe(0);
  });
});

describe("ringModel", () => {
  it("maps remaining/total onto a 360 degree sweep", () => {
    expect(ringModel({ remaining: 30, total: 60 }).degrees).toBe(180);
    expect(ringModel({ remaining: 60, total: 60 }).degrees).toBe(360);
  });

  it("clamps and marks expiry without going negative", () => {
    const expired = ringModel({ remaining: -4, total: 60 });
    expect(expired.degrees).toBe(0);
    expect(expired.expired).toBe(true);
    expect(ringModel({ remaining: 5, total: 0 })).toEqual({ ratio: 0, percent: 0, degrees: 0, expired: true });
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("excludes disabled controls and negative tab stops from the trap", () => {
    expect(FOCUSABLE_SELECTOR).toContain("button:not(:disabled)");
    expect(FOCUSABLE_SELECTOR).toContain("[tabindex]:not([tabindex='-1'])");
  });
});
