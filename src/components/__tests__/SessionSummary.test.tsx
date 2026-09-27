// ---------------------------------------------------------------------------
// Tests for SessionSummary — token expenses table + git "Changed files" list
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SessionSummary from "../SessionSummary";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
import type { SessionRecord } from "../../lib/sessions";

const baseSession: SessionRecord = {
  id: "s_test",
  summary: "Improve the session summary",
  status: "active",
  createdAt: 1700000000,
  updatedAt: 1700003600,
  messageCount: 2,
  toolCallCount: 1,
  firstMessage: "Improve the session summary",
  lastMessage: "done",
  tokenUsage: 1200,
  contextWindow: 64000,
  messages: [
    { role: "user", content: "Improve the session summary", createdAt: 1700000000, tokens: 5 },
    {
      role: "assistant",
      content: "done",
      model: "openai/gpt-4o",
      createdAt: 1700000010,
      tokens: 2,
      toolCalls: [
        {
          name: "read_file",
          arguments: '{"path":"src/App.tsx"}',
          result_snippet: "export default App;",
          result_full: "export default App;\n",
        },
      ],
    },
  ],
  usage: [
    { provider: "openrouter", model: "openai/gpt-4o", promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000 },
    { provider: "ollama", model: "qwen3", promptTokens: 500, completionTokens: 50, totalTokens: 550 },
  ],
};

const sampleDiff = [
  "diff --git a/src/App.tsx b/src/App.tsx",
  "index 1111111..2222222 100644",
  "--- a/src/App.tsx",
  "+++ b/src/App.tsx",
  "@@ -1,3 +1,4 @@",
  " import React",
  "+import { useState } from \"react\";",
  "-const stale = true;",
  " export default App;",
].join("\n");

