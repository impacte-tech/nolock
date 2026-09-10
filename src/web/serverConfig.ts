/**
 * Web-only server config (fetched once from `GET /api/config`).
 *
 * The nolock-server exposes optional deployment config — currently the
 * llama.cpp service URL (from the `LLAMACPP_URL` Railway reference variable).
 * This lets the web app auto-wire the llama.cpp provider URL without manual setup.
 */

interface ServerConfig {
  llamacppUrl?: string | null;
}

let cached: Promise<ServerConfig> | null = null;

/** Fetch the server config once and cache it for the session. */
export function getServerConfig(): Promise<ServerConfig> {
  if (!cached) {
    cached = fetch("/api/config")
      .then((res) => (res.ok ? res.json() : {}))
      .then((body) => (body && typeof body === "object" ? body : {}))
      .catch(() => ({}));
  }
  return cached;
}

/** The auto-wired llama.cpp service URL (or null when not configured). */
export async function getLlamacppUrl(): Promise<string | null> {
  const cfg = await getServerConfig();
  return cfg.llamacppUrl || null;
}