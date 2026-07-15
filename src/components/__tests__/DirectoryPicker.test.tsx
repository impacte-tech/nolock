import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DirectoryPicker from "../DirectoryPicker";
import { mockInvoke } from "../../test/tauri-mock";

describe("DirectoryPicker", () => {
  const defaultProps = {
    sourcePath: "/root/test.txt",
    sourceName: "test.txt",
    rootPath: "/root",
    onMove: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([
      { name: "docs", path: "/root/docs", is_dir: true },
      { name: "src", path: "/root/src", is_dir: true },
    ]);
  });

  it("renders modal with source file name", async () => {
    render(<DirectoryPicker {...defaultProps} />);
    expect(screen.getByText(/Move "test.txt"/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });
  });

  it("shows breadcrumb for nested directory after navigation", async () => {
    render(<DirectoryPicker {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    fireEvent.mouseDown(screen.getByText("docs"));
    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });
  });

  it("shows loading indicator while fetching", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    render(<DirectoryPicker {...defaultProps} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty state when no directories exist", async () => {
    mockInvoke.mockResolvedValue([]);
    render(<DirectoryPicker {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("(empty)")).toBeInTheDocument();
    });
  });

  it("navigates into a directory on click", async () => {
    render(<DirectoryPicker {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue([
      { name: "subdir", path: "/root/docs/subdir", is_dir: true },
    ]);

    fireEvent.mouseDown(screen.getByText("docs"));
    await waitFor(() => {
      expect(screen.getByText("subdir")).toBeInTheDocument();
    });
    expect(mockInvoke).toHaveBeenCalledWith("list_directory", { path: "/root/docs" });
  });

  it("calls onMove with source and selected directory on Move Here", async () => {
    const onMove = vi.fn();
    render(<DirectoryPicker {...defaultProps} onMove={onMove} />);
    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Move to destination"));
    expect(onMove).toHaveBeenCalledWith("/root/test.txt", "/root");
  });

  it("calls onClose on Cancel button", () => {
    render(<DirectoryPicker {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose on overlay click", () => {
    render(<DirectoryPicker {...defaultProps} />);
    const overlay = document.querySelector(".modal-overlay");
    expect(overlay).toBeInTheDocument();
    fireEvent.click(overlay!);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows 'Go up' when not at root directory", async () => {
    render(<DirectoryPicker {...defaultProps} />);
    await waitFor(() => expect(screen.getByText("docs")).toBeInTheDocument());

    mockInvoke.mockResolvedValue([
      { name: "subdir", path: "/root/docs/subdir", is_dir: true },
    ]);
    fireEvent.mouseDown(screen.getByText("docs"));
    await waitFor(() => {
      expect(screen.getByText("Go up")).toBeInTheDocument();
    });
  });

  it("disables buttons while moving", async () => {
    const onMove = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)));
    render(<DirectoryPicker {...defaultProps} onMove={onMove} />);
    await waitFor(() => expect(screen.getByText("docs")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Move to destination"));
    expect(screen.getByText("Moving...")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeDisabled();
  });
});
