// ---------------------------------------------------------------------------
// Smoke tests for SearchPanel component (with Tauri API mocks)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SearchPanel from "../SearchPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

// Helper to build SearchMatch objects
function makeMatch(
  filePath: string,
  lineNumber: number,
  lineContent: string,
  matchStart = 0,
  matchEnd = 0,
) {
  return { file_path: filePath, line_number: lineNumber, line_content: lineContent, match_start: matchStart, match_end: matchEnd };
}

describe("SearchPanel", () => {
  const mockOnResultClick = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    mockOnResultClick.mockReset();
    mockOnClose.mockReset();
    // Default: search returns no results
    mockInvoke.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  // ---- Render states ------------------------------------------------------

  it('shows "no folder" message when rootPath is empty', () => {
    render(
      <SearchPanel
        rootPath=""
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );
    expect(screen.getByText(/Open a folder to search/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Open a folder to search/i)).toBeInTheDocument();
  });

  it("shows idle message when rootPath is set but no query typed", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );
    expect(
      screen.getByText(/Type a search term to find across all files/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search in workspace/i),
    ).toBeInTheDocument();
  });

  it("renders the header with close button", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("\u00D7")).toBeInTheDocument(); // close button
  });

  // ---- Input and search trigger -------------------------------------------

  it("calls invoke with correct args when user types a query", async () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    // Wait for debounce (300ms) + async invoke
    await waitFor(
      () => {
        expect(mockInvoke).toHaveBeenCalledWith("search_in_files", {
          rootPath: "/test",
          query: "hello",
          matchCase: false,
          useRegex: false,
        });
      },
      { timeout: 500 },
    );
  });

  it("does not search when query is empty", async () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "" } });

    // Wait a bit to ensure no invoke call was made
    await new Promise((r) => setTimeout(r, 400));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does not search when query is too short (1 char)", async () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "a" } });

    await new Promise((r) => setTimeout(r, 400));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("shows searching indicator while waiting for results", async () => {
    // Make invoke hang until we resolve it
    let resolveInvoke: (value: any) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    // After debounce, the searching indicator should appear
    await waitFor(
      () => {
        expect(screen.getByText("Searching...")).toBeInTheDocument();
      },
      { timeout: 500 },
    );

    // Resolve the search with empty results
    resolveInvoke!([]);
  });

  // ---- Results display ----------------------------------------------------

  it("shows no results message when search returns empty", async () => {
    mockInvoke.mockResolvedValue([]);

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(
      () => {
        expect(screen.getByText("No results found")).toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  it("displays search results grouped by file", async () => {
    mockInvoke.mockResolvedValue([
      makeMatch("src/main.rs", 1, "fn main() {", 3, 7),
      makeMatch("src/main.rs", 3, 'println!("hello");', 10, 15),
      makeMatch("src/lib.rs", 5, "pub fn hello() {}", 7, 12),
    ]);

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(
      () => {
        // Should show file path headers
        expect(screen.getByText(/main\.rs/)).toBeInTheDocument();
        expect(screen.getByText(/lib\.rs/)).toBeInTheDocument();
        // Should show line numbers
        // Use getAllByText for "1" since src/lib.rs file-count also shows "1"
        expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("3")).toBeInTheDocument();
        expect(screen.getByText("5")).toBeInTheDocument();
        // Should show results count
        expect(screen.getByText("3 results in 2 files")).toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  it("shows replace mode toggle", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    // Click "Replace" toggle in header
    fireEvent.click(screen.getByText("Replace"));
    expect(screen.getByPlaceholderText(/Replace with/)).toBeInTheDocument();
    expect(screen.getByText("Replace All")).toBeInTheDocument();

    // Click "Search" toggle to go back (use title since header also contains "Search")
    fireEvent.click(screen.getByTitle("Switch to search mode"));
    expect(screen.queryByPlaceholderText(/Replace with/)).not.toBeInTheDocument();
  });

  // ---- Options ------------------------------------------------------------

  it("toggles match case option", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const matchCaseOption = screen.getByText("Match case");
    expect(matchCaseOption).toBeInTheDocument();

    // Click to toggle on
    fireEvent.click(matchCaseOption);
    expect(matchCaseOption.parentElement).toHaveClass("active");
  });

  it("toggles regex option", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const regexOption = screen.getByText("Regex");
    expect(regexOption).toBeInTheDocument();

    // Click to toggle on
    fireEvent.click(regexOption);
    expect(regexOption.parentElement).toHaveClass("active");
  });

  it("re-searches when match case option changes with a query", async () => {
    mockInvoke.mockResolvedValue([]);

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    // Type a query first
    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    // Wait for initial search
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    }, { timeout: 500 });

    mockInvoke.mockClear();

    // Toggle match case on
    const matchCaseOption = screen.getByText("Match case");
    fireEvent.click(matchCaseOption);

    // Should trigger a new search with matchCase: true
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("search_in_files", {
        rootPath: "/test",
        query: "hello",
        matchCase: true,
        useRegex: false,
      });
    }, { timeout: 500 });
  });

  // ---- Error handling -----------------------------------------------------

  it("shows error message when invoke fails", async () => {
    mockInvoke.mockRejectedValue(new Error("Connection refused"));

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(
      () => {
        expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  // ---- Result click -------------------------------------------------------

  it("calls onResultClick when a result line is clicked", async () => {
    mockInvoke.mockResolvedValue([
      makeMatch("src/main.rs", 5, "fn main() {", 3, 7),
    ]);

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "main" } });

    // Wait for results and click on line number "5"
    await waitFor(
      () => {
        expect(screen.getByText("5")).toBeInTheDocument();
      },
      { timeout: 500 },
    );

    fireEvent.click(screen.getByText("5"));
    expect(mockOnResultClick).toHaveBeenCalledWith("src/main.rs", 5);
  });

  // ---- Collapse / Expand --------------------------------------------------

  it("collapses and expands file groups", async () => {
    mockInvoke.mockResolvedValue([
      makeMatch("src/main.rs", 1, "fn main() {", 3, 7),
      makeMatch("src/lib.rs", 5, "pub fn hello() {}", 7, 12),
    ]);

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(() => {
      expect(screen.getByText("Collapse All")).toBeInTheDocument();
    }, { timeout: 500 });

    // Click collapse all
    fireEvent.click(screen.getByText("Collapse All"));
    // Results should be hidden (file headers still visible though)
    expect(screen.getByText("Expand All")).toBeInTheDocument();

    // Click expand all
    fireEvent.click(screen.getByText("Expand All"));
    expect(screen.getByText("Collapse All")).toBeInTheDocument();
  });

  // ---- Close on Escape ----------------------------------------------------

  it("calls onClose when Escape is pressed", () => {
    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  // ---- Replace All flow ---------------------------------------------------

  it("shows Replace All button in replace mode and calls invoke on click", async () => {
    // First search needs to return results
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "search_in_files") {
        return Promise.resolve([makeMatch("src/main.rs", 1, "hello world", 0, 5)]);
      }
      if (cmd === "replace_in_files") {
        return Promise.resolve({ files_changed: 1, replacements_made: 2 });
      }
      return Promise.resolve([]);
    });
    // Mock window.confirm to return true
    const origConfirm = window.confirm;
    window.confirm = vi.fn(() => true);
    const origAlert = window.alert;
    window.alert = vi.fn();

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    // Type a search query
    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(() => {
      expect(screen.getByText(/1 result in 1 file/)).toBeInTheDocument();
    }, { timeout: 500 });

    // Switch to replace mode
    fireEvent.click(screen.getByText("Replace"));
    expect(screen.getByPlaceholderText(/Replace with/)).toBeInTheDocument();

    // Type replacement
    const replaceInput = screen.getByPlaceholderText(/Replace with/);
    fireEvent.change(replaceInput, { target: { value: "hi" } });

    // Clear previous invoke calls
    mockInvoke.mockClear();

    // Click Replace All
    // Re-set the mock before clicking
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "replace_in_files") {
        return Promise.resolve({ files_changed: 1, replacements_made: 1 });
      }
      if (cmd === "search_in_files") {
        return Promise.resolve([makeMatch("src/main.rs", 1, "hi world", 0, 2)]);
      }
      return Promise.resolve([]);
    });
    window.confirm = vi.fn(() => true);
    window.alert = vi.fn();

    fireEvent.click(screen.getByText("Replace All"));

    await waitFor(() => {
      // Should have called replace_in_files with correct args
      expect(mockInvoke).toHaveBeenCalledWith("replace_in_files", {
        rootPath: "/test",
        query: "hello",
        replacement: "hi",
        matchCase: false,
        useRegex: false,
      });
    }, { timeout: 500 });

    // Restore
    window.confirm = origConfirm;
    window.alert = origAlert;
  });

  it("does not call replace if confirm is cancelled", async () => {
    mockInvoke.mockResolvedValue([makeMatch("src/main.rs", 1, "hello world", 0, 5)]);
    const origConfirm = window.confirm;
    window.confirm = vi.fn(() => false); // user cancels

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(() => {
      expect(screen.getByText(/1 result in 1 file/)).toBeInTheDocument();
    }, { timeout: 500 });

    // Switch to replace mode
    fireEvent.click(screen.getByText("Replace"));

    const replaceInput = screen.getByPlaceholderText(/Replace with/);
    fireEvent.change(replaceInput, { target: { value: "hi" } });

    mockInvoke.mockClear();

    fireEvent.click(screen.getByText("Replace All"));

    // Wait a bit to ensure no replace call was made
    await new Promise((r) => setTimeout(r, 200));
    expect(mockInvoke).not.toHaveBeenCalledWith("replace_in_files", expect.anything());

    window.confirm = origConfirm;
  });

  // ---- Enter key triggers immediate search --------------------------------

  it("triggers search immediately on Enter key", async () => {
    // Give mock a delayed resolve so we can see the search happens
    let resolveSearch: (v: any) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );

    render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    const input = screen.getByPlaceholderText(/Search in workspace/i);
    // Type a query
    fireEvent.change(input, { target: { value: "hello" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Should have called invoke immediately (not waiting for debounce)
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("search_in_files", {
        rootPath: "/test",
        query: "hello",
        matchCase: false,
        useRegex: false,
      });
    }, { timeout: 100 });

    resolveSearch!([]);
  });

  // ---- Re-evaluates state when rootPath changes ---------------------------

  it("resets to no-folder state when rootPath becomes empty", () => {
    const { rerender } = render(
      <SearchPanel
        rootPath="/test"
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByPlaceholderText(/Search in workspace/i)).toBeInTheDocument();

    rerender(
      <SearchPanel
        rootPath=""
        onResultClick={mockOnResultClick}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByPlaceholderText(/Open a folder to search/i)).toBeInTheDocument();
  });
});
