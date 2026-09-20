import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChatModelPanel from "../ChatModelPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

describe("ChatModelPanel — Chat Mode", () => {
  beforeEach(() => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    mockInvoke.mockResolvedValue({ content: "ok", tool_calls: [] });
  });

  it("renders the panel with the mode selector defaulting to Building", () => {
    render(<ChatModelPanel visible onClose={vi.fn()} />);
    expect(screen.getByText("Chat Mode")).toBeInTheDocument();
    expect(screen.getByText("Building")).toBeInTheDocument();
  });

  it("saves the selected chat mode to localStorage", async () => {
    render(<ChatModelPanel visible onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Building" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Learning" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("option", { name: "Learning" }));

    await waitFor(() => expect(screen.getByText(/maintains a plain-text/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Save"));
    expect(localStorage.getItem("nolock.chatMode")).toBe("learning");
  });
});