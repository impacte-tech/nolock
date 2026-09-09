/**
 * Web shim for `@tauri-apps/plugin-shell`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, `import { open } from "@tauri-apps/plugin-shell"`
 * resolves to this module instead. The desktop build keeps the real plugin.
 *
 * On the web the app already runs IN a browser, so "open with the system
 * handler" simply means opening a new browser tab.
 */

export async function open(path: string): Promise<void> {
  window.open(path, "_blank", "noopener,noreferrer");
}
