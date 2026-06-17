// ---------------------------------------------------------------------------
// Tests for TerminalMemoryOverlay component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TerminalMemoryOverlay from "../TerminalMemoryOverlay";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

describe("TerminalMemoryOverlay", () => {
  const onDismiss = vi.fn();

  beforeEach(() => {
    resetTauriMocks();
    onDismiss.mockClear();
    // Default: empty top commands and categories
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands") return Promise.resolve([]);
      if (cmd === "get_command_categories") return Promise.resolve(["uncategorized"]);
      return Promise.reject("Unknown command");
    });
  });

  it("renders the overlay with title and hint", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    expect(screen.getByText("Terminal Memory")).toBeInTheDocument();
    expect(screen.getByText("Top Commands")).toBeInTheDocument();
    expect(screen.getByText("Categories")).toBeInTheDocument();
  });

  it("shows empty state when no commands recorded", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    expect(screen.getByText("No commands recorded yet")).toBeInTheDocument();
  });

  it("renders top commands when present", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands")
        return Promise.resolve([
          { command: "docker ps", category: "docker", timestamp: 1000, count: 5 },
          { command: "git status", category: "git", timestamp: 2000, count: 3 },
        ]);
      if (cmd === "get_command_categories")
        return Promise.resolve(["docker", "git", "uncategorized"]);
      return Promise.reject("Unknown command");
    });

    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    await waitFor(() => {
      expect(screen.getByText("docker ps")).toBeInTheDocument();
    });
    expect(screen.getByText("git status")).toBeInTheDocument();
    expect(screen.getByText("5x")).toBeInTheDocument();
    expect(screen.getByText("3x")).toBeInTheDocument();
  });

  it("enters save mode when S is pressed", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    // Press S to enter save mode
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByText(/Save "docker ps" as:/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type category name/)).toBeInTheDocument();
  });

  it("saves category via input and Enter key", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands") return Promise.resolve([]);
      if (cmd === "get_command_categories")
        return Promise.resolve(["uncategorized"]);
      if (cmd === "save_command_category") return Promise.resolve(undefined);
      return Promise.reject("Unknown command");
    });

    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);

    // Enter save mode
    fireEvent.keyDown(window, { key: "s" });

    // Type a category
    const input = screen.getByPlaceholderText(/Type category name/);
    fireEvent.change(input, { target: { value: "docker" } });

    // Press Enter
    fireEvent.keyDown(window, { key: "Enter" });

    // Should have called save_command_category
    expect(mockInvoke).toHaveBeenCalledWith("save_command_category", {
      command: "docker ps",
      category: "docker",
    });
  });

  it("saves category by clicking a tag", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands") return Promise.resolve([]);
      if (cmd === "get_command_categories")
        return Promise.resolve(["docker", "git", "uncategorized"]);
      if (cmd === "save_command_category") return Promise.resolve(undefined);
      return Promise.reject("Unknown command");
    });

    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);

    // Wait for categories to load
    await waitFor(() => {
      expect(screen.getByText("docker")).toBeInTheDocument();
    });

    // Enter save mode
    fireEvent.keyDown(window, { key: "s" });

    // Click the "docker" category tag
    fireEvent.click(screen.getByText("docker"));

    // Should have called save_command_category
    expect(mockInvoke).toHaveBeenCalledWith("save_command_category", {
      command: "docker ps",
      category: "docker",
    });
  });

  it("dismisses on Escape when not in save mode", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses on clicking the overlay backdrop", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    // Click the overlay backdrop (the outer div with className "term-memory-overlay")
    const overlay = document.querySelector(".term-memory-overlay")!;
    fireEvent.click(overlay);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("exits save mode via Escape", () => {
    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    // Enter save mode
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByPlaceholderText(/Type category name/)).toBeInTheDocument();

    // Escape should exit save mode
    fireEvent.keyDown(window, { key: "Escape" });
    // After exiting save mode, the input should not be present
    expect(screen.queryByPlaceholderText(/Type category name/)).not.toBeInTheDocument();
  });

  it("renders categories as clickable tags", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands") return Promise.resolve([]);
      if (cmd === "get_command_categories")
        return Promise.resolve(["docker", "git", "network"]);
      return Promise.reject("Unknown command");
    });

    render(<TerminalMemoryOverlay lastCommand="docker ps" onDismiss={onDismiss} />);
    await waitFor(() => {
      expect(screen.getByText("docker")).toBeInTheDocument();
    });
    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("network")).toBeInTheDocument();
  });

  // ---- Empty-command guard tests ---------------------------------------

  it("shows error and does NOT enter save mode when S is pressed but lastCommand is empty", () => {
    render(<TerminalMemoryOverlay lastCommand="" onDismiss={onDismiss} />);
    expect(screen.queryByPlaceholderText(/Type category name/)).not.toBeInTheDocument();

    // Press S — should show error instead of entering save mode
    fireEvent.keyDown(window, { key: "s" });
    expect(
      screen.getByText(/No command to save/)
    ).toBeInTheDocument();
    // Save input should NOT appear
    expect(screen.queryByPlaceholderText(/Type category name/)).not.toBeInTheDocument();
  });

  it("shows error when category is selected but lastCommand is empty", () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_top_commands") return Promise.resolve([]);
      if (cmd === "get_command_categories")
        return Promise.resolve(["docker", "git"]);
      return Promise.reject("Unknown command");
    });

    // Use startInSaveMode to bypass the guard and enter save mode directly
    render(
      <TerminalMemoryOverlay
        lastCommand=""
        onDismiss={onDismiss}
        startInSaveMode={true}
      />
    );

    // In save mode with empty command, should show the empty-save message
    expect(screen.getByText(/No command to save yet/)).toBeInTheDocument();
    // No input field
    expect(screen.queryByPlaceholderText(/Type category name/)).not.toBeInTheDocument();
  });

  it("prevents saving via Enter key when lastCommand is empty", () => {
    render(
      <TerminalMemoryOverlay
        lastCommand=""
        onDismiss={onDismiss}
        startInSaveMode={true}
      />
    );

    // empty-save message is shown instead of input — Enter does nothing
    expect(screen.getByText(/No command to save yet/)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("save_command_category", expect.anything());
  });
});
