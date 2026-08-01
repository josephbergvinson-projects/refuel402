import { describe, expect, it } from "vitest";
import { PriceProtectionRow } from "./PriceProtectionRow.jsx";

function text(node: any): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object") return text(node.props?.children);
  return String(node);
}

describe("PriceProtectionRow", () => {
  // It used to return null without a model, which meant changing the preset —
  // an action that invalidates the quote — unmounted the control mid-change.
  it("survives the quote invalidation its own controls cause", () => {
    const rendered = PriceProtectionRow({ model: null, preset: "strict" });
    expect(rendered).not.toBeNull();
    const rendering = text(rendered);
    expect(rendering).toContain("Refuel price protection");
    expect(rendering).toContain("Strict");
    expect(rendering).toContain("Get a quote to price this cap");
  });

  it("keeps the custom field and its minimum visible while a cap is being typed", () => {
    const rendering = text(PriceProtectionRow({
      model: {
        bufferBps: 500,
        options: [{ id: "strict", label: "Strict" }],
        today: { amount: "0.00069 WETH", usd: null },
        cap: { amount: "0.00073 WETH", usd: null },
        explanation: "explanation",
      },
      preset: "custom",
      customCap: "0.0001",
      symbol: "WETH",
    }));
    expect(rendering).toContain("Must be at least 0.00069 WETH");
  });

  it("prices the cap once a quote binds it", () => {
    const rendering = text(PriceProtectionRow({
      model: {
        bufferBps: 3500,
        options: [{ id: "flexible", label: "Flexible" }],
        today: { amount: "0.00069 WETH", usd: null },
        cap: { amount: "0.00080 WETH", usd: null },
        explanation: "explanation",
      },
      preset: "flexible",
    }));
    expect(rendering).toContain("0.00080 WETH");
    expect(rendering).not.toContain("Get a quote to price this cap");
  });
});
