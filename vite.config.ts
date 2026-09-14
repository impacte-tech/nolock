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
      "@tauri-apps/api/dpi": path.resolve(__dirname, "src/web/dpi.ts"),
      "@tauri-apps/api/webview": path.resolve(__dirname, "src/web/webview.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "src/web/window.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "src/web/dialog.ts"),
      "@tauri-apps/plugin-shell": path.resolve(__dirname, "src/web/shell.ts"),
    }
  : {};

export default defineConfig({
  plugins: [
    // Redirect the remaining katex deep imports (katex.min.css / katex.min.js /
    // contrib/auto-render*) to the vendored copies in src/assets/katex/ so the
    // app never resolves files inside node_modules/katex/dist — that broke
    // fresh clones with missing or different-version katex installs.
    // Notebook.tsx keeps importing the old specifiers; the mapping is here.
    {
      name: "vendored-katex",
      enforce: "pre",
      resolveId(id) {
        const vendored = (file: string) =>
          path.resolve(__dirname, "src/assets/katex", file);
        switch (id) {
          case "katex/dist/katex.min.css":
            return vendored("katex.min.css");
          case "katex/dist/katex.min.css?raw":
            return vendored("katex.min.css") + "?raw";
          case "katex/dist/katex.min.js?raw":
            return vendored("katex.min.js") + "?raw";
          case "katex/dist/contrib/auto-render.min.js?raw":
            return vendored("auto-render.min.js") + "?raw";
          case "katex/dist/contrib/auto-render.mjs":
            return vendored("auto-render.mjs");
          default:
            return null;
        }
      },
    },
    react(),
  ],
  clearScreen: false,
  // Injected only in the web build so shared code can detect the target via
  // `typeof __WEB_TARGET__ !== "undefined" && __WEB_TARGET__` (see src/lib/webEnv.ts).
  define: webTarget ? { __WEB_TARGET__: "true" } : {},
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
      // Ignore heavy/generated trees. The .venvs/ python environments contain
      // torch's site-packages (~100k files), which exceeds the kernel's
      // fs.inotify.max_user_watches limit and crashes the dev server with
      // ENOSPC. Bytecode caches and build output are noise for HMR anyway.
      ignored: [
        "**/src-tauri/**",
        "**/.venvs/**",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/dist/**",
      ],
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
