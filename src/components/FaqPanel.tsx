// ---------------------------------------------------------------------------
// .faq panel — read the learned question → answer knowledge base.
//
// Shows what Learning mode has auto-indexed for the CURRENTLY OPEN project.
// Each open folder keeps its own SQLite + sqlite-vec store at
// `<root>/.faq/nolock-faq.db`, so this panel always reflects the open folder
// (it renders an empty state when no folder is open).
// ---------------------------------------------------------------------------

import { useState, useCallback, useEffect } from "react";
import { faqList, faqStats, faqDelete, type FaqEntry, type FaqStats } from "../lib/faq";

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

function formatScore(entry: FaqEntry): string {
  if (entry.similarity != null) {
    return `similarity ${(entry.similarity * 100).toFixed(1)}%`;
  }
  if (entry.score != null) {
    return `score ${entry.score.toFixed(2)}`;
  }
  return "score —";
}

export default function FaqPanel({ visible, onClose, rootPath }: Props) {
  const [entries, setEntries] = useState<FaqEntry[]>([]);
  const [stats, setStats] = useState<FaqStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!rootPath) {
      setEntries([]);
      setStats(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEntries(await faqList(rootPath));
      setStats(await faqStats(rootPath));
    } catch (e) {
      setError(String(e));
      setEntries([]);
      setStats(null);
    }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const removeEntry = async (question: string) => {
    if (!rootPath) return;
    setBusy(true);
    setError(null);
    try {
      await faqDelete(rootPath, question);
      await load();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>.faq — Learned Knowledge</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {!rootPath ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>
              Open a project folder to view its learned .faq entries. Each project keeps its
              own SQLite + sqlite-vec store at <code>.faq/nolock-faq.db</code>, so the index is
              always scoped to the open folder.
            </span>
          ) : loading && entries.length === 0 ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>
              Loading learned entries…
            </span>
          ) : entries.length === 0 ? (
            <>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>
                No learned entries yet for <strong>{rootPath}</strong>.
                Ask questions in <strong>Learning mode</strong> (Chat Model panel) and nolock
                will index each exchange so future questions retrieve it automatically.
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <button className="btn-secondary" onClick={() => void load()}>Refresh</button>
              </div>
            </>
          ) : (
            <>
              {stats && (
                <div style={{ marginBottom: 12, fontSize: 11, color: "var(--text-muted)" }}>
                  <strong>{stats.count}</strong> learned exchange{stats.count === 1 ? "" : "s"}
                  · embedding <code>{stats.model}</code>
                  {stats.dimension > 0 ? ` · ${stats.dimension}-dim` : ""}
                  <span style={{ display: "block", marginTop: 2 }} title={stats.dbPath}>
                    Store: <code>{stats.dbPath}</code>
                  </span>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <button className="btn-secondary" onClick={() => void load()}>Refresh</button>
              </div>
              <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Ranked by learning-mode ranking (most relevant / most-asked first).
                </span>
              </div>
              {entries.map((entry) => {
                const isOpen = expanded.has(entry.id);
                return (
                  <div key={entry.id} style={{ marginTop: 10, padding: "8px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <strong style={{ fontSize: 12 }}>{entry.question}</strong>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        asked {entry.frequency}× · {formatScore(entry)} · last asked {formatTime(entry.lastAsked)}
                      </span>
                      {!isOpen ? (
                        <button type="button" className="btn-secondary" onClick={() => toggleExpanded(entry.id)}>Show answer</button>
                      ) : (
                        <>
                          <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.answer}</pre>
                          <button type="button" className="btn-secondary" onClick={() => toggleExpanded(entry.id)}>Hide answer</button>
                        </>
                      )}
                      <button type="button"
                        className="btn-secondary"
                        style={{ color: "var(--danger, #c0392b)" }}
                        disabled={busy}
                        onClick={() => void removeEntry(entry.question)}>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {error && (
            <span style={{ fontSize: 11, color: "var(--danger, #c0392b)", display: "block", marginTop: 8 }}>
              {error}
            </span>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}