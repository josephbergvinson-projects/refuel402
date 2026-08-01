import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every component is executed at least once.
 *
 * A missing import shipped to production and the whole suite stayed green: the
 * browser harness exercises models and asserts on source text, and no test ever
 * CALLED a component, so `deriveJourneyPhases is not defined` only surfaced in
 * the owner's console on a live page.
 *
 * This does not assert what a component renders — the presentation models are
 * tested for that, and rendering assertions here would duplicate them. It
 * asserts the one thing nothing else did: that the function body can run, which
 * is what catches an unresolved identifier, a bad import path, or a typo'd
 * helper.
 *
 * Props are deliberately minimal. A component that throws on missing data is
 * fine; a component that throws because a name does not exist is not.
 */
const root = path.dirname(fileURLToPath(import.meta.url));

function componentFiles(dir: string): string[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((name) => name.endsWith(".jsx"))
    .map((name) => `./${dir}/${name}`);
}

const MODULES = [...componentFiles("journey"), ...componentFiles("compose"), ...componentFiles("ui")];

describe("every component can actually run", () => {
  it("finds the component modules to smoke", () => {
    expect(MODULES.length).toBeGreaterThan(5);
  });

  for (const specifier of MODULES) {
    it(`executes every export in ${specifier}`, async () => {
      const module = await import(specifier);
      const components = Object.entries(module)
        .filter(([name, value]) => typeof value === "function" && /^[A-Z]/.test(name));
      expect(components.length).toBeGreaterThan(0);

      for (const [name, component] of components) {
        try {
          (component as (props: unknown) => unknown)({});
        } catch (error) {
          // A ReferenceError means a name the component uses does not exist —
          // a missing import, a bad path, a typo. Nothing else in the suite
          // catches that, and it is fatal on the live page.
          if (error instanceof ReferenceError) {
            throw new Error(`${specifier} → ${name} references an undefined name: ${error.message}`);
          }
          // Anything else is this component objecting to empty props, which is
          // its right and is not what this test is about.
        }
      }
    });
  }
});
