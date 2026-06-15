import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface TreeDirEntry extends DirEntry {
  children?: TreeDirEntry[];
  expanded?: boolean;
  loaded?: boolean;
}

interface Props {
  onFileOpen: (path: string, name: string) => void;
  rootPath: string;
  setRootPath: (p: string) => void;
  visible: boolean;
  refreshKey?: number;
}

function getFileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name.toLowerCase() === "dockerfile") return "#4588c4";
  if (name.toLowerCase() === "makefile") return "#e06c75";
  const colorMap: Record<string, string> = {
    ts: "#3178c6", tsx: "#3178c6",
    js: "#f7df1e", jsx: "#f7df1e",
    py: "#4584b6", rs: "#dea584", go: "#00add8",
    html: "#e34c26", css: "#563d7c",
    json: "#cbcb41", md: "#519aba",
    yaml: "#cb171e", yml: "#cb171e",
    toml: "#9c4221", sh: "#89e051", bash: "#89e051",
  };
  return colorMap[ext] || "#6c7086";
}

export default function FileExplorer({ onFileOpen, rootPath, setRootPath, visible, refreshKey }: Props) {
  const [entries, setEntries] = useState<TreeDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const items: DirEntry[] = await invoke("list_directory", { path });
      setEntries(items.map((e) => ({
        ...e,
        children: undefined,
        expanded: false,
        loaded: false,
      })));
    } catch (e) {
      console.error("Failed to list directory:", e);
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (rootPath) {
      loadDir(rootPath);
    }
  }, [rootPath, loadDir, refreshKey]);

  const updateEntries = (path: string, updater: (e: TreeDirEntry) => TreeDirEntry): void => {
    const walk = (items: TreeDirEntry[]): TreeDirEntry[] =>
      items.map((item) => {
        if (item.path === path) return updater(item);
        if (item.children) return { ...item, children: walk(item.children) };
        return item;
      });
    setEntries((prev) => walk(prev));
  };

  const toggleDir = useCallback(async (entry: TreeDirEntry) => {
    const willExpand = !entry.expanded;
    updateEntries(entry.path, (e) => ({ ...e, expanded: willExpand }));

    if (willExpand && !entry.loaded) {
      try {
        const children: DirEntry[] = await invoke("list_directory", { path: entry.path });
        const treeChildren: TreeDirEntry[] = children.map((c) => ({
          ...c,
          children: undefined,
          expanded: false,
          loaded: false,
        }));
        updateEntries(entry.path, (e) => ({
          ...e,
          children: treeChildren,
          loaded: true,
        }));
      } catch (e) {
        console.error("Failed to load children:", e);
      }
    }
  }, []);

  const renderItem = (entry: TreeDirEntry, depth: number) => {
    const isActive = entry.path === activePath;
    const chevron = entry.is_dir
      ? entry.expanded ? "\u25BC" : "\u25B6"
      : null;
    const fileColor = !entry.is_dir ? getFileColor(entry.name) : undefined;

    return (
      <div key={entry.path}>
        <div
          className={`tree-item ${isActive ? "active" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` } as React.CSSProperties}
          onClick={() => {
            if (entry.is_dir) {
              toggleDir(entry);
            } else {
              setActivePath(entry.path);
              onFileOpen(entry.path, entry.name);
            }
          }}
        >
          {entry.is_dir ? (
            <span className="chevron">{chevron}</span>
          ) : (
            <span className="chevron-spacer" />
          )}
          <span className="file-name" style={!entry.is_dir ? { color: fileColor } : undefined}>
            {entry.name}
          </span>
        </div>
        {entry.is_dir && entry.expanded && entry.children && (
          <div>
            {entry.children.map((child) => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (!visible) return null;

  return (
    <div className="file-explorer">
      <div className="explorer-header">
        <span>Explorer</span>
        <button onClick={() => loadDir(rootPath)} title="Refresh">&#x21bb;</button>
      </div>
      <div className="file-tree">
        {rootPath && (
          <div
            className="tree-item"
            style={{ paddingLeft: "8px" } as React.CSSProperties}
          >
            <span className="chevron">&#x25BC;</span>
            <span className="file-name" style={{ fontWeight: 600 }}>
              {rootPath.split("/").pop() || rootPath}
            </span>
          </div>
        )}
        {entries.map((e) => renderItem(e, 1))}
        {loading && (
          <div className="tree-item" style={{ paddingLeft: "8px", color: "var(--text-muted)" } as React.CSSProperties}>
            <span className="file-name">Loading...</span>
          </div>
        )}
        {rootPath && entries.length === 0 && !loading && (
          <div className="tree-item" style={{ paddingLeft: "8px", color: "var(--text-muted)" } as React.CSSProperties}>
            <span className="file-name">Empty folder</span>
          </div>
        )}
      </div>
    </div>
  );
}
