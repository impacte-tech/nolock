/**
 * Web auth helpers — token storage for the nolock web deployment.
 *
 * The server (nolock-server) runs with `NOLOCK_WEB_TOKEN` set and requires a
 * Bearer token on every `/api` call. This module stores the token the user
 * enters on the login page and exposes it to the web shims (`core.ts`,
 * `event.ts`).
 *
 * Storage precedence:
 *   1. localStorage    — "remember me" (persists across browser restarts)
 *   2. sessionStorage  — per-tab session (cleared when the tab closes)
 *   3. URL `?token=`   — shared links / bookmarks
 */

const LS_KEY = "nolock.webToken";
const SS_KEY = "nolock.webToken.session";

/** Current access token, or null when not authenticated. */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const remembered = localStorage.getItem(LS_KEY);
    if (remembered) return remembered;
  } catch {
    /* storage unavailable */
  }
  try {
    const session = sessionStorage.getItem(SS_KEY);
    if (session) return session;
  } catch {
    /* storage unavailable */
  }
  const urlToken = new URLSearchParams(window.location.search).get("token");
  return urlToken && urlToken.trim() ? urlToken.trim() : null;
}

/** Store the token. `remember` keeps it in localStorage (survives restarts). */
export function setToken(token: string, remember: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (remember) {
      localStorage.setItem(LS_KEY, token);
      sessionStorage.removeItem(SS_KEY);
    } else {
      sessionStorage.setItem(SS_KEY, token);
      localStorage.removeItem(LS_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

/** Forget the token everywhere (sign out). */
export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* storage unavailable */
  }
  try {
    sessionStorage.removeItem(SS_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** True when a token is present (does not validate it). */
export function hasToken(): boolean {
  return getToken() !== null;
}

/**
 * True when a token is persisted in localStorage/sessionStorage — i.e. NOT
 * one that only came from the URL `?token=` parameter (which `getToken`
 * reads as a fallback but never stores).
 */
export function hasStoredToken(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (localStorage.getItem(LS_KEY)) return true;
  } catch {
    /* storage unavailable */
  }
  try {
    if (sessionStorage.getItem(SS_KEY)) return true;
  } catch {
    /* storage unavailable */
  }
  return false;
}