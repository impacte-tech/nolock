// ---------------------------------------------------------------------------
// Tests for new ChatPanel features:
//   - looksIncomplete heuristic
//   - ThinkingIndicator component
//   - Continue button visibility & behavior
//   - Thinking token streaming
//   - continueResponse flow
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel, { looksIncomplete, ThinkingIndicator } from "../ChatPanel";
import { mockInvoke, mockListen, resetTauriMocks } from "../../test/tauri-mock";

// Mock countTokens to return predictable values in tests
vi.mock("../../lib/tokenizer", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// =========================================================================
// looksIncomplete — pure-function unit tests
// =========================================================================
describe("looksIncomplete", () => {
  it("returns false for empty string", () => {
    expect(looksIncomplete("")).toBe(false);
  });

  it("returns false for complete sentences ending with period", () => {
    expect(looksIncomplete("Hello world.")).toBe(false);
    expect(looksIncomplete("This is a complete sentence!")).toBe(false);
    expect(looksIncomplete("Is this a question?")).toBe(false);
  });

  it("returns false for complete sentences ending with newline", () => {
    expect(looksIncomplete("Hello world.\n")).toBe(false);
    expect(looksIncomplete("Done.\n\n")).toBe(false);
  });

  it("returns false for text ending with closing bracket/brace/paren", () => {
    expect(looksIncomplete("const x = 1; }")).toBe(false);
    expect(looksIncomplete("arr.push(item)")).toBe(false);
    expect(looksIncomplete("arr[0]")).toBe(false);
  });

  it("returns false for text ending with semicolon", () => {
    expect(looksIncomplete("const x = 1;")).toBe(false);
  });

  it("returns false for text ending with closing backtick", () => {
    expect(looksIncomplete("Use `npm install`.")).toBe(false);
  });

  it("returns true for unclosed code fence (odd triple-backtick count)", () => {
    expect(looksIncomplete("Here is some code:\n```python\nprint('hello')")).toBe(true);
    expect(looksIncomplete("```js")).toBe(true);
  });

  it("returns false for matched code fences (even triple-backtick count)", () => {
    expect(looksIncomplete("```js\nconst x = 1;\n```")).toBe(false);
  });

  it("returns true for unclosed markdown image link", () => {
    expect(looksIncomplete("Check this ![image](")).toBe(true);
    expect(looksIncomplete("![alt text](http://example.com/img.pn")).toBe(true);
  });

  it("returns true for unclosed markdown text link", () => {
    expect(looksIncomplete("[click here](")).toBe(true);
    expect(looksIncomplete("[link](http://example.co")).toBe(true);
  });

  it("returns true for text ending mid-word (alphanumeric last char)", () => {
    expect(looksIncomplete("The function calculate")).toBe(true);
    expect(looksIncomplete("const result = 42")).toBe(true);
  });

  it("returns true for text ending with colon", () => {
    expect(looksIncomplete("Here are the steps:")).toBe(true);
  });

  it("returns true for text ending with comma", () => {
    expect(looksIncomplete("The values are 1, 2,")).toBe(true);
  });

  it("returns true for text ending with opening bracket", () => {
    expect(looksIncomplete("const arr = [")).toBe(true);
    expect(looksIncomplete("function foo() {")).toBe(true);
    expect(looksIncomplete("func(")).toBe(true);
  });

  it("returns false for text ending with closing parenthesis after a complete sentence", () => {
    expect(looksIncomplete("Done (see above).")).toBe(false);
  });

  it("returns false for whitespace-only text (empty after trim)", () => {
    expect(looksIncomplete("   ")).toBe(false);
  });
});

// =========================================================================
// ThinkingIndicator — component unit tests
// =========================================================================
describe("ThinkingIndicator", () => {
  it("renders nothing when text is empty", () => {
    const { container } = render(<ThinkingIndicator text="" />);
    expect(container.querySelector(".thinking-indicator")).toBeNull();
  });

  it("renders thinking header with label and token count", () => {
    render(<ThinkingIndicator text="Let me think about this..." />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    // "Let me think about this..." = 26 chars → 7 tokens (ceil(26/4))
    expect(screen.getByText("7 tokens")).toBeInTheDocument();
  });

  it("is collapsed by default — body is not visible", () => {
    render(<ThinkingIndicator text="Reasoning trace here" />);
    expect(screen.queryByText("Reasoning trace here")).not.toBeInTheDocument();
  });

  it("expands to show thinking text when header is clicked", () => {
    render(<ThinkingIndicator text="Reasoning trace here" />);
    fireEvent.click(screen.getByText("Thinking..."));
    expect(screen.getByText("Reasoning trace here")).toBeInTheDocument();
  });

  it("collapses when header is clicked again", () => {
    render(<ThinkingIndicator text="Reasoning trace here" />);
    fireEvent.click(screen.getByText("Thinking...")); // expand
    expect(screen.getByText("Reasoning trace here")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Thinking...")); // collapse
    expect(screen.queryByText("Reasoning trace here")).not.toBeInTheDocument();
  });

  it("displays chevron arrow indicator", () => {
    render(<ThinkingIndicator text="test" />);
    // Collapsed shows right-pointing triangle
    expect(screen.getByText("\u25B6")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Thinking..."));
    // Expanded shows down-pointing triangle
    expect(screen.getByText("\u25BC")).toBeInTheDocument();
  });

  it("formats large token counts with locale separators", () => {
    const longText = "x".repeat(1500);
    render(<ThinkingIndicator text={longText} />);
    // 1500 chars → 375 tokens (ceil(1500/4))
    expect(screen.getByText("375 tokens")).toBeInTheDocument();
  });
});

// =========================================================================
// ChatPanel — thinking token streaming integration
// =========================================================================
describe("ChatPanel — thinking token streaming", () => {
  let streamTokenHandler: ((payload: { token: string; thinking: boolean }) => void) | null = null;
  let resolveInvoke: ((value: any) => void) | null = null;

  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    localStorage.setItem("nolock.showThinking", "true");
    streamTokenHandler = null;
    resolveInvoke = null;

    // get_model_info resolves immediately, get_secret/store_secret resolve
    // with null, ai_chat hangs until we resolve it manually
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") {
        return Promise.resolve({ context_length: 8192 });
      }
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      // ai_chat hangs — we control when it resolves
      return new Promise((resolve) => {
        resolveInvoke = resolve;
      });
    });

    // Capture the stream-token listener callback so we can emit tokens in tests
    (mockListen as any).mockImplementation(async (event: string, cb: any) => {
      if (event === "stream-token") {
        streamTokenHandler = cb;
      }
      return vi.fn();
    });
  });

  afterEach(() => {
    streamTokenHandler = null;
    resolveInvoke = null;
    vi.clearAllTimers();
  });

  /** Helper: send a message and wait for the stream-token listener to be registered. */
  async function sendMessageAndWaitForStream(text: string) {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));

    // Wait until the listen mock has captured the stream-token handler
    await waitFor(() => expect(streamTokenHandler).not.toBeNull());
  }

  it("shows ThinkingIndicator when showThinking is true and thinking tokens arrive", async () => {
    await sendMessageAndWaitForStream("Think about it");

    // Emit a thinking token while loading — wrap in TauriEvent shape
    await act(async () => {
      streamTokenHandler!({ payload: { token: "Let me consider...", thinking: true } } as any);
    });

    // ThinkingIndicator should appear (use the class to distinguish from send button)
    expect(document.querySelector(".thinking-indicator")).toBeInTheDocument();
    expect(screen.getByText("5 tokens")).toBeInTheDocument();

    // Resolve the invoke to finish loading
    await act(async () => {
      resolveInvoke?.({ content: "Final answer.", tool_calls: [] });
    });
  });

  it("does not show ThinkingIndicator when showThinking is false", async () => {
    localStorage.setItem("nolock.showThinking", "false");

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Think about it" } });
    fireEvent.click(screen.getByText("Send"));

    // Wait for the listen mock to capture the handler
    await waitFor(() => expect(streamTokenHandler).not.toBeNull());

    // Emit a thinking token
    await act(async () => {
      streamTokenHandler!({ payload: { token: "Let me consider...", thinking: true } } as any);
    });

    // ThinkingIndicator should NOT appear (check by class, not text — button says "Thinking..." too)
    expect(document.querySelector(".thinking-indicator")).toBeNull();

    // Resolve invoke
    await act(async () => {
      resolveInvoke?.({ content: "Final answer.", tool_calls: [] });
    });
  });

  it("thinking tokens do not pollute the assistant message content", async () => {
    await sendMessageAndWaitForStream("Hello");

    // Emit thinking tokens, then a content token
    await act(async () => {
      streamTokenHandler!({ payload: { token: "reasoning...", thinking: true } } as any);
      streamTokenHandler!({ payload: { token: "more reasoning...", thinking: true } } as any);
      streamTokenHandler!({ payload: { token: "Hello answer.", thinking: false } } as any);
    });

    // The assistant message should contain the content token
    const assistantMsgs = document.querySelectorAll(".chat-msg.assistant .chat-markdown");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    expect(lastMsg?.textContent).toContain("Hello answer.");
    // Verify "reasoning" is NOT in any assistant message
    for (const el of assistantMsgs) {
      expect(el.textContent).not.toContain("reasoning");
    }

    // Resolve invoke
    await act(async () => {
      resolveInvoke?.({ content: "Hello answer.", tool_calls: [] });
    });
  });

  it("thinking tokens accumulate in ThinkingIndicator and clear when response completes", async () => {
    await sendMessageAndWaitForStream("Hi");

    // Emit several thinking tokens
    await act(async () => {
      streamTokenHandler!({ payload: { token: "step 1. ", thinking: true } } as any);
      streamTokenHandler!({ payload: { token: "step 2. ", thinking: true } } as any);
    });

    expect(screen.getByText("4 tokens")).toBeInTheDocument();

    // Emit a content token
    await act(async () => {
      streamTokenHandler!({ payload: { token: "Done.", thinking: false } } as any);
    });

    // Resolve invoke — the finally block clears thinkingText
    await act(async () => {
      resolveInvoke?.({ content: "Done.", tool_calls: [] });
    });

    // ThinkingIndicator should be gone
    expect(document.querySelector(".thinking-indicator")).toBeNull();
  });

  it("ThinkingIndicator is collapsible while streaming", async () => {
    await sendMessageAndWaitForStream("Hello");

    await act(async () => {
      streamTokenHandler!({ payload: { token: "thinking...", thinking: true } } as any);
    });

    // Starts collapsed — no thinking body visible
    expect(document.querySelector(".thinking-indicator-body")).toBeNull();

    // Expand — click the header
    const header = document.querySelector(".thinking-indicator-header")!;
    fireEvent.click(header);
    expect(screen.getByText("thinking...")).toBeInTheDocument();

    // Collapse — click the header again
    const headerAfter = document.querySelector(".thinking-indicator-header")!;
    fireEvent.click(headerAfter);
    expect(document.querySelector(".thinking-indicator-body")).toBeNull();

    // Resolve invoke
    await act(async () => {
      resolveInvoke?.({ content: "Final answer.", tool_calls: [] });
    });
  });
});

