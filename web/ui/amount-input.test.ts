import { describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { sanitizeDecimal } from "./AmountInput.jsx";

describe("sanitizeDecimal", () => {
  it("keeps a plain decimal string untouched", () => {
    expect(sanitizeDecimal("25")).toBe("25");
    expect(sanitizeDecimal("0.00000001")).toBe("0.00000001");
    expect(sanitizeDecimal("25.")).toBe("25.");
  });

  it("strips signs, exponents, spaces, and grouping characters", () => {
    expect(sanitizeDecimal("-25")).toBe("25");
    expect(sanitizeDecimal("1e9")).toBe("19");
    expect(sanitizeDecimal("1 234,56")).toBe("123456");
  });

  it("collapses extra separators into a single decimal point", () => {
    expect(sanitizeDecimal("1.2.3")).toBe("1.23");
    expect(sanitizeDecimal("..5")).toBe(".5");
  });

  it("handles empty and nullish input", () => {
    expect(sanitizeDecimal("")).toBe("");
    expect(sanitizeDecimal(null)).toBe("");
  });
});
