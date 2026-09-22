// ---------------------------------------------------------------------------
// FaqPanel — Knowledge Base (.faq) full CRUD: categories, edit, move, search.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FaqPanel from "../FaqPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

interface State {
  categories: any[];
  uncategorized: any[];
}

const ENTRY = (id: number, question: string, answer: string, frequency = 1, categoryId?: number, similarity?: number, model?: string, backend?: string) => ({
  id,
  question,
  answer,
  frequency,
  lastAsked: 1_750_000_000,
  updatedAt: 1_750_000_000,
  categoryId,
  similarity,
  score: similarity ?? undefined,
  model,
  backend,
});

const STATS = { count: 3, dimension: 768, model: "nomic-embed-text", dbPath: "/repo/.faq/nolock-faq.db" };

function baseState(): State {
  return {
    categories: [
      {
        id: 1,
        name: "Tool loop",
        isAuto: true,
        size: 2,
        entries: [
          ENTRY(1, "How does the tool loop stop?", "It stops after max_iterations.", 5, 1, 0.97, "qwen3:8b", "ollama"),
          ENTRY(2, "When does the agent loop stop?", "Same as above.", 2, 1, 0.9),
        ],
      },
    ],
    uncategorized: [ENTRY(3, "Why cap output tokens?", "So input + output fit the context.", 1)],
  };
}

