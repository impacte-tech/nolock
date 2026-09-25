import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Terminal as XTerm } from "@xterm/xterm";
import { flushTerminalActivity, setActiveSessionId } from "../../lib/terminalSessions";
import TerminalView, { TerminalWorkspace, type TerminalInstance } from "../Terminal";
import { mockInvoke, mockListen, resetTauriMocks } from "../../test/tauri-mock";

const mockTerminals = () => (XTerm as unknown as { all: unknown[] }).all;

const handlers = vi.hoisted(() => ({ input: (_data: string) => {}, focuses: [] as unknown[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    static all: unknown[] = [];
    cols = 80;
    rows = 24;
    constructor() { (this.constructor as unknown as { all: unknown[] }).all.push(this); }
    loadAddon() {}
    open() {}
    focus() { handlers.focuses.push(this); }
    write() {}
    dispose() {}
    onData(fn: (data: string) => void) { handlers.input = fn; return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

describe("shell command terminal", () => {
  beforeEach(() => {
    resetTauriMocks();
    mockInvoke.mockResolvedValue(undefined);
    handlers.focuses.length = 0;
    mockTerminals().length = 0;
  });

  it("waits for output listeners and passes multiline commands intact with the project cwd", async () => {
    let ready!: (dispose: ReturnType<typeof vi.fn>) => void;
    mockListen.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const command = " printf '%s' \"$HOME\"\npwd";
    const instance: TerminalInstance = { id: "test", label: "shell", active: true, initialCommand: { current: command } };
    render(<TerminalView instance={instance} rootPath="/project" />);
    expect(mockInvoke).not.toHaveBeenCalledWith("pty_spawn", expect.anything());
    await act(async () => ready(vi.fn()));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({ command, cwd: "/project", shell: null })));
  });

  it("never replays a command after the terminal is remounted", async () => {
    const instance: TerminalInstance = { id: "test", label: "shell", active: true, initialCommand: { current: "aws login" } };
    const first = render(<TerminalView instance={instance} rootPath="" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({ command: "aws login" })));
    first.unmount();
    render(<TerminalView instance={instance} rootPath="" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({ command: null })));
    const spawns = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[0][1].id).not.toBe(spawns[1][1].id);
  });
});


