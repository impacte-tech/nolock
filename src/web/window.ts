/**
 * Web shim for `@tauri-apps/api/window`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, imports of `@tauri-apps/api/window` resolve to this
 * module. The browser panel (native webview) is desktop-only; these helpers
 * throw a friendly error if ever used on the web.
 */

class WebWindow {
  constructor(..._args: unknown[]) {
    throw new Error("Window APIs are only available in the nolock desktop app");
  }
}

export function getCurrentWindow(): WebWindow {
  throw new Error("Window APIs are only available in the nolock desktop app");
}

export function getAllWindows(): WebWindow[] {
  throw new Error("Window APIs are only available in the nolock desktop app");
}

export class Window extends WebWindow {}