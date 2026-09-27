import { beforeEach, expect, it } from "vitest";
import { BACKENDS, getChatBackend, getFimBackend, migrateRemovedProviders, resolveBackendUrl } from "../backends";
beforeEach(() => localStorage.clear());
it("offers exactly the supported providers", () => {
  expect(BACKENDS.map(b => b.value)).toEqual(["ollama", "llamacpp", "openrouter"]);
});
it("retires provider settings without reusing their URL or models", () => {
  localStorage.setItem("nolock.backend", "digitalocean");
  localStorage.setItem("nolock.url", "https://inference.do-ai.run/v1");
  localStorage.setItem("nolock.chatModel", "router:old");
  localStorage.setItem("nolock.completionModel", "old");
  migrateRemovedProviders();
  expect(getChatBackend()).toBe("ollama");
  expect(getFimBackend()).toBe("ollama");
  expect(resolveBackendUrl("ollama")).toBe("http://localhost:11434");
  expect(localStorage.getItem("nolock.chatModel")).toBeNull();
  expect(localStorage.getItem("nolock.completionModel")).toBeNull();
});
it("preserves valid overrides and custom endpoints during migration", () => {
  localStorage.setItem("nolock.backend", "opencode");
  localStorage.setItem("nolock.chatBackend", "openrouter");
  localStorage.setItem("nolock.chatModel", "kept");
  localStorage.setItem("nolock.url.openrouter", "https://openrouter.ai/api/v1");
  migrateRemovedProviders();
  expect(getChatBackend()).toBe("openrouter");
  expect(localStorage.getItem("nolock.chatModel")).toBe("kept");
});
