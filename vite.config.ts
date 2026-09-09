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

// Web deployment target (`npm run build:web`): swap the Tauri IPC/event/dialog
// modules for browser shims that talk to the nolock-server Rust backend
// (src-tauri/src/bin/nolock-server.rs). The desktop build keeps the real
// @tauri-apps modules — same source, two targets.
const webTarget = process.env.VITE_TARGET === "web";
const webAliases = webTarget
  ? {
      "@tauri-apps/api/core": path.resolve(__dirname, "src/web/core.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "src/web/event.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "src/web/dialog.ts"),
      "@tauri-apps/plugin-shell": path.resolve(__dirname, "src/web/shell.ts"),
    }
  : {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: { ...testAliases, ...webAliases },
  },
  server: {
    port: 1420,
    strictPort: true,
    // In web mode, proxy the Rust backend API (run `cargo run --bin nolock-server`
    // alongside `npm run dev:web`).
    ...(webTarget
      ? { proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } } }
      : {}),
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
