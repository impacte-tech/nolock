/**
 * Web shim for `@tauri-apps/api/core`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, every `import { invoke } from "@tauri-apps/api/core"`
 * resolves to this module instead. The desktop build keeps the real Tauri IPC.
 *
 * `invoke` POSTs to the nolock-server (`src-tauri/src/bin/nolock-server.rs`)
 * which dispatches to the exact same Rust command functions the desktop app
 * uses. Errors reject with the raw error string, matching Tauri semantics.
 */

import { getToken } from "./auth";

interface InvokeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown> | undefined,
  _options?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    throw `nolock-server unreachable (${String(e)})`;
  }

  let body: InvokeEnvelope<T> | null = null;
  try {
    body = (await res.json()) as InvokeEnvelope<T>;
  } catch {
    body = null;
  }

  if (!res.ok || !body || body.ok === false) {
    const message =
      body?.error ?? `nolock-server error (HTTP ${res.status} ${res.statusText})`;
    // Tauri's invoke rejects with the raw error value (a string for
    // Result<_, String> commands) — mirror that so existing catch blocks work.
    throw body?.error ?? message;
  }

  return body.data as T;
}
