import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileExplorer from "../FileExplorer";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

beforeEach(() => { resetTauriMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
it("reflects external additions and deletions inside expanded folders without collapsing them", async () => {
  let name = "before.ts";
  mockInvoke.mockImplementation(async (_cmd, args) => args.path === "/repo" ? [{ name: "src", path: "/repo/src", is_dir: true }] : [{ name, path: `/repo/src/${name}`, is_dir: false }]);
  await act(async () => { render(<FileExplorer rootPath="/repo" setRootPath={vi.fn()} onFileOpen={vi.fn()} visible />); });
  await act(async () => { fireEvent.click(screen.getByText("src")); });
  expect(screen.getByText("before.ts")).toBeInTheDocument();
  name = "after.ts";
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.queryByText("before.ts")).not.toBeInTheDocument();
  expect(screen.getByText("after.ts")).toBeInTheDocument();
});
it("refreshes collapsed folders when reopened and stops polling on unmount", async () => {
  let name = "old.ts";
  mockInvoke.mockImplementation(async (_cmd, args) => args.path === "/repo" ? [{ name: "src", path: "/repo/src", is_dir: true }] : [{ name, path: `/repo/src/${name}`, is_dir: false }]);
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<FileExplorer rootPath="/repo" setRootPath={vi.fn()} onFileOpen={vi.fn()} visible />); });
  await act(async () => { fireEvent.click(screen.getByText("src")); });
  fireEvent.click(screen.getByText("src"));
  name = "new.ts";
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { fireEvent.click(screen.getByText("src")); });
  expect(screen.getByText("new.ts")).toBeInTheDocument();
  view.unmount(); const count = mockInvoke.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mockInvoke).toHaveBeenCalledTimes(count);
});
