/** Secrets persist only in the host's secret store, never browser storage.
 * If the host store is unavailable, values survive only in this app session. */
import { invoke } from "@tauri-apps/api/core";
const SERVICE = "com.nolock.app";
const session = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
function warn(): void {
  window.dispatchEvent(new CustomEvent("nolock:secret-storage-warning", {
    detail: "Secure secret storage is unavailable. Credentials are kept only for this app session and must be entered again after restart.",
  }));
}
export async function setSecret(key: string, value: string): Promise<void> {
  session.set(key, value);
  localStorage.removeItem(`nolock.${key}`);
  // Serialize writes so an older save cannot overwrite a newer credential.
  const write = (pending.get(key) ?? Promise.resolve()).then(async () => {
    try { await invoke("store_secret", { service: SERVICE, key, value }); }
    catch { warn(); }
  });
  pending.set(key, write);
  await write;
  if (pending.get(key) === write) pending.delete(key);
}
export async function getSecret(key: string): Promise<string | null> {
  const legacy = localStorage.getItem(`nolock.${key}`);
  if (legacy !== null) {
    await setSecret(key, legacy);
    return legacy;
  }
  if (session.has(key)) return session.get(key)!;
  try {
    const value = await invoke<unknown>("get_secret", { service: SERVICE, key });
    // Don't replace a value saved while the host read was pending.
    if (session.has(key)) return session.get(key)!;
    if (typeof value === "string") { session.set(key, value); return value; }
  } catch { /* No plaintext fallback. */ }
  return null;
}
export async function deleteSecret(key: string): Promise<void> {
  session.delete(key);
  localStorage.removeItem(`nolock.${key}`);
  await pending.get(key);
  await invoke("delete_secret", { service: SERVICE, key });
}
export async function migrateLegacySecrets(): Promise<void> {
  const oldKey = localStorage.getItem("nolock.apiKey");
  if (oldKey !== null) {
    const backend = localStorage.getItem("nolock.backend") || "ollama";
    if (!(await getSecret(`apiKey.${backend}`))) await setSecret(`apiKey.${backend}`, oldKey);
    localStorage.removeItem("nolock.apiKey");
  }
  const keys = Object.keys(localStorage).filter((key) =>
    key.startsWith("nolock.apiKey.") || key === "nolock.toolConfig" || key === "nolock.apiKey");
  await Promise.all(keys.map((key) => getSecret(key.slice("nolock.".length))));
}
/** Drop in-memory credentials on sign-out (and isolate application sessions in tests). */
export function clearSecretSession(): void { session.clear(); }
