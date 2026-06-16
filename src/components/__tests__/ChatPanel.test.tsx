// ---------------------------------------------------------------------------
// Smoke tests for ChatPanel component (with Tauri API mocks)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

describe("ChatPanel", () => {
  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("zencode.backend", "ollama");
    localStorage.setItem("zencode.url", "http://localhost:11434");
    localStorage.setItem("zencode.chatModel", "qwen3:8b");
    // Make invoke succeed with a default response
    mockInvoke.mockResolvedValue({ content: "Test response", tool_calls: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("renders empty chat state", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    expect(screen.getByText("Ask anything about your code...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask the AI...")).toBeInTheDocument();
    expect(screen.getByText("Send")).toBeInTheDocument();
  });

  it("renders header with close button", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    expect(screen.getByText("Agent Chat")).toBeInTheDocument();
    expect(screen.getByText("\u00D7")).toBeInTheDocument(); // close button
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<ChatPanel onClose={onClose} onOpenUrl={vi.fn()} />);
    fireEvent.click(screen.getByText("\u00D7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows typing in the input area", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    const input = screen.getByPlaceholderText("Ask the AI...") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hello AI" } });
    expect(input.value).toBe("Hello AI");
  });

  it("shows warning when no chat model is configured", async () => {
    localStorage.removeItem("zencode.chatModel");
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(
        screen.getByText(/No chat model configured/),
      ).toBeInTheDocument();
    });
  });

  it("sends message and displays response", async () => {
    mockInvoke.mockResolvedValue({ content: "Hello! I'm an AI.", tool_calls: [] });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "Hi there" } });
    fireEvent.click(screen.getByText("Send"));

    // User message should appear
    expect(screen.getByText("Hi there")).toBeInTheDocument();

    // Response should appear
    await waitFor(() => {
      expect(screen.getByText("Hello! I'm an AI.")).toBeInTheDocument();
    });
  });

  it("shows error message when invoke fails", async () => {
    mockInvoke.mockRejectedValue(new Error("Connection refused"));

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText(/Error: Connection refused/)).toBeInTheDocument();
    });
  });

  it("prepends https:// to URLs in the global openUrl handler", async () => {
    const onOpenUrl = vi.fn();
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={onOpenUrl} />);

    // Simulate a link click via the global handler
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "example";
    document.body.appendChild(anchor);

    fireEvent.click(anchor);

    // The globalOpenUrl handler should have been called
    await waitFor(() => {
      expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/");
    });

    document.body.removeChild(anchor);
  });

  it("shows 'thinking...' state while loading", async () => {
    // Make the invoke promise pending
    mockInvoke.mockReturnValue(new Promise(() => {})); // never resolves

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("thinking...")).toBeInTheDocument();
  });

  it("disables send button while loading", () => {
    mockInvoke.mockReturnValue(new Promise(() => {}));

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    expect(screen.getByText("Thinking...")).toBeDisabled();
  });

  it("sends message on Enter key (without Shift)", () => {
    mockInvoke.mockResolvedValue({ content: "OK", tool_calls: [] });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("does not send empty messages", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText("Ask the AI...");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Send"));

    // No messages should appear
    expect(screen.getByText("Ask anything about your code...")).toBeInTheDocument();
  });
});
