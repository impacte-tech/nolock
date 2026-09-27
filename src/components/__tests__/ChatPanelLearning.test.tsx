// ---------------------------------------------------------------------------
// ChatPanel × Learning mode — semantic .faq vector-store integration.
//
// Verifies that when Chat Mode = Learning:
//   - the user's question is first used to semantically retrieve past
//     question → answer pairs (faq_search) and the hits are injected into the
//     ai_chat request context as "Learned knowledge";
//   - completed exchanges are only persisted after explicit review approval;
//   - the plain-text .faq/README still works as a fallback when the semantic
//     search is unavailable.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, mockListen, resetTauriMocks } from "../../test/tauri-mock";

vi.mock("../../lib/tokenizer", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

interface AiChatArgs {
  req: { messages: { role: string; content: string }[] };
}

function setup(overrides: { faqSearchHits?: any[]; noProjectRoot?: boolean } = {}) {
  resetTauriMocks();
  localStorage.clear();
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.chatModel", "qwen3:8b");
  localStorage.setItem("nolock.showThinking", "false");
  localStorage.setItem("nolock.toolsEnabled", "[]");
  localStorage.setItem("nolock.chatSystemPrompt", "Default system prompt.");
  localStorage.setItem("nolock.chatMode", "learning");
  localStorage.setItem("nolock.faqEmbeddingModel", "nomic-embed-text");
  localStorage.setItem("nolock.faqRanking", "hybrid");
  localStorage.setItem("nolock.faqTopK", "3");
  const root = overrides.noProjectRoot ? "" : "/project/root";
  return root;
}

describe("ChatPanel learning mode", () => {
  it("retrieves knowledge but only indexes a completed exchange after approval", async () => {
    let aiChatReq: AiChatArgs | null = null;
    let upsertArgs: any = null;
    setup();
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "faq_search") {
        return Promise.resolve([
          {
            id: 1,
            question: "How does the tool loop stop?",
            answer: "It stops after max_iterations.",
            frequency: 3,
            similarity: 0.92,
            score: 0.9,
          },
        ]);
      }
      if (cmd === "faq_review_preview") return Promise.resolve({ review: null, categories: [] });
      if (cmd === "faq_review_save") {
        upsertArgs = args;
        return Promise.resolve({ ...args.review, revision: 1 });
      }
      if (cmd === "ai_chat") {
        aiChatReq = args as AiChatArgs;
        return Promise.resolve({ content: "Let me teach you about that.", tool_calls: [] });
      }
      return Promise.resolve(null);
    });
    const root = "/project/root";
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath={root} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "When does the agent loop stop?" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(aiChatReq).not.toBeNull());

    // Agent saw the retrieved exchange as "Learned knowledge" context (inlined
    // into the user message alongside file context).
    const userText = aiChatReq!.req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    expect(userText).toContain("Learned knowledge");
    expect(userText).toContain("How does the tool loop stop?");
    expect(userText).toContain("When does the agent loop stop?");

    await screen.findByRole("button", { name: "Review knowledge" });
    expect(upsertArgs).toBeNull();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "faq_upsert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review knowledge" }));
    await screen.findByLabelText("Chunk 1 text");
    expect(upsertArgs).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    await waitFor(() => expect(upsertArgs).not.toBeNull());
    expect(upsertArgs.review.question).toBe("When does the agent loop stop?");
    expect(upsertArgs.review.answer).toBe("Let me teach you about that.");
    expect(upsertArgs.review.chunks[0].text).toBe("Let me teach you about that.");
    expect(upsertArgs.config.topK).toBe(3);
    await screen.findByRole("button", { name: "Review saved knowledge" });
  });

  it("falls back to the plain-text .faq README when the semantic store is unavailable", async () => {
    const aiChatReqs: AiChatArgs[] = [];
    setup();
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "faq_search") return Promise.reject(new Error("no embedding model"));
      if (cmd === "read_file") return Promise.resolve("1. What is a router? — asked 2 times\n");
      if (cmd === "ai_chat") {
        aiChatReqs.push(args as AiChatArgs);
        return Promise.resolve({ content: "Good question!", tool_calls: [] });
      }
      return Promise.resolve(null);
    });
    const root = "/project/root";
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath={root} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "What is a router?" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(aiChatReqs.length).toBeGreaterThan(0));
    const userText = aiChatReqs[0].req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    expect(userText).toContain("Ranked FAQ");
    expect(userText).toContain("What is a router?");
  });

  it("skips retrieval entirely when no project root is open", async () => {
    const aiChatReqs: AiChatArgs[] = [];
    setup({ noProjectRoot: true });
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
      if (cmd === "ai_chat") {
        aiChatReqs.push(args as AiChatArgs);
        return Promise.resolve({ content: "No project here.", tool_calls: [] });
      }
      return Promise.resolve(null);
    });
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "teach me" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(aiChatReqs.length).toBeGreaterThan(0));
    const called = mockInvoke.mock.calls.filter((c) => c[0] === "faq_search" || c[0] === "faq_upsert");
    expect(called.length).toBe(0);
  });
});