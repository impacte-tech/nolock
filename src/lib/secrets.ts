/** API credentials live only in memory for this app session. No host vault APIs. */
const session = new Map<string, string>();
export async function setSecret(key: string, value: string): Promise<void> {
  session.set(key, value);
  localStorage.removeItem(`nolock.${key}`);
}
export async function getSecret(key: string): Promise<string | null> {
  const legacy = localStorage.getItem(`nolock.${key}`);
  if (legacy !== null) { await setSecret(key, legacy); }
  return session.get(key) ?? null;
}
export async function deleteSecret(key: string): Promise<void> {
  session.delete(key);
  localStorage.removeItem(`nolock.${key}`);
}
/** Move old browser copies into this session; never read a password manager. */
export async function migrateLegacySecrets(): Promise<void> {
  const old = localStorage.getItem("nolock.apiKey");
  if (old !== null) {
    const backend = localStorage.getItem("nolock.backend") || "ollama";
    if (!(await getSecret(`apiKey.${backend}`))) await setSecret(`apiKey.${backend}`, old);
    localStorage.removeItem("nolock.apiKey");
  }
  await Promise.all(Object.keys(localStorage).filter(k => k.startsWith("nolock.apiKey.") || k === "nolock.toolConfig").map(k => getSecret(k.slice(7))));
}
export function clearSecretSession(): void { session.clear(); }
