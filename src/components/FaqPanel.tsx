// ---------------------------------------------------------------------------
// Knowledge Base (.faq) — full CRUD over the learned question → answer store.
//
// Per open folder (each project keeps its own SQLite + sqlite-vec store at
// `<root>/.faq/nolock-faq.db`):
//   - automatic categories: on load, unassigned entries are clustered by
//     embedding similarity into groups of at most Top K (from the Chat Model
//     panel) and each group becomes an auto-category with a short topic name from the chat model;
//   - manual categories: create / rename / delete, and move Q→A pairs between
//     them (moving any entry 'freezes' it out of auto-clustering);
//   - edit any question/answer pair (re-embeds it), delete any pair;
//   - search matches category names, questions AND answers.
// ---------------------------------------------------------------------------

import { useState, useCallback, useEffect, useRef } from "react";
import Select from "./Select";
import {
  faqListCategories,
  nameFaqCategories,
  faqStats,
  faqCreateCategory,
  faqRenameCategory,
  faqDeleteCategory,
  faqSetEntryCategory,
  faqUpdateEntry,
  faqDeleteEntry,
  getFaqConfig,
  type FaqCategory,
  type FaqCategoryList,
  type FaqEntry,
  type FaqStats,
} from "../lib/faq";

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath: string;
}

