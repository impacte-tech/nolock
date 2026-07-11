import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface Props {
  sourcePath: string;
  sourceName: string;
  rootPath: string;
  onMove: (source: string, destDir: string) => Promise<void>;
  onClose: () => void;
}

function formatRelativePath(fullPath: string, rootPath: string): string {
  if (fullPath === rootPath) return "";
  return fullPath.replace(rootPath, "").replace(/^\//, "");
}

const rootDirName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "";

export default function DirectoryPicker({ sourcePath, sourceName, rootPath, onMove, onClose }: Props) {
  const [currentDir, setCurrentDir] = useState(rootPath);
  const [dirHistory, setDirHistory] = useState<string[]>([]);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Build flat list of focusable items: Go up (if present) + directory entries
  const focusableItems = useMemo(() => {
    const items: { type: "go-up" } | { type: "entry"; entry: DirEntry }[] = [];
    if (dirHistory.length > 0) items.push({ type: "go-up" } as const);
    entries.forEach((entry) => items.push({ type: "entry" as const, entry }));
    return items;
  }, [dirHistory.length, entries]);

  const listRef = useRef<HTMLDivElement>(null);

  // Reset focused index when entries change (navigation completed)
  useEffect(() => {
    setFocusedIndex(0);
  }, [currentDir]);

  // Auto-focus the list on mount and after navigation
  useEffect(() => {
    listRef.current?.focus();
  }, [currentDir]);

  // Load entries for current directory
  useEffect(() => {
    setLoading(true);
    invoke<DirEntry[]>("list_directory", { path: currentDir })
      .then((items) => {
        setEntries(items.filter((e) => e.is_dir));
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [currentDir]);

  const navigateInto = useCallback((dirPath: string) => {
    setDirHistory((prev) => [...prev, currentDir]);
    setCurrentDir(dirPath);
  }, [currentDir]);

  const navigateUp = useCallback(() => {
    if (dirHistory.length === 0) return;
    const parent = dirHistory[dirHistory.length - 1];
    setDirHistory((prev) => prev.slice(0, -1));
    setCurrentDir(parent);
  }, [dirHistory]);

  const handleMove = async () => {
    if (moving) return;
    setMoving(true);
    try {
      await onMove(sourcePath, currentDir);
    } finally {
      setMoving(false);
    }
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (loading || moving) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, focusableItems.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "ArrowRight":
      case "Enter": {
        e.preventDefault();
        const item = focusableItems[focusedIndex];
        if (!item) return;
        if (item.type === "go-up") {
          navigateUp();
        } else if (item.type === "entry") {
          navigateInto(item.entry.path);
        }
        break;
      }
      case "ArrowLeft":
        e.preventDefault();
        navigateUp();
        break;
    }
  }, [focusableItems, focusedIndex, loading, moving, navigateInto, navigateUp]);

  const relativePath = formatRelativePath(currentDir, rootPath);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "420px" }}>
        <div className="modal-header">
          <span>Move "{sourceName}" to {relativePath || `${rootDirName(rootPath)} (root)`}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "16px" }}>&times;</button>
        </div>
        <div className="modal-body" ref={listRef} tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: "none" }}>
          {relativePath ? (
            <div className="file-autocomplete-breadcrumb">
              <span className="file-autocomplete-breadcrumb-icon">{">"}</span>
              <span className="file-autocomplete-breadcrumb-path">{relativePath}</span>
            </div>
          ) : (
            <div className="file-autocomplete-breadcrumb">
              <span className="file-autocomplete-breadcrumb-icon">{">"}</span>
              <span className="file-autocomplete-breadcrumb-path" style={{ fontStyle: "italic" }}>{rootDirName(rootPath)} (root)</span>
            </div>
          )}

          {dirHistory.length > 0 && (
            <div
              className="file-autocomplete-item"
              onMouseDown={navigateUp}
              onMouseEnter={() => setFocusedIndex(0)}
              style={{
                cursor: "pointer",
                opacity: 0.7,
                background: focusedIndex === 0 ? "var(--bg-hover, rgba(255,255,255,0.05))" : undefined,
                color: focusedIndex === 0 ? "white" : undefined,
              }}
            >
              <span className="file-autocomplete-icon folder-icon">...</span>
              <span className="file-autocomplete-name" style={{ fontStyle: "italic" }}>Go up</span>
            </div>
          )}

          {loading && <div className="file-autocomplete-loading" style={{ padding: "8px 12px", fontSize: "12px", color: "var(--text-muted)" }}>Loading...</div>}

          {!loading && entries.length === 0 && (
            <div className="file-autocomplete-empty">
              <span className="file-autocomplete-empty-text">(empty)</span>
            </div>
          )}

          {entries.map((e, i) => {
            const itemIndex = dirHistory.length > 0 ? i + 1 : i;
            return (
              <div
                key={e.path}
                className="file-autocomplete-item"
                onMouseDown={() => navigateInto(e.path)}
                onMouseEnter={() => setFocusedIndex(itemIndex)}
                style={{
                  background: focusedIndex === itemIndex ? "var(--bg-hover, rgba(255,255,255,0.05))" : undefined,
                  color: focusedIndex === itemIndex ? "white" : undefined,
                }}
              >
                <span className="file-autocomplete-icon folder-icon">{">"}</span>
                <span className="file-autocomplete-name">{e.name}</span>
              </div>
            );
          })}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={moving}>Cancel</button>
          <button className="btn-primary" onClick={handleMove} disabled={moving}>
            {moving ? "Moving..." : "Move to destination"}
          </button>
        </div>
      </div>
    </div>
  );
}
