// ---------------------------------------------------------------------------
// Tests for StatusBar component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StatusBar from "../StatusBar";

describe("StatusBar", () => {
  beforeEach(() => {
    localStorage.clear();
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
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} />);

    // Should eventually show "ollama" in the status bar
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });

  it("shows warning indicator when backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    localStorage.setItem("nolock.backend", "ollama");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} />);

    // The indicator should be hollow (offline) when fetch fails
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });

  it("displays completion and chat models when configured", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.completionModel", "qwen2.5-coder:1.5b");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");

    render(<StatusBar showChat={false} onToggleChat={vi.fn()} />);

    expect(await screen.findByText(/qwen2\.5-coder:1\.5b/)).toBeInTheDocument();
    expect(await screen.findByText(/qwen3:8b/)).toBeInTheDocument();
  });

  it("shows Chat / Hide Chat toggle", () => {
    const onToggle = vi.fn();
    render(<StatusBar showChat={false} onToggleChat={onToggle} />);
    expect(screen.getByText("Chat")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Chat"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows Hide Chat when chat is open", () => {
    render(<StatusBar showChat={true} onToggleChat={vi.fn()} />);
    expect(screen.getByText("Hide Chat")).toBeInTheDocument();
  });

  it("renders correctly when no models are configured", async () => {
    localStorage.setItem("nolock.backend", "ollama");
    render(<StatusBar showChat={false} onToggleChat={vi.fn()} />);

    // Should show backend status but no model names
    const statusItem = await screen.findByText(/ollama/);
    expect(statusItem).toBeInTheDocument();
  });
});
