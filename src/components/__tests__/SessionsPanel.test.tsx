import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SessionsPanel from "../SessionsPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
vi.mock("../SessionSummary", () => ({ default: ({ session }: any) => <div>Details {session.id}</div> }));
beforeEach(() => resetTauriMocks());
it("searches full chat/tool content and terminal recordings and filters by type", async () => {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "list_sessions") return [
      { id: "chat", summary: "Chat review", messageCount: 1, messages: [{ content: "Investigate", toolCalls: [{ name: "read_file", result_full: "needle-in-tool-result" }] }] },
      { id: "terminal", summary: "Build run", messageCount: 0 },
    ];
    if (command === "read_terminal_session_events") return args.sessionId === "terminal" ? [{ label: "Compiler", text: "\u001b[32mcompilation failed\u001b[0m", terminalId: "t1" }] : [];
    return null;
  });
  render(<SessionsPanel visible rootPath="/project" onClose={vi.fn()} />);
  await screen.findByText("Chat review");
  const search = screen.getByRole("textbox", { name: "Search sessions" });
  fireEvent.change(search, { target: { value: "needle-in-tool-result" } });
  expect(screen.getByText("Chat review")).toBeInTheDocument();
  expect(screen.queryByText("Build run")).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "compilation failed" } });
  expect(screen.getByText("Build run")).toBeInTheDocument();
  expect(screen.queryByText("Chat review")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Session type"), { target: { value: "chat" } });
  expect(screen.getByText("No matching sessions.")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Session type"), { target: { value: "terminal" } });
  fireEvent.click(screen.getByText("Build run"));
  expect(screen.getByText("Details terminal")).toBeInTheDocument();
});
it("surfaces load failures", async () => {
  mockInvoke.mockRejectedValue(new Error("unavailable"));
  render(<SessionsPanel visible rootPath="/project" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unavailable"));
});
it("searches structured OpenCode responses even when terminal redraws split their text", async () => {
  mockInvoke.mockImplementation(async command => {
    if (command === "list_sessions") return [{ id: "agent-one", summary: "OpenCode run", agent: { name: "opencode" } }];
    if (command === "read_agent_conversation") return { candidates: [{ id: "native", title: "Check in" }], selectedId: "native", messages: [{ role: "assistant", content: "Yes, I am here!" }] };
    if (command === "read_terminal_session_events") return [{ label: "OpenCode", terminalId: "t", text: "Yes...spinner...I am here" }];
    return null;
  });
  render(<SessionsPanel visible rootPath="/project" onClose={vi.fn()} />);
  await screen.findByText("OpenCode run");
  fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "Yes, I am here!" } });
  expect(screen.getByText("OpenCode run")).toBeInTheDocument();
});

it("keeps results and search stable during background refreshes", async () => {
  const session = { id: "stable", summary: "Build review", messages: [], messageCount: 0 };
  let finishRefresh: ((value: unknown) => void) | undefined;
  let reads = 0;
  mockInvoke.mockImplementation(async command => {
    if (command === "list_sessions") {
      reads += 1;
      if (reads === 1) return [session];
      return new Promise(resolve => { finishRefresh = resolve; });
    }
    return [];
  });
  vi.useFakeTimers();
  try {
    await act(async () => { render(<SessionsPanel visible rootPath="/project" onClose={vi.fn()} />); });
    const result = screen.getByText("Build review", { selector: "strong" });
    fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "Build" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(finishRefresh).toBeDefined();
    expect(screen.queryByText("Refreshing sessions…")).not.toBeInTheDocument();
    expect(screen.getByText("Build review", { selector: "strong" })).toBe(result);
    expect(screen.getByLabelText("Search sessions")).toHaveValue("Build");
    await act(async () => { finishRefresh!([session]); });
    expect(screen.getByText("Build review", { selector: "strong" })).toBe(result);
  } finally { vi.useRealTimers(); }
});
