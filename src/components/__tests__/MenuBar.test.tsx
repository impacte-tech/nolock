// ---------------------------------------------------------------------------
// Tests for MenuBar component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MenuBar from "../MenuBar";

describe("MenuBar", () => {
  const mockMenus = [
    {
      label: "File",
      items: [
        { label: "Open", action: vi.fn(), shortcut: "Ctrl+O" },
        { label: "Save", action: vi.fn(), shortcut: "Ctrl+S" },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", action: vi.fn(), shortcut: "Ctrl+Z" },
      ],
    },
  ];

  it("renders all top-level menu labels", () => {
    render(<MenuBar menus={mockMenus} />);
    expect(screen.getByText("File")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("does not show dropdown items by default", () => {
    render(<MenuBar menus={mockMenus} />);
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(screen.queryByText("Undo")).not.toBeInTheDocument();
  });

  it("opens dropdown on click", () => {
    render(<MenuBar menus={mockMenus} />);
    fireEvent.mouseDown(screen.getByText("File"));
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("calls action and closes dropdown on item click", () => {
    const action = vi.fn();
    const menus = [
      { label: "File", items: [{ label: "Open", action }] },
    ];
    render(<MenuBar menus={menus} />);
    fireEvent.mouseDown(screen.getByText("File"));
    fireEvent.click(screen.getByText("Open"));
    expect(action).toHaveBeenCalledOnce();

    // Dropdown should close
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("displays shortcut text when provided", () => {
    render(<MenuBar menus={mockMenus} />);
    fireEvent.mouseDown(screen.getByText("File"));
    expect(screen.getByText("Ctrl+O")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+S")).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", () => {
    render(<MenuBar menus={mockMenus} />);
    fireEvent.mouseDown(screen.getByText("File"));
    expect(screen.getByText("Open")).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("switches menu on hover when another menu is open", () => {
    render(<MenuBar menus={mockMenus} />);
    // Open File menu
    fireEvent.mouseDown(screen.getByText("File"));
    expect(screen.getByText("Open")).toBeInTheDocument();

    // Hover over Edit — should switch to Edit's dropdown
    fireEvent.mouseEnter(screen.getByText("Edit"));
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
    expect(screen.getByText("Undo")).toBeInTheDocument();
  });

  it("renders empty when menus array is empty", () => {
    const { container } = render(<MenuBar menus={[]} />);
    expect(container.querySelector(".menubar")).toBeInTheDocument();
  });
});
