import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface Props {
  /** The query text after @ (e.g. "src/comp" from "@src/comp") */
  query: string;
  /** Root path to list files from */
  rootPath: string;
  /** Position of the @ symbol in the textarea (for dropdown placement) */
  anchorRect: DOMRect | null;
  /** Called when a file is selected */
  onSelect: (filePath: string, fileName: string) => void;
  /** Called when the autocomplete should close (escape, blur, etc.) */
  onClose: () => void;
}

/**
 * Autocomplete dropdown that lists files from the project tree, filtered
 * by the current @-mention query.  Directories can be expanded/collapsed.
 */
export default function FileAutocomplete({ query, rootPath, anchorRect, onSelect, onClose }: Props) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load root entries on mount and when rootPath changes
  useEffect(() => {
    if (!rootPath) return;
    setLoading(true);
    invoke<DirEntry[]>("list_directory", { path: rootPath })
      .then((items) => {
        setEntries(items);
        setSelectedIndex(0);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [rootPath]);

  // Filter entries by query
  const filtered = entries.filter((e) => {
    if (!query) return true;
    const lower = query.toLowerCase();
    return e.name.toLowerCase().includes(lower) || e.path.toLowerCase().includes(lower);
  });

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected && !selected.is_dir) {
          onSelect(selected.path, selected.name);
        } else if (selected && selected.is_dir) {
          // Expand directory — simple toggle: reload children into the list
          invoke<DirEntry[]>("list_directory", { path: selected.path })
            .then((children) => {
              // Replace the directory with its children
              const idx = entries.indexOf(selected);
              const newEntries = [...entries];
              newEntries.splice(idx, 1, ...children);
              setEntries(newEntries);
              setSelectedIndex(idx);
            })
            .catch(() => {});
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, entries, onSelect, onClose],
  );

  // Listen for keyboard events on the panel (textarea won't fire them once
  // the dropdown steals focus, so we use document-level listener).
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (filtered.length === 0 && !loading) return null;

  // Position the dropdown
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = "fixed";
    style.left = `${anchorRect.left}px`;
    style.top = `${anchorRect.bottom + 4}px`;
    style.width = "320px";
    style.maxHeight = "260px";
  }

  return (
    <div className="file-autocomplete" ref={listRef} style={style}>
      {loading && <div className="file-autocomplete-loading">Loading...</div>}
      {filtered.map((entry, i) => (
        <div
          key={entry.path}
          className={`file-autocomplete-item ${i === selectedIndex ? "selected" : ""}`}
          onMouseDown={() => {
            if (!entry.is_dir) {
              onSelect(entry.path, entry.name);
            }
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          {entry.is_dir ? (
            <span className="file-autocomplete-icon">{">"}</span>
          ) : (
            <span className="file-autocomplete-icon">{""}</span>
          )}
          <span className="file-autocomplete-name">{entry.name}</span>
          <span className="file-autocomplete-path">{entry.path.replace(rootPath, "").replace(/^\//, "")}</span>
        </div>
      ))}
    </div>
  );
}
