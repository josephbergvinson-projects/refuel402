import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Browser source is intentionally plain ESM JavaScript.
import { fallbackMark, iconState, observeIcon, resetIconCache } from "./icon-cache.js";

class FakeImage {
  src = "";
  handlers = new Map<string, (() => void)[]>();
  addEventListener(type: string, handler: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  fire(type: string) {
    for (const handler of this.handlers.get(type) ?? []) handler();
  }
}

describe("icon cache", () => {
  beforeEach(() => resetIconCache());

  it("probes a URL once and shares the outcome with every later observer", () => {
    const created: FakeImage[] = [];
    const createImage = () => {
      const image = new FakeImage();
      created.push(image);
      return image;
    };
    const first: string[] = [];
    const second: string[] = [];
    observeIcon("/tokens/lcx.svg", (state: string) => first.push(state), { createImage });
    observeIcon("/tokens/lcx.svg", (state: string) => second.push(state), { createImage });
    expect(created).toHaveLength(1);

    created[0]!.fire("load");
    expect(first).toEqual(["loaded"]);
    expect(second).toEqual(["loaded"]);
    expect(iconState("/tokens/lcx.svg")).toBe("loaded");

    expect(observeIcon("/tokens/lcx.svg", () => undefined, { createImage }).state).toBe("loaded");
    expect(created).toHaveLength(1);
  });

  it("never re-fetches a URL that already failed", () => {
    const created: FakeImage[] = [];
    const createImage = () => {
      const image = new FakeImage();
      created.push(image);
      return image;
    };
    observeIcon("/broken.png", () => undefined, { createImage });
    created[0]!.fire("error");
    expect(iconState("/broken.png")).toBe("failed");
    expect(observeIcon("/broken.png", () => undefined, { createImage }).state).toBe("failed");
    expect(created).toHaveLength(1);
  });

  it("drops an unsubscribed observer before the probe settles", () => {
    const created: FakeImage[] = [];
    const createImage = () => {
      const image = new FakeImage();
      created.push(image);
      return image;
    };
    const seen: string[] = [];
    const observed = observeIcon("/late.svg", (state: string) => seen.push(state), { createImage });
    observed.unsubscribe();
    created[0]!.fire("load");
    expect(seen).toEqual([]);
  });

  it("uses a deterministic two-character fallback mark", () => {
    expect(fallbackMark("usdc")).toBe("US");
    expect(fallbackMark(null)).toBe("?");
  });
});
