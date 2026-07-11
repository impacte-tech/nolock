import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import DirectoryPicker from "./DirectoryPicker";

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
  style?: React.CSSProperties;
}

interface CtxMenu {
  visible: boolean;
  x: number;
  y: number;
  /** The entry that was right-clicked, if any. */
  target: TreeDirEntry | null;
  /** True when right-clicking empty whitespace inside a folder. */
  isWhitespace: boolean;
  /** The directory path to use for "new file" when whitespace-clicked. */
  whitespaceDir: string;
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

export default function FileExplorer({ onFileOpen, rootPath, setRootPath, visible, refreshKey, style }: Props) {
  const [entries, setEntries] = useState<TreeDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [rootExpanded, setRootExpanded] = useState(true);
  const entriesRef = useRef<TreeDirEntry[]>([]);
  const dragSourceRef = useRef<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  // Keep entriesRef in sync with entries state
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  // ---- Context menu state ----
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>({
    visible: false, x: 0, y: 0, target: null, isWhitespace: false, whitespaceDir: "",
  });

  // ---- Rename state ----
  const [renaming, setRenaming] = useState<{ path: string; currentName: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ---- New-file / new-folder state ----
  const [newFileName, setNewFileName] = useState<{ parentPath: string } | null>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const [newFolderName, setNewFolderName] = useState<{ parentPath: string } | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // ---- Copy/paste clipboard ----
  const copiedPathRef = useRef<string | null>(null);

  // ---- "Move to..." directory picker ----
  const [moveSource, setMoveSource] = useState<string | null>(null);

  // ---- Load directory on mount / path change ----
  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    try {
      const items: DirEntry[] = await invoke("list_directory", { path: dirPath, showHidden: true });
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

  /** Re-fetches directory contents at dirPath, preserving expanded/children state. */
  const reloadPreservingState = useCallback(async (dirPath: string) => {
    try {
      const items: DirEntry[] = await invoke("list_directory", { path: dirPath, showHidden: true });
      const oldEntries = entriesRef.current;

      // Walk the entire old tree to collect expanded paths and cached children
      const expandedPaths = new Set<string>();
      const childrenCache = new Map<string, TreeDirEntry[] | undefined>();
      const walkOld = (list: TreeDirEntry[]) => {
        for (const e of list) {
          if (e.expanded) expandedPaths.add(e.path);
          if (e.children) {
            childrenCache.set(e.path, e.children);
            walkOld(e.children);
          }
        }
      };
      walkOld(oldEntries);

      // Merge new items with preserved state (recursive)
      const merge = (newItems: DirEntry[]): TreeDirEntry[] =>
        newItems.map((item) => {
          const wasExpanded = expandedPaths.has(item.path);
          const cachedChildren = childrenCache.get(item.path);
          return {
            ...item,
            children: cachedChildren,
            expanded: wasExpanded,
            loaded: wasExpanded ? true : false,
          };
        });

      setEntries(merge(items));
    } catch (e) {
      console.error("Failed to reload directory:", e);
    }
  }, []);

  useEffect(() => {
    if (rootPath) {
      loadDir(rootPath);
    }
  }, [rootPath, loadDir, refreshKey]);

  // ---- Close context menu on outside click ----
  useEffect(() => {
    if (!ctxMenu.visible) return;
    const close = () => setCtxMenu((p) => ({ ...p, visible: false }));
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ctxMenu.visible]);

  // ---- Focus rename input when it appears ----
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  // ---- Focus new-file / new-folder input when it appears ----
  useEffect(() => {
    if (newFileName) newFileInputRef.current?.focus();
  }, [newFileName]);
  useEffect(() => {
    if (newFolderName) newFolderInputRef.current?.focus();
  }, [newFolderName]);

  // ---- Helpers ----
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
        const children: DirEntry[] = await invoke("list_directory", { path: entry.path, showHidden: true });
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

  // ---- Context menu handlers ----
  const openCtxForItem = useCallback((e: React.MouseEvent, entry: TreeDirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      target: entry,
      isWhitespace: false,
      whitespaceDir: "",
    });
  }, []);

  const openCtxForWhitespace = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      target: null,
      isWhitespace: true,
      whitespaceDir: rootPath,
    });
  }, [rootPath]);

  const closeCtx = useCallback(() => {
    setCtxMenu((p) => ({ ...p, visible: false }));
  }, []);

  // ---- Operations ----
  const doRename = useCallback((entry: TreeDirEntry) => {
    closeCtx();
    setRenaming({ path: entry.path, currentName: entry.name });
  }, [closeCtx]);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const input = renameInputRef.current;
    const newName = input?.value.trim();
    if (!newName || newName === renaming.currentName) {
      setRenaming(null);
      return;
    }
    try {
      await invoke("rename_file", { path: renaming.path, newName });
      setRenaming(null);
      // Reload but preserve expanded state
      reloadPreservingState(rootPath);
    } catch (e) {
      console.error("Rename failed:", e);
      alert(`Rename failed: ${e}`);
      setRenaming(null);
    }
  }, [renaming, rootPath]);

  const cancelRename = useCallback(() => {
    setRenaming(null);
  }, []);

  const doDelete = useCallback((entry: TreeDirEntry) => {
    closeCtx();
    const kind = entry.is_dir ? "folder" : "file";
    if (!confirm(`Delete ${kind} "${entry.name}"?`)) return;
    invoke("delete_file", { path: entry.path })
      .then(() => reloadPreservingState(rootPath))
      .catch((e: any) => alert(`Delete failed: ${e}`));
  }, [closeCtx, rootPath]);

  const doCopy = useCallback((entry: TreeDirEntry) => {
    closeCtx();
    copiedPathRef.current = entry.path;
  }, [closeCtx]);

  const doPaste = useCallback(async (targetDir: string) => {
    closeCtx();
    const src = copiedPathRef.current;
    if (!src) return;
    const fileName = src.split("/").pop() || "unknown";
    const dest = `${targetDir}/${fileName}`;
    try {
      await invoke("copy_file", { source: src, destination: dest });
      copiedPathRef.current = null;
      reloadPreservingState(rootPath);
    } catch (e) {
      alert(`Paste failed: ${e}`);
    }
  }, [closeCtx, reloadPreservingState, rootPath]);

  const doNewFile = useCallback((parentPath: string) => {
    closeCtx();
    setNewFileName({ parentPath });
  }, [closeCtx]);

  const submitNewFile = useCallback(async () => {
    if (!newFileName) return;
    const input = newFileInputRef.current;
    const name = input?.value.trim();
    if (!name) {
      setNewFileName(null);
      return;
    }
    const fullPath = `${newFileName.parentPath}/${name}`;
    try {
      await invoke("create_file", { path: fullPath });
      setNewFileName(null);
      reloadPreservingState(rootPath);
    } catch (e) {
      console.error("Create file failed:", e);
      alert(`Create file failed: ${e}`);
      setNewFileName(null);
    }
  }, [newFileName, reloadPreservingState, rootPath]);

  const cancelNewFile = useCallback(() => {
    setNewFileName(null);
  }, []);

  const doNewFolder = useCallback((parentPath: string) => {
    closeCtx();
    setNewFolderName({ parentPath });
  }, [closeCtx]);

  const submitNewFolder = useCallback(async () => {
    if (!newFolderName) return;
    const input = newFolderInputRef.current;
    const name = input?.value.trim();
    if (!name) {
      setNewFolderName(null);
      return;
    }
    const fullPath = `${newFolderName.parentPath}/${name}`;
    try {
      await invoke("create_directory", { path: fullPath });
      setNewFolderName(null);
      reloadPreservingState(rootPath);
    } catch (e) {
      console.error("Create folder failed:", e);
      alert(`Create folder failed: ${e}`);
      setNewFolderName(null);
    }
  }, [newFolderName, reloadPreservingState, rootPath]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderName(null);
  }, []);

  // Helper: find an entry by path in the tree (recursive)
  const findEntryByPath = useCallback((path: string, items: TreeDirEntry[]): TreeDirEntry | null => {
    for (const item of items) {
      if (item.path === path) return item;
      if (item.children) {
        const found = findEntryByPath(path, item.children);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // Container-level drag/drop (event delegation)
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    const item = (e.target as Element).closest('.tree-item');
    if (!item) {
      if (dragOverPath !== null) setDragOverPath(null);
      return;
    }
    const isDir = item.getAttribute('data-is-dir') === 'true';
    if (!isDir) {
      e.dataTransfer.dropEffect = "none";
      if (dragOverPath !== null) setDragOverPath(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const path = item.getAttribute('data-path');
    if (path && dragOverPath !== path) {
      setDragOverPath(path);
    }
  }, [dragOverPath]);

  const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when actually leaving the entire file-tree
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) {
      setDragOverPath(null);
    }
  }, []);

  const handleContainerDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverPath(null);
    const srcPath = dragSourceRef.current || e.dataTransfer.getData("text/plain");
    dragSourceRef.current = null;
    if (!srcPath) return;

    const item = (e.target as Element).closest('.tree-item');
    if (!item) return;
    const path = item.getAttribute('data-path');
    const isDir = item.getAttribute('data-is-dir') === 'true';
    if (!path) return;
    if (!isDir) return;
    if (srcPath === path) return;

    try {
      await invoke("move_file", { source: srcPath, destDir: path });
      reloadPreservingState(rootPath);
    } catch (err) {
      console.error("Failed to move file:", err);
      alert(`Failed to move file: ${err}`);
    }
  }, [rootPath, reloadPreservingState]);

  // ---- Tree rendering ----
  const renderItem = (entry: TreeDirEntry, depth: number) => {
    const isActive = entry.path === activePath;
    const isHidden = entry.name.startsWith('.');
    const chevron = entry.is_dir
      ? entry.expanded ? "\u25BC" : "\u25B6"
      : null;
    const fileColor = !entry.is_dir ? getFileColor(entry.name) : undefined;
    const isDragOver = entry.is_dir && dragOverPath === entry.path;

    // Inline rename
    const isRenaming = renaming && renaming.path === entry.path;

    const handleDragStart = (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", entry.path);
      e.dataTransfer.effectAllowed = "move";
      dragSourceRef.current = entry.path;
    };

    return (
      <div key={entry.path}>
        <div
          className={`tree-item ${isActive ? "active" : ""} ${isHidden ? "tree-item--hidden" : ""} ${isDragOver ? "tree-item--drag-over" : ""}`}
          data-path={entry.path}
          data-is-dir={entry.is_dir ? "true" : "false"}
          style={{ paddingLeft: `${8 + depth * 14}px` } as React.CSSProperties}
          onClick={() => {
            if (entry.is_dir) {
              toggleDir(entry);
            } else {
              setActivePath(entry.path);
              onFileOpen(entry.path, entry.name);
            }
          }}
          onContextMenu={(e) => openCtxForItem(e, entry)}
          draggable={!entry.is_dir}
          onDragStart={handleDragStart}
        >
          {entry.is_dir ? (
            <span className="chevron">{chevron}</span>
          ) : (
            <span className="chevron-spacer" />
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="tree-rename-input"
              defaultValue={renaming!.currentName}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                else if (e.key === "Escape") cancelRename();
                e.stopPropagation();
              }}
              onBlur={submitRename}
            />
          ) : (
            <span className="file-name" style={!entry.is_dir ? { color: fileColor } : undefined}>
              {entry.name}
            </span>
          )}
        </div>
        {entry.is_dir && entry.expanded && entry.children && (
          <div>
            {entry.children.map((child) => renderItem(child, depth + 1))}
            {/* Inline "new file" input at the bottom of the folder */}
            {newFileName && newFileName.parentPath === entry.path && (
              <div
                className="tree-item"
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px` } as React.CSSProperties}
              >
                <span className="chevron-spacer" />
                <input
                  ref={newFileInputRef}
                  className="tree-rename-input"
                  placeholder="filename.ext"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNewFile();
                    else if (e.key === "Escape") cancelNewFile();
                    e.stopPropagation();
                  }}
                  onBlur={submitNewFile}
                />
              </div>
            )}
            {/* Inline "new folder" input at the bottom of the folder */}
            {newFolderName && newFolderName.parentPath === entry.path && (
              <div
                className="tree-item"
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px` } as React.CSSProperties}
              >
                <span className="chevron-spacer" />
                <input
                  ref={newFolderInputRef}
                  className="tree-rename-input"
                  placeholder="folder_name"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNewFolder();
                    else if (e.key === "Escape") cancelNewFolder();
                    e.stopPropagation();
                  }}
                  onBlur={submitNewFolder}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!visible) return null;

  return (
    <div className="file-explorer" style={style}>
      <div className="explorer-header">
        <span>Explorer</span>
        <button onClick={() => loadDir(rootPath)} title="Refresh">&#x21bb;</button>
      </div>
      <div
        className="file-tree"
        onContextMenu={openCtxForWhitespace}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {rootPath && (
          <div
            className={`tree-item${dragOverPath === rootPath ? " tree-item--drag-over" : ""}`}
            data-path={rootPath}
            data-is-dir="true"
            style={{ paddingLeft: "8px" } as React.CSSProperties}
            onClick={() => setRootExpanded((v) => !v)}
          >
            <span className="chevron">{rootExpanded ? "\u25BC" : "\u25B6"}</span>
            <span className="file-name" style={{ fontWeight: 600 }}>
              {rootPath.split("/").pop() || rootPath}
            </span>
          </div>
        )}
        {rootExpanded && entries.map((e) => renderItem(e, 1))}

        {/* Inline "new file" input at root level */}
        {newFileName && newFileName.parentPath === rootPath && (
          <div
            className="tree-item"
            style={{ paddingLeft: `${8 + 1 * 14}px` } as React.CSSProperties}
          >
            <span className="chevron-spacer" />
            <input
              ref={newFileInputRef}
              className="tree-rename-input"
              placeholder="filename.ext"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewFile();
                else if (e.key === "Escape") cancelNewFile();
                e.stopPropagation();
              }}
              onBlur={submitNewFile}
            />
          </div>
        )}

        {/* Inline "new folder" input at root level */}
        {newFolderName && newFolderName.parentPath === rootPath && (
          <div
            className="tree-item"
            style={{ paddingLeft: `${8 + 1 * 14}px` } as React.CSSProperties}
          >
            <span className="chevron-spacer" />
            <input
              ref={newFolderInputRef}
              className="tree-rename-input"
              placeholder="folder_name"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewFolder();
                else if (e.key === "Escape") cancelNewFolder();
                e.stopPropagation();
              }}
              onBlur={submitNewFolder}
            />
          </div>
        )}

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

      {/* ----- Context Menu ----- */}
      {ctxMenu.visible && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.isWhitespace ? (
            // Right-click on empty folder space → New File / New Folder
            <>
              <div
                className="ctx-menu-item"
                onClick={() => doNewFile(ctxMenu.whitespaceDir)}
              >
                New File
              </div>
              <div
                className="ctx-menu-item"
                onClick={() => doNewFolder(ctxMenu.whitespaceDir)}
              >
                New Folder
              </div>
            </>
          ) : ctxMenu.target ? (
            // Right-click on file or folder
            <>
              <div
                className="ctx-menu-item"
                onClick={() => ctxMenu.target && doRename(ctxMenu.target)}
              >
                Rename
              </div>
              <div
                className="ctx-menu-item"
                onClick={() => ctxMenu.target && doDelete(ctxMenu.target)}
              >
                Delete
              </div>
              {ctxMenu.target.is_dir ? (
                // Folder: Copy + Paste + New File + New Folder
                <>
                  <div
                    className="ctx-menu-item"
                    onClick={() => ctxMenu.target && doCopy(ctxMenu.target)}
                  >
                    Copy
                  </div>
                  {copiedPathRef.current && (
                    <div
                      className="ctx-menu-item"
                      onClick={() => ctxMenu.target && doPaste(ctxMenu.target.path)}
                    >
                      Paste
                    </div>
                  )}
                  <div className="ctx-menu-separator" />
                  <div
                    className="ctx-menu-item"
                    onClick={() => ctxMenu.target && doNewFile(ctxMenu.target.path)}
                  >
                    New File
                  </div>
                  <div
                    className="ctx-menu-item"
                    onClick={() => ctxMenu.target && doNewFolder(ctxMenu.target.path)}
                  >
                    New Folder
                  </div>
                </>
              ) : (
                // File: Rename, Delete, Copy, Move to...
                <>
                  <div
                    className="ctx-menu-item"
                    onClick={() => ctxMenu.target && doCopy(ctxMenu.target)}
                  >
                    Copy
                  </div>
                  <div className="ctx-menu-separator" />
                  <div
                    className="ctx-menu-item"
                    onClick={() => {
                      if (ctxMenu.target) setMoveSource(ctxMenu.target.path);
                      setCtxMenu((p) => ({ ...p, visible: false }));
                    }}
                  >
                    Move to...
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      )}
      {moveSource && rootPath && (
        <DirectoryPicker
          sourcePath={moveSource}
          sourceName={moveSource.split("/").pop() || moveSource}
          rootPath={rootPath}
          onMove={async (source, destDir) => {
            await invoke("move_file", { source, destDir });
            setMoveSource(null);
            reloadPreservingState(rootPath);
          }}
          onClose={() => setMoveSource(null)}
        />
      )}
    </div>
  );
}
