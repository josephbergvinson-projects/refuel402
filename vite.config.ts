import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: path.join(root, "web"),
  publicDir: path.join(root, "web", "public"),
  // Preact JSX through esbuild only: a Babel/plugin dependency would add a
  // runtime the CSP-sealed bundle does not need.
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    outDir: path.join(root, "dist", "web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.join(root, "web", "index.html"),
        developer: path.join(root, "web", "developer.html"),
      },
    },
    sourcemap: false,
    target: "es2022",
  },
});
