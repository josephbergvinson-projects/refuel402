import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "server/src/index.ts"), "utf8");

describe("OpenAPI recovery contract", () => {
  it("publishes every recovery mutation path and preserves pure journey reads", () => {
    expect(source).toContain('version: "0.5.0"');
    expect(source).toContain('"/v1/product/journeys/{id}/refuel-authorization"');
    expect(source).toContain('"/v1/product/journeys/{id}/bridge/adopt"');
    expect(source).toContain('"/v1/product/journeys/{id}/reconcile-submissions"');
    expect(source).toContain('"/v1/product/journeys/{id}/source-quote"');
    expect(source).toContain('"/v1/product/journeys/{id}/destination-quote"');
    expect(source).toContain("Read a bounded, account-scoped Activity page without selecting or mutating a journey");
    expect(source).toContain("Composite Activity cursor journey-id tie-breaker");
    expect(source).toContain("Pure read of journey, effective quote, events, and server-authoritative recovery decision");
    expect(source).toContain("Resolve review state from authoritative mirror evidence without signing or resubmission");
  });
});
