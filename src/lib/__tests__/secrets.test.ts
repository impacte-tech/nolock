import { beforeEach, describe, expect, it } from "vitest";
import { setSecret, getSecret, deleteSecret, migrateLegacySecrets, clearSecretSession } from "../secrets";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
describe("session credentials", () => {
  beforeEach(() => { localStorage.clear(); resetTauriMocks(); clearSecretSession(); });
  it("keeps keys in memory without browser persistence or host secret commands", async () => {
    await setSecret("apiKey.openrouter", "fixture-secret");
    expect(await getSecret("apiKey.openrouter")).toBe("fixture-secret");
    expect(localStorage.length).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalled();
    clearSecretSession();
    expect(await getSecret("apiKey.openrouter")).toBeNull();
  });
  it("moves legacy browser values into this session without accessing a password manager", async () => {
    localStorage.setItem("nolock.apiKey.openrouter", "fixture-secret");
    localStorage.setItem("nolock.toolConfig", '{"web_search":{"api_key":"fixture-brave"}}');
    localStorage.setItem("nolock.chatModel", "model");
    await migrateLegacySecrets();
    expect(Object.keys(localStorage)).toEqual(["nolock.chatModel"]);
    expect(await getSecret("toolConfig")).toContain("fixture-brave");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
  it("clears an in-memory credential without touching host vaults", async () => {
    await setSecret("apiKey.openrouter", "fixture-secret");
    await deleteSecret("apiKey.openrouter");
    expect(await getSecret("apiKey.openrouter")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
