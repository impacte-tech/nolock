/**
 * Web-only server config (fetched once from `GET /api/config`).
 *
 * The nolock-server exposes optional deployment config — currently the
 * llama.cpp service URL (from the `LLAMACPP_URL` Railway reference variable).
 * This lets the web app auto-wire the llama.cpp provider URL without manual setup.
 */

import { getToken } from "./auth";

interface ServerConfig {
  llamacppUrl?: string | null;
}

let cached: Promise<ServerConfig> | null = null;

/**
 * Fetch the server config and cache it for the session.
 *
 * The endpoint requires the same Bearer token as every other `/api` route, so
 * the stored/URL token is attached here (an unauthenticated call 401s on any
 * deployment with `NOLOCK_WEB_TOKEN` set and the config would be silently
 * lost). A failed fetch is NOT cached — the next call retries, so the config
 * is picked up as soon as a valid token exists (e.g. right after login).
 */
export function getServerConfig(): Promise<ServerConfig> {
  if (!cached) {
    const token = getToken();
    cached = fetch("/api/config", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) {
          cached = null; // retry on the next call (e.g. after login)
          return {} as ServerConfig;
        }
        return res.json();
      })
      .then((body) => (body && typeof body === "object" ? body : {}))
      .catch(() => {
        cached = null; // network error — retry on the next call
        return {} as ServerConfig;
      });
  }
  return cached;
}

/** The auto-wired llama.cpp service URL (or null when not configured). */
export async function getLlamacppUrl(): Promise<string | null> {
  const cfg = await getServerConfig();
  return cfg.llamacppUrl || null;
}