// =========================================================================
// ChatPanel — Continue button
// =========================================================================
describe("ChatPanel — Continue button", () => {
  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    localStorage.setItem("nolock.showThinking", "false");

    // Default: get_model_info + get_secret resolve immediately, ai_chat
    // resolves with a complete response
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return Promise.resolve({ content: "Complete response.", tool_calls: [] });
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("appears when the last assistant message ends mid-word", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return Promise.resolve({ content: "Here is the function to calculate", tool_calls: [] });
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Write a function" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Here is the function to calculate")).toBeInTheDocument();
    });

    expect(screen.getByText("Continue")).toBeInTheDocument();
  });

  it("does not appear for complete responses ending with punctuation", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return Promise.resolve({ content: "Here you go.", tool_calls: [] });
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Show me" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Here you go.")).toBeInTheDocument();
    });

    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
  });

  it("does not appear while the response is still loading", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return new Promise(() => {}); // ai_chat never resolves
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByText("Send"));

    await screen.findByText("Thinking...");

    expect(screen.queryByText("Continue")).not.toBeInTheDocument();
  });

  it("clicking Continue sends a follow-up that appends to the message", async () => {
    // Only count ai_chat calls (not get_secret/store_secret/get_model_info)
    let aiChatCalls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      aiChatCalls++;
      if (aiChatCalls === 1) {
        return Promise.resolve({ content: "Here is the code to calculate", tool_calls: [] });
      }
      return Promise.resolve({ content: " the sum of two numbers.", tool_calls: [] });
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Write a function" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Here is the code to calculate")).toBeInTheDocument();
    });

    // Click Continue
    fireEvent.click(screen.getByText("Continue"));

    // The continuation result should be appended to the existing message
    await waitFor(() => {
      const assistantMsgs = document.querySelectorAll(".chat-msg.assistant .chat-markdown");
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      expect(lastMsg?.textContent).toContain("the sum of two numbers.");
    });
  });
});

