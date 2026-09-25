import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSecret, getSecret, deleteSecret, migrateLegacySecrets } from "../secrets";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
describe("secret storage boundary", () => {
  beforeEach(() => { localStorage.clear(); resetTauriMocks(); mockInvoke.mockResolvedValue(null); });
  it("stores secrets in the host store without a plaintext browser copy", async () => {
    await setSecret("apiKey.example", "fixture-secret");
    expect(localStorage.getItem("nolock.apiKey.example")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("store_secret", { service: "com.nolock.app", key: "apiKey.example", value: "fixture-secret" });
    expect(await getSecret("apiKey.example")).toBe("fixture-secret");
  });
  it("keeps failed writes session-only and gives a value-free warning", async () => {
    mockInvoke.mockRejectedValue(new Error("fixture-secret"));
    const warning = vi.fn(); window.addEventListener("nolock:secret-storage-warning", warning);
    await setSecret("apiKey.example", "fixture-secret");
    expect(localStorage.length).toBe(0);
    expect(await getSecret("apiKey.example")).toBe("fixture-secret");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0].detail).not.toContain("fixture-secret");
    window.removeEventListener("nolock:secret-storage-warning", warning);
  });
  it("migrates legacy API and tool credentials out of browser storage", async () => {
    localStorage.setItem("nolock.apiKey.example", "fixture-secret");
    localStorage.setItem("nolock.toolConfig", '{"web_search":{"api_key":"fixture-brave"}}');
    localStorage.setItem("nolock.chatModel", "model");
    await migrateLegacySecrets();
    expect(Object.keys(localStorage)).toEqual(["nolock.chatModel"]);
    expect(await getSecret("toolConfig")).toContain("fixture-brave");
  });
  it("deletes the keychain copy and session copy", async () => {
    await setSecret("apiKey.example", "fixture-secret");
    await deleteSecret("apiKey.example");
    expect(await getSecret("apiKey.example")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("delete_secret", expect.objectContaining({ key: "apiKey.example" }));
  });
});
