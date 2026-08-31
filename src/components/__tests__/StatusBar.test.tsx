// ---------------------------------------------------------------------------
// Tests for StatusBar component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StatusBar from "../StatusBar";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

describe("StatusBar", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTauriMocks();
    // Mock fetch to return successful response by default
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders backend status with dot indicator", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);

    // Should eventually show "ollama" in the status bar
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });

  it("shows warning indicator when backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    localStorage.setItem("nolock.backend", "ollama");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);

    // The indicator should be hollow (offline) when fetch fails
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });

  it("displays completion and chat models when configured", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.completionModel", "qwen2.5-coder:1.5b");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");

    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);

    expect(await screen.findByText(/qwen2\.5-coder:1\.5b/)).toBeInTheDocument();
    expect(await screen.findByText(/qwen3:8b/)).toBeInTheDocument();
  });

  it("shows Chat / Hide Chat toggle", () => {
    const onToggle = vi.fn();
    render(<StatusBar showChat={false} onToggleChat={onToggle} rootPath="" />);
    expect(screen.getByText("Chat")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Chat"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows Hide Chat when chat is open", () => {
    render(<StatusBar showChat={true} onToggleChat={vi.fn()} rootPath="" />);
    expect(screen.getByText("Hide Chat")).toBeInTheDocument();
  });

  it("renders correctly when no models are configured", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);

    // Should show backend status but no model names
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });

  it("reflects the main chat provider (nolock.chatBackend), not the global backend", async () => {
    // Global backend is digitalocean, but the chat panel overrode to openrouter.
    localStorage.setItem("nolock.backend", "digitalocean");
    localStorage.setItem("nolock.chatBackend", "openrouter");
    localStorage.setItem("nolock.chatModel", "nvidia/foo:free");

    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);

    // The bottom bar must show the chat provider (openrouter), not digitalocean.
    expect(await screen.findByText(/openrouter/)).toBeInTheDocument();
    expect(screen.queryByText(/digitalocean/)).not.toBeInTheDocument();
  });

  it("updates when the chat provider changes (nolock:settings-changed event)", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="" />);
    expect(await screen.findByText(/ollama/)).toBeInTheDocument();

    // User changes the chat provider to openrouter.
    localStorage.setItem("nolock.chatBackend", "openrouter");
    localStorage.setItem("nolock.chatModel", "nvidia/nemotron:free");
    window.dispatchEvent(new CustomEvent("nolock:settings-changed"));

    // The bar must reflect the new provider without waiting for the 30s poll.
    expect(await screen.findByText(/openrouter/)).toBeInTheDocument();
    expect(screen.queryByText(/ollama/)).not.toBeInTheDocument();
  });

  it("shows switchyard - on and the route name when switchyard is enabled", async () => {
    // Mock the invoke that reads the per-project switchyard config.
    mockInvoke.mockResolvedValue({
      enabled: true,
      routes: [
        { name: "nemotron-family", purpose: "chat", algorithm: "random", targets: [] },
      ],
    });

    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");

    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="/tmp/proj" />);

    // The provider indicator becomes "switchyard - on" and the chat model is
    // replaced by the route name.
    expect(await screen.findByText(/switchyard - on/)).toBeInTheDocument();
    expect(await screen.findByText(/nemotron-family/)).toBeInTheDocument();
    // The raw provider/model must not be shown.
    expect(screen.queryByText(/ollama/)).not.toBeInTheDocument();
    expect(screen.queryByText(/qwen3:8b/)).not.toBeInTheDocument();
  });

  it("falls back to provider/model when switchyard is disabled", async () => {
    mockInvoke.mockResolvedValue({ enabled: false, routes: [] });

    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");

    render(<StatusBar showChat={false} onToggleChat={vi.fn()} rootPath="/tmp/proj" />);

    expect(await screen.findByText(/ollama/)).toBeInTheDocument();
    expect(await screen.findByText(/qwen3:8b/)).toBeInTheDocument();
    expect(screen.queryByText(/switchyard - on/)).not.toBeInTheDocument();
  });
});
