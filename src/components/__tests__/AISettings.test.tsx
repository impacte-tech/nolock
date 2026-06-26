// ---------------------------------------------------------------------------
// Tests for new AI settings panel components
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelProvidersPanel from "../ModelProvidersPanel";
import ChatModelPanel from "../ChatModelPanel";
import FITMModelPanel from "../FITMModelPanel";
import ToolsPanel from "../ToolsPanel";

// ===== ModelProvidersPanel =====
describe("ModelProvidersPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not visible", () => {
    const { container } = render(
      <ModelProvidersPanel visible={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the modal when visible", () => {
    render(<ModelProvidersPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("Model Providers")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
  });

  it("loads settings from localStorage on visibility", () => {
    localStorage.setItem("nolock.backend", "llamacpp");
    localStorage.setItem("nolock.url", "http://localhost:8080");

    render(<ModelProvidersPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("llama.cpp").closest(".backend-card")).toHaveClass("active");
    const urlInput = screen.getByDisplayValue("http://localhost:8080");
    expect(urlInput).toBeInTheDocument();
  });

  it("switches backend on card click", () => {
    render(<ModelProvidersPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("Ollama").closest(".backend-card")).toHaveClass("active");

    fireEvent.click(screen.getByText("llama.cpp"));
    expect(screen.getByText("llama.cpp").closest(".backend-card")).toHaveClass("active");
    expect(screen.getByText("Ollama").closest(".backend-card")).not.toHaveClass("active");
    const urlInput = screen.getByDisplayValue("http://localhost:8080");
    expect(urlInput).toBeInTheDocument();
  });

  it("calls onClose when clicking close button", () => {
    const onClose = vi.fn();
    render(<ModelProvidersPanel visible={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00D7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves settings to localStorage on Save", () => {
    const onClose = vi.fn();
    render(<ModelProvidersPanel visible={true} onClose={onClose} />);

    const urlInput = screen.getByDisplayValue("http://localhost:11434");
    fireEvent.change(urlInput, { target: { value: "http://my-server:8080" } });
    fireEvent.click(screen.getByText("Save"));

    expect(localStorage.getItem("nolock.url")).toBe("http://my-server:8080");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows API key field for OpenRouter", () => {
    render(<ModelProvidersPanel visible={true} onClose={vi.fn()} />);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("OpenRouter"));
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });
});

// ===== ChatModelPanel =====
describe("ChatModelPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not visible", () => {
    const { container } = render(
      <ChatModelPanel visible={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders with title and input", () => {
    render(<ChatModelPanel visible={true} onClose={vi.fn()} />);
    // The title appears in both the header and the label
    expect(screen.getAllByText("Chat Model").length).toBeGreaterThanOrEqual(2);
    const input = screen.getByPlaceholderText("e.g. qwen3:8b");
    expect(input).toBeInTheDocument();
  });

  it("loads chat model from localStorage", () => {
    localStorage.setItem("nolock.chatModel", "test-model");
    render(<ChatModelPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("test-model")).toBeInTheDocument();
  });

  it("saves chat model on Save", () => {
    const onClose = vi.fn();
    render(<ChatModelPanel visible={true} onClose={onClose} />);
    const input = screen.getByPlaceholderText("e.g. qwen3:8b");
    fireEvent.change(input, { target: { value: "my-chat-model" } });
    fireEvent.click(screen.getByText("Save"));

    expect(localStorage.getItem("nolock.chatModel")).toBe("my-chat-model");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ===== FITMModelPanel =====
describe("FITMModelPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not visible", () => {
    const { container } = render(
      <FITMModelPanel visible={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders with title and input", () => {
    render(<FITMModelPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("FITM Model")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("e.g. qwen2.5-coder:1.5b");
    expect(input).toBeInTheDocument();
  });

  it("loads completion model from localStorage", () => {
    localStorage.setItem("nolock.completionModel", "test-fitm");
    render(<FITMModelPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("test-fitm")).toBeInTheDocument();
  });

  it("saves completion model on Save", () => {
    const onClose = vi.fn();
    render(<FITMModelPanel visible={true} onClose={onClose} />);
    const input = screen.getByPlaceholderText("e.g. qwen2.5-coder:1.5b");
    fireEvent.change(input, { target: { value: "my-fitm-model" } });
    fireEvent.click(screen.getByText("Save"));

    expect(localStorage.getItem("nolock.completionModel")).toBe("my-fitm-model");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ===== ToolsPanel =====
describe("ToolsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not visible", () => {
    const { container } = render(
      <ToolsPanel visible={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders with title and tool checkboxes", () => {
    render(<ToolsPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("Agent Tools")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Web Search/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Web Fetch/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Read File/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^List Directory/)).toBeInTheDocument();
  });

  it("toggles tool checkboxes", () => {
    render(<ToolsPanel visible={true} onClose={vi.fn()} />);
    const webFetchCheckbox = screen.getByLabelText(/^Web Fetch/);
    expect(webFetchCheckbox).not.toBeChecked();

    fireEvent.click(webFetchCheckbox);
    expect(webFetchCheckbox).toBeChecked();

    fireEvent.click(webFetchCheckbox);
    expect(webFetchCheckbox).not.toBeChecked();
  });

  it("renders tool descriptions", () => {
    render(<ToolsPanel visible={true} onClose={vi.fn()} />);
    expect(screen.getByText("Search the internet to discover relevant URLs before fetching them")).toBeInTheDocument();
    expect(screen.getByText("Fetch and read web page content from a specific URL")).toBeInTheDocument();
    expect(screen.getByText("Read file contents from disk")).toBeInTheDocument();
    expect(screen.getByText("Explore project structure")).toBeInTheDocument();
  });

  it("calls onClose when clicking close button", () => {
    const onClose = vi.fn();
    render(<ToolsPanel visible={true} onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00D7"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
