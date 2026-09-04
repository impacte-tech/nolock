// ---------------------------------------------------------------------------
// Smoke tests for ChatPanel component (with Tauri API mocks)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, mockListen, resetTauriMocks } from "../../test/tauri-mock";

describe("ChatPanel", () => {
  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    // Make invoke succeed with a default response
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_model_info") {
        return Promise.resolve({ context_length: 8192 });
      }
      return Promise.resolve({ content: "Test response", tool_calls: [] });
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("renders empty chat state", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    expect(screen.getByText(/Ask anything about your code/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask the AI/)).toBeInTheDocument();
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
    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hello AI" } });
    expect(input.value).toBe("Hello AI");
  });

  it("shows warning when no chat model is configured", async () => {
    localStorage.removeItem("nolock.chatModel");
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
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

    const input = screen.getByPlaceholderText(/Ask the AI/);
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

    const input = screen.getByPlaceholderText(/Ask the AI/);
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

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("Thinking...")).toBeInTheDocument();
  });

  it("disables send button while loading", () => {
    mockInvoke.mockReturnValue(new Promise(() => {}));

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    expect(screen.getByText("Thinking...")).toBeDisabled();
  });

  it("sends message on Enter key (without Shift)", () => {
    mockInvoke.mockResolvedValue({ content: "OK", tool_calls: [] });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("does not send empty messages", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Send"));

    // No messages should appear
    expect(screen.getByText(/Ask anything about your code/)).toBeInTheDocument();
  });

  // ---- Keyboard shortcut tests (Linux/Windows) --------------------------
  // NOTE: These tests verify the keyboard event routing (preventDefault behavior).
  // Full undo/redo state updates require trusted (isTrusted=true) input events,
  // which synthetic fireEvent.change() cannot produce. The undo/redo logic itself
  // is exercised by the macOS Tauri event listener tests.

  it("Ctrl+Z calls preventDefault (intercepts for custom undo)", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");
    input.dispatchEvent(keyDownEvent);

    // Ctrl+Z should be intercepted (preventDefault called) to stop native undo
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("Ctrl+Y calls preventDefault (intercepts for custom redo)", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "y",
      ctrlKey: true,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");
    input.dispatchEvent(keyDownEvent);

    // Ctrl+Y should be intercepted (preventDefault called)
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("Ctrl+Shift+Z calls preventDefault (intercepts for custom redo)", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");
    input.dispatchEvent(keyDownEvent);

    // Ctrl+Shift+Z should be intercepted (preventDefault called)
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("Ctrl+X does NOT call preventDefault (lets browser handle cut)", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");
    input.dispatchEvent(keyDownEvent);

    // Ctrl+X should NOT be intercepted — let browser handle cut natively
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it("Ctrl+A does NOT call preventDefault (lets browser handle selectAll)", () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    const keyDownEvent = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(keyDownEvent, "preventDefault");
    input.dispatchEvent(keyDownEvent);

    // Ctrl+A should NOT be intercepted — let browser handle selectAll natively
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  // ---- Context limit counter tracks mid-session settings changes ----------

  it("updates the context limit counter when the Context Window setting changes mid-session", async () => {
    // Cloud backend → the configured Context Window (nolock.contextLength) is
    // the meter denominator (no local auto-detection override).
    localStorage.setItem("nolock.chatBackend", "openrouter");
    localStorage.setItem("nolock.chatModel", "nvidia/nemotron:free");
    localStorage.setItem("nolock.contextLength", "1000");

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "ai_chat") {
        return Promise.resolve({ content: "Done", tool_calls: [], context_tokens: 500 });
      }
      return Promise.resolve(null);
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    // 500 / 1,000 tokens = 50%
    await waitFor(() => {
      expect(screen.getByTitle("500 tokens / 1,000 tokens")).toBeInTheDocument();
    });

    // User changes the Context Window to 2000 in the Chat Model panel and
    // saves — the panel writes localStorage then dispatches the event.
    localStorage.setItem("nolock.contextLength", "2000");
    window.dispatchEvent(new CustomEvent("nolock:settings-changed"));

    // The meter denominator must update immediately: 500 / 2,000 = 25%.
    await waitFor(() => {
      expect(screen.getByTitle("500 tokens / 2,000 tokens")).toBeInTheDocument();
    });
  });

  it("re-detects the context window when the local chat model changes mid-session", async () => {
    // Local backend (ollama default from beforeEach) → the model's real
    // context length is auto-detected via get_model_info.
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_model_info") {
        const model = args?.req?.model ?? "";
        return Promise.resolve({ context_length: model === "llama3:70b" ? 131_072 : 8_192 });
      }
      if (cmd === "ai_chat") {
        return Promise.resolve({ content: "Done", tool_calls: [], context_tokens: 100 });
      }
      return Promise.resolve(null);
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Send"));

    // Initial auto-detection for qwen3:8b → 8,192.
    await waitFor(() => {
      expect(screen.getByTitle("100 tokens / 8,192 tokens")).toBeInTheDocument();
    });

    // User switches to a model with a bigger window and saves settings.
    localStorage.setItem("nolock.chatModel", "llama3:70b");
    window.dispatchEvent(new CustomEvent("nolock:settings-changed"));

    // The meter must re-detect the new model's context length immediately.
    await waitFor(() => {
      expect(screen.getByTitle("100 tokens / 131,072 tokens")).toBeInTheDocument();
    });
  });

  it("shows tool calls in the session summary opened from the picker", async () => {
    // list_sessions returns the record exactly as the Rust backend serializes
    // it: camelCase message keys, snake_case tool-call result fields. Use the
    // REAL persisted session file (67 tool calls) as the payload.
    const { readFileSync } = await import("node:fs");
    const realSession = JSON.parse(
      readFileSync("/home/amazonas/Projects/homelab/nolock/.sessions/s_mtmxtsq9_fvnd1yui.json", "utf8"),
    );
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_sessions") {
        return Promise.resolve([realSession]);
      }
      return Promise.resolve(null);
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/tmp/proj" />);

    // Open the session picker and click the session (the list loads async).
    fireEvent.click(screen.getByTitle("Sessions"));
    const item = await screen.findByText("Help me to review the security aspects of this project");
    fireEvent.click(item);

    // The summary overlay opens and lists the session's tool calls.
    await waitFor(() => {
      expect(screen.getByText(/Tool calls/)).toBeInTheDocument();
    });
    expect(screen.getAllByText("list_directory").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/67 calls/)).toBeInTheDocument();
  });

  it("persists completed tool calls into the conversation log mid-turn", async () => {
    // Keep the request in flight so the turn is ongoing when the tool completes.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "ai_chat") return new Promise(() => {});
      return Promise.resolve(null);
    });

    const { container } = render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/tmp/proj" />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "run tools" } });
    fireEvent.click(screen.getByText("Send"));

    // Let sendMessage's async setup (listener registration + assistant
    // placeholder) settle before the backend reports tool progress.
    await act(async () => {});

    // The backend reports a tool call completing mid-turn.
    const tpEntry = mockListen.mock.calls.find((call) => call[0] === "tool-progress");
    expect(tpEntry).toBeDefined();
    const handler = tpEntry![1] as (e: { payload: Record<string, unknown> }) => void;
    act(() => {
      handler({ payload: { type: "start", name: "read_file", path: "/x", arguments: '{"path":"/x"}' } });
      handler({ payload: { type: "done", name: "read_file", path: "/x", arguments: '{"path":"/x"}', result: "file body" } });
    });

    // The completed call is attached to the assistant message (rendered via the
    // persisted ToolCallBlock) IN ADDITION to the live window — so the next
    // session save persists it and the session summary shows it mid-turn.
    await waitFor(() => {
      expect(container.querySelectorAll(".tool-call-window").length).toBe(2);
    });
  });

  it("refreshes the open session summary when the sessions list updates", async () => {
    const base = {
      id: "s_live",
      summary: "Live session",
      status: "active",
      createdAt: 1700000000,
      updatedAt: 1700003600,
      messageCount: 2,
      toolCallCount: 1,
      firstMessage: "Live session",
      lastMessage: "done",
      tokenUsage: 100,
      contextWindow: 64000,
      usage: [],
    };
    const withoutCalls = {
      ...base,
      messages: [
        { role: "user", content: "Live session", displayContent: "Live session", createdAt: 1700000000, tokens: 5 },
        { role: "assistant", content: "done", createdAt: 1700000010, tokens: 2 },
      ],
    };
    const withCalls = {
      ...base,
      messages: [
        { role: "user", content: "Live session", displayContent: "Live session", createdAt: 1700000000, tokens: 5 },
        {
          role: "assistant",
          content: "done",
          createdAt: 1700000010,
          tokens: 2,
          toolCalls: [{ name: "list_directory", arguments: '{"path":"/x"}', result_snippet: "a", result_full: "a" }],
        },
      ],
    };
    let list = [withoutCalls];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_sessions") return Promise.resolve(list);
      return Promise.resolve(null);
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/tmp/proj" />);

    // Open the summary of the current session — no tool calls persisted yet.
    fireEvent.click(screen.getByTitle("Sessions"));
    fireEvent.click(await screen.findByText("Live session"));
    await waitFor(() => {
      expect(screen.getByText(/Tool calls/)).toBeInTheDocument();
    });
    expect(screen.getByText("No tool calls in this session.")).toBeInTheDocument();

    // A mid-turn save persists tool calls and refreshes the sessions list —
    // the OPEN summary must update without closing and re-opening it.
    list = [withCalls];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_sessions") return Promise.resolve(list);
      if (cmd === "ai_chat") return Promise.resolve({ content: "ok", tool_calls: [] });
      return Promise.resolve(null);
    });
    fireEvent.change(screen.getByPlaceholderText(/Ask the AI/), { target: { value: "go" } });
    fireEvent.click(screen.getByText("Send"));

    // The debounced auto-save fires (~800ms) → listSessions → summary refresh.
    await waitFor(
      () => {
        expect(screen.getAllByText("list_directory").length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 4000 },
    );
    expect(screen.queryByText("No tool calls in this session.")).not.toBeInTheDocument();
  });
});