function setup(state: State = baseState()) {
  resetTauriMocks();
  localStorage.clear();
  mockInvoke.mockImplementation((cmd: string, args?: any) => {
    switch (cmd) {
      case "faq_list_categories":
        return Promise.resolve({
          categories: state.categories,
          uncategorized: state.uncategorized,
        });
      case "faq_stats":
        return Promise.resolve(STATS);
      case "faq_create_category":
        state.categories.push({ id: 99, name: args.name, isAuto: false, size: 0, entries: [] });
        return Promise.resolve(null);
      case "faq_rename_category":
        const cat = state.categories.find((c) => c.id === args.id);
        if (cat) cat.name = args.name;
        return Promise.resolve(null);
      case "faq_delete_category":
        const deleted = state.categories.find((c) => c.id === args.id);
        if (deleted) {
          state.uncategorized.push(...deleted.entries.map((e: any) => ({ ...e, categoryId: undefined })));
          state.categories = state.categories.filter((c) => c.id !== args.id);
        }
        return Promise.resolve(null);
      case "faq_delete_entry":
        state.categories = state.categories.map((c) => ({ ...c, entries: c.entries.filter((e: any) => e.id !== args.id) }));
        state.uncategorized = state.uncategorized.filter((e) => e.id !== args.id);
        return Promise.resolve(null);
      case "faq_set_entry_category":
        return Promise.resolve(null);
      case "faq_update_entry":
        state.categories = state.categories.map((c) => ({
          ...c,
          entries: c.entries.map((e: any) => (e.id === args.id ? { ...e, question: args.question, answer: args.answer } : e)),
        }));
        state.uncategorized = state.uncategorized.map((e) => (e.id === args.id ? { ...e, question: args.question, answer: args.answer } : e));
        return Promise.resolve(null);
      case "get_secret":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
  return state;
}

describe("FaqPanel", () => {
  it("renders categories with an auto badge, members and the Top K note", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);

    await waitFor(() => expect(screen.getAllByText("Tool loop").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/auto · Top K 3/).length).toBeGreaterThan(0);
    expect(screen.getByText("How does the tool loop stop?")).toBeInTheDocument();
    expect(screen.getByText("When does the agent loop stop?")).toBeInTheDocument();
    expect(screen.getByText(/cosine ≥ 85%, at most Top K 3 per group/)).toBeInTheDocument();
    // Unassigned entries are listed under their own section.
    expect(screen.getByText("Unassigned (1)")).toBeInTheDocument();
    expect(screen.getByText("Why cap output tokens?")).toBeInTheDocument();
    // Model provenance is shown.
    expect(screen.getByText(/answered by qwen3:8b \(ollama\)/)).toBeInTheDocument();
  });

  it("creates a manual category", async () => {
    const state = setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => expect(screen.getAllByText("Tool loop").length).toBeGreaterThan(0));

    const input = screen.getByPlaceholderText(/New category/);
    fireEvent.change(input, { target: { value: "Concepts" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getAllByText("Concepts").length).toBeGreaterThan(0));
    expect(state.categories.some((c) => c.name === "Concepts" && c.isAuto === false)).toBe(true);
  });

  it("renames a manual category and disables rename for auto categories", async () => {
    const state = setup();
    state.categories.push({ id: 2, name: "Bookmarks", isAuto: false, size: 1, entries: [ENTRY(4, "A fav question?", "Answer.", 1, 2)] });
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => expect(screen.getAllByText("Bookmarks").length).toBeGreaterThan(0));

    // Auto category: rename is disabled.
    const autoHeader = screen.getAllByText("Tool loop")[0].closest("div") as HTMLElement;
    const autoRename = autoHeader.querySelector('button[title*="Auto categories"]') as HTMLButtonElement;
    expect(autoRename.disabled).toBe(true);

    // Manual category rename flow.
    const manualHeader = screen.getAllByText("Bookmarks")[0].closest("div") as HTMLElement;
    const renameButtons = Array.from(manualHeader.querySelectorAll("button"));
    const renameBtn = renameButtons.find((b) => b.textContent === "Rename") as HTMLButtonElement;
    fireEvent.click(renameBtn);
    const nameInput = screen.getByLabelText("Category name");
    fireEvent.change(nameInput, { target: { value: "General" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByText("General").length).toBeGreaterThan(0));
    expect(state.categories.find((c) => c.id === 2)?.name).toBe("General");
  });

  it("edits a question/answer pair through faq_update_entry", async () => {
    const state = setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => expect(screen.getAllByText("Tool loop").length).toBeGreaterThan(0));
    const cards = screen.getAllByText("Why cap output tokens?").length;
    expect(cards).toBe(1);
    const row = screen.getByText("Why cap output tokens?").closest("div") as HTMLElement;
    const editBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Edit") as HTMLButtonElement;
    fireEvent.click(editBtn);

    const qInput = screen.getByLabelText("Edit question");
    const aInput = screen.getByLabelText("Edit answer");
    fireEvent.change(qInput, { target: { value: "Why cap output?" } });
    fireEvent.change(aInput, { target: { value: "So the context fits." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Why cap output?")).toBeInTheDocument());
    expect(mockInvoke).toHaveBeenCalledWith("faq_update_entry", expect.objectContaining({
      question: "Why cap output?",
      answer: "So the context fits.",
    }));
    const updated = state.uncategorized.find((e) => e.id === 3);
    expect(updated.question).toBe("Why cap output?");
  });

  it("deletes a category (members move to Unassigned) and deletes an entry", async () => {
    const state = setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => expect(screen.getAllByText("Tool loop").length).toBeGreaterThan(0));

    const autoHeader = screen.getAllByText("Tool loop")[0].closest("div") as HTMLElement;
    const delCat = Array.from(autoHeader.querySelectorAll("button")).find((b) => b.textContent === "Delete") as HTMLButtonElement;
    fireEvent.click(delCat);
    await waitFor(() => expect(screen.getByText("Unassigned (3)")).toBeInTheDocument());
    expect(state.categories.length).toBe(0);
    expect(state.uncategorized.length).toBe(3);

    // Delete a specific Q→A pair.
    const row = screen.getByText("How does the tool loop stop?").closest("div") as HTMLElement;
    const delEntry = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Delete") as HTMLButtonElement;
    fireEvent.click(delEntry);
    await waitFor(() => expect(screen.queryByText("How does the tool loop stop?")).not.toBeInTheDocument());
    expect(state.uncategorized.length).toBe(2);
  });

  it("searches across category names, questions and answers", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="/repo" />);
    await waitFor(() => expect(screen.getAllByText("Tool loop").length).toBeGreaterThan(0));

    // Match on a QUESTION term.
    const search = screen.getByLabelText("Search knowledge base");
    fireEvent.change(search, { target: { value: "max_iterations" } });
    expect(screen.getByText("How does the tool loop stop?")).toBeInTheDocument();
    expect(screen.queryByText("Why cap output tokens?")).not.toBeInTheDocument();

    // Match on a CATEGORY name.
    fireEvent.change(search, { target: { value: "tool loop" } });
    expect(screen.getByText("How does the tool loop stop?")).toBeInTheDocument();
    expect(screen.queryByText("Why cap output tokens?")).not.toBeInTheDocument();

    // Match on an ANSWER term.
    fireEvent.change(search, { target: { value: "context" } });
    expect(screen.getByText("Why cap output tokens?")).toBeInTheDocument();
  });

  it("shows the empty state when no project folder is open", async () => {
    setup();
    render(<FaqPanel visible onClose={vi.fn()} rootPath="" />);
    expect(screen.getByText(/Open a project folder to view its knowledge base/)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("faq_list_categories", expect.anything());
  });
});