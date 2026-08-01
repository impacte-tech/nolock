// ---------------------------------------------------------------------------
// Tests for Hooks → ChatPanel integration:
//   - Completed hook outputs appear as visible "Hook result" messages in the
//     chat thread (and failed runs as "Hook failed" error blocks)
//   - Those messages are serialized as system context in subsequent chat
//     requests and in the "Continue" request
//   - Replayed / finished runs never duplicate their visible block
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
import { runHook, resetHookStateForTests } from "../../lib/hooks";

// Mock countTokens to return predictable values in tests
vi.mock("../../lib/tokenizer", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

function setup() {
  resetTauriMocks();
  resetHookStateForTests();
  localStorage.clear();
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.chatModel", "qwen3:8b");
  localStorage.setItem("nolock.showThinking", "false");
  localStorage.setItem("nolock.toolsEnabled", "[]");
  localStorage.setItem("nolock.toolConfig", "{}");
  localStorage.setItem("nolock.chatSystemPrompt", "Default system prompt.");
}

const HOOK_RESULT = "HOOK_RESULT_TEXT: three critical issues found in staged changes.";

/**
 * Mock invoke. `ai_chat` requests are captured in `aiChatReqs`; hook-run
 * requests (whose user message mentions the manual trigger description) get
 * HOOK_RESULT, chat requests get a generic reply.
 */
function isHookRunMessages(messages: any[]): boolean {
  return messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.toLowerCase().includes("triggered manually"),
  );
}

function mockWithAiChatCapture(aiChatReqs: any[]) {
  mockInvoke.mockImplementation((cmd: string, args?: any) => {
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "store_secret") return Promise.resolve(null);
    if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
    if (cmd === "ai_chat") {
      aiChatReqs.push(args);
      const messages = args?.req?.messages || [];
      if (isHookRunMessages(messages)) {
        return Promise.resolve({ content: HOOK_RESULT, tool_calls: [] });
      }
      return Promise.resolve({ content: "A generic chat reply.", tool_calls: [] });
    }
    // Anything else (list commands, skill reads, etc.) resolves harmlessly.
    return Promise.resolve({ content: "", tool_calls: [] });
  });
}

