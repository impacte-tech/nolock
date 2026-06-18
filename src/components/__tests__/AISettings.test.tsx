// ---------------------------------------------------------------------------
// Tests for AISettings component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AISettings from "../AISettings";

describe("AISettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not visible", () => {
    const { container } = render(
      <AISettings visible={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the modal when visible", () => {
    render(<AISettings visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("AI Integrations")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("llama.cpp")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Zen")).toBeInTheDocument();
  });

  it("loads settings from localStorage on visibility", () => {
    localStorage.setItem("nolock.backend", "llamacpp");
    localStorage.setItem("nolock.url", "http://localhost:8080");
    localStorage.setItem("nolock.completionModel", "codellama");
    localStorage.setItem("nolock.chatModel", "llama3");

    render(<AISettings visible={true} onClose={vi.fn()} />);
    // llanacpp should be selected
    expect(screen.getByText("llama.cpp").closest(".backend-card")).toHaveClass("active");

    // URL input should be populated
    const urlInput = screen.getByDisplayValue("http://localhost:8080");
    expect(urlInput).toBeInTheDocument();
  });

  it("switches backend and updates URL when clicking a backend card", () => {
    render(<AISettings visible={true} onClose={vi.fn()} />);

    // Initially Ollama is selected
    expect(screen.getByText("Ollama").closest(".backend-card")).toHaveClass("active");

    // Click llama.cpp
    fireEvent.click(screen.getByText("llama.cpp"));
    expect(screen.getByText("llama.cpp").closest(".backend-card")).toHaveClass("active");
    expect(screen.getByText("Ollama").closest(".backend-card")).not.toHaveClass("active");

    // URL should have changed to llama.cpp's default
    const urlInput = screen.getByDisplayValue("http://localhost:8080");
    expect(urlInput).toBeInTheDocument();
  });

  it("toggles tool checkboxes", () => {
    render(<AISettings visible={true} onClose={vi.fn()} />);

    const webFetchCheckbox = screen.getByLabelText(/^Web Fetch/);
    expect(webFetchCheckbox).not.toBeChecked();

    fireEvent.click(webFetchCheckbox);
    expect(webFetchCheckbox).toBeChecked();

    fireEvent.click(webFetchCheckbox);
    expect(webFetchCheckbox).not.toBeChecked();
  });

  it("disables tool checkboxes when backend does not support tools", () => {
    // llama.cpp does not support tools
    render(<AISettings visible={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("llama.cpp"));

    const webFetchCheckbox = screen.getByLabelText(/^Web Fetch/);
    expect(webFetchCheckbox).toBeDisabled();
  });

  it("calls onClose when clicking the close button", () => {
    const onClose = vi.fn();
    render(<AISettings visible={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00D7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the overlay backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<AISettings visible={true} onClose={onClose} />);
    const overlay = container.querySelector(".modal-overlay")!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal", () => {
    const onClose = vi.fn();
    const { container } = render(<AISettings visible={true} onClose={onClose} />);
    const modal = container.querySelector(".modal")!;
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves settings to localStorage on Save", () => {
    const onClose = vi.fn();
    render(<AISettings visible={true} onClose={onClose} />);

    // Change URL
    const urlInput = screen.getByDisplayValue("http://localhost:11434");
    fireEvent.change(urlInput, { target: { value: "http://my-server:8080" } });

    // Click Save
    fireEvent.click(screen.getByText("Save"));

    expect(localStorage.getItem("nolock.url")).toBe("http://my-server:8080");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows API key field for OpenRouter", () => {
    render(<AISettings visible={true} onClose={vi.fn()} />);
    // No API key field for Ollama initially
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    // Switch to OpenRouter
    fireEvent.click(screen.getByText("OpenRouter"));
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });

  it("renders tool descriptions for each available tool", () => {
    render(<AISettings visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("Search the internet (DuckDuckGo) to discover relevant URLs")).toBeInTheDocument();
    expect(screen.getByText("Fetch and read web page content from a specific URL")).toBeInTheDocument();
    expect(screen.getByText("Read file contents from disk")).toBeInTheDocument();
    expect(screen.getByText("Explore project structure")).toBeInTheDocument();
  });
});
