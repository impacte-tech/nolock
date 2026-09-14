/**
 * Web shim for `@tauri-apps/plugin-dialog`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, `import { open } from "@tauri-apps/plugin-dialog"`
 * resolves to this module instead. The desktop build keeps the real native
 * dialog.
 *
 * A browser cannot browse the SERVER's filesystem, so folder/file picking
 * uses an in-app selector for a server-side path. On a Railway deployment the
 * interesting paths are whatever the container can see (e.g. a mounted volume
 * at `/data`).
 */

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export async function open(
  options?: OpenDialogOptions,
): Promise<string | string[] | null> {
  const { selectServerPath } = await import("./PathDialog");
  const value = await selectServerPath(options);
  if (!value) return null;
  return options?.multiple ? [value] : value;
}

// The desktop dialog plugin also exports these; stub them so any future
// import keeps bundling (they are not used by the app today).
export async function save(): Promise<string | null> {
  return window.prompt("Save to server-side path:") || null;
}

export async function message(): Promise<void> {
  /* no-op on web */
}

export async function ask(): Promise<boolean> {
  return window.confirm("Confirm?");
}

export async function confirm(): Promise<boolean> {
  return window.confirm("Confirm?");
}
