import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceGitPanel from "../WorkspaceGitPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

beforeEach(() => { resetTauriMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const file = { path: "src/app.ts", staged: "M", unstaged: "M", untracked: false, conflict: false };

describe("workspace Git", () => {
  it("shows staged and unstaged diffs independently and refreshes content even when status stays M", async () => {
    let content = "+first";
    mockInvoke.mockImplementation(async (cmd, args) => cmd === "git_workspace_status" ? { repository: "/repo", branch: "main", files: [file] } : { diff: `${args.area}\n${content}`, truncated: false });
    await act(async () => { render(<WorkspaceGitPanel rootPath="/repo" open onToggle={vi.fn()} />); });
    const rows = screen.getAllByRole("button", { name: /src\/app.ts/ });
    await act(async () => { fireEvent.click(rows[0]); });
    expect(screen.getByLabelText("File diff")).toHaveTextContent("+first");
    await act(async () => { fireEvent.click(rows[1]); });
    expect(mockInvoke).toHaveBeenCalledWith("git_workspace_diff", { rootPath: "/repo", path: "src/app.ts", area: "unstaged" });
    content = "+changed again";
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByLabelText("File diff")).toHaveTextContent("+changed again");
  });
  it("does not poll when collapsed and discards old state on project changes", async () => {
    let resolve!: (value: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const view = render(<WorkspaceGitPanel rootPath="/old" open={false} onToggle={vi.fn()} />);
    expect(mockInvoke).not.toHaveBeenCalled();
    view.rerender(<WorkspaceGitPanel rootPath="/old" open onToggle={vi.fn()} />);
    view.rerender(<WorkspaceGitPanel rootPath="" open onToggle={vi.fn()} />);
    await act(async () => { resolve({ branch: "old", files: [file], repository: "/old" }); });
    expect(screen.queryByText("old")).not.toBeInTheDocument();
    expect(screen.getByText("Open a folder to review its changes.")).toBeInTheDocument();
  });
});
