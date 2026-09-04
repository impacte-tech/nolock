// ---------------------------------------------------------------------------
// Smoke + regression tests for sub-agent triggering.
//
// Regression covered: after the multi-provider / thinking-model changes, the
// `@agent` flow started routing the whole request to the agent's OWN model,
// which swallowed the `spawn_subagent` trigger — so sub-agents stopped
// appearing, even when explicitly invoked with `@`.
//
// The fix: the orchestrator stays on the PLANNING (main) model, and the
// request carries an explicit spawn directive for each referenced @agent. The
// spawned sub-agent still runs on its own configured provider/model (via
// run_subagent on the backend), which preserves per-agent model sourcing.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChatPanel from "../ChatPanel";
import { mockInvoke, mockListen, resetTauriMocks } from "../../test/tauri-mock";

const AGENT_NAME = "code-reviewer";
const AGENT_MODEL = "lfm2.5";
const AGENT_PROMPT = "You are an expert code reviewer. Review the code and report findings. Do not edit files.";
const SECOND_AGENT_NAME = "researcher";
const SECOND_AGENT_PROMPT = "You are a researcher. Search the web and return sourced findings.";

function setupAgentMocks(chatModel = "nemotron:9b") {
  // list_agents returns the agent so the @autocomplete can offer it.
  mockInvoke.mockImplementation((cmd: string, args?: any) => {
    if (cmd === "list_agents") {
      return Promise.resolve([
        { name: AGENT_NAME, path: `/root/.agents/${AGENT_NAME}.md` },
      ]);
    }
    if (cmd === "read_agent") {
      return Promise.resolve({
        name: AGENT_NAME,
        description: "Reviews code",
        prompt: AGENT_PROMPT,
        model: AGENT_MODEL,
        backend: "ollama",
        temperature: 0.3,
        tools: ["read_file", "list_directory", "grep"],
      });
    }
    if (cmd === "list_directory") return Promise.resolve([]);
    if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "store_secret") return Promise.resolve(null);
    if (cmd === "append_to_file") return Promise.resolve(null);
    if (cmd === "create_dir_all") return Promise.resolve(null);
    return Promise.resolve({ content: "Test response", tool_calls: [] });
  });
}

function setupLocalStorage() {
  localStorage.clear();
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.chatModel", "nemotron:9b");
  localStorage.setItem("nolock.toolsEnabled", JSON.stringify(["read_file", "grep"]));
}

let aiChatResolver: ((v: any) => void) | null = null;
let subagentStartHandler: ((e: any) => void) | null = null;
let subagentTokenHandler: ((e: any) => void) | null = null;
let subagentDoneHandler: ((e: any) => void) | null = null;
let toolProgressHandler: ((e: any) => void) | null = null;

function setupInvokeWithDeferredAiChat() {
  (mockInvoke as any).mockImplementation((cmd: string, args: any) => {
    if (cmd === "list_agents") {
      return Promise.resolve([
        { name: AGENT_NAME, path: `/root/.agents/${AGENT_NAME}.md` },
        { name: SECOND_AGENT_NAME, path: `/root/.agents/${SECOND_AGENT_NAME}.md` },
      ]);
    }
    if (cmd === "read_agent") {
      const path: string = args?.path ?? "";
      if (path.includes(SECOND_AGENT_NAME)) {
        return Promise.resolve({
          name: SECOND_AGENT_NAME, description: "Researches a topic", prompt: SECOND_AGENT_PROMPT,
          model: AGENT_MODEL, backend: "ollama", temperature: 0.7,
          tools: ["web_search", "web_fetch"],
        });
      }
      return Promise.resolve({
        name: AGENT_NAME, description: "Reviews code", prompt: AGENT_PROMPT,
        model: AGENT_MODEL, backend: "ollama", temperature: 0.3,
        tools: ["read_file", "list_directory", "grep"],
      });
    }
    if (cmd === "list_directory") return Promise.resolve([]);
    if (cmd === "get_model_info") return Promise.resolve({ context_length: 8192 });
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "store_secret") return Promise.resolve(null);
    if (cmd === "append_to_file") return Promise.resolve(null);
    if (cmd === "create_dir_all") return Promise.resolve(null);
    // ai_chat hangs until the test resolves it.
    return new Promise((resolve: any) => {
      aiChatResolver = resolve;
    });
  });
}

