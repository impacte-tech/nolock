// ---------------------------------------------------------------------------
// FaqPanel — Learning-mode .faq knowledge base viewer.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import FaqPanel from "../FaqPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

const ENTRY = (id: number, question: string, answer: string, frequency: number, similarity?: number) => ({
  id,
  question,
  answer,
  frequency,
  lastAsked: 1_750_000_000,
  updatedAt: 1_750_000_000,
  similarity,
  score: similarity ?? undefined,
});

function setup() {
  resetTauriMocks();
  localStorage.clear();
  mockInvoke.mockImplementation((cmd: string, args?: any) => {
    if (cmd === "faq_list") {
      return Promise.resolve([
        ENTRY(1, "How does the tool loop stop?", "It stops after max_iterations.", 3, 0.92),
        ENTRY(2, "Why cap output tokens?", "So input + output fit the context.", 1),
      ]);
    }
    if (cmd === "faq_stats") {
      return Promise.resolve({ count: 2, dimension: 768, model: "nomic-embed-text", dbPath: "/repo/.faq/nolock-faq.db" });
    }
    return Promise.resolve(null);
  });
}

describe("FaqPanel", () => {
  it("renders the learned entries and store stats for the open folder", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);

    await waitFor(() => {
      expect(screen.getByText("How does the tool loop stop?")).toBeInTheDocument();
    });
    expect(screen.getByText(/learned exchange/)).toBeInTheDocument();
    expect(screen.getByText(/nomic-embed-text/)).toBeInTheDocument();
    expect(screen.getByText(/similarity 92\.0%/)).toBeInTheDocument();
    expect(screen.getByText("Why cap output tokens?")).toBeInTheDocument();
  });

  it("shows the empty state when no project folder is open", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="" />);
    expect(screen.getByText(/Open a project folder to view its learned \.faq entries/)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("faq_list", expect.anything());
  });

  it("shows an empty prompt when no entries exist yet", async () => {
    setup();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "faq_list") return Promise.resolve([]);
      if (cmd === "faq_stats") return Promise.resolve({ count: 0, dimension: 0, model: "nomic-embed-text", dbPath: "/repo/.faq/nolock-faq.db" });
      return Promise.resolve(null);
    });
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => {
      expect(screen.getByText(/No learned entries yet/)).toBeInTheDocument();
    });
  });

  it("reveals the answer when expanded", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => screen.getByText("How does the tool loop stop?"));
    expect(screen.queryByText("It stops after max_iterations.")).not.toBeInTheDocument();
    const showButton = screen.getAllByText("Show answer")[0];
    fireEvent.click(showButton);
    expect(screen.getByText("It stops after max_iterations.")).toBeInTheDocument();
  });

  it("deletes an entry via faq_delete and reloads the list", async () => {
    setup();
    let listCalls = 0;
    let deletedQuestion: string | null = null;
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "faq_list") {
        listCalls += 1;
        return Promise.resolve([ENTRY(1, "Keep me", "A.", 1, 0.5)]);
      }
      if (cmd === "faq_stats") {
        return Promise.resolve({ count: 1, dimension: 4, model: "nomic-embed-text", dbPath: "/repo/.faq/nolock-faq.db" });
      }
      if (cmd === "faq_delete") {
        deletedQuestion = args.question;
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => screen.getByText("Keep me"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletedQuestion).toBe("Keep me"));
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
  });
});