describe("ChatPanel — hook output context injection", () => {
  beforeEach(() => {
    setup();
  });

  it("includes a completed hook's output as system context in the next chat request", async () => {
    const aiChatReqs: any[] = [];
    mockWithAiChatCapture(aiChatReqs);

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/proj" />);

    // Run a hook to completion — this fires run-start/run-done events that the
    // panel subscribes to and records in its completed-hook context.
    await act(async () => {
      await runHook("/proj", {
        name: "commit-review",
        description: "",
        trigger: { type: "command", command: "git commit" },
        agent: { name: "", prompt: "You are a reviewer.", skills: [], tools: [] },
      }, { kind: "manual" });
    });

    // Send a follow-up chat message.
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "What did the hook find?" } });
    fireEvent.click(screen.getByText("Send"));

    // Wait for the chat ai_chat request to be issued.
    await waitFor(() => {
      expect(
        aiChatReqs.some(
          (a) => a?.req?.messages?.[0]?.content?.includes("[Hook run: commit-review]"),
        ),
      ).toBe(true);
    });

    const chatReq = aiChatReqs.find(
      (a) => a?.req?.messages?.[0]?.content?.includes("[Hook run: commit-review]"),
    );
    expect(chatReq).toBeTruthy();

    const msgs = chatReq.req.messages;
    // The first message is the hook-context system message.
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("[Hook run: commit-review]");
    expect(msgs[0].content).toContain("Triggered manually");
    expect(msgs[0].content).toContain(HOOK_RESULT);
    // The user's actual question is still present in the conversation.
    expect(
      msgs.some((m: any) => m.role === "user" && m.content.includes("What did the hook find?")),
    ).toBe(true);
  });

  it("shows a completed hook's output as a visible block in the chat thread", async () => {
    const aiChatReqs: any[] = [];
    mockWithAiChatCapture(aiChatReqs);

    const { container } = render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/proj" />);

    // No hook-result blocks before any hook runs.
    expect(container.querySelectorAll(".hook-result-block").length).toBe(0);

    // Run a hook to completion — this fires run-start/run-done events that the
    // panel subscribes to and appends as a visible message in the thread.
    await act(async () => {
      await runHook("/proj", {
        name: "commit-review",
        description: "",
        trigger: { type: "command", command: "git commit" },
        agent: { name: "", prompt: "You are a reviewer.", skills: [], tools: [] },
      }, { kind: "manual" });
    });

    // The completed output appears directly in the chat, not inside a card.
    const blocks = container.querySelectorAll(".hook-result-block");
    expect(blocks.length).toBe(1);
    expect(blocks[0].classList.contains("error")).toBe(false);
    expect(screen.getByText("Hook result: commit-review")).toBeInTheDocument();
    expect(screen.getByText("Triggered manually")).toBeInTheDocument();
    expect(screen.getByText(/HOOK_RESULT_TEXT/)).toBeInTheDocument();

    // No "Hook: commit-review" run card remains once the hook is done.
    expect(screen.queryByText("Hook: commit-review")).not.toBeInTheDocument();
  });

  it("shows a failed hook as an error block in the chat thread", async () => {
    // Hook-run ai_chat requests fail; chat requests still succeed.
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "ai_chat") {
        const messages = args?.req?.messages || [];
        if (isHookRunMessages(messages)) {
          return Promise.reject(new Error("model unavailable"));
        }
        return Promise.resolve({ content: "A generic chat reply.", tool_calls: [] });
      }
      return Promise.resolve({ content: "", tool_calls: [] });
    });

    const { container } = render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/proj" />);

    await act(async () => {
      await runHook("/proj", {
        name: "commit-review",
        description: "",
        trigger: { type: "command", command: "git commit" },
        agent: { name: "", prompt: "You are a reviewer.", skills: [], tools: [] },
      }, { kind: "manual" });
    });

    const blocks = container.querySelectorAll(".hook-result-block");
    expect(blocks.length).toBe(1);
    expect(blocks[0].classList.contains("error")).toBe(true);
    expect(screen.getByText("Hook failed: commit-review")).toBeInTheDocument();
    expect(screen.getByText("Error: model unavailable")).toBeInTheDocument();
  });

  it("does not duplicate the hook-result block when a follow-up message is sent", async () => {
    const aiChatReqs: any[] = [];
    mockWithAiChatCapture(aiChatReqs);

    const { container } = render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/proj" />);

    // Run a completed hook — appends one visible block.
    await act(async () => {
      await runHook("/proj", {
        name: "commit-review",
        description: "",
        trigger: { type: "command", command: "git commit" },
        agent: { name: "", prompt: "You are a reviewer.", skills: [], tools: [] },
      }, { kind: "manual" });
    });
    expect(container.querySelectorAll(".hook-result-block").length).toBe(1);

    // Send a follow-up chat message — the block must not be re-appended.
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "What did the hook find?" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(
        aiChatReqs.some(
          (a) => a?.req?.messages?.some(
            (m: any) => m.role === "user" && m.content.includes("What did the hook find?"),
          ),
        ),
      ).toBe(true);
    });

    // Still exactly one block, and the output remains in the thread.
    expect(container.querySelectorAll(".hook-result-block").length).toBe(1);
    expect(screen.getByText("Hook result: commit-review")).toBeInTheDocument();
  });

  it("keeps including completed hook output in the Continue request", async () => {
    const aiChatReqs: any[] = [];
    mockWithAiChatCapture(aiChatReqs);

    // First chat response ends mid-word so the Continue button appears.
    let chatCount = 0;
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "store_secret") return Promise.resolve(null);
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "ai_chat") {
        aiChatReqs.push(args);
        const messages = args?.req?.messages || [];
        if (isHookRunMessages(messages)) {
          return Promise.resolve({ content: HOOK_RESULT, tool_calls: [] });
        }
        // Only count chat requests (not hook runs) for the reply sequence.
        chatCount++;
        // First chat reply ends mid-word (Continue button appears); the
        // Continue reply appends more text.
        return Promise.resolve({
          content: chatCount === 1 ? "Here is the summary of the hook:" : " more detail.",
          tool_calls: [],
        });
      }
      return Promise.resolve({ content: "", tool_calls: [] });
    });

    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/proj" />);

    // Run a completed hook.
    await act(async () => {
      await runHook("/proj", {
        name: "commit-review",
        description: "",
        trigger: { type: "command", command: "git commit" },
        agent: { name: "", prompt: "You are a reviewer.", skills: [], tools: [] },
      }, { kind: "manual" });
    });

    // Send a message so the Continue button appears.
    const input = screen.getByPlaceholderText(/Ask the AI/);
    fireEvent.change(input, { target: { value: "Summarize" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Here is the summary of the hook:")).toBeInTheDocument();
    });

    // Click Continue.
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(
        aiChatReqs.some(
          (a) => a?.req?.messages?.some(
            (m: any) => m.role === "system" && m.content?.includes("[Hook run: commit-review]"),
          ) && a?.req?.messages?.some(
            (m: any) => m.role === "system" && m.content?.includes("Continue your previous response"),
          ),
        ),
      ).toBe(true);
    });
  });
});
