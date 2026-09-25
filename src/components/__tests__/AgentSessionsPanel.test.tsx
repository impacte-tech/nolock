import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import AgentSessionsPanel from "../AgentSessionsPanel";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../SessionSummary", () => ({ default: ({ session, onClose }: any) => <div>Recording {session.id}<button onClick={onClose}>Back</button></div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("lists independent agent runs, opens a recording and deletes without killing the process", async () => {
  const runs = [
    { id: "chat", summary: "Ordinary chat" },
    { id: "a", summary: "claude run", createdAt: 1, status: "active", agent: { terminalId: "term-1" } },
    { id: "b", summary: "codex run", createdAt: 2, status: "finished", agent: { terminalId: "term-2", exitCode: 7 } },
  ];
  vi.mocked(invoke).mockImplementation(async command => command === "list_sessions" ? runs : undefined);
  render(<AgentSessionsPanel visible rootPath="/project" onClose={vi.fn()} />);
  expect(await screen.findByText("claude run")).toBeInTheDocument();
  expect(screen.getByText(/term-2 · Exited 7/)).toBeInTheDocument();
  expect(screen.queryByText("Ordinary chat")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("claude run"));
  expect(screen.getByText("Recording a")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Back"));
  fireEvent.click(screen.getByRole("button", { name: "Delete claude run" }));
  await waitFor(() => expect(screen.queryByText("claude run")).not.toBeInTheDocument());
  expect(invoke).toHaveBeenCalledWith("delete_session", { rootPath: "/project", id: "a" });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "pty_kill")).toBe(false);
});
it("does not load sessions without a project", () => {
  render(<AgentSessionsPanel visible rootPath="" onClose={vi.fn()} />);
  expect(screen.getByText("Open a project to see its agent sessions.")).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});