describe("SessionSummary", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    resetTauriMocks();
    onClose.mockClear();
    localStorage.clear();
    mockInvoke.mockImplementation(() => Promise.resolve([]));
  });

  it("only closes via the X button — Escape does nothing", () => {
    render(<SessionSummary session={baseSession} rootPath="" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders token expense rows with pricing, requests and cost", () => {
    localStorage.setItem(
      "nolock.modelPrices",
      JSON.stringify({ "openai/gpt-4o": { prompt: 2.5, completion: 10 } }),
    );
    render(<SessionSummary session={baseSession} rootPath="" onClose={onClose} />);

    // Total: 2.5*1 + 10*0.1 = $3.50, with a "≥" prefix because the local model
    // has no pricing (partial cost).
    expect(screen.getByText("≥ $3.50 est.")).toBeInTheDocument();
    expect(screen.getByText("Reqs")).toBeInTheDocument();
    // Per-1M price pair rendered — never "undefined".
    expect(screen.getByText("$2.50 / $10.00")).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    // The unpriced model shows "—" for both price and cost.
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });

  it("shows the empty-usage message when no usage was recorded", () => {
    render(
      <SessionSummary
        session={{ ...baseSession, usage: [] }}
        rootPath=""
        onClose={onClose}
      />,
    );
    expect(screen.getByText(/No token usage recorded/)).toBeInTheDocument();
  });

  it("renders the changed-files list and loads the diff of a clicked file", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "git_session_files") {
        expect(args.rootPath).toBe("/tmp/proj");
        expect(args.sinceTs).toBe(1700000000);
        return Promise.resolve([
          { path: "src/App.tsx", status: "modified", insertions: 1, deletions: 1, untracked: false },
          { path: "notes/new.txt", status: "added", insertions: 3, deletions: 0, untracked: true },
          { path: "old.txt", status: "deleted", insertions: 0, deletions: 4, untracked: false },
        ]);
      }
      if (cmd === "git_session_file_diff") {
        expect(args.rootPath).toBe("/tmp/proj");
        expect(args.sinceTs).toBe(1700000000);
        expect(args.path).toBe("src/App.tsx");
        return Promise.resolve({ path: "src/App.tsx", status: "modified", diff: sampleDiff });
      }
      return Promise.reject(`Unknown command: ${cmd}`);
    });

    const { container } = render(
      <SessionSummary session={baseSession} rootPath="/tmp/proj" onClose={onClose} />,
    );

    // Files appear, grouped by status (added → modified → deleted).
    await waitFor(() => {
      expect(screen.getByText("notes/new.txt")).toBeInTheDocument();
    });
    expect(screen.getAllByText("src/App.tsx").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("old.txt")).toBeInTheDocument();
    expect(screen.getByText("untracked")).toBeInTheDocument();
    // Stats are rendered as +/− counts.
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();

    // Clicking a file lazily loads its diff (shared diff-line classes).
    // (The path also appears in the tool-call log's argument summary, so take
    // the first match — the changed-files row.)
    fireEvent.click(screen.getAllByText("src/App.tsx")[0]);
    await waitFor(() => {
      expect(container.querySelector(".file-diff-block")).not.toBeNull();
    });
    const add = container.querySelector(".diff-added");
    expect(add?.textContent).toContain("import { useState }");
    const del = container.querySelector(".diff-removed");
    expect(del?.textContent).toContain("const stale");
    const hunk = container.querySelector(".diff-hunk");
    expect(hunk?.textContent).toContain("@@");
    // Clicking again collapses the diff.
    fireEvent.click(screen.getAllByText("src/App.tsx")[0]);
    expect(container.querySelector(".file-diff-block")).toBeNull();
  });

  it("renders the tool call log with expandable input and output", () => {
    render(<SessionSummary session={baseSession} rootPath="" onClose={onClose} />);

    // Flattened log lists the call with an argument summary (the first match —
    // the same call also appears inline in the conversation log).
    expect(screen.getAllByText("read_file").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("src/App.tsx").length).toBeGreaterThanOrEqual(1);

    // Expanding reveals labeled Input (pretty JSON) and Output blocks.
    fireEvent.click(screen.getAllByText("read_file")[0]);
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/"path": "src\/App.tsx"/)).toBeInTheDocument();
    expect(screen.getByText(/export default App;/)).toBeInTheDocument();
  });

  it("searches across the session: filters the chat log and tool calls", () => {
    const { container } = render(
      <SessionSummary session={baseSession} rootPath="" onClose={onClose} />,
    );
    const input = screen.getByPlaceholderText("Search messages, tool calls, files…");

    // Searching for the tool name keeps the assistant message (its tool call
    // matches) but drops the user message from the conversation log.
    fireEvent.change(input, { target: { value: "read_file" } });
    expect(container.querySelector(".session-summary-msg-user")).toBeNull();
    expect(container.querySelector(".session-summary-msg-assistant")).not.toBeNull();
    // The tool-call log still lists the matching call, with a match count.
    expect(container.querySelector(".session-summary-toollog")?.textContent).toContain("read_file");
    expect(screen.getByText(/1 of 1 call matches/)).toBeInTheDocument();

    // A query with no matches shows per-section empty states.
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByText("No tool calls match “zzz-no-match”.")).toBeInTheDocument();
    expect(screen.getByText("No messages match “zzz-no-match”.")).toBeInTheDocument();

    // Clearing the query restores everything.
    fireEvent.click(screen.getByTitle("Clear search"));
    expect(container.querySelector(".session-summary-msg-user")).not.toBeNull();
  });

  it("search filters the changed-files list by path", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_session_files") {
        return Promise.resolve([
          { path: "src/App.tsx", status: "modified", insertions: 1, deletions: 1, untracked: false },
          { path: "notes/new.txt", status: "added", insertions: 3, deletions: 0, untracked: true },
        ]);
      }
      return Promise.reject(`Unknown command: ${cmd}`);
    });

    const { container } = render(
      <SessionSummary session={baseSession} rootPath="/tmp/proj" onClose={onClose} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".session-summary-files")?.textContent).toContain("notes/new.txt");
    });

    fireEvent.change(screen.getByPlaceholderText("Search messages, tool calls, files…"), {
      target: { value: "notes" },
    });
    const filesText = container.querySelector(".session-summary-files")?.textContent ?? "";
    expect(filesText).toContain("notes/new.txt");
    expect(filesText).not.toContain("old.txt");
    expect(filesText).not.toContain("src/App.tsx");
    expect(screen.getByText(/1 of 2 files matches/)).toBeInTheDocument();
  });

  it("shows a friendly message when the project is not a git repository", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_session_files") {
        return Promise.reject("git failed: fatal: not a git repository (or any of the parent directories): .git");
      }
      return Promise.reject(`Unknown command: ${cmd}`);
    });

    render(<SessionSummary session={baseSession} rootPath="/tmp/notrepo" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
    });
  });

  it("shows the empty state when no files changed", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_session_files") return Promise.resolve([]);
      return Promise.reject(`Unknown command: ${cmd}`);
    });

    render(<SessionSummary session={baseSession} rootPath="/tmp/clean" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText("No files changed during this session window.")).toBeInTheDocument();
    });
  });
});