// =========================================================================
// ChatPanel — stopGeneration clears thinking
// =========================================================================
describe("ChatPanel — stop clears thinking", () => {
  let streamTokenHandler: ((payload: { token: string; thinking: boolean }) => void) | null = null;
  let resolveInvoke: ((value: any) => void) | null = null;

  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    localStorage.setItem("nolock.showThinking", "true");
    streamTokenHandler = null;
    resolveInvoke = null;

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return new Promise((resolve) => {
        resolveInvoke = resolve;
      });
    });

    (mockListen as any).mockImplementation(async (event: string, cb: any) => {
      if (event === "stream-token") {
        streamTokenHandler = cb;
      }
      return vi.fn();
    });
  });

  afterEach(() => {
    streamTokenHandler = null;
    resolveInvoke = null;
    vi.clearAllTimers();
  });

  it("stop button clears the ThinkingIndicator", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByText("Send"));

    // Wait until the listen mock has captured the stream-token handler
    await waitFor(() => expect(streamTokenHandler).not.toBeNull());

    // Emit thinking tokens
    await act(async () => {
      streamTokenHandler!({ payload: { token: "reasoning...", thinking: true } } as any);
    });

    // ThinkingIndicator is visible (check by class, not text)
    expect(document.querySelector(".thinking-indicator")).toBeInTheDocument();

    // Click stop button
    const stopBtn = screen.getByTitle("Stop generation");
    fireEvent.click(stopBtn);

    // ThinkingIndicator should be gone
    expect(document.querySelector(".thinking-indicator")).toBeNull();
  });
});