describe("terminal workspace", () => {
  beforeEach(() => {
    resetTauriMocks();
    mockInvoke.mockResolvedValue(undefined);
    handlers.focuses.length = 0;
    mockTerminals().length = 0;
    localStorage.clear();
  });

  function workspaceProps(instances: TerminalInstance[], activeId: string) {
    return { instances, activeId, rootPath: "/layout", terminalPercent: 30, onSelect: vi.fn(), onClose: vi.fn(), onCreate: vi.fn(), onEditorTerminal: vi.fn(), onRename: vi.fn(), resizeHandle: null, children: <div>Files</div> };
  }

  it("preserves every process when rearranging and moving into and out of the editor", async () => {
    const instances = [{ id: "one", label: "One", active: true }, { id: "two", label: "Two", active: false }];
    const props = workspaceProps(instances, "one");
    const view = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: "Arrange: tabs" }));
    fireEvent.click(view.getByRole("button", { name: "Arrange: columns" }));
    view.rerender(<TerminalWorkspace {...props} editorTerminalId="two" />);
    view.rerender(<TerminalWorkspace {...props} editorTerminalId={null} />);
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(2);
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_kill")).toHaveLength(0);
    expect(view.getAllByRole("button", { name: "Record transcript" })).toHaveLength(2);
  });

  it("remembers the chosen arrangement across remounts", async () => {
    localStorage.setItem("nolock:terminal-layout", "grid");
    const instances = [{ id: "one", label: "One", active: true }, { id: "two", label: "Two", active: false }];
    const props = workspaceProps(instances, "one");
    const view = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(2));
    expect(view.getByRole("button", { name: "Arrange: grid" })).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Arrange: grid" }));
    expect(localStorage.getItem("nolock:terminal-layout")).toBe("tabs");
    view.unmount();
    const second = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    expect(second.getByRole("button", { name: "Arrange: tabs" })).toBeInTheDocument();
  });

  it("focuses the terminal that becomes active", async () => {
    const instances = [{ id: "one", label: "One", active: true }, { id: "two", label: "Two", active: false }];
    const props = workspaceProps(instances, "one");
    const view = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(2));
    handlers.focuses.length = 0;
    fireEvent.click(view.getByRole("tab", { name: "Two" }));
    expect(props.onSelect).toHaveBeenCalledWith("two");
    view.rerender(<TerminalWorkspace {...workspaceProps(instances, "two")} editorTerminalId={null} />);
    expect(handlers.focuses).toHaveLength(1);
    expect(handlers.focuses[0]).toBe(mockTerminals()[1]);
  });

  it("arranges four terminals in a balanced grid without a full-width odd one out", async () => {
    const instances = [
      { id: "one", label: "One", active: true },
      { id: "two", label: "Two", active: false },
      { id: "three", label: "Three", active: false },
      { id: "four", label: "Four", active: false },
    ];
    const props = workspaceProps(instances, "one");
    const view = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(4));
    fireEvent.click(view.getByRole("button", { name: "Arrange: tabs" }));
    fireEvent.click(view.getByRole("button", { name: "Arrange: columns" }));
    const panes = Array.from(view.container.querySelectorAll<HTMLElement>(".terminal-workspace-pane"));
    expect(panes).toHaveLength(4);
    // 4 terminals in grid mode → 2 columns × 2 rows, no pane spans the full width
    expect(panes[2].style.gridColumn).toBe("1");
    expect(panes[3].style.gridColumn).toBe("2");
    expect(panes.every((pane) => pane.style.gridColumn !== "1 / -1")).toBe(true);
  });

  it("supports more than six terminals without a product limit", async () => {
    const instances = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, active: i === 0 }));
    const props = workspaceProps(instances, "t0");
    const view = render(<TerminalWorkspace {...props} editorTerminalId={null} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(9));
    expect(view.getByText("9 terminals")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "New terminal" })).not.toBeDisabled();
  });
});


it("records metadata by default and output only after opt-in, following the shared session", async () => {
  resetTauriMocks(); mockInvoke.mockResolvedValue(undefined);
  const instance = { id: "privacy", label: "Terminal", active: true };
  const view = render(<TerminalView instance={instance} rootPath="/privacy" />);
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pty_spawn", expect.anything()));
  const ptyId = mockInvoke.mock.calls.find(([cmd]) => cmd === "pty_spawn")![1].id;
  const output = mockListen.mock.calls.find(([event]) => event === "pty-output")![1];
  act(() => { handlers.input("secret-password\r"); output({ payload: { id: ptyId, data: "unrecorded-secret" } }); });
  await flushTerminalActivity();
  const events = mockInvoke.mock.calls.filter(([cmd]) => cmd === "append_terminal_session_events").flatMap(([, args]) => args.events);
  expect(events.some((event: any) => event.kind === "input")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("secret");
  view.rerender(<TerminalView instance={instance} rootPath="/privacy" recording />);
  act(() => setActiveSessionId("/privacy", "next-session"));
  act(() => output({ payload: { id: ptyId, data: "opted-in-output" } }));
  await flushTerminalActivity();
  expect(mockInvoke).toHaveBeenCalledWith("append_terminal_session_events", expect.objectContaining({ sessionId: "next-session", events: expect.arrayContaining([expect.objectContaining({ kind: "output", text: "opted-in-output" })]) }));
  expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn")).toHaveLength(1);
});


it("opens a full-access terminal without broker negotiation", async () => {
  resetTauriMocks();
  mockInvoke.mockResolvedValue(undefined);
  render(<TerminalView instance={{ id: "normal", label: "Agent", active: true }} rootPath="/project" />);
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({ cwd: "/project" })));
  const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "pty_spawn")!;
  expect(call[1]).not.toHaveProperty("protected");
  expect(mockInvoke.mock.calls.some(([cmd]) => String(cmd).includes("credential"))).toBe(false);
});
