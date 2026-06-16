/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In test mode, monaco-editor cannot be resolved because its package.json has
// no `main` / `exports` fields (only `module`).  We swap in a lightweight mock
// at the module‑resolution level so that tests can load components importing it.
const testAliases =
  process.env.NODE_ENV === "test" || process.env.VITEST
    ? {
        "monaco-editor": path.resolve(
          __dirname,
          "src/test/__mocks__/monaco-editor.ts",
        ),
      }
    : {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: testAliases,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