// =========================================================================
// ChatPanel — nemotron "no answer" regression smoke tests
//
// Thinking-capable Ollama models (nemotron, qwen3, deepseek-r1) can behave
// like this:
//   * stream a long `thinking` trace, then
//   * end the generation WITHOUT emitting any `content` token,
//   * OR produce a response whose only visible content is an empty string.
// nolock must not leave the user with a silently blank assistant bubble.
// These smoke tests lock in the frontend contract so a regression that
// reintroduces "sometimes it just doesn't answer" fails the suite.
// =========================================================================
describe("ChatPanel — nemotron no-answer regression", () => {
  let streamTokenHandler: ((payload: { token: string; thinking: boolean }) => void) | null = null;
  let resolveInvoke: ((value: any) => void) | null = null;

  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "nemotron:9b");
    streamTokenHandler = null;
    resolveInvoke = null;

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      return new Promise((resolve) => {
        resolveInvoke = resolve;
      });
    });

    (mockListen as any).mockImplementation(async (event: string, cb: any) => {
      if (event === "stream-token") {
        streamTokenHandler = cb;
      }
      return vi.fn();
    });
  });

  afterEach(() => {
    streamTokenHandler = null;
    resolveInvoke = null;
    vi.clearAllTimers();
  });

  async function sendMessageAndWaitForStream(text: string) {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(streamTokenHandler).not.toBeNull());
  }

  it("never dumps thinking into the main chat even when the model returns no real content", async () => {
    // Nemotron-style: only thinking tokens stream in, then invoke resolves with
    // empty content. The backend no longer dumps reasoning into the message —
    // the frontend must show a clear fallback, NOT the model's internal
    // reasoning trace.
    await sendMessageAndWaitForStream("Why is this crashing?");

    // Long reasoning bursts stream in with thinking:true. showThinking is OFF
    // here, so they must be silently discarded (the main chat must not show them).
    await act(async () => {
      streamTokenHandler!({ payload: { token: "The stack shows an out-of-bounds read", thinking: true } } as any);
      streamTokenHandler!({ payload: { token: " in the ring buffer.", thinking: true } } as any);
    });

    // Invoke resolves with empty content (the "no answer" regression case).
    await act(async () => {
      resolveInvoke!({ content: "", tool_calls: [] });
    });

    // The assistant message must not contain the reasoning trace, and must not
    // be a visually blank empty string — the frontend's
    // `responseText || "(no response)"` fallback kicks in.
    const assistantMsgs = document.querySelectorAll(".chat-msg.assistant .chat-markdown");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    expect(lastMsg?.textContent).toContain("no response");
    expect(lastMsg?.textContent).not.toContain("out-of-bounds");
  });

  it("keeps only real content tokens in the final message when thinking streamed first", async () => {
    // Nemotron produces thinking THEN a normal answer. With showThinking off the
    // thinking must NOT leak into the assistant bubble, and the answer must.
    await sendMessageAndWaitForStream("Test");

    await act(async () => {
      streamTokenHandler!({ payload: { token: "Hmm, let me reason about this carefully and explore each branch of the problem before answering.", thinking: true } } as any);
      streamTokenHandler!({ payload: { token: "The bug is a null deref in `main.rs`.", thinking: false } } as any);
    });

    const assistantMsgs = document.querySelectorAll(".chat-msg.assistant .chat-markdown");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    expect(lastMsg?.textContent).toContain("The bug is a null deref");
    expect(lastMsg?.textContent).not.toContain("Hmm, let me think");

    await act(async () => {
      resolveInvoke!({ content: "The bug is a null deref.", tool_calls: [] });
    });
  });

  it("shows a clear fallback instead of a silent blank when the model returns nothing at all", async () => {
    // The worst-case regression: model streams nothing (not even thinking) and
    // returns an empty result. The chat must not leave a trailing empty bubble.
    await sendMessageAndWaitForStream("ping");

    await act(async () => {
      resolveInvoke!({ content: "", tool_calls: [] });
    });

    // No streamed content, no thinking — frontend must surface the fallback
    // text rather than a blank assistant message.
    const assistantMsgs = document.querySelectorAll(".chat-msg.assistant .chat-markdown");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    expect(lastMsg?.textContent).toContain("no response");
  });
});
