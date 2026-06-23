/**
 * OS Keychain-backed secret storage with localStorage fallback.
 *
 * Uses the native OS keyring (GNOME Keyring / KDE Wallet on Linux, Keychain on
 * macOS, Credential Manager on Windows) via Tauri Rust commands.  Falls back
 * to plain `localStorage` if the keychain is unavailable (headless, CI, etc.).
 *
 * Secret keys are namespaced under `nolock.${key}` in localStorage for
 * backward compatibility during migration.
 */

import { invoke } from "@tauri-apps/api/core";

const SERVICE = "com.nolock.app";

/** Store a secret in the OS keychain and localStorage (dual-write). */
export async function setSecret(key: string, value: string): Promise<void> {
  // Always write to localStorage for backward compat and test compatibility
  localStorage.setItem(`nolock.${key}`, value);
  try {
    await invoke("store_secret", { service: SERVICE, key, value });
  } catch {
    // Keychain unavailable — localStorage write is sufficient
  }
}

/**
 * Retrieve a secret from the OS keychain (fallback: localStorage).
 * Returns `null` if the secret does not exist.
 */
export async function getSecret(key: string): Promise<string | null> {
  try {
    const val = await invoke<unknown>("get_secret", {
      service: SERVICE,
      key,
    });
    // Only accept actual string values from the keychain
    if (typeof val === "string") return val;
  } catch {
    // Keychain unavailable — fall through to localStorage
  }
  return localStorage.getItem(`nolock.${key}`);
}

/** Delete a secret from the OS keychain and localStorage. */
export async function deleteSecret(key: string): Promise<void> {
  localStorage.removeItem(`nolock.${key}`);
  try {
    await invoke("delete_secret", { service: SERVICE, key });
  } catch {
    // Keychain unavailable — localStorage removal is sufficient
  }
}
