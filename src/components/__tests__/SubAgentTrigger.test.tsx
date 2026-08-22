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
      return vi.fn();
    });
  });

  afterEach(() => {
    subagentTokenHandler = null;
    subagentDoneHandler = null;
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
});