/**
 * Tests for the web server-config shim (`src/web/serverConfig.ts`).
 *
 * Regression coverage for the Railway deployment bug: `GET /api/config`
 * requires the same Bearer token as every other `/api` route, and a failed
 * fetch must not be cached (the config has to be re-fetched after login).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const okBody = { ok: true, llamacppUrl: "http://llamacpp.railway.internal:8080" };

function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("web serverConfig", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // `cached` is module-level state — reset the module for every test.
    vi.resetModules();
  });

  it("sends the stored token as a Bearer header", async () => {
    localStorage.setItem("nolock.webToken", "tok123");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { getLlamacppUrl } = await import("../serverConfig");
    await expect(getLlamacppUrl()).resolves.toBe(okBody.llamacppUrl);
    expect(fetchMock).toHaveBeenCalledWith("/api/config", {
      headers: { Authorization: "Bearer tok123" },
    });
  });

  it("sends no Authorization header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { getLlamacppUrl } = await import("../serverConfig");
    await expect(getLlamacppUrl()).resolves.toBe(okBody.llamacppUrl);
    expect(fetchMock).toHaveBeenCalledWith("/api/config", { headers: {} });
  });

  it("does not cache a failed (401) fetch — retries after login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(okBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { getLlamacppUrl } = await import("../serverConfig");
    // Before login: 401 → no llama.cpp URL, and the failure is not cached.
    await expect(getLlamacppUrl()).resolves.toBeNull();

    // After login the token exists — the next call retries and succeeds.
    localStorage.setItem("nolock.webToken", "tok123");
    await expect(getLlamacppUrl()).resolves.toBe(okBody.llamacppUrl);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a successful config (one fetch per session)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { getLlamacppUrl } = await import("../serverConfig");
    await getLlamacppUrl();
    await getLlamacppUrl();
    await getLlamacppUrl();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a network error as no config and retries later", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(okBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { getLlamacppUrl } = await import("../serverConfig");
    await expect(getLlamacppUrl()).resolves.toBeNull();
    await expect(getLlamacppUrl()).resolves.toBe(okBody.llamacppUrl);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
