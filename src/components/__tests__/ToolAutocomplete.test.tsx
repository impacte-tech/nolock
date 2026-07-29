// ---------------------------------------------------------------------------
// Tests for ToolAutocomplete component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { mockInvoke } from "../../test/tauri-mock";
import ToolAutocomplete from "../ToolAutocomplete";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps = {
  query: "",
  rootPath: "/home/user/project",
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

function renderToolAutocomplete(overrides: Partial<typeof defaultProps> = {}) {
  return render(<ToolAutocomplete {...defaultProps} {...overrides} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolAutocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue([]); // no custom tools by default
  });

  // ---- Built-in tools presence -------------------------------------------

  it("lists all built-in tools when query is empty", async () => {
    renderToolAutocomplete();

    expect(await screen.findByText("#web_search")).toBeInTheDocument();
    expect(screen.getByText("#web_fetch")).toBeInTheDocument();
    expect(screen.getByText("#grep")).toBeInTheDocument();
    expect(screen.getByText("#read_file")).toBeInTheDocument();
    expect(screen.getByText("#edit")).toBeInTheDocument();
    expect(screen.getByText("#write_file")).toBeInTheDocument();
    expect(screen.getByText("#list_directory")).toBeInTheDocument();
    expect(screen.getByText("#rust_repl")).toBeInTheDocument();
    expect(screen.getByText("#bash_sandbox")).toBeInTheDocument();
  });

  it("shows exactly 9 built-in tools", async () => {
    renderToolAutocomplete();
    const items = await screen.findAllByText(/^#/, { selector: ".tool-autocomplete-name span" });
    expect(items).toHaveLength(9);
  });

  // ---- Filtering ---------------------------------------------------------

  it("filters tools by query", async () => {
    renderToolAutocomplete({ query: "web" });

    const items = await screen.findAllByText(/^#/, { selector: ".tool-autocomplete-name span" });
    const texts = items.map((el) => el.textContent);
    expect(texts).toContain("#web_search");
    expect(texts).toContain("#web_fetch");
    expect(texts).not.toContain("#grep");
    expect(texts).not.toContain("#rust_repl");
  });

  it("filters tools case-insensitively", async () => {
    renderToolAutocomplete({ query: "RUST" });

    const items = await screen.findAllByText(/^#/, { selector: ".tool-autocomplete-name span" });
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("#rust_repl");
  });

  it("filters by partial match on any position", async () => {
    renderToolAutocomplete({ query: "sandbox" });

    const items = await screen.findAllByText(/^#/, { selector: ".tool-autocomplete-name span" });
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("#bash_sandbox");
  });

  it("shows 'no tools found' when query matches nothing", async () => {
    renderToolAutocomplete({ query: "zzz_nonexistent_zzz" });

    await screen.findByText(/No tools found/);
    expect(screen.getByText(/No tools found/)).toBeInTheDocument();
  });

  // ---- Custom tools ------------------------------------------------------

  it("merges custom tools from invoke into the list", async () => {
    mockInvoke.mockResolvedValue([
      { name: "my_custom_tool", path: "/home/user/project/.tools/my_custom_tool.json", description: "A custom tool" },
    ]);

    renderToolAutocomplete();

    expect(await screen.findByText("#my_custom_tool")).toBeInTheDocument();
    expect(screen.getByText("A custom tool")).toBeInTheDocument();
    // Built-in tools should still be there
    expect(screen.getByText("#web_search")).toBeInTheDocument();
  });

  it("does not duplicate custom tool if a built-in has the same id", async () => {
    mockInvoke.mockResolvedValue([
      { name: "grep", path: "/home/user/project/.tools/grep.json", description: "Custom grep override" },
    ]);

    renderToolAutocomplete();

    await screen.findByText("#grep");
    const grepItems = screen.getAllByText("#grep");
    // Should only appear once (the built-in version)
    expect(grepItems).toHaveLength(1);
  });

  it("filters custom tools by query too", async () => {
    mockInvoke.mockResolvedValue([
      { name: "deploy_prod", path: ".tools/deploy_prod.json", description: "Deploy to production" },
    ]);

    renderToolAutocomplete({ query: "deploy" });

    expect(await screen.findByText("#deploy_prod")).toBeInTheDocument();
  });

  // ---- Built-in badge ----------------------------------------------------

  it("shows 'built-in' badge for built-in tools", async () => {
    renderToolAutocomplete();

    await screen.findByText("#web_search");
    const badges = screen.getAllByText("built-in");
    expect(badges.length).toBeGreaterThanOrEqual(9); // all 9 built-in tools
  });

  it("does not show 'built-in' badge for custom tools", async () => {
    mockInvoke.mockResolvedValue([
      { name: "my_tool", path: ".tools/my_tool.json", description: "Custom" },
    ]);

    renderToolAutocomplete();

    await screen.findByText("#my_tool");
    // The custom tool row should NOT contain a "built-in" badge
    const badges = screen.getAllByText("built-in");
    // Still 9 built-in badges for the built-in tools, not 10
    expect(badges).toHaveLength(9);
  });

  // ---- Selection callbacks -----------------------------------------------

  it("calls onSelect with correct path and name when clicking a tool", async () => {
    const onSelect = vi.fn();
    renderToolAutocomplete({ onSelect });

    fireEvent.mouseDown(await screen.findByText("#rust_repl"));

    expect(onSelect).toHaveBeenCalledWith("builtin:rust_repl", "rust_repl");
  });

  it("calls onSelect with custom tool path for custom tools", async () => {
    const onSelect = vi.fn();
    mockInvoke.mockResolvedValue([
      { name: "my_tool", path: "/project/.tools/my_tool.json", description: "Custom" },
    ]);

    renderToolAutocomplete({ onSelect });

    fireEvent.mouseDown(await screen.findByText("#my_tool"));

    expect(onSelect).toHaveBeenCalledWith("/project/.tools/my_tool.json", "my_tool");
  });

  // ---- Keyboard navigation -----------------------------------------------

  it("selects next tool on ArrowDown", async () => {
    renderToolAutocomplete();

    await screen.findByText("#web_search");
    // First item should be selected by default
    const items = screen.getAllByText(/^#/, { selector: ".tool-autocomplete-name span" });
    expect(items[0].closest(".tool-autocomplete-item")).toHaveClass("selected");

    // Arrow down should select second
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(items[1].closest(".tool-autocomplete-item")).toHaveClass("selected");
  });

  it("selects previous tool on ArrowUp", async () => {
    renderToolAutocomplete();

    await screen.findByText("#web_search");
    const items = screen.getAllByText(/^#/, { selector: ".tool-autocomplete-name span" });

    // Move down first
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    // Now on index 2, move back up
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(items[1].closest(".tool-autocomplete-item")).toHaveClass("selected");
  });

  it("does not go below index 0 on ArrowUp", async () => {
    renderToolAutocomplete();

    await screen.findByText("#web_search");
    const items = screen.getAllByText(/^#/, { selector: ".tool-autocomplete-name span" });

    fireEvent.keyDown(document, { key: "ArrowUp" });
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(items[0].closest(".tool-autocomplete-item")).toHaveClass("selected");
  });

  it("calls onSelect on Enter key", async () => {
    const onSelect = vi.fn();
    renderToolAutocomplete({ onSelect });

    await screen.findByText("#web_search");
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("builtin:web_search", "web_search");
  });

  it("calls onSelect on Tab key", async () => {
    const onSelect = vi.fn();
    renderToolAutocomplete({ onSelect });

    await screen.findByText("#web_search");
    fireEvent.keyDown(document, { key: "Tab" });

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("calls onClose on Escape key", async () => {
    const onClose = vi.fn();
    renderToolAutocomplete({ onClose });

    await screen.findByText("#web_search");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("navigates to selected tool then selects with Enter", async () => {
    const onSelect = vi.fn();
    renderToolAutocomplete({ onSelect });

    await screen.findByText("#web_search");
    // Navigate down to rust_repl (index 7) and select
    for (let i = 0; i < 7; i++) {
      fireEvent.keyDown(document, { key: "ArrowDown" });
    }
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("builtin:rust_repl", "rust_repl");
  });

  // ---- Custom tool fetch failure ------------------------------------------

  it("handles invoke failure gracefully (no custom tools)", async () => {
    mockInvoke.mockRejectedValue(new Error("invoke failed"));

    renderToolAutocomplete();

    // Built-in tools should still render
    expect(await screen.findByText("#web_search")).toBeInTheDocument();
    expect(screen.getByText("#bash_sandbox")).toBeInTheDocument();
  });
});
