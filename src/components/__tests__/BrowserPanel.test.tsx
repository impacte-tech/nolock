// ---------------------------------------------------------------------------
// Smoke tests for BrowserPanel component (with Tauri API mocks)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BrowserPanel from "../BrowserPanel";
import { mockInvoke } from "../../test/tauri-mock";

describe("BrowserPanel", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // By default make the Rust command fail, forcing JS fallback
    mockInvoke.mockRejectedValue(new Error("Not on Linux"));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("renders the toolbar with URL input and buttons", () => {
    render(<BrowserPanel url="https://example.com" onClose={vi.fn()} resizeEpoch={0} />);
    // URL input should show the initial URL
    const urlInput = screen.getByDisplayValue("https://example.com");
    expect(urlInput).toBeInTheDocument();
    // Close button
    expect(screen.getByTitle("Close browser")).toBeInTheDocument();
    // Reload button
    expect(screen.getByTitle("Reload")).toBeInTheDocument();
    // Open in system browser button
    expect(screen.getByTitle("Open in system browser")).toBeInTheDocument();
  });

  it("shows loading state while creating webview", () => {
    render(<BrowserPanel url="https://example.com" onClose={vi.fn()} resizeEpoch={0} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://example.com" onClose={onClose} resizeEpoch={0} />);
    fireEvent.click(screen.getByTitle("Close browser"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("updates input value on typing", () => {
    render(<BrowserPanel url="https://example.com" onClose={vi.fn()} resizeEpoch={0} />);
    const input = screen.getByDisplayValue("https://example.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://github.com" } });
    expect(input.value).toBe("https://github.com");
  });

  it("tries Rust command on mount and falls back to JS", async () => {
    render(<BrowserPanel url="https://example.com" onClose={vi.fn()} resizeEpoch={0} />);

    await waitFor(() => {
      // The Rust create_browser_webview should have been called
      expect(mockInvoke).toHaveBeenCalledWith("create_browser_webview", expect.any(Object));
    });
  });

  it("renders without crashing for empty URL", () => {
    render(<BrowserPanel url="" onClose={vi.fn()} resizeEpoch={0} />);
    const input = screen.getByDisplayValue("") as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });
});
