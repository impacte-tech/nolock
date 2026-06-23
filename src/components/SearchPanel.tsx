import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchMatch {
  file_path: string;
  line_number: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

interface Props {
  rootPath: string;
  onResultClick: (filePath: string, lineNumber: number) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

type PanelState =
  | { kind: "no-folder" }
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; matches: SearchMatch[] }
  | { kind: "no-results" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Group matches by file path, preserving order of first occurrence. */
function groupByFile(matches: SearchMatch[]): { filePath: string; matches: SearchMatch[] }[] {
  const map = new Map<string, SearchMatch[]>();
  const order: string[] = [];

  for (const m of matches) {
    if (!map.has(m.file_path)) {
      map.set(m.file_path, []);
      order.push(m.file_path);
    }
    map.get(m.file_path)!.push(m);
  }

  return order.map((fp) => ({ filePath: fp, matches: map.get(fp)! }));
}

/** Highlight a match in a line of text by wrapping it in a <mark>. */
function highlightLine(
  line: string,
  matchStart: number,
  matchEnd: number,
): (string | { text: string; highlight: boolean })[] {
  const parts: (string | { text: string; highlight: boolean })[] = [];

  if (matchStart > 0) {
    parts.push(line.slice(0, matchStart));
  }
  parts.push({ text: line.slice(matchStart, matchEnd), highlight: true });
  if (matchEnd < line.length) {
    parts.push(line.slice(matchEnd));
  }

  return parts;
}

/** Shorten a file path for display (show last N path components). */
function shortenPath(filePath: string, maxParts: number = 3): string {
  const parts = filePath.split("/");
  if (parts.length <= maxParts) return filePath;
  return ".../" + parts.slice(-maxParts).join("/");
}

// ---------------------------------------------------------------------------
// SearchPanel Component
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;

export default function SearchPanel({ rootPath, onResultClick, onClose, style }: Props) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [panelState, setPanelState] = useState<PanelState>(() =>
    rootPath ? { kind: "idle" } : { kind: "no-folder" },
  );
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [expandedAll, setExpandedAll] = useState(true);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Re-evaluate state when rootPath changes
  useEffect(() => {
    if (!rootPath) {
      setPanelState({ kind: "no-folder" });
      setQuery("");
    } else if (panelState.kind === "no-folder") {
      setPanelState({ kind: "idle" });
    }
  }, [rootPath]);

  // ---- Search ----
  const executeSearch = useCallback(
    async (q: string, mc: boolean, ur: boolean) => {
      const trimmed = q.trim();
      if (!trimmed || trimmed.length < 2) {
        setPanelState({ kind: "idle" });
        return;
      }
      if (!rootPath) {
        setPanelState({ kind: "no-folder" });
        return;
      }

      setPanelState({ kind: "searching" });

      try {
        const matches: SearchMatch[] = await invoke("search_in_files", {
          rootPath,
          query: trimmed,
          matchCase: mc,
          useRegex: ur,
        });

        if (matches.length === 0) {
          setPanelState({ kind: "no-results" });
        } else {
          setPanelState({ kind: "results", matches });
          // Expand all by default
          setCollapsedFiles(new Set());
          setExpandedAll(true);
        }
      } catch (e: any) {
        setPanelState({ kind: "error", message: String(e) });
      }
    },
    [rootPath],
  );

  // Debounced search trigger
  const triggerSearch = useCallback(
    (q: string, mc: boolean, ur: boolean) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        executeSearch(q, mc, ur);
      }, DEBOUNCE_MS);
    },
    [executeSearch],
  );

  // Handle query changes
  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (!value.trim()) {
        setPanelState({ kind: "idle" });
        return;
      }
      triggerSearch(value, matchCase, useRegex);
    },
    [matchCase, useRegex, triggerSearch],
  );

  // Handle option changes — re-search immediately
  const handleMatchCaseChange = useCallback(() => {
    setMatchCase((prev) => {
      const next = !prev;
      if (query.trim().length >= 2) {
        triggerSearch(query, next, useRegex);
      }
      return next;
    });
  }, [query, useRegex, triggerSearch]);

  const handleUseRegexChange = useCallback(() => {
    setUseRegex((prev) => {
      const next = !prev;
      if (query.trim().length >= 2) {
        triggerSearch(query, matchCase, next);
      }
      return next;
    });
  }, [query, matchCase, triggerSearch]);

  // ---- Replace All ----
  const handleReplaceAll = useCallback(async () => {
    if (panelState.kind !== "results") return;
    const trimmed = query.trim();
    if (!trimmed || !rootPath) return;

    const confirmed = window.confirm(
      `Replace all occurrences of "${trimmed}" with "${replacement}" in the workspace?\n\nThis action cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const result: { files_changed: number; replacements_made: number } = await invoke(
        "replace_in_files",
        {
          rootPath,
          query: trimmed,
          replacement,
          matchCase,
          useRegex,
        },
      );

      // Re-run search to refresh results
      executeSearch(trimmed, matchCase, useRegex);

      alert(
        `Replaced ${result.replacements_made} occurrence(s) across ${result.files_changed} file(s).`,
      );
    } catch (e: any) {
      alert(`Replace failed: ${e}`);
    }
  }, [panelState, query, replacement, rootPath, matchCase, useRegex, executeSearch]);

  // ---- File collapse / expand ----
  const toggleFile = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
    setExpandedAll(false);
  }, []);

  const collapseAll = useCallback(() => {
    if (panelState.kind !== "results") return;
    const all = new Set(panelState.matches.map((m) => m.file_path));
    setCollapsedFiles(all);
    setExpandedAll(false);
  }, [panelState]);

  const expandAll = useCallback(() => {
    setCollapsedFiles(new Set());
    setExpandedAll(true);
  }, []);

  // ---- Keyboard ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // ---- Computed ----
  const fileGroups = useMemo(
    () => (panelState.kind === "results" ? groupByFile(panelState.matches) : []),
    [panelState],
  );
  const totalMatches = useMemo(
    () => (panelState.kind === "results" ? panelState.matches.length : 0),
    [panelState],
  );

  // ---- Result-click handler ----
  const handleResultClick = useCallback(
    (filePath: string, lineNumber: number) => {
      onResultClick(filePath, lineNumber);
    },
    [onResultClick],
  );

  // ---- Render helpers ----
  const renderResultLine = (m: SearchMatch) => {
    const parts = highlightLine(m.line_content, m.match_start, m.match_end);
    return (
      <div
        key={`${m.file_path}:${m.line_number}:${m.match_start}`}
        className="search-result-line"
        onClick={() => handleResultClick(m.file_path, m.line_number)}
        title={m.line_content}
      >
        <span className="search-line-number">{m.line_number}</span>
        <span className="search-line-content">
          {parts.map((part, i) =>
            typeof part === "string" ? (
              <span key={i}>{part}</span>
            ) : (
              <mark key={i} className="search-highlight">
                {part.text}
              </mark>
            ),
          )}
        </span>
      </div>
    );
  };

  const renderFileGroup = (group: { filePath: string; matches: SearchMatch[] }) => {
    const isCollapsed = collapsedFiles.has(group.filePath);
    return (
      <div key={group.filePath} className="search-file-group">
        <div
          className="search-file-header"
          onClick={() => toggleFile(group.filePath)}
        >
          <span className="search-chevron">{isCollapsed ? "\u25B6" : "\u25BC"}</span>
          <span className="search-file-path" title={group.filePath}>
            {shortenPath(group.filePath)}
          </span>
          <span className="search-file-count">{group.matches.length}</span>
        </div>
        {!isCollapsed && (
          <div className="search-file-matches">
            {group.matches.map(renderResultLine)}
          </div>
        )}
      </div>
    );
  };

  // ---- Render ----
  return (
    <div className="search-panel" style={style}>
      {/* Header */}
      <div className="search-header">
        <span>Search</span>
        <div className="search-header-actions">
          {replaceMode ? (
            <span
              className="search-header-btn active"
              onClick={() => setReplaceMode(false)}
              title="Switch to search mode"
            >
              Search
            </span>
          ) : (
            <span
              className="search-header-btn"
              onClick={() => setReplaceMode(true)}
              title="Switch to replace mode"
            >
              Replace
            </span>
          )}
          <span className="search-header-btn search-close-btn" onClick={onClose}>
            &times;
          </span>
        </div>
      </div>

      {/* Search input */}
      <div className="search-input-area">
        <div className="search-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder={
              rootPath ? "Search in workspace..." : "Open a folder to search"
            }
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim().length >= 2) {
                executeSearch(query.trim(), matchCase, useRegex);
              }
              if (e.key === "Escape") {
                onClose();
              }
            }}
            disabled={!rootPath}
          />
          {panelState.kind === "searching" && (
            <span className="search-spinner" title="Searching...">&#x21bb;</span>
          )}
        </div>

        {/* Replace input (shown only in replace mode) */}
        {replaceMode && (
          <div className="search-replace-bar">
            <input
              type="text"
              className="search-input replace-input"
              placeholder="Replace with..."
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleReplaceAll();
              }}
            />
            <button
              className="replace-all-btn"
              onClick={handleReplaceAll}
              disabled={
                panelState.kind !== "results" || !replacement.trim()
              }
              title="Replace all occurrences"
            >
              Replace All
            </button>
          </div>
        )}

        {/* Options row */}
        <div className="search-options">
          <label
            className={`search-option ${matchCase ? "active" : ""}`}
            onClick={handleMatchCaseChange}
          >
            <span className="search-option-kbd">Aa</span>
            <span className="search-option-label">Match case</span>
          </label>
          <label
            className={`search-option ${useRegex ? "active" : ""}`}
            onClick={handleUseRegexChange}
          >
            <span className="search-option-kbd">.*</span>
            <span className="search-option-label">Regex</span>
          </label>
        </div>
      </div>

      {/* Results area */}
      <div className="search-results">
        {/* Summary bar */}
        {panelState.kind === "results" && (
          <div className="search-summary">
            <span className="search-summary-text">
              {totalMatches} result{totalMatches !== 1 ? "s" : ""} in{" "}
              {fileGroups.length} file{fileGroups.length !== 1 ? "s" : ""}
            </span>
            <div className="search-summary-actions">
              <span
                className="search-summary-btn"
                onClick={collapseAll}
                title="Collapse all"
              >
                Collapse All
              </span>
              <span
                className="search-summary-btn"
                onClick={expandAll}
                title="Expand all"
              >
                Expand All
              </span>
            </div>
          </div>
        )}

        {/* No folder */}
        {panelState.kind === "no-folder" && (
          <div className="search-message">
            Open a folder to search across files
          </div>
        )}

        {/* Idle */}
        {panelState.kind === "idle" && (
          <div className="search-message">
            Type a search term to find across all files in the workspace
          </div>
        )}

        {/* Searching */}
        {panelState.kind === "searching" && (
          <div className="search-message">Searching...</div>
        )}

        {/* No results */}
        {panelState.kind === "no-results" && (
          <div className="search-message">No results found</div>
        )}

        {/* Error */}
        {panelState.kind === "error" && (
          <div className="search-message search-error">
            Error: {panelState.message}
          </div>
        )}

        {/* Results */}
        {panelState.kind === "results" && (
          <div className="search-file-list">
            {fileGroups.map(renderFileGroup)}
          </div>
        )}
      </div>
    </div>
  );
}
