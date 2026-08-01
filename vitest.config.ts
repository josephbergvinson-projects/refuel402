import { defineConfig } from "vitest/config";

export default defineConfig({
  // Must mirror vite.config.ts so a .jsx primitive imported by a test compiles
  // against preact rather than an absent React runtime.
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  test: {
    include: ["server/test/**/*.test.ts", "web/**/*.test.ts", "agent-kit/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
