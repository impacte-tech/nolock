import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface CustomToolEntry {
  name: string;
  path: string;
  description: string;
}

interface ToolItem {
  id: string;
  label: string;
  description: string;
  /** File path for custom tools, "builtin:<id>" for built-in tools. */
  path: string;
  isBuiltin: boolean;
}

const BUILTIN_TOOLS: ToolItem[] = [
  { id: "web_search", label: "web_search", description: "Search the internet for up-to-date information", path: "builtin:web_search", isBuiltin: true },
  { id: "web_fetch", label: "web_fetch", description: "Fetch and read web page content from a URL", path: "builtin:web_fetch", isBuiltin: true },
  { id: "grep", label: "grep", description: "Search file contents for a regex pattern", path: "builtin:grep", isBuiltin: true },
  { id: "read_file", label: "read_file", description: "Read file contents from disk", path: "builtin:read_file", isBuiltin: true },
  { id: "edit", label: "edit", description: "Targeted search-and-replace edits", path: "builtin:edit", isBuiltin: true },
  { id: "write_file", label: "write_file", description: "Create and overwrite files on disk", path: "builtin:write_file", isBuiltin: true },
  { id: "list_directory", label: "list_directory", description: "Explore project structure", path: "builtin:list_directory", isBuiltin: true },
];

interface Props {
  query: string;
  rootPath: string;
  onSelect: (toolPath: string, toolName: string) => void;
  onClose: () => void;
  className?: string;
}

export default function ToolAutocomplete({ query, rootPath, onSelect, onClose, className }: Props) {
  const [customTools, setCustomTools] = useState<CustomToolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootPath) return;
    setLoading(true);
    invoke<CustomToolEntry[]>("list_tools", { rootPath })
      .then((entries) => {
        setCustomTools(entries);
      })
      .catch(() => setCustomTools([]))
      .finally(() => setLoading(false));
  }, [rootPath]);

  // Merge built-in + custom tools
  const allTools: ToolItem[] = (() => {
    const merged: ToolItem[] = [...BUILTIN_TOOLS];
    for (const ct of customTools) {
      // Don't add a custom tool if a built-in with the same name already exists
      if (!merged.some((t) => t.id === ct.name)) {
        merged.push({ id: ct.name, label: ct.name, description: ct.description, path: ct.path, isBuiltin: false });
      }
    }
    return merged;
  })();

  const filteredTools = (() => {
    if (!query) return allTools;
    const lowerQuery = query.toLowerCase();
    return allTools.filter((t) => t.id.toLowerCase().includes(lowerQuery));
  })();

  useEffect(() => {
    if (selectedIndex >= filteredTools.length) {
      setSelectedIndex(Math.max(0, filteredTools.length - 1));
    }
  }, [filteredTools.length, selectedIndex]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const items = container.querySelectorAll<HTMLElement>(".tool-autocomplete-item");
    const target = items[selectedIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredTools.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = filteredTools[selectedIndex];
        if (!selected) return;
        onSelect(selected.path, selected.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filteredTools, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (filteredTools.length === 0 && !loading) {
    return (
      <div className={`tool-autocomplete ${className || ""}`} ref={listRef}>
        <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          No tools found. Create custom tools in <code style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 11 }}>.tools/</code> via <strong>Agent Tools</strong> settings.
        </div>
      </div>
    );
  }

  return (
    <div className={`tool-autocomplete ${className || ""}`} ref={listRef}>
      {loading && <div className="tool-autocomplete-loading">Loading...</div>}

      {filteredTools.map((tool, i) => (
        <div
          key={tool.path}
          className={`tool-autocomplete-item ${i === selectedIndex ? "selected" : ""}`}
          onMouseDown={() => onSelect(tool.path, tool.id)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="tool-autocomplete-icon">
            {tool.isBuiltin ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            )}
          </span>
          <div>
            <div className="tool-autocomplete-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>#{tool.id}</span>
              {tool.isBuiltin && (
                <span style={{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg-surface)", borderRadius: 3, padding: "0 4px" }}>built-in</span>
              )}
            </div>
            <div className="tool-autocomplete-desc">{tool.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