function formatTime(secs: number): string {
  if (!secs) return "—";
  try {
    return new Date(secs * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function formatMeta(entry: FaqEntry): string {
  const parts = [`asked ${entry.frequency}×`, `last asked ${formatTime(entry.lastAsked)}`];
  if (entry.similarity != null) {
    parts.push(`similarity ${(entry.similarity * 100).toFixed(1)}% to group`);
  }
  if (entry.model) {
    parts.push(entry.backend ? `answered by ${entry.model} (${entry.backend})` : `answered by ${entry.model}`);
  }
  return parts.join(" · ");
}

/** Match against the category name, question or answer text. */
function textMatches(needle: string, ...haystacks: string[]): boolean {
  const q = needle.toLowerCase();
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

export default function FaqPanel({ visible, onClose, rootPath }: Props) {
  const [list, setList] = useState<FaqCategoryList | null>(null);
  const [stats, setStats] = useState<FaqStats | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null); // action errors
  const [newCategory, setNewCategory] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameName, setRenameName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editBackend, setEditBackend] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoNote, setAutoNote] = useState("");

  const request = useRef(0);
  const topK = getFaqConfig().topK;

  const load = useCallback(async () => {
    const version = ++request.current;
    setNaming(false);
    if (!rootPath) { setList(null); setStats(null); return; }
    setBusy(true);
    setError(null);
    const cfg = getFaqConfig();
    try {
      const [next, info] = await Promise.all([
        faqListCategories(rootPath, cfg.topK, cfg.minSimilarity), faqStats(rootPath),
      ]);
      if (version !== request.current) return;
      setList(next);
      setStats(info);
      setAutoNote(`Learning mode saves answered questions here. Similar questions are grouped together and named by your chat model. Rename any category or use a question’s category selector to organize it yourself.`);
      setBusy(false);
      if (next.categories.some((c) => c.needsName)) {
        setNaming(true);
        try { await nameFaqCategories(rootPath, next, () => version === request.current); }
        catch (e) { if (version === request.current) setError(String(e)); }
        if (version !== request.current) return;
        const named = await faqListCategories(rootPath, cfg.topK, cfg.minSimilarity);
        if (version === request.current) setList(named);
      }
    } catch (e) {
      if (version === request.current) setError(String(e));
    } finally {
      if (version === request.current) { setBusy(false); setNaming(false); }
    }
  }, [rootPath]);

  useEffect(() => {
    setList(null);
    setStats(null);
    setEditingId(null);
    setRenaming(null);
    setExpanded(new Set());
    setQuery("");
    if (visible) void load();
    return () => { request.current++; };
  }, [visible, load]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    const version = ++request.current;
    setNaming(false);
    setBusy(true);
    setError(null);
    try {
      await action();
      if (version === request.current) await load();
    } catch (e) {
      if (version === request.current) setError(String(e));
    }
    if (version === request.current) setBusy(false);
  };

  const createCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    void run(async () => {
      await faqCreateCategory(rootPath, name);
      setNewCategory("");
    });
  };

  const renameCategory = (id: number) => {
    const name = renameName.trim();
    if (!name) return;
    void run(async () => {
      await faqRenameCategory(rootPath, id, name);
      setRenaming(null);
    });
  };

  const deleteCategory = (category: FaqCategory) => {
    if (!confirm(`Delete category "${category.name}"? Its ${category.size} question(s) move back to Unassigned.`)) return;
    void run(() => faqDeleteCategory(rootPath, category.id));
  };

  const moveEntry = (entryId: number, categoryId: string) => {
    void run(() => faqSetEntryCategory(rootPath, entryId, categoryId === "" ? null : Number(categoryId)));
  };

  const startEdit = (entry: FaqEntry) => {
    setEditingId(entry.id);
    setEditQuestion(entry.question);
    setEditAnswer(entry.answer);
    setEditCategoryId(entry.categoryId != null ? String(entry.categoryId) : "");
    setEditModel(entry.model ?? "");
    setEditBackend(entry.backend ?? "");
  };

  const saveEdit = () => {
    if (editingId == null) return;
    if (!editQuestion.trim()) {
      setError("Question cannot be empty.");
      return;
    }
    const saving = editingId;
    const question = editQuestion.trim();
    const answer = editAnswer;
    const categoryId = editCategoryId === "" ? null : Number(editCategoryId);
    void run(async () => {
      await faqUpdateEntry(rootPath, saving, question, answer, categoryId, editModel, editBackend);
      setEditingId(null);
    });
  };

  const deleteEntry = (entry: FaqEntry) => {
    if (!confirm(`Delete "${entry.question}" from the knowledge base?`)) return;
    void run(() => faqDeleteEntry(rootPath, entry.id));
  };

  const toggleExpanded = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  if (!visible) return null;

  const categories = (list?.categories ?? []).map((category) => ({
    ...category,
    name: category.needsName ? "Awaiting category name" : category.name,
  }));
  const uncategorized = list?.uncategorized ?? [];
  const totalCount = stats?.count ?? 0;

  const categoryOptions = [
    { value: "", label: "Unassigned" },
    ...categories.map((c) => ({ value: String(c.id), label: c.name })),
  ];

  const searching = query.trim().length > 0;
  const q = query.trim();

  // Flat search view: (categoryName | null, entry) pairs matching the query.
  const searchHits: { category: string | null; entry: FaqEntry }[] = searching
    ? [
        ...categories.flatMap((c) =>
          c.entries
            .filter((e) => textMatches(q, c.name, e.question, e.answer))
            .map((e) => ({ category: c.name, entry: e })),
        ),
        ...uncategorized
          .filter((e) => textMatches(q, "Unassigned", e.question, e.answer))
          .map((e) => ({ category: null, entry: e })),
      ]
    : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal faq-panel" role="dialog" aria-modal="true" aria-label="Knowledge Base" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Knowledge Base (.faq)</span>
          <button aria-label="Close knowledge base" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {naming && <div role="status">Naming categories with the chat model… You can keep editing.</div>}
          {error && <div className="faq-error" role="alert">{error}</div>}
          {!rootPath ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>
              Open a project folder to view its knowledge base. Each project keeps its own
              SQLite + sqlite-vec store at <code>.faq/nolock-faq.db</code>.
            </span>
          ) : !list && busy ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>
              Loading knowledge base…
            </span>
          ) : (
            <>
              {totalCount === 0 && <p className="faq-empty">No learned entries yet. Switch the chat to Learning mode and ask a question to start your knowledge base.</p>}
              {stats && (
                <div style={{ marginBottom: 8, fontSize: 11, color: "var(--text-muted)" }}>
                  <strong>{stats.count}</strong> learned exchange{stats.count === 1 ? "" : "s"}
                  {` · ${categories.length} categories`}
                  <details className="faq-details"><summary>Index details</summary>
                    <p>Embedding: {stats.model} · {stats.dimension} dimensions</p>
                    <code>{stats.dbPath}</code>
                  </details>
                </div>
              )}
              <div style={{ marginBottom: 10, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {autoNote}
              </div>
              {stats?.lastError ? (
                <div style={{ marginBottom: 10, padding: "8px 10px", background: "var(--surface)", border: "1px solid var(--danger, #c0392b)", borderRadius: 6, fontSize: 11 }}>
                  <strong>Indexing is partially degraded:</strong> some entries are saved as text
                  but could not be vectorized, so semantic search won't match them.
                  <span style={{ display: "block", color: "var(--danger, #c0392b)", marginTop: 4 }}>
                    Last error: {stats.lastError}
                  </span>
                </div>
              ) : null}

              {/* Toolbar: new category + search + refresh */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="field-input"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createCategory()}
                  placeholder="New category…"
                  aria-label="New category name"
                  style={{ flex: 1, minWidth: 120 }}
                />
                <button className="btn-secondary" onClick={createCategory} disabled={!newCategory.trim() || busy}>Add</button>
                <button className="btn-secondary" onClick={() => void load()} disabled={busy}>Refresh</button>
              </div>
              <div style={{ marginBottom: 10 }}>
                <input
                  className="field-input"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search categories, questions and answers…"
                  aria-label="Search knowledge base"
                  style={{ width: "100%" }}
                />
              </div>

              {searching ? (
                <>
                  <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Search results for "{q}" ({searchHits.length})
                    </span>
                  </div>
                  {searchHits.length === 0 ? (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      No matches. Try a term from a category, question or answer.
                    </span>
                  ) : (
                    searchHits.map(({ category, entry }) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        categoryName={category ?? undefined}
                        categoryOptions={categoryOptions}
                        expanded={expanded}
                        topK={topK}
                        busy={busy}
                        editingId={editingId}
                        editQuestion={editQuestion}
                        editAnswer={editAnswer}
                        editCategoryId={editCategoryId}
                        setEditQuestion={setEditQuestion}
                        setEditAnswer={setEditAnswer}
                        setEditCategoryId={setEditCategoryId}
                        onToggle={() => toggleExpanded(entry.id)}
                        onStartEdit={() => startEdit(entry)}
                        onSaveEdit={saveEdit}
                        onCancelEdit={() => setEditingId(null)}
                        onDelete={() => deleteEntry(entry)}
                        onMove={(categoryId) => moveEntry(entry.id, categoryId)}
                      />
                    ))
                  )}
                </>
              ) : (
                <>
                  {categories.map((category) => (
                    <CategorySection
                      key={category.id}
                      category={category}
                      topK={topK}
                      busy={busy}
                      renaming={renaming}
                      renameName={renameName}
                      setRenaming={setRenaming}
                      setRenameName={setRenameName}
                      onRename={() => renameCategory(category.id)}
                      onDelete={() => deleteCategory(category)}
                      categoryOptions={categoryOptions}
                      expanded={expanded}
                      editingId={editingId}
                      editQuestion={editQuestion}
                      editAnswer={editAnswer}
                      editCategoryId={editCategoryId}
                      setEditQuestion={setEditQuestion}
                      setEditAnswer={setEditAnswer}
                      setEditCategoryId={setEditCategoryId}
                      onToggle={toggleExpanded}
                      onStartEdit={startEdit}
                      onSaveEdit={saveEdit}
                      onCancelEdit={() => setEditingId(null)}
                      onDeleteEntry={deleteEntry}
                      onMoveEntry={moveEntry}
                    />
                  ))}
                  {uncategorized.length > 0 && (
                    <div style={{ marginTop: 12, padding: "8px 10px", background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-muted)" }}>
                        Unassigned ({uncategorized.length}) <span style={{ textTransform: "none", fontWeight: 400 }}>— choose a category to organize these questions</span>
                      </div>
                      {uncategorized.map((entry) => (
                        <EntryCard
                          key={entry.id}
                          entry={entry}
                          categoryOptions={categoryOptions}
                          expanded={expanded}
                          topK={topK}
                          busy={busy}
                          editingId={editingId}
                          editQuestion={editQuestion}
                          editAnswer={editAnswer}
                          editCategoryId={editCategoryId}
                          setEditQuestion={setEditQuestion}
                          setEditAnswer={setEditAnswer}
                          setEditCategoryId={setEditCategoryId}
                          onToggle={() => toggleExpanded(entry.id)}
                          onStartEdit={() => startEdit(entry)}
                          onSaveEdit={saveEdit}
                          onCancelEdit={() => setEditingId(null)}
                          onDelete={() => deleteEntry(entry)}
                          onMove={(categoryId) => moveEntry(entry.id, categoryId)}
                        />
                      ))}
                    </div>
                  )}
                  {categories.length === 0 && uncategorized.length === 0 && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      No categories yet — create one above.
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CardProps {
  entry: FaqEntry;
  categoryName?: string;
  categoryOptions: { value: string; label: string }[];
  expanded: Set<number>;
  topK: number;
  busy: boolean;
  editingId: number | null;
  editQuestion: string;
  editAnswer: string;
  editCategoryId: string;
  setEditQuestion: (v: string) => void;
  setEditAnswer: (v: string) => void;
  setEditCategoryId: (v: string) => void;
  onToggle: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onMove: (categoryId: string) => void;
}

/** Editable question → answer card with expand-to-answer, edit, move, delete. */
function EntryCard(props: CardProps) {
  const { entry, categoryName, categoryOptions, expanded, busy, editingId } = props;
  const isOpen = expanded.has(entry.id);
  const isEditing = editingId === entry.id;

  if (isEditing) {
    return (
      <div className="faq-entry" style={{ marginTop: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-secondary)" }}>
        <input
          className="field-input"
          value={props.editQuestion}
          onChange={(e) => props.setEditQuestion(e.target.value)}
          placeholder="Question"
          aria-label="Edit question"
          style={{ width: "100%", marginBottom: 6 }}
        />
        <textarea
          className="field-input"
          value={props.editAnswer}
          onChange={(e) => props.setEditAnswer(e.target.value)}
          placeholder="Answer"
          aria-label="Edit answer"
          rows={3}
          style={{ width: "100%", resize: "vertical", marginBottom: 6, fontFamily: "monospace", fontSize: 11 }}
        />
        <Select
          value={props.editCategoryId}
          onChange={props.setEditCategoryId}
          options={categoryOptions}
          style={{ marginBottom: 6 }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn-primary" onClick={props.onSaveEdit} disabled={busy}>Save</button>
          <button className="btn-secondary" onClick={props.onCancelEdit}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="faq-entry" style={{ marginTop: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6 }}>
      <strong style={{ fontSize: 12, display: "block" }}>{entry.question}</strong>
      <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginTop: 2 }}>
        {formatMeta(entry)}
      </span>
      {isOpen ? (
        <pre style={{ margin: "4px 0", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.answer}</pre>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn-secondary" onClick={props.onToggle}>
          {isOpen ? "Hide answer" : "Show answer"}
        </button>
        <button type="button" className="btn-secondary" onClick={props.onStartEdit} disabled={busy}>Edit</button>
        <Select
          value={entry.categoryId != null ? String(entry.categoryId) : ""}
          onChange={(value) => { if (!busy) props.onMove(value); }}
          options={categoryOptions}
          placeholder={categoryName ?? "Unassigned"}
          style={{ minWidth: 120 }}
        />
        <button type="button"
          className="btn-secondary"
          style={{ color: "var(--danger, #c0392b)" }}
          disabled={busy}
          onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

interface CategoryProps {
  category: FaqCategory;
  topK: number;
  busy: boolean;
  renaming: number | null;
  renameName: string;
  setRenaming: (v: number | null) => void;
  setRenameName: (v: string) => void;
  onRename: () => void;
  onDelete: () => void;
  categoryOptions: { value: string; label: string }[];
  expanded: Set<number>;
  editingId: number | null;
  editQuestion: string;
  editAnswer: string;
  editCategoryId: string;
  setEditQuestion: (v: string) => void;
  setEditAnswer: (v: string) => void;
  setEditCategoryId: (v: string) => void;
  onStartEdit: (entry: FaqEntry) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteEntry: (entry: FaqEntry) => void;
  onMoveEntry: (entryId: number, categoryId: string) => void;
  onToggle: (id: number) => void;
}

/** A category card with its member entries. */
function CategorySection(props: CategoryProps) {
  const { category } = props;
  return (
    <div className="faq-category" style={{ marginTop: 10, padding: "8px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {props.renaming === category.id ? (
          <>
            <input
              className="field-input"
              value={props.renameName}
              onChange={(e) => props.setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && props.onRename()}
              aria-label="Category name"
              style={{ flex: 1, minWidth: 140 }}
            />
            <button className="btn-primary" onClick={props.onRename} disabled={!props.renameName.trim() || props.busy}>Save</button>
            <button className="btn-secondary" onClick={() => props.setRenaming(null)}>Cancel</button>
          </>
        ) : (
          <>
            <strong style={{ fontSize: 12, flex: 1 }}>{category.name}</strong>
            {category.isAuto ? (
              <span style={{ fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
                Automatic
              </span>
            ) : (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>manual</span>
            )}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {category.size} question{category.size === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn-secondary" onClick={() => {
              props.setRenameName(category.needsName ? "" : category.name);
              props.setRenaming(category.id);
            }} disabled={props.busy}>
              Rename
            </button>
            <button type="button" className="btn-secondary" style={{ color: "var(--danger, #c0392b)" }} onClick={props.onDelete} disabled={props.busy}>
              Delete
            </button>
          </>
        )}
      </div>
      {category.entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          categoryName={category.name}
          categoryOptions={props.categoryOptions}
          expanded={props.expanded}
          topK={props.topK}
          busy={props.busy}
          editingId={props.editingId}
          editQuestion={props.editQuestion}
          editAnswer={props.editAnswer}
          editCategoryId={props.editCategoryId}
          setEditQuestion={props.setEditQuestion}
          setEditAnswer={props.setEditAnswer}
          setEditCategoryId={props.setEditCategoryId}
          onToggle={() => props.onToggle(entry.id)}
          onStartEdit={() => props.onStartEdit(entry)}
          onSaveEdit={props.onSaveEdit}
          onCancelEdit={props.onCancelEdit}
          onDelete={() => props.onDeleteEntry(entry)}
          onMove={(categoryId) => props.onMoveEntry(entry.id, categoryId)}
        />
      ))}
    </div>
  );
}