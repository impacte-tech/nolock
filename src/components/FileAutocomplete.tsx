import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface AgentRef {
  name: string;
  path: string;
  description: string;
}

interface AutocompleteItem {
  type: "agent" | "file";
  name: string;
  path: string;
  /** For files: the display path under root. */
  displayPath?: string;
  /** For agents: short description. */
  description?: string;
  is_dir?: boolean;
}

interface Props {
  /** The query text after @ (e.g. "src/comp" from "@src/comp") */
  query: string;
  /** Root path to list files from */
  rootPath: string;
  /** Called when a file is selected */
  onSelect: (filePath: string, fileName: string) => void;
  /** Called when an agent is selected */
  onSelectAgent?: (agent: AgentRef) => void;
  /** Called when the autocomplete should close (escape, blur, etc.) */
  onClose: () => void;
  /** Optional additional class name */
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a relative path for the breadcrumb display. */
function formatRelativePath(fullPath: string, rootPath: string): string {
  if (fullPath === rootPath) return "";
  return fullPath.replace(rootPath, "").replace(/^\//, "");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FileAutocomplete({ query, rootPath, onSelect, onSelectAgent, onClose, className }: Props) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [agents, setAgents] = useState<AgentRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // ----- Directory navigation state -----
  const [currentDir, setCurrentDir] = useState(rootPath);
  const [dirHistory, setDirHistory] = useState<string[]>([]);
  const navPendingRef = useRef(false);

  // Reset navigation when rootPath changes
  useEffect(() => {
    setCurrentDir(rootPath);
    setDirHistory([]);
  }, [rootPath]);

  // ----- Load entries for the current directory -----
  useEffect(() => {
    if (!rootPath || !currentDir) return;
    setLoading(true);
    invoke<DirEntry[]>("list_directory", { path: currentDir })
      .then((items) => {
        setEntries(items);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [rootPath, currentDir]);

  // After entries load following a navigation, focus on the first file item
  useEffect(() => {
    if (!navPendingRef.current) return;
    navPendingRef.current = false;
    if (entries.length > 0) {
      setSelectedIndex(agents.length);
    } else {
      // No files — focus on first agent, or index 0
      setSelectedIndex(0);
    }
  }, [entries, agents.length]);

  // ----- Load agents from .agents/ directory -----
  useEffect(() => {
    if (!rootPath) return;
    invoke<{ name: string; path: string }[]>("list_agents", { rootPath })
      .then(async (agentEntries) => {
        const agentRefs: AgentRef[] = [];
        for (const ae of agentEntries) {
          try {
            const data: any = await invoke("read_agent", { path: ae.path });
            agentRefs.push({
              name: ae.name,
              path: ae.path,
              description: data.description || "",
            });
          } catch {
            agentRefs.push({ name: ae.name, path: ae.path, description: "" });
          }
        }
        setAgents(agentRefs);
      })
      .catch(() => setAgents([]));
  }, [rootPath]);

  // ----- Navigation helpers -----
  const navigateInto = useCallback((dirPath: string) => {
    setDirHistory((prev) => [...prev, currentDir]);
    setCurrentDir(dirPath);
    navPendingRef.current = true;
  }, [currentDir]);

  const navigateUp = useCallback(() => {
    if (dirHistory.length === 0) return;
    const parent = dirHistory[dirHistory.length - 1];
    setDirHistory((prev) => prev.slice(0, -1));
    setCurrentDir(parent);
    navPendingRef.current = true;
  }, [dirHistory]);

  // ----- Build combined items list (agents first, then files) -----
  const allItems: AutocompleteItem[] = (() => {
    const items: AutocompleteItem[] = [];
    const lowerQuery = query ? query.toLowerCase() : "";

    // Agents (always visible, project-wide)
    for (const agent of agents) {
      if (!query || agent.name.toLowerCase().includes(lowerQuery)) {
        items.push({
          type: "agent",
          name: agent.name,
          path: agent.path,
          description: agent.description,
        });
      }
    }

    // Files from current directory
    for (const e of entries) {
      if (!query || e.name.toLowerCase().includes(lowerQuery) || e.path.toLowerCase().includes(lowerQuery)) {
        items.push({
          type: "file",
          name: e.name,
          path: e.path,
          displayPath: e.path.replace(currentDir, "").replace(/^\//, ""),
          is_dir: e.is_dir,
        });
      }
    }

    return items;
  })();

  // ----- Compute relative path for breadcrumb display -----
  const relativePath = formatRelativePath(currentDir, rootPath);

  // ----- Clamp selected index -----
  useEffect(() => {
    if (selectedIndex >= allItems.length) {
      setSelectedIndex(Math.max(0, allItems.length - 1));
    }
  }, [allItems.length, selectedIndex]);

  // ----- Scroll selected item into view -----
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    // Use querySelectorAll to find all .file-autocomplete-item elements regardless of nesting
    const items = container.querySelectorAll<HTMLElement>(".file-autocomplete-item");
    const target = items[selectedIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // ----- Keyboard handling -----
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const selected = allItems[selectedIndex];
        if (selected && selected.is_dir) {
          navigateInto(selected.path);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentDir !== rootPath) {
          navigateUp();
        }
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = allItems[selectedIndex];
        if (!selected) return;

        if (selected.type === "agent") {
          onSelectAgent?.({
            name: selected.name,
            path: selected.path,
            description: selected.description || "",
          });
        } else if (selected.is_dir) {
          navigateInto(selected.path);
        } else {
          onSelect(selected.path, selected.name);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [allItems, selectedIndex, onSelect, onSelectAgent, onClose, navigateInto, navigateUp, currentDir, rootPath],
  );

  // Listen for keyboard events on the panel
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ----- Render -----
  if (allItems.length === 0 && !loading) return null;

  // Detect section separators
  const hasAgents = allItems.some((i) => i.type === "agent");
  const hasFiles = allItems.some((i) => i.type === "file");

  return (
    <div className={`file-autocomplete ${className || ""}`} ref={listRef}>
      {loading && <div className="file-autocomplete-loading">Loading...</div>}

      {/* Breadcrumb showing current directory path */}
      {relativePath && (
        <div className="file-autocomplete-breadcrumb">
          <span className="file-autocomplete-breadcrumb-icon">{">"}</span>
          <span className="file-autocomplete-breadcrumb-path">{relativePath}</span>
        </div>
      )}

      {/* Empty directory hint */}
      {relativePath && entries.length === 0 && !loading && (
        <div className="file-autocomplete-empty">
          <span className="file-autocomplete-empty-text">Press ← to go up</span>
        </div>
      )}

      {allItems.map((item, i) => (
        <div key={`${item.type}-${item.path}-${i}`}>
          {/* Section separator between agents and files */}
          {i > 0 && item.type === "file" && allItems[i - 1].type === "agent" && hasFiles && (
            <div className="file-autocomplete-section-label">Files</div>
          )}

          <div
            className={`file-autocomplete-item ${i === selectedIndex ? "selected" : ""}`}
            onMouseDown={() => {
              if (item.type === "agent") {
                onSelectAgent?.({
                  name: item.name,
                  path: item.path,
                  description: item.description || "",
                });
              } else if (item.is_dir) {
                navigateInto(item.path);
              } else {
                onSelect(item.path, item.name);
              }
            }}
            onMouseEnter={() => setSelectedIndex(i)}
          >
            {item.type === "agent" ? (
              <span className="file-autocomplete-icon agent-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="4" x2="12" y2="7" />
                  <circle cx="12" cy="3" r="1.5" fill="currentColor" />
                  <rect x="3" y="7" width="18" height="13" rx="5" />
                  <circle cx="8.5" cy="11.5" r="2" fill="currentColor" />
                  <circle cx="15.5" cy="11.5" r="2" fill="currentColor" />
                  <path d="M9 16 Q12 18.5 15 16" strokeWidth="1.5" fill="none" />
                </svg>
              </span>
            ) : item.is_dir ? (
              <span className="file-autocomplete-icon folder-icon">{">"}</span>
            ) : (
              <span className="file-autocomplete-icon file-icon">{""}</span>
            )}
            <span className="file-autocomplete-name">{item.name}</span>
            {item.type === "agent" ? (
              <span className="file-autocomplete-path agent-desc">
                {item.description || "AI Agent"}
              </span>
            ) : (
              <span className="file-autocomplete-path">{item.displayPath || ""}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
