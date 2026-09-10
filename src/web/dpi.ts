/**
 * Web shim for `@tauri-apps/api/dpi`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, imports of `@tauri-apps/api/dpi` resolve to this module.
 * The browser panel (native webview) is desktop-only, so these types throw a
 * friendly error if ever constructed on the web.
 */

export class LogicalPosition {
  constructor(..._args: unknown[]) {
    throw new Error("LogicalPosition is only available in the nolock desktop app");
  }
}

export class LogicalSize {
  constructor(..._args: unknown[]) {
    throw new Error("LogicalSize is only available in the nolock desktop app");
  }
}

export class PhysicalPosition {
  constructor(..._args: unknown[]) {
    throw new Error("PhysicalPosition is only available in the nolock desktop app");
  }
}

export class PhysicalSize {
  constructor(..._args: unknown[]) {
    throw new Error("PhysicalSize is only available in the nolock desktop app");
  }
}

export class Position {
  constructor(..._args: unknown[]) {
    throw new Error("Position is only available in the nolock desktop app");
  }
}

export class Size {
  constructor(..._args: unknown[]) {
    throw new Error("Size is only available in the nolock desktop app");
  }
}