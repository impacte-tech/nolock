// ---------------------------------------------------------------------------
// Component tests for the Hooks panel (src/components/HooksPanel.tsx)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import HooksPanel from "../HooksPanel";
import { mockInvoke } from "../../test/tauri-mock";

function mockEmptyReferenceLists() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_hooks") return Promise.resolve([]);
    if (cmd === "list_agents") return Promise.resolve([]);
    if (cmd === "list_skills") return Promise.resolve([]);
    if (cmd === "list_tools") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

describe("HooksPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
  });

  it("renders an empty state when no hooks exist", async () => {
    mockEmptyReferenceLists();
    render(<HooksPanel visible rootPath="/p" onClose={() => {}} />);
    expect(await screen.findByText(/No hooks yet/)).toBeInTheDocument();
  });

  it("lists hooks with their trigger label and actions", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hooks") {
        return Promise.resolve([{ name: "commit-review", path: "/p/.hooks/commit-review.yaml" }]);
      }
      if (cmd === "read_hook") {
        return Promise.resolve({
          name: "commit-review",
          description: "Review staged changes.",
          trigger: { type: "command", command: "git commit" },
          agent: { prompt: "x", skills: [], tools: [] },
        });
      }
      if (cmd === "list_agents") return Promise.resolve([]);
      if (cmd === "list_skills") return Promise.resolve([]);
      if (cmd === "list_tools") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<HooksPanel visible rootPath="/p" onClose={() => {}} />);

    expect(await screen.findByText("commit-review")).toBeInTheDocument();
    expect(screen.getByText(/After command:/)).toBeInTheDocument();
    expect(screen.getByText("Review staged changes.")).toBeInTheDocument();
    expect(screen.getByText("Run now")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("opens the creation form and saves a new command hook", async () => {
    mockEmptyReferenceLists();
    render(<HooksPanel visible rootPath="/p" onClose={() => {}} />);

    fireEvent.click(screen.getByText("New Hook"));

    const nameInput = screen.getByPlaceholderText("e.g. commit-review");
    fireEvent.change(nameInput, { target: { value: "commit-review" } });

    const commandInput = screen.getByPlaceholderText("git commit");
    fireEvent.change(commandInput, { target: { value: "git commit" } });

    const promptInput = screen.getByPlaceholderText(/You are a commit-review hook/);
    fireEvent.change(promptInput, { target: { value: "Review the staged diff." } });

    fireEvent.click(screen.getByText("Save Hook"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_hook",
        expect.objectContaining({
          rootPath: "/p",
          name: "commit-review",
        }),
      );
    });
  });

  it("switches to a cron trigger and saves the schedule", async () => {
    mockEmptyReferenceLists();
    render(<HooksPanel visible rootPath="/p" onClose={() => {}} />);

    fireEvent.click(screen.getByText("New Hook"));

    const nameInput = screen.getByPlaceholderText("e.g. commit-review");
    fireEvent.change(nameInput, { target: { value: "daily-report" } });

    fireEvent.click(screen.getByText("Cron schedule"));

    const scheduleInput = screen.getByPlaceholderText("0 9 * * 1-5");
    fireEvent.change(scheduleInput, { target: { value: "0 9 * * 1-5" } });

    const promptInput = screen.getByPlaceholderText(/You are a commit-review hook/);
    fireEvent.change(promptInput, { target: { value: "Generate the daily report." } });

    fireEvent.click(screen.getByText("Save Hook"));

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "save_hook");
      const args = (call?.[1] ?? {}) as Record<string, unknown>;
      expect(args.name).toBe("daily-report");
      expect((args.config as Record<string, unknown>).trigger).toEqual({
        type: "cron",
        schedule: "0 9 * * 1-5",
      });
    });
  });

  it("shows validation errors instead of saving an incomplete hook", async () => {
    mockEmptyReferenceLists();
    render(<HooksPanel visible rootPath="/p" onClose={() => {}} />);

    fireEvent.click(screen.getByText("New Hook"));
    fireEvent.click(screen.getByText("Save Hook"));

    expect(await screen.findByText(/Hook name is required/)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("save_hook", expect.anything());
  });

  it("does not render when hidden", () => {
    mockEmptyReferenceLists();
    const { container } = render(<HooksPanel visible={false} rootPath="/p" onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