describe("ChatPanel — sub-agent trigger (@agent → spawn_subagent)", () => {
  beforeEach(() => {
    resetTauriMocks();
    setupLocalStorage();
    aiChatResolver = null;
    subagentStartHandler = null;
    setupInvokeWithDeferredAiChat();

    (mockListen as any).mockImplementation(async (event: string, cb: any) => {
      if (event === "subagent-start") subagentStartHandler = cb;
      if (event === "subagent-token") subagentTokenHandler = cb;
      if (event === "subagent-done") subagentDoneHandler = cb;
      if (event === "tool-progress") toolProgressHandler = cb;
      return vi.fn();
    });
  });

  afterEach(() => {
    subagentTokenHandler = null;
    subagentDoneHandler = null;
    toolProgressHandler = null;
    vi.clearAllTimers();
  });

  it("@agent invocation sends the spawn directive AND keeps the orchestrator on the planning (main) model", async () => {
    // Render WITHOUT rootPath to keep agent autocomplete's file listing quiet,
    // but with rootPath so list_agents/read_agent are exercised.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);

    // Type "@" to open the mention autocomplete.
    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@" } });

    // Wait for the agent autocomplete item to appear.
    const agentItem = await screen.findByText("Reviews code");
    await act(async () => {
      // Select the agent from the dropdown (mouse down selects it).
      fireEvent.mouseDown(agentItem);
    });

    // The @name stays in the input and the agent ref chip is shown.
    expect(input.value).toContain("@code-reviewer");

    // Continue typing the rest of the message.
    fireEvent.change(input, { target: { value: "@code-reviewer review src/main.rs" } });
    fireEvent.click(screen.getByText("Send"));

    // The backend should receive an ai_chat request.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ai_chat", expect.anything()));
    const [, { req }] = (mockInvoke as any).mock.calls.find(([c]: [string]) => c === "ai_chat");

    // Orchestrator stays on the PLANNING (main) model — not the agent's model.
    expect(req.model).toBe("nemotron:9b");
    expect(req.backend).toBe("ollama");

    // The agent's own model is used at spawn time on the backend (run_subagent
    // resolves it from the agent file); here we assert the prompt is sent as
    // context so the orchestrator knows the requested specialty.
    const systemContents = req.messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content);
    expect(systemContents.some((c: string) => c.includes("You are an expert code reviewer"))).toBe(true);

    // The directive tells the orchestrator the agent was dispatched by the
    // system (backend pre-spawns @agents in parallel) — NOT to spawn it again.
    const directives = systemContents.filter((c: string) => c.includes("dispatched by the system"));
    expect(directives.length).toBeGreaterThan(0);
    expect(directives.some((c: string) => c.includes("@code-reviewer"))).toBe(true);
    expect(directives.some((c: string) => c.includes("Do NOT call spawn_subagent"))).toBe(true);

    // The request carries the referenced agent so the backend pre-spawns it.
    expect(req.referencedAgents).toContain("code-reviewer");

    // Resolve the pending ai_chat so the test completes cleanly.
    await act(async () => {
      aiChatResolver?.({ content: "Reviewed.", tool_calls: [{ name: "spawn_subagent", arguments: "{}", result_snippet: "" }] });
    });
  }, 15000);

  it("sends BOTH referenced agents for parallel backend dispatch", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    // Select @researcher.
    fireEvent.change(input, { target: { value: "@" } });
    const researchItem = await screen.findByText("Researches a topic");
    await act(async () => {
      fireEvent.mouseDown(researchItem);
    });
    expect(input.value).toContain("@researcher");

    // Select @code-reviewer.
    fireEvent.change(input, { target: { value: "@" } });
    const reviewItem = await screen.findByText("Reviews code");
    await act(async () => {
      fireEvent.mouseDown(reviewItem);
    });
    expect(input.value).toContain("@code-reviewer");

    fireEvent.change(input, { target: { value: "@researcher @code-reviewer review the project" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ai_chat", expect.anything()));
    const [, { req }] = (mockInvoke as any).mock.calls.find(([c]: [string]) => c === "ai_chat");

    // Backend must receive BOTH referenced agents so it pre-spawns in parallel.
    expect(req.referencedAgents).toContain("researcher");
    expect(req.referencedAgents).toContain("code-reviewer");

    // The directive names both agents.
    const directives = req.messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content)
      .filter((c: string) => c.includes("dispatched by the system"));
    expect(directives.some((c: string) => c.includes("@researcher") && c.includes("@code-reviewer"))).toBe(true);

    await act(async () => {
      aiChatResolver?.({ content: "Done.", tool_calls: [] });
    });
  }, 15000);

  it("shows a sub-agent window when subagent-start fires", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);

    // The sub-agent listeners are registered on mount.
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());

    // Fire subagent-start; the ChatPanel must open an inspectable sub-agent
    // window for it.
    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_test", agent: "code-reviewer", task: "review x", model: "lfm2.5" } });
    });

    await waitFor(() => {
      expect(document.querySelector(".subagent-name")).toBeInTheDocument();
    });
    expect(screen.getByText(/@code-reviewer/)).toBeInTheDocument();
    expect(screen.getByText(/review x/)).toBeInTheDocument();
  });

  it("renders sub-agent thinking in a collapsible box (same as main agent)", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());

    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_x", agent: "code-reviewer", task: "review", model: "lfm2.5" } });
    });

    // Expand the sub-agent body.
    await act(async () => {
      fireEvent.click(screen.getByText(/@code-reviewer/));
    });

    // Emit a thinking token.
    await act(async () => {
      subagentTokenHandler?.({ payload: { id: "sa_x", token: "Let me reason about the bug.", thinking: true } });
    });

    // The thinking box header (reuses the main ThinkingIndicator classes).
    await waitFor(() => {
      expect(document.querySelector(".subagent-thinking-box")).toBeInTheDocument();
      expect(document.querySelector(".thinking-indicator-label")).toBeInTheDocument();
    });
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("replaces the sub-agent window content with the cleaned result on subagent-done", async () => {
    // Regression: the lfm sub-agent streams a raw JSON blob
    // ({"analysis":…,"final_answer":…}) into the window. The backend unwraps it
    // to the final_answer and emits it via subagent-done; the window must show
    // the CLEANED result, not the raw JSON.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());

    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_clean", agent: "researcher", task: "research", model: "lfm2.5" } });
    });
    // Expand the body.
    await act(async () => {
      fireEvent.click(screen.getByText(/@researcher/));
    });

    // Stream the raw JSON blob (as the model would).
    await act(async () => {
      subagentTokenHandler?.({ payload: { id: "sa_clean", token: '{"analysis":"a","final_answer":"Use memoization."}', thinking: false } });
    });

    // Backend emits the cleaned result on done.
    await act(async () => {
      subagentDoneHandler?.({ payload: { id: "sa_clean", result: "Use memoization." } });
    });

    await waitFor(() => {
      expect(document.querySelector(".subagent-block-body")).toBeInTheDocument();
    });
    // The window shows the cleaned answer, NOT the raw JSON blob.
    expect(screen.getByText("Use memoization.")).toBeInTheDocument();
    expect(screen.queryByText(/final_answer/)).not.toBeInTheDocument();
  });

  it("pre-spawns ALL agents mentioned as plain text (no dropdown selection)", async () => {
    // Regression: agentRefs only fills when the user clicks the autocomplete
    // dropdown. Typing/pasting `@researcher @code-reviewer` as plain text must
    // still resolve BOTH mentions so the backend pre-spawns them in parallel.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;

    // Type the full prompt WITHOUT selecting from the dropdown.
    fireEvent.change(input, {
      target: {
        value:
          "How do I write a recursive fib in Rust? @researcher search the web while @code-reviewer reviews the code, in parallel.",
      },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ai_chat", expect.anything()));
    const [, { req }] = (mockInvoke as any).mock.calls.find(([c]: [string]) => c === "ai_chat");

    // Both plain-text mentions must reach the backend for parallel pre-spawn.
    expect(req.referencedAgents).toContain("researcher");
    expect(req.referencedAgents).toContain("code-reviewer");

    // The directive names both.
    const directives = req.messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content)
      .filter((c: string) => c.includes("dispatched by the system"));
    expect(directives.some((c: string) => c.includes("@researcher") && c.includes("@code-reviewer"))).toBe(true);

    await act(async () => {
      aiChatResolver?.({ content: "Done.", tool_calls: [] });
    });
  }, 15000);

  it("re-triggering the same @agent continues the same window (not a duplicate)", async () => {
    // A follow-up user message triggering the SAME @agent must reuse the same
    // sub-agent window (backend keeps the agent's conversation context), with
    // the window going pending again — no second window is created.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());
    await waitFor(() => expect(subagentDoneHandler).not.toBeNull());
    await waitFor(() => expect(subagentTokenHandler).not.toBeNull());

    // First run of @researcher.
    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_1", agent: "researcher", task: "task one", model: "lfm2.5" } });
      subagentTokenHandler?.({ payload: { id: "sa_1", token: "First pass", thinking: false } });
      subagentDoneHandler?.({ payload: { id: "sa_1", result: "First pass" } });
    });

    // Follow-up turn re-triggering the SAME agent.
    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_2", agent: "researcher", task: "task two (follow-up)", model: "lfm2.5" } });
    });

    // Exactly ONE window for #researcher.
    expect(document.querySelectorAll(".subagent-block").length).toBe(1);

    // The window kept its prior content (continuity) AND the new task is shown.
    const block = document.querySelector(".subagent-block");
    expect(block?.textContent).toContain("@researcher");
    expect(block?.textContent).toContain("task two (follow-up)");
  });

  it("uses the backend-reported context_tokens for the session context meter", async () => {
    // Regression: the context meter used to only count the frontend's estimate
    // of the outgoing payload, missing tool-loop iterations and injected
    // sub-agent results — making the session token count look LOWER than the
    // context the main agent + sub-agents actually consumed. The backend now
    // returns `context_tokens` (the real full-context count) and the UI must
    // reflect it.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(aiChatResolver).not.toBeNull());

    // Backend reports a large context usage (e.g. 4096 tokens across the whole
    // tool loop + injected sub-agent results).
    await act(async () => {
      aiChatResolver?.({ content: "Hi there!", tool_calls: [], context_tokens: 4096 });
    });

    // The persistent context bar should reflect the reported 4096 tokens.
    await waitFor(() => {
      const indicator = document.querySelector(".context-persistent-bar .context-indicator");
      expect(indicator).toBeInTheDocument();
      const title = indicator?.getAttribute("title") || "";
      expect(title).toContain("4,096");
    });
  }, 15000);

  it("supports KTO thumbs-up on a completed sub-agent", async () => {
    // Sub-agents now have the same KTO (thumbs up/down) mechanism as the main
    // chat. Clicking thumbs up on a done sub-agent must save KTO feedback with
    // the sub-agent's task as the prompt and its model, then mark the window.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());
    await waitFor(() => expect(subagentDoneHandler).not.toBeNull());

    // A completed sub-agent with content.
    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_kto", agent: "code-reviewer", task: "review src/main.rs", model: "nemotron:9b" } });
      subagentTokenHandler?.({ payload: { id: "sa_kto", token: "The code has a bug.", thinking: false } });
      subagentDoneHandler?.({ payload: { id: "sa_kto", result: "The code has a bug." } });
    });

    // Expand the sub-agent so the thumbs-up button is available.
    await act(async () => {
      fireEvent.click(screen.getByText(/@code-reviewer/));
    });

    // The thumbs-up button appears (same rlhf-btn-up style as the main chat).
    const thumbsUp = await screen.findByLabelText("Thumbs up");
    await act(async () => {
      fireEvent.click(thumbsUp);
    });

    // The window flips to a "Saved" badge — mirroring the main KTO UX.
    await waitFor(() => {
      expect(document.querySelectorAll(".subagent-block .rlhf-badge-saved").length).toBe(1);
    });

    // A KTO good entry must have been written via append_to_file.
    await waitFor(() => {
      const called = (mockInvoke as any).mock.calls.some(
        ([cmd, args]: [string, any]) =>
          cmd === "append_to_file" &&
          args &&
          typeof args.path === "string" &&
          args.path.includes("kto/good/")
      );
      expect(called).toBe(true);
    });
  }, 15000);

  it("supports KTO thumbs-down with a correction on a completed sub-agent", async () => {
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(subagentStartHandler).not.toBeNull());
    await waitFor(() => expect(subagentDoneHandler).not.toBeNull());

    await act(async () => {
      subagentStartHandler?.({ payload: { id: "sa_kto2", agent: "researcher", task: "find sources", model: "nemotron:9b" } });
      subagentTokenHandler?.({ payload: { id: "sa_kto2", token: "No sources found.", thinking: false } });
      subagentDoneHandler?.({ payload: { id: "sa_kto2", result: "No sources found." } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/@researcher/));
    });

    const thumbsDown = await screen.findByLabelText("Thumbs down");
    await act(async () => {
      fireEvent.click(thumbsDown);
    });

    // Correction input appears (same as main chat).
    await waitFor(() => {
      expect(document.querySelector(".subagent-block .rlhf-correction-label")).toBeInTheDocument();
    });

    const input = document.querySelector(".subagent-block textarea") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Use more recent sources" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Submit Feedback"));
    });

    // A KTO bad entry must be written with the correction.
    await waitFor(() => {
      const called = (mockInvoke as any).mock.calls.some(
        ([cmd, args]: [string, any]) =>
          cmd === "append_to_file" &&
          args &&
          typeof args.path === "string" &&
          args.path.includes("kto/bad/")
      );
      expect(called).toBe(true);
    });
  }, 15000);

  it("shows live running tool-call feedback for the main agent while it streams", async () => {
    // Regression: the main chat (e.g. OpenRouter reasoning model) runs many tool
    // calls before writing its answer, but the UI showed nothing until the end.
    // `tool-progress` events must render as running tool-call windows.
    render(<ChatPanel onClose={vi.fn()} onOpenUrl={vi.fn()} rootPath="/root" />);
    await waitFor(() => expect(toolProgressHandler).not.toBeNull());

    const input = screen.getByPlaceholderText(/Ask the AI/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "search the web for x" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(aiChatResolver).not.toBeNull());

    // A tool starts — a running tool-call window must appear immediately.
    await act(async () => {
      toolProgressHandler?.({ payload: { type: "start", name: "web_search", path: null } });
    });
    expect(await screen.findByText("web_search")).toBeInTheDocument();
    expect(screen.getByText(/running/)).toBeInTheDocument();

    // The tool finishes — the running indicator flips to done.
    await act(async () => {
      toolProgressHandler?.({ payload: { type: "done", name: "web_search", path: null } });
    });
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();

    // Resolve the pending ai_chat so the test completes cleanly.
    await act(async () => {
      aiChatResolver?.({ content: "Here is the answer.", tool_calls: [], context_tokens: 1024 });
    });
    // The live "done" window is cleared once the response completes — but the
    // completed call is now part of the conversation log (persisted block), so
    // it remains visible and is included in the next session save.
    await waitFor(() => {
      expect(screen.queryByText("done")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("web_search").length).toBeGreaterThanOrEqual(1);
  }, 15000);
});