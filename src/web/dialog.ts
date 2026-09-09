/**
 * Web shim for `@tauri-apps/plugin-dialog`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, `import { open } from "@tauri-apps/plugin-dialog"`
 * resolves to this module instead. The desktop build keeps the real native
 * dialog.
 *
 * A browser cannot browse the SERVER's filesystem, so folder/file picking
 * falls back to a prompt for a server-side path. On a Railway deployment the
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
  const label =
    options?.title ??
    (options?.directory
      ? "Open a server-side folder path"
      : "Open a server-side file path");
  const hint = options?.defaultPath ?? "/data";
  const value = window.prompt(`${label} (e.g. ${hint}):`, hint);
  if (!value || !value.trim()) return null;
  return options?.multiple ? [value.trim()] : value.trim();
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
