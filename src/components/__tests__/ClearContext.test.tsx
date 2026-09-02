// ---------------------------------------------------------------------------
// Regression tests: "Clear context" must produce a COMPLETELY new context
// window.
//
// Covered regressions:
// 1. Clearing context while a request is in flight used to let the stale
//    request write its result into the fresh session — the old response, its
//    reported context_tokens (context meter) and its usage entries all bled
//    into the new session, so "prompting again" ran on the old context window.
// 2. A stopped generation set a stop flag that was never reset, silently
//    discarding every future response — starting a new session now clears it.
// 3. After clearing, the next prompt's outgoing payload must contain ONLY the
//    new message (no history from the cleared conversation).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

let aiChatCalls: { req: { messages: { role: string; content: string }[] } }[] = [];
let aiChatResolver: ((v: any) => void) | null = null;

function setupMocks() {
  aiChatCalls = [];
  aiChatResolver = null;
  mockInvoke.mockImplementation((cmd: string, _args?: any) => {
    if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "ai_chat") {
      aiChatCalls.push(_args);
      return new Promise((resolve) => {
        aiChatResolver = resolve;
      });
    }
    return Promise.resolve(null);
  });
}

function setupLocalStorage() {
  localStorage.clear();
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.chatModel", "nemotron:9b");
}

async function send(text: string) {
  const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText("Send"));
}

describe("ChatPanel clear context", () => {
  beforeEach(() => {
    resetTauriMocks();
    setupLocalStorage();
    setupMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("clearing context mid-request discards the stale response and its context meter", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);

    // Send a prompt whose response we keep pending.
    await send("remember the word BANANA");
    await waitFor(() => expect(aiChatResolver).not.toBeNull());

    // Clear context while the request is still in flight.
    const clearBtn = document.querySelector(".clear-context-btn") as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn);

    // The chat empties (fresh session) once the clear completes.
    await waitFor(() => {
      expect(document.querySelector(".clear-context-btn")).toBeNull();
    });

    // NOW the stale request resolves with a big context report — it must be
    // discarded entirely: no response text, no context-meter pollution.
    await act(async () => {
      aiChatResolver?.({ content: "stale old response", tool_calls: [], context_tokens: 9000 });
    });

    await waitFor(() => {
      expect(screen.queryByText("stale old response")).toBeNull();
    });
    // The persistent context bar stays hidden — the new session has no context.
    expect(document.querySelector(".context-persistent-bar")).toBeNull();
  });

  it("prompting after clear sends ONLY the new message (completely fresh window)", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);

    await send("remember the word BANANA");
    await waitFor(() => expect(aiChatResolver).not.toBeNull());
    await act(async () => {
      aiChatResolver?.({ content: "ok", tool_calls: [], context_tokens: 100 });
    });
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());

    // Clear context, then prompt again.
    fireEvent.click(document.querySelector(".clear-context-btn") as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector(".clear-context-btn")).toBeNull();
    });

    await send("what did I ask you to remember?");
    await waitFor(() => expect(aiChatCalls.length).toBe(2));

    const outgoing = aiChatCalls[1].req.messages;
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].role).toBe("user");
    expect(outgoing[0].content).toContain("what did I ask you to remember?");
    // The cleared conversation must not leak into the new context window.
    expect(JSON.stringify(outgoing)).not.toContain("BANANA");
  }, 15000);

  it("a stopped generation does not silence the next session", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);

    // Start a generation and stop it while streaming.
    await send("first prompt");
    await waitFor(() => expect(aiChatResolver).not.toBeNull());
    const stopBtn = document.querySelector(".stop-generation-btn") as HTMLButtonElement;
    expect(stopBtn).not.toBeNull();
    fireEvent.click(stopBtn);

    // The stopped request resolves — its response is discarded.
    await act(async () => {
      aiChatResolver?.({ content: "stopped response", tool_calls: [] });
    });
    await waitFor(() => expect(screen.queryByText("stopped response")).toBeNull());

    // Clear context (resets the stop flag), then prompt again — the new
    // response must actually appear instead of being silently discarded.
    fireEvent.click(document.querySelector(".clear-context-btn") as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector(".clear-context-btn")).toBeNull();
    });

    await send("second prompt");
    await waitFor(() => expect(aiChatCalls.length).toBe(2));
    await act(async () => {
      aiChatResolver?.({ content: "fresh response", tool_calls: [] });
    });
    await waitFor(() => expect(screen.getByText("fresh response")).toBeInTheDocument());
  }, 15000);
});