it("shows structured OpenCode messages, reasoning and tools in Conversation log", async () => {
  resetTauriMocks();
  const agent = { name: "opencode", terminalId: "t1", cwd: "/project", pid: 1, exitCode: null, transcriptTruncated: false };
  mockInvoke.mockImplementation(async command => {
    if (command === "read_agent_conversation") return { candidates: [{ id: "native-one", title: "Quick check-in", createdAt: 1 }], selectedId: "native-one", messages: [
      { role: "user", content: "hey are you there?", createdAt: 1 },
      { role: "assistant", content: "Yes, I am here!", reasoning: "Checking the request", createdAt: 2, toolCalls: [{ name: "read_file", arguments: '{"path":"a.txt"}', result_full: "file body" }] },
    ] };
    return [];
  });
  const { container } = render(<SessionSummary session={{ ...baseSession, agent, messages: [], messageCount: 0 }} rootPath="/project" onClose={vi.fn()} />);
  await screen.findByText("hey are you there?");
  const log = container.querySelector(".session-summary-section-log")!;
  expect(log).toHaveTextContent("2 messages");
  expect(log).toHaveTextContent("Yes, I am here!");
  expect(log).toHaveTextContent("Reasoning");
  expect(log).toHaveTextContent("read_file");
  expect(screen.queryByText("No messages logged yet.")).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Search messages, tool calls, files…"), { target: { value: "Checking the request" } });
  expect(log).toHaveTextContent("Yes, I am here!");
  expect(log).not.toHaveTextContent("hey are you there?");
});

it("organizes terminal-only output under Conversation log and strips terminal protocol noise", async () => {
  resetTauriMocks();
  mockInvoke.mockImplementation(async command => command === "read_terminal_session_events" ? [
    { id: "1", terminalId: "t1", label: "Build", kind: "output", createdAt: 1, text: "\u001bP+q4d73\u001b\\\u001b_Gi=31337;AAAA\u001b\\\u001b[32mBuild " },
    { id: "2", terminalId: "t1", label: "Build", kind: "output", createdAt: 2, text: "complete\u001b[0m\n" },
  ] : []);
  const { container } = render(<SessionSummary session={{ ...baseSession, messages: [], messageCount: 0 }} rootPath="/project" onClose={vi.fn()} />);
  await screen.findByText("Build complete");
  const log = container.querySelector(".session-summary-section-log")!;
  expect(log).toHaveTextContent("1 terminal output block");
  expect(log).toHaveTextContent("Terminal output");
  expect(log).not.toHaveTextContent("AAAA");
  expect(log).not.toHaveTextContent("q4d73");
  expect(screen.queryByText("No messages logged yet.")).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Search messages, tool calls, files…"), { target: { value: "missing" } });
  expect(log).not.toHaveTextContent("Build complete");
});

it("requires selection for overlapping OpenCode histories", async () => {
  resetTauriMocks(); localStorage.clear();
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "read_agent_conversation") return { candidates: [{ id: "one", title: "One", createdAt: 1 }, { id: "two", title: "Two", createdAt: 2 }], selectedId: args.nativeId, messages: args.nativeId ? [{ role: "assistant", content: "Selected history" }] : [] };
    return [];
  });
  render(<SessionSummary session={{ ...baseSession, messages: [], agent: { name: "opencode", terminalId: "t", cwd: "/project", pid: 1, exitCode: null, transcriptTruncated: false } }} rootPath="/project" onClose={vi.fn()} />);
  await screen.findByText(/Multiple conversations overlap/);
  fireEvent.change(screen.getByLabelText("OpenCode conversation"), { target: { value: "two" } });
  await screen.findByText("Selected history");
  expect(mockInvoke).toHaveBeenCalledWith("read_agent_conversation", { rootPath: "/project", sessionId: "s_test", nativeId: "two" });
});

it("renders separate readable prompts and model paragraphs, lists and code", () => {
  resetTauriMocks(); mockInvoke.mockResolvedValue([]);
  const { container } = render(<SessionSummary session={{ ...baseSession, messages: [
    { role: "user", content: "First line\n\nSecond paragraph" },
    { role: "assistant", content: "First answer paragraph.\n\nSecond answer paragraph.\n\n- One\n- Two\n\n```js\nconst answer = 42;\n```" },
  ] }} rootPath="/project" onClose={vi.fn()} />);
  expect(screen.getByRole("article", { name: "User prompt" })).toHaveTextContent("You");
  expect(screen.getByRole("article", { name: "Model response" })).toHaveTextContent("Model");
  expect(container.querySelector(".session-summary-msg-user p")?.textContent).toBe("First line\n\nSecond paragraph");
  expect(container.querySelectorAll(".session-summary-msg-assistant .chat-markdown p")).toHaveLength(2);
  expect(container.querySelectorAll(".session-summary-msg-assistant li")).toHaveLength(2);
  expect(container.querySelector(".session-summary-msg-assistant pre code")).toHaveTextContent("const answer = 42;");
});
