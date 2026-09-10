/**
 * Web shim for `@tauri-apps/api/webview`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, imports of `@tauri-apps/api/webview` resolve to this
 * module. The browser panel (native webview) is desktop-only; constructing a
 * `Webview` on the web throws a friendly error (BrowserPanel already wraps
 * webview creation in try/catch and degrades gracefully).
 */

export class Webview {
  constructor(..._args: unknown[]) {
    throw new Error("The browser panel requires the nolock desktop app (native webview)");
  }
}