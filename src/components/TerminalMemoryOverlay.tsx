// ---------------------------------------------------------------------------
// TerminalMemoryOverlay — shown on Ctrl+Tab. Displays top 5 commands and
// command categories. Ctrl+Tab+S enters save mode to assign a category.
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CommandRecord {
  command: string;
  category: string;
  timestamp: number;
  count: number;
}

interface Props {
  lastCommand: string;
  onDismiss: () => void;
  startInSaveMode?: boolean;
}

export default function TerminalMemoryOverlay({ lastCommand, onDismiss, startInSaveMode }: Props) {
  const [topCommands, setTopCommands] = useState<CommandRecord[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [saveMode, setSaveMode] = useState(!!startInSaveMode);
  const [categoryInput, setCategoryInput] = useState("");
  const [selectedCategoryIdx, setSelectedCategoryIdx] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch data on mount
  useEffect(() => {
    invoke<CommandRecord[]>("get_top_commands")
      .then(setTopCommands)
      .catch(() => {});
    invoke<string[]>("get_command_categories")
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Focus input when entering save mode
  useEffect(() => {
    if (saveMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [saveMode]);

  const doSaveCategory = useCallback(
    (cat: string) => {
      const trimmed = cat.trim();
      if (!trimmed) return;
      if (!lastCommand.trim()) {
        setError("No command to save — type something in the terminal first");
        return;
      }
      invoke("save_command_category", {
        command: lastCommand,
        category: trimmed,
      })
        .then(() => onDismiss())
        .catch((e) => setError(String(e)));
    },
    [lastCommand, onDismiss]
  );

  // Keyboard handler on the overlay itself
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (saveMode) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (selectedCategoryIdx >= 0 && selectedCategoryIdx < categories.length) {
            doSaveCategory(categories[selectedCategoryIdx]);
          } else if (categoryInput.trim()) {
            doSaveCategory(categoryInput);
          }
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedCategoryIdx((prev) =>
            prev < categories.length - 1 ? prev + 1 : 0
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedCategoryIdx((prev) =>
            prev > 0 ? prev - 1 : categories.length - 1
          );
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSaveMode(false);
          setCategoryInput("");
          setSelectedCategoryIdx(-1);
          return;
        }
      } else {
        if (e.key === "s" || e.key === "S") {
          e.preventDefault();
          e.stopPropagation();
          if (!lastCommand.trim()) {
            setError("No command to save — type something in the terminal first");
            return;
          }
          setSaveMode(true);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onDismiss();
          return;
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [saveMode, categories, categoryInput, selectedCategoryIdx, doSaveCategory, onDismiss]);

  // Filter categories based on input
  const filteredCategories = saveMode
    ? categories.filter((c) =>
        c.toLowerCase().includes(categoryInput.toLowerCase())
      )
    : categories;

  return (
    <div className="term-memory-overlay" onClick={onDismiss}>
      <div className="term-memory-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="term-memory-header">
          <span className="term-memory-title">Terminal Memory</span>
          <span className="term-memory-hint">
            {saveMode
              ? "Type or select a category, then press Enter"
              : "Press S to save the last command, Esc to close"}
          </span>
        </div>

        {/* Top 5 Commands */}
        <div className="term-memory-section">
          <div className="term-memory-section-title">Top Commands</div>
          {topCommands.length === 0 ? (
            <div className="term-memory-empty">No commands recorded yet</div>
          ) : (
            <div className="term-memory-list">
              {topCommands.map((rec, i) => (
                <div key={i} className="term-memory-cmd-row">
                  <span className="term-memory-cmd-rank">{i + 1}</span>
                  <span className="term-memory-cmd-text">{rec.command}</span>
                  <span className="term-memory-cmd-count">{rec.count}x</span>
                  <span className="term-memory-cmd-cat">{rec.category}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Categories */}
        <div className="term-memory-section">
          <div className="term-memory-section-title">Categories</div>
          {categories.length === 0 ? (
            <div className="term-memory-empty">No categories yet</div>
          ) : (
            <div className="term-memory-categories">
              {categories.map((cat, i) => (
                <button
                  key={cat}
                  className={`term-memory-cat-tag ${
                    saveMode && selectedCategoryIdx === i ? "selected" : ""
                  }`}
                  onClick={() => {
                    if (saveMode) {
                      doSaveCategory(cat);
                    }
                  }}
                  onMouseEnter={() => setSelectedCategoryIdx(i)}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Error — shown outside save-mode block so empty-command guard is visible */}
        {error && <div className="term-memory-error">{error}</div>}

        {/* Save mode input */}
        {saveMode && (
          <div className="term-memory-save-area">
            {lastCommand.trim() ? (
              <>
                <div className="term-memory-save-label">
                  Save "{lastCommand}" as:
                </div>
                <input
                  ref={inputRef}
                  className="term-memory-input"
                  type="text"
                  value={categoryInput}
                  placeholder="Type category name or select above..."
                  onChange={(e) => {
                    setCategoryInput(e.target.value);
                    setSelectedCategoryIdx(-1);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (categoryInput.trim()) {
                        doSaveCategory(categoryInput);
                      }
                    }
                  }}
                />
                {filteredCategories.length > 0 && categoryInput && (
                  <div className="term-memory-autocomplete">
                    {filteredCategories.slice(0, 6).map((cat) => (
                      <div
                        key={cat}
                        className="term-memory-autocomplete-item"
                        onClick={() => doSaveCategory(cat)}
                      >
                        {cat}
                      </div>
                    ))}
                  </div>
                )}
                <div className="term-memory-save-actions">
                  <button
                    className="btn-primary"
                    onClick={() => {
                      if (categoryInput.trim()) {
                        doSaveCategory(categoryInput);
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setSaveMode(false);
                      setCategoryInput("");
                      setSelectedCategoryIdx(-1);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="term-memory-empty-save">
                  No command to save yet — type something in the terminal first.
                </div>
                <div className="term-memory-save-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setSaveMode(false);
                      setCategoryInput("");
                      setSelectedCategoryIdx(-1);
                      setError(null);
                    }}
                  >
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
