import WorkspaceGitPanel from "./components/WorkspaceGitPanel";
import { migrateLegacySecrets } from "./lib/secrets";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import FileExplorer from "./components/FileExplorer";
import MagnifierIcon from "./components/MagnifierIcon";
import FolderIcon from "./components/FolderIcon";
import Editor from "./components/Editor";
import { TerminalWorkspace, type TerminalInstance } from "./components/Terminal";
import ChatPanel from "./components/ChatPanel";
import BrowserPanel from "./components/BrowserPanel";
import MenuBar from "./components/MenuBar";
import ModelProvidersPanel from "./components/ModelProvidersPanel";
import ChatModelPanel from "./components/ChatModelPanel";
import FIMModelPanel from "./components/FIMModelPanel";
import ToolsPanel from "./components/ToolsPanel";
import AgentSessionsPanel from "./components/AgentSessionsPanel";
import McpPanel from "./components/McpPanel";
import RlhfPanel from "./components/RlhfPanel";
import SwitchyardPanel from "./components/SwitchyardPanel";
import FaqPanel from "./components/FaqPanel";
import EditorSettings from "./components/EditorSettings";
import TerminalMemoryOverlay from "./components/TerminalMemoryOverlay";
import AgentManager from "./components/AgentManager";
import HooksPanel from "./components/HooksPanel";
import { startHookScheduler, subscribeHooks } from "./lib/hooks";
import StatusBar from "./components/StatusBar";
import ResizableHandle from "./components/ResizableHandle";
import ShortcutsScreen from "./components/ShortcutsScreen";
import SearchPanel from "./components/SearchPanel";
import Notebook from "./components/Notebook";
import { MarkdownContent } from "./components/ChatPanel";
import nolockLogo from "./assets/nolocklogo-white.svg";

// ---------------------------------------------------------------------------
// localStorage migration — copy old zencode.* keys to nolock.*
// ---------------------------------------------------------------------------
(function migrateOldKeys() {
  const keyMap: Record<string, string> = {
    "zencode.backend": "nolock.backend",
    "zencode.url": "nolock.url",
    "zencode.chatModel": "nolock.chatModel",
    "zencode.completionModel": "nolock.completionModel",
    "zencode.apiKey": "nolock.apiKey",
    "zencode.toolsEnabled": "nolock.toolsEnabled",
    "zencode.model": "nolock.model",
  };
  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldVal);
      localStorage.removeItem(oldKey);
    }
  }

})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a CSS `flex` shorthand using flex-grow ratio and flex-basis: 0.
 *
 * Strategy for robust proportional resizing WITHOUT calc() headaches:
 *
 *   - Resizable panels use `flex: <grow> 1 0` (flex-basis: 0).
 *   - Resize handles use `flex: 0 0 5px` (fixed 5px, no grow/shrink).
 *   - The flex container distributes **available** space (total minus handles)
 *     among items according to their flex-grow ratios.
 *
 * This naturally accounts for any number of handles — no calc() or
 * percentage math needed.  The total always adds up to 100% of the
 * space that's actually available for panels.
 */
function ratioFlex(grow: number): string {
  return `${grow} 1 0`;
}

interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}


export default function App() {
  const termCounter = useRef(0);
  const [secretStorageWarning, setSecretStorageWarning] = useState("");
  useEffect(() => {
    const warn = (event: Event) => setSecretStorageWarning((event as CustomEvent<string>).detail);
    window.addEventListener("nolock:secret-storage-warning", warn);
    void migrateLegacySecrets();
    return () => window.removeEventListener("nolock:secret-storage-warning", warn);
  }, []);
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia?.("(max-width: 760px)")?.matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const update = () => setMobileLayout(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // --- Files ---
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // --- Panels ---
  const [showExplorer, setShowExplorer] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [showModelProviders, setShowModelProviders] = useState(false);
  const [showChatModel, setShowChatModel] = useState(false);
  const [showFIMModel, setShowFIMModel] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [showAgentSessions, setShowAgentSessions] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showRlhf, setShowRlhf] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSwitchyard, setShowSwitchyard] = useState(false);

  // --- Agent Manager ---
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [agentManagerInitialTab, setAgentManagerInitialTab] = useState<"agents" | "skills" | undefined>(undefined);
  const [agentRefreshKey, setAgentRefreshKey] = useState(0);

  // --- Hooks ---
  const [showHooks, setShowHooks] = useState(false);
  const [showFaq, setShowFaq] = useState(false);

  // --- Search ---
  const [showSearch, setShowSearch] = useState(false);

  // --- Editor line navigation (from search results) ---
  const [revealLine, setRevealLine] = useState<{ filePath: string; lineNumber: number } | null>(null);

  // --- Markdown preview: set of file paths currently showing rendered preview ---
  const [markdownPreviewFiles, setMarkdownPreviewFiles] = useState<Set<string>>(new Set());

  // --- Browser panel ---
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);

  // --- Resize epoch: incremented after every drag-end to trigger a final
  //     position sync on the browser webview (like a "page reload" for
  //     just the webview, not the whole app). --------------------------
  const [resizeEpoch, setResizeEpoch] = useState(0);

  // --- Resizable panel proportions (flex-grow values, sum = 100) ---
  // Using integer "points" that sum to 100 for the outer row layout.
  const [explorerPts, setExplorerPts] = useState(18);
  const [chatPts, setChatPts] = useState(25);

  // Inner layouts use separate ratio spaces:
  const [terminalPts, setTerminalPts] = useState(25);  // vertical: editor vs terminal
  const [browserPts, setBrowserPts] = useState(50);    // horizontal: editor vs browser

  // Refs for measuring parent containers during drag
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const editorMainRef = useRef<HTMLDivElement>(null);
  const editorContentRef = useRef<HTMLDivElement>(null);

  // --- Split editor ---
  const [splitActiveFile, setSplitActiveFile] = useState<string | null>(null);
  const [draggedTabPath, setDraggedTabPath] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<"left" | "right" | null>(null);
  const [splitRatio, setSplitRatio] = useState(50);

  const isSplit = splitActiveFile !== null;
  const leftFile = openFiles.find((f) => f.path === activeFile) ?? null;
  const rightFile = isSplit ? (openFiles.find((f) => f.path === splitActiveFile) ?? null) : null;

  /**
   * Creates a resize handler for dragging a handle.
   *
   * Converts the pixel delta into a proportion delta using the parent
   * container's size (minus the handle so the ratio stays accurate).
   * The total proportion space is `totalPts` (default 100).
   */
  const makeResizeHandler = (
    setter: React.Dispatch<React.SetStateAction<number>>,
    minPts: number,
    maxPts: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
    axis: "width" | "height",
    totalPts: number = 100,
    invert: boolean = false,
  ) => {
    return (delta: number) => {
      const parent = containerRef.current;
      if (!parent) return;

      const parentSize =
        axis === "width"
          ? parent.getBoundingClientRect().width
          : parent.getBoundingClientRect().height;

      // Subtract handle so the ratio maps to available panel space
      const available = parentSize - 5;
      if (available <= 0) return;

      const ptsDelta = (delta / available) * totalPts;

      // When `invert` is true, the delta is negated so that moving the mouse
      // toward the panel makes it *grow* (instead of shrink).  This is needed
      // when the controlled panel sits on the opposite side of the drag
      // direction from the handle movement:
      //   - Panel LEFT of handle: drag RIGHT  (delta > 0) → panel grows  → invert=false
      //   - Panel RIGHT of handle: drag LEFT  (delta < 0) → panel grows  → invert=true
      //   - Panel BELOW of handle: drag UP   (delta < 0) → panel grows  → invert=true
      const sign = invert ? -1 : 1;

      setter((prev) => Math.max(minPts, Math.min(maxPts, prev + sign * ptsDelta)));
    };
  };

  // --- Folder ---
  const [rootPath, setRootPath] = useState<string>(() => {
    return localStorage.getItem("nolock.lastRootPath") || "";
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  // Persist last opened folder across restarts
  useEffect(() => {
    if (rootPath) {
      localStorage.setItem("nolock.lastRootPath", rootPath);
    } else {
      localStorage.removeItem("nolock.lastRootPath");
    }
  }, [rootPath]);

  // --- Hooks: in-app cron scheduler (restarts when the root folder changes) ---
  useEffect(() => {
    if (!rootPath) return;
    const stopScheduler = startHookScheduler(rootPath);
    return stopScheduler;
  }, [rootPath]);

  // --- Hooks: auto-open the chat panel so hook feedback is visible ---
  useEffect(() => {
    return subscribeHooks((event) => {
      if (event.type === "run-start") {
        setShowChat(true);
      }
    });
  }, []);

  // --- Split editor: auto-cleanup when files are closed externally ---
  useEffect(() => {
    if (splitActiveFile && !openFiles.find((f) => f.path === splitActiveFile)) {
      setSplitActiveFile(null);
    }
  }, [openFiles, splitActiveFile]);

  useEffect(() => {
    if (activeFile && !openFiles.find((f) => f.path === activeFile)) {
      if (splitActiveFile) {
        setActiveFile(splitActiveFile);
        setSplitActiveFile(null);
      } else {
        setActiveFile(openFiles.length > 0 ? openFiles[openFiles.length - 1].path : null);
      }
    }
  }, [openFiles, activeFile, splitActiveFile]);

  // --- Terminals ---
  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);

  const [showGit, setShowGit] = useState(false);
  const [gitPts, setGitPts] = useState(26);
  const [editorTerminalId, setEditorTerminalId] = useState<string | null>(null);

  // --- Chord state: null | 'A' | 'T' | 'B' | 'E' | 'F'
  // 'A' = waiting for second key after Ctrl+A (AI shortcuts)
  // 'T' = waiting for second key after Ctrl+T (Terminal shortcuts)
  // 'B' = waiting for second key after Ctrl+B (Browser shortcuts)
  const [chordPrefix, setChordPrefix] = useState<string | null>(null);

  // --- Terminal Memory ---
  const [showTermMemory, setShowTermMemory] = useState(false);
  const lastCommandRef = useRef<string>("");

  // --- Open URL in browser panel (called from ChatPanel) ---
  const openInBrowser = useCallback((url: string) => {
    setBrowserUrl(url);
  }, []);

  // --- Close browser panel ---
  const closeBrowser = useCallback(() => {
    setBrowserUrl(null);
  }, []);

  const terminalCountRef = useRef(terminals.length);
  terminalCountRef.current = terminals.length;
  const createTerminal = useCallback(() => {
    terminalCountRef.current++;
    termCounter.current++;
    const id = `term-${termCounter.current}`;
    const label = `Terminal ${termCounter.current}`;
    const inst: TerminalInstance = { id, label, active: true, rootPath };
    setTerminals((prev) => [...prev, inst]);
    setActiveTermId(id);
  }, [rootPath]);

  const runShellCommand = useCallback((command: string) => {
    terminalCountRef.current++;
    termCounter.current++;
    const id = `term-${termCounter.current}`;
    setTerminals((prev) => [...prev, {
      id, label: `Shell ${termCounter.current}`, active: true, rootPath,
      initialCommand: { current: command },
    }]);
    setActiveTermId(id);
    return true;
  }, [rootPath]);

  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActiveTermId((prev) => {
      if (prev !== id) return prev;
      const remaining = terminals.filter((t) => t.id !== id);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
    setEditorTerminalId((prev) => prev === id ? null : prev);
  }, [terminals]);

  const cycleTerminal = useCallback(() => {
    if (terminals.length < 2) return;
    const index = terminals.findIndex((t) => t.id === activeTermId);
    setActiveTermId(terminals[(index + 1) % terminals.length].id);
  }, [terminals, activeTermId]);

  // --- Open folder ---
  const openFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Folder",
    });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
  }, []);

  const refreshFolder = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // --- Files ---
  const openFile = useCallback(
    async (filePath: string, fileName: string) => {
      if (openFiles.find((f) => f.path === filePath)) {
        setActiveFile(filePath);
        return;
      }
      try {
        const content: string = await invoke("read_file", { path: filePath });
        setOpenFiles((prev) => [
          ...prev,
          { path: filePath, name: fileName, content, dirty: false },
        ]);
        setActiveFile(filePath);
      } catch (e) {
        console.error("Failed to open file:", e);
      }
    },
    [openFiles]
  );

  const saveFile = useCallback(
    async (filePath: string) => {
      const file = openFiles.find((f) => f.path === filePath);
      if (!file) return;
      try {
        await invoke("write_file", { path: filePath, content: file.content });
        setOpenFiles((prev) =>
          prev.map((f) => (f.path === filePath ? { ...f, dirty: false } : f))
        );
      } catch (e) {
        console.error("Failed to save file:", e);
      }
    },
    [openFiles]
  );

  const closeFile = useCallback(
    (filePath: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.path !== filePath));

      if (splitActiveFile === filePath) {
        setSplitActiveFile(null);
        return;
      }

      if (activeFile === filePath) {
        if (splitActiveFile) {
          setActiveFile(splitActiveFile);
          setSplitActiveFile(null);
        } else {
          const remaining = openFiles.filter((f) => f.path !== filePath);
          setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
        }
      }
    },
    [openFiles, activeFile, splitActiveFile]
  );

  const updateFileContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, content, dirty: true } : f))
    );
  }, []);

  const isMarkdownFile = useCallback((filePath: string) => {
    return filePath.split(".").pop()?.toLowerCase() === "md";
  }, []);

  const isNotebookFile = useCallback((filePath: string) => {
    return filePath.split(".").pop()?.toLowerCase() === "ipynb";
  }, []);

  /**
   * Renders the main view for an open file: a Colab-style notebook for
   * `.ipynb` files, the Monaco editor for everything else.
   */
  const renderFileView = useCallback(
    (file: OpenFile) => {
      if (isNotebookFile(file.path)) {
        return (
          <Notebook
            key={file.path}
            filePath={file.path}
            content={file.content}
            onChange={(content) => updateFileContent(file.path, content)}
            onSave={() => saveFile(file.path)}
            rootPath={rootPath}
          />
        );
      }
      return (
        <Editor
          key={file.path}
          filePath={file.path}
          content={file.content}
          onChange={(content) => updateFileContent(file.path, content)}
          onSave={() => saveFile(file.path)}
          revealLine={revealLine?.filePath === file.path ? revealLine.lineNumber : undefined}
          onRevealConsumed={() => setRevealLine(null)}
        />
      );
    },
    [isNotebookFile, updateFileContent, saveFile, rootPath, revealLine]
  );

  const toggleMarkdownPreview = useCallback((filePath: string) => {
    setMarkdownPreviewFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  // --- Split editor: custom drag via mouse events (avoids HTML5 drag issues with Monaco) ---
  const draggedTabRef = useRef<string | null>(null);
  const dropSideRef = useRef<"left" | "right" | null>(null);
  const splitRef = useRef(isSplit);
  splitRef.current = isSplit;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const editorPaneRef = useRef<HTMLDivElement>(null);

  const handleTabMouseDown = useCallback((filePath: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) {
          dragging = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          draggedTabRef.current = filePath;
          setDraggedTabPath(filePath);
        }
      }
      if (dragging) {
        const pane = editorPaneRef.current;
        if (pane) {
          const rect = pane.getBoundingClientRect();
          const midpoint = rect.left + rect.width / 2;
          const side: "left" | "right" = ev.clientX < midpoint ? "left" : "right";
          dropSideRef.current = side;
          setDropSide(side);
        }
      }
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      if (dragging) {
        const tab = draggedTabRef.current;
        const side = dropSideRef.current;
        draggedTabRef.current = null;
        dropSideRef.current = null;
        setDraggedTabPath(null);
        setDropSide(null);

        if (tab && side) {
          if (!splitRef.current) {
            if (side === "right") {
              setSplitActiveFile(tab);
            } else {
              setSplitActiveFile(activeFileRef.current);
              setActiveFile(tab);
            }
          } else {
            if (side === "right") {
              setSplitActiveFile(tab);
            } else {
              setActiveFile(tab);
            }
          }
        }
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // --- Search result → open file and navigate to line ---
  const handleSearchResultClick = useCallback(
    (filePath: string, lineNumber: number) => {
      const fileName = filePath.split("/").pop() || filePath;
      // Open the file if not already open
      const existing = openFiles.find((f) => f.path === filePath);
      if (!existing) {
        // Open asynchronously
        invoke("read_file", { path: filePath })
          .then((content: any) => {
            setOpenFiles((prev) => [
              ...prev,
              { path: filePath, name: fileName, content, dirty: false },
            ]);
            setActiveFile(filePath);
            // Schedule reveal after React renders the new Editor
            requestAnimationFrame(() => {
              setRevealLine({ filePath, lineNumber });
            });
          })
          .catch((e) => console.error("Failed to open file from search:", e));
      } else {
        setActiveFile(filePath);
        // Schedule reveal after React re-renders with the new activeFile
        requestAnimationFrame(() => {
          setRevealLine({ filePath, lineNumber });
        });
      }
    },
    [openFiles],
  );

  const currentFile = openFiles.find((f) => f.path === activeFile);

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ---- Defensive: always prevent Ctrl+S / Cmd+S from reaching ----
      // the webview's native "Save Page" handler, which can cause the
      // app to close in some Tauri v2 environments (notably Linux/GTK).
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        return;
      }

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      // Exclude xterm.js hidden textarea (xterm-helper-textarea) from the
      // input check. That textarea has tagName TEXTAREA but it's just a
      // technical capture device for the terminal emulator — not an actual
      // user text input.  We need chord shortcuts to still work when the
      // terminal panel is focused (the textarea sits inside a .xterm element).
      // `?.closest?.(...)` guards against non-Element targets (e.g. window /
      // document) dispatched in tests and by global keyboard listeners.
      const isXtermTextarea = !!target?.closest?.(".xterm");
      const isInput = tag === "INPUT" || (tag === "TEXTAREA" && !isXtermTextarea);

      // When focus is in an input/textarea, skip chord prefixes and app
      // shortcuts so the input gets native handling (e.g. Ctrl+A selectAll,
      // Ctrl+Z undo, Ctrl+X cut). Only Escape goes through to close overlays.
      if (isInput) {
        if (e.key === "Escape") {
          if (showSearch) { setShowSearch(false); return; }
          if (showAgentManager) setShowAgentManager(false);
          if (showModelProviders) setShowModelProviders(false);
          if (showChatModel) setShowChatModel(false);
          if (showFIMModel) setShowFIMModel(false);
          if (showTools) setShowTools(false);
          if (showMcp) setShowMcp(false);
          if (showAgentSessions) setShowAgentSessions(false);
          if (showSettings) setShowSettings(false);
          if (showTermMemory) { setShowTermMemory(false); }
          return;
        }
        return; // Let all other keys reach the input/textarea
      }

      // ---- Chord dispatch -------------------------------------------------
      // If we're waiting for a second chord key, handle it first (regardless
      // of modifier keys on the second press — that matches the existing
      // Ctrl+A, C pattern where C is pressed without modifiers).
      if (chordPrefix !== null) {
        // Any keypress that isn't a valid second key cancels the chord
        if (chordPrefix === "A") {
          if (e.key === "o") {
            e.preventDefault();
            setChordPrefix(null);
            setShowChat((v) => !v);
            return;
          }
          if (e.key === "g") {
            e.preventDefault();
            setChordPrefix(null);
            setAgentManagerInitialTab("agents");
            setShowAgentManager(true);
            return;
          }
          if (e.key === "p") {
            e.preventDefault();
            setChordPrefix(null);
            setShowModelProviders(true);
            return;
          }
          if (e.key === "m") {
            e.preventDefault();
            setChordPrefix(null);
            setShowChatModel(true);
            return;
          }
          if (e.key === "f") {
            e.preventDefault();
            setChordPrefix(null);
            setShowFIMModel(true);
            return;
          }
          if (e.key === "t") {
            e.preventDefault();
            setChordPrefix(null);
            setShowTools(true);
            return;
          }
          if (e.key === "k") {
            e.preventDefault();
            setChordPrefix(null);
            setAgentManagerInitialTab("skills");
            setShowAgentManager(true);
            return;
          }
          if (e.key === "h") {
            e.preventDefault();
            setChordPrefix(null);
            setShowHooks(true);
            return;
          }
          if (e.key === "r") {
            e.preventDefault();
            setChordPrefix(null);
            setShowRlhf(true);
            return;
          }
          if (e.key === "l") {
            e.preventDefault();
            setChordPrefix(null);
            setShowFaq(true);
            return;
          }
        }

        if (chordPrefix === "B") {
          if (e.key === "o" || e.key === "O") {
            e.preventDefault();
            setChordPrefix(null);
            if (browserUrl) {
              closeBrowser();
            } else {
              setBrowserUrl("https://google.com");
            }
            return;
          }
        }

        if (chordPrefix === "T") {
          if (e.key === "o" || e.key === "O") {
            e.preventDefault();
            setChordPrefix(null);
            createTerminal();
            return;
          }
          if (e.key === "l" || e.key === "L") {
            e.preventDefault();
            setChordPrefix(null);
            createTerminal();
            return;
          }
          if (e.key === "n" || e.key === "N") {
            e.preventDefault();
            setChordPrefix(null);
            cycleTerminal();
            return;
          }
          if (e.key === "w" || e.key === "W") {
            e.preventDefault();
            setChordPrefix(null);
            if (activeTermId) closeTerminal(activeTermId);
            return;
          }
          if (e.key === "m" || e.key === "M") {
            e.preventDefault();
            setChordPrefix(null);
            setShowTermMemory(true);
            return;
          }
        }

        if (chordPrefix === "E") {
          if (e.key === "o" || e.key === "O") {
            e.preventDefault();
            setChordPrefix(null);
            setShowExplorer((v) => !v);
            return;
          }
          if (e.key === "s" || e.key === "S") {
            e.preventDefault();
            setChordPrefix(null);
            setShowSettings(true);
            return;
          }
        }

        if (chordPrefix === "F") {
          if (e.key === "s" || e.key === "S") {
            e.preventDefault();
            setChordPrefix(null);
            if (!showSearch) {
              setShowExplorer(true);
            }
            setShowSearch((v) => !v);
            return;
          }
          if (e.key === "o" || e.key === "O") {
            e.preventDefault();
            setChordPrefix(null);
            openFolder();
            return;
          }
          if (e.key === "e" || e.key === "E") {
            e.preventDefault();
            setChordPrefix(null);
            setShowExplorer((v) => !v);
            return;
          }
          if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            setChordPrefix(null);
            refreshFolder();
            return;
          }
        }

        // Unrecognised second key — cancel the chord and let the event
        // propagate normally (no preventDefault/stopPropagation).
        setChordPrefix(null);
        // Don't return; fall through so the key can still be handled by
        // the regular shortcuts below (e.g. a stray 'o' after a cancelled
        // chord should still trigger Ctrl+O).
      }

      // ---- Direct shortcuts (with Ctrl held) ------------------------------

      // Ctrl+O — Open Folder
      if (e.ctrlKey && !e.shiftKey && e.key === "o") {
        e.preventDefault();
        openFolder();
        return;
      }

      // Ctrl+R — Refresh Explorer
      if (e.ctrlKey && !e.shiftKey && e.key === "r") {
        e.preventDefault();
        refreshFolder();
        return;
      }

      // Ctrl+T — Chord prefix for Terminal shortcuts.
      // No longer creates a terminal immediately; press T again to do that.
      if (e.ctrlKey && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        if (chordPrefix === "T") {
          // Tapped twice quickly — cancel chord
          setChordPrefix(null);
        } else {
          setChordPrefix("T");
          setTimeout(() => setChordPrefix(null), 1500);
        }
        return;
      }

      // Ctrl+B — Chord prefix for Browser shortcuts.
      if (e.ctrlKey && !e.shiftKey && e.key === "b") {
        e.preventDefault();
        if (chordPrefix === "B") {
          // Tapped twice quickly — cancel chord
          setChordPrefix(null);
        } else {
          setChordPrefix("B");
          setTimeout(() => setChordPrefix(null), 1500);
        }
        return;
      }

      // Ctrl+F — Chord prefix for File/Search shortcuts.
      if (e.ctrlKey && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        if (chordPrefix === "F") {
          // Tapped twice quickly — cancel chord
          setChordPrefix(null);
        } else {
          setChordPrefix("F");
          setTimeout(() => setChordPrefix(null), 1500);
        }
        return;
      }

      // Ctrl+A — Chord prefix for AI shortcuts
      if (e.ctrlKey && !e.shiftKey && e.key === "a") {
        e.preventDefault();
        if (chordPrefix === "A") {
          // Tapped twice quickly — cancel chord
          setChordPrefix(null);
        } else {
          setChordPrefix("A");
          setTimeout(() => setChordPrefix(null), 1500);
        }
        return;
      }

      // Ctrl+E — Chord prefix for Settings/Explorer shortcuts.
      if (e.ctrlKey && !e.shiftKey && e.key === "e") {
        e.preventDefault();
        if (chordPrefix === "E") {
          // Tapped twice quickly — cancel chord
          setChordPrefix(null);
        } else {
          setChordPrefix("E");
          setTimeout(() => setChordPrefix(null), 1500);
        }
        return;
      }

      // Escape — Close overlays
      if (e.key === "Escape") {
        if (showSearch) {
          setShowSearch(false);
          return;
        }
        if (showAgentManager) setShowAgentManager(false);
        if (showModelProviders) setShowModelProviders(false);
        if (showChatModel) setShowChatModel(false);
        if (showFIMModel) setShowFIMModel(false);
        if (showTools) setShowTools(false);
          if (showMcp) setShowMcp(false);
          if (showAgentSessions) setShowAgentSessions(false);
        if (showSettings) setShowSettings(false);
        if (showTermMemory) {
          setShowTermMemory(false);
        }
        if (showFaq) setShowFaq(false);
        return;
      }
    };

    // Use capture phase so the handler fires BEFORE xterm.js and other
    // element-level keydown listeners can intercept/consume the event.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [openFolder, refreshFolder, createTerminal, closeTerminal, cycleTerminal, activeTermId, showModelProviders, showChatModel, showFIMModel, showTools, showMcp, showAgentSessions, showSettings, showAgentManager, chordPrefix, browserUrl, closeBrowser, showTermMemory, showSearch, showFaq]);

  // --- Menu ---
  const menus = [
    {
      label: "Files",
      items: [
        { label: "Open Folder", action: openFolder, shortcut: "Ctrl+F, O" },
        { label: "Upload", disabled: !rootPath || uploadingFiles, action: () => {
          // Mount the explorer synchronously so opening the picker stays within
          // the user's click gesture, including when Search is currently open.
          flushSync(() => {
            setShowExplorer(true);
            setShowSearch(false);
          });
          uploadInputRef.current?.click();
        } },
        { label: "Refresh Explorer", action: refreshFolder, shortcut: "Ctrl+F, R" },
        { label: "Toggle Explorer", action: () => setShowExplorer((v) => !v), shortcut: "Ctrl+F, E" },
        { label: "Search in Files", action: () => {
          if (!showSearch) setShowExplorer(true);
          setShowSearch((v) => !v);
        }, shortcut: "Ctrl+F, S" },
      ],
    },
    {
      label: "Terminal",
      items: [
        { label: "New Terminal", action: () => createTerminal(), shortcut: "Ctrl+T, O" },
        { label: "Next Terminal", action: cycleTerminal, shortcut: "Ctrl+T, N" },
        { label: "Close Terminal", disabled: terminals.length === 0, action: () => { if (activeTermId) closeTerminal(activeTermId); }, shortcut: "Ctrl+T, W" },
        { label: "Agent Sessions...", action: () => setShowAgentSessions(true) },
        { label: "Terminal Memory", action: () => setShowTermMemory(true), shortcut: "Ctrl+T, M" },
        ...terminals.map((t) => ({
          label: t.label,
          action: () => setActiveTermId(t.id),
        })),
      ],
    },
    {
      label: "Browser",
      items: [
        { label: "Toggle Browser", action: () => browserUrl ? closeBrowser() : setBrowserUrl("https://google.com"), shortcut: "Ctrl+B, O" },
      ],
    },
    {
      label: "AI Integrations",
      items: [
        { label: "Toggle Agent Chat", action: () => setShowChat((v) => !v), shortcut: "Ctrl+A, O" },
        { label: "Model Providers...", action: () => setShowModelProviders(true), shortcut: "Ctrl+A, P" },
        { label: "Chat Model...", action: () => setShowChatModel(true), shortcut: "Ctrl+A, M" },
        { label: "FIM model...", action: () => setShowFIMModel(true), shortcut: "Ctrl+A, F" },
        { label: "Tools...", action: () => setShowTools(true), shortcut: "Ctrl+A, T" },
        { label: "Agents...", action: () => { setAgentManagerInitialTab("agents"); setShowAgentManager(true); }, shortcut: "Ctrl+A, G" },
        { label: "Skills...", action: () => { setAgentManagerInitialTab("skills"); setShowAgentManager(true); }, shortcut: "Ctrl+A, K" },
        { label: "Hooks...", action: () => setShowHooks(true), shortcut: "Ctrl+A, H" },
        { label: "Human Feedback (RLHF)...", action: () => setShowRlhf(true), shortcut: "Ctrl+A, R" },
        { label: "Switchyard Router...", action: () => setShowSwitchyard(true), shortcut: "Ctrl+A, Y" },
        { label: "Knowledge Base...", action: () => setShowFaq(true), shortcut: "Ctrl+A, L" },
      ],
    },
    { label: "MCP", items: [{ label: "Manage MCP servers...", action: () => { setShowMcp(true); } }] },
    {
      label: "Editor",
      items: [
        { label: "Editor Settings...", action: () => setShowSettings(true), shortcut: "Ctrl+E, S" },
      ],
    },
  ];

  // ---- Compute flex-grow values for the main-area row --------------------
  //
  // The outer row (main-area) has:
  //   [explorer] [handle5] [editor-area | ...] [handle5] [chat]
  //
  // explorerPts + editorPts + chatPts = 100 (even when chat is hidden).
  // The handles have fixed 5px each and are excluded from the ratio.
  //
  const hasExplorer = showExplorer;
  const hasChat = showChat;
  const hasBrowser = browserUrl !== null;
  const hasTerminal = terminals.length > 0;

  // Editor area gets whatever is left from the 100-point outer pool
  const outerSidePanels = (hasExplorer ? explorerPts : 0) + (hasChat ? chatPts : 0) + (showGit ? gitPts : 0);
  const editorPts = Math.max(15, 100 - outerSidePanels);

  return (
    <div className="app">
      {chordPrefix && (
        <div className="chord-hint">
          {chordPrefix === "A" ? (
            <>Waiting for second key... (press <strong>O</strong> for Chat, <strong>G</strong> for Agents, <strong>H</strong> for Hooks, <strong>I</strong> for AI Settings, <strong>R</strong> for RLHF, <strong>L</strong> for .faq)</>
          ) : chordPrefix === "T" ? (
            <>Waiting for second key... (press <strong>O</strong> for Terminal, <strong>L</strong> for Local, <strong>N</strong> for Next, <strong>W</strong> for Close, <strong>M</strong> for Memory)</>
          ) : chordPrefix === "B" ? (
            <>Waiting for second key... (press <strong>O</strong> for Browser)</>
          ) : chordPrefix === "E" ? (
            <>Waiting for second key... (press <strong>O</strong> for Explorer, <strong>S</strong> for Editor Settings)</>
          ) : (
            <>Waiting for second key... (press <strong>S</strong> for Search, <strong>O</strong> for Open Folder, <strong>E</strong> for Explorer, <strong>R</strong> for Refresh)</>
          )}
        </div>
      )}

      <MenuBar
        menus={menus}
        logo={<img src={nolockLogo} alt="nolock" className="menubar-logo-img" />}
        mobileControls={<>
          <button type="button" aria-label="Toggle file explorer" aria-expanded={showExplorer} onClick={() => { setShowExplorer(v => !v); setShowChat(false); setShowSearch(false); }}><FolderIcon /></button>
          <button type="button" aria-label="Search in files" aria-expanded={showSearch} onClick={() => { setShowChat(false); setShowExplorer(true); setShowSearch(v => !v); }}><MagnifierIcon /></button>
          <button type="button" aria-label="Toggle chat" aria-expanded={showChat} onClick={() => { setShowChat(v => !v); setShowExplorer(false); }}>Chat</button>
        </>}
      />

      <div className="main-area" ref={mainAreaRef}>
        {hasExplorer && (
          <>
            {showSearch ? (
              <SearchPanel
                rootPath={rootPath}
                onResultClick={handleSearchResultClick}
                onClose={() => setShowSearch(false)}
                style={{ flex: ratioFlex(explorerPts) }}
              />
            ) : (
              <FileExplorer
                uploadInputRef={uploadInputRef}
                onUploadingChange={setUploadingFiles}
                onFileOpen={(path, name) => { void openFile(path, name); if (mobileLayout) setShowExplorer(false); }}
                onOpenSearch={() => setShowSearch(true)}
                rootPath={rootPath}
                setRootPath={setRootPath}
                visible={true}
                refreshKey={refreshKey}
                style={{ flex: ratioFlex(explorerPts) }}
              />
            )}
            <ResizableHandle
              direction="horizontal"
              onDrag={makeResizeHandler(setExplorerPts, 8, 50, mainAreaRef, "width", 100, false)}
              onDragEnd={() => setResizeEpoch((e) => e + 1)}
            />
          </>
        )}

        <div className="editor-area" ref={editorAreaRef} style={{ flex: ratioFlex(editorPts) }}>
          <TerminalWorkspace instances={terminals} activeId={activeTermId} editorTerminalId={editorTerminalId}
            rootPath={rootPath} terminalPercent={terminalPts} onSelect={setActiveTermId} onClose={closeTerminal}
            onCreate={() => createTerminal()} onEditorTerminal={setEditorTerminalId}
            onRename={(id, label) => setTerminals((prev) => prev.map((t) => t.id === id ? { ...t, label } : t))}
            resizeHandle={<ResizableHandle direction="vertical" onDrag={makeResizeHandler(setTerminalPts, 8, 80, editorAreaRef, "height", 100, true)} onDragEnd={() => setResizeEpoch((e) => e + 1)} />}
          >
          <div className={`editor-main ${hasBrowser ? "split" : ""}`} ref={editorMainRef}
            style={{ flex: "1 1 0", width: "100%" }}
          >
            <div
              className="editor-pane"
              ref={editorPaneRef}
              style={{
                flex: hasBrowser ? ratioFlex(100 - browserPts) : "1 1 0",
              }}
            >
              {/* Drop zone overlays */}
              {draggedTabPath && (
                <div className="editor-drop-zones">
                  <div className={`editor-drop-zone ${dropSide === "left" ? "active" : ""}`}>
                    <span className="editor-drop-zone-icon">&#8592;</span>
                    <span>Drop left</span>
                  </div>
                  <div className={`editor-drop-zone ${dropSide === "right" ? "active" : ""}`}>
                    <span>Drop right</span>
                    <span className="editor-drop-zone-icon">&#8594;</span>
                  </div>
                </div>
              )}

              {isSplit ? (
                <div className="editor-split-container" ref={editorContentRef}>
                  {/* Left pane */}
                  <div className="editor-split-pane" style={{ flex: ratioFlex(splitRatio) }}>
                    {openFiles.length > 0 && (
                      <div className="editor-tabs">
                        {openFiles.map((f) => (
                          <div
                            key={f.path}
                            className={`editor-tab ${f.path === activeFile ? "active" : ""}`}
                            onClick={() => setActiveFile(f.path)}
                            onMouseDown={(e) => handleTabMouseDown(f.path, e)}
                          >
                            <span>{f.dirty ? "\u25CF " : ""}{f.name}</span>
                            <span
                              className="close"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeFile(f.path);
                              }}
                            >
                              &times;
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="editor-content-inner">
                      {leftFile ? (
                        renderFileView(leftFile)
                      ) : (
                        <ShortcutsScreen />
                      )}
                    </div>
                  </div>

                  <ResizableHandle
                    direction="horizontal"
                    onDrag={makeResizeHandler(setSplitRatio, 20, 80, editorContentRef, "width", 100, false)}
                    onDragEnd={() => setResizeEpoch((e) => e + 1)}
                  />

                  {/* Right pane */}
                  <div className="editor-split-pane" style={{ flex: ratioFlex(100 - splitRatio) }}>
                    {openFiles.length > 0 && (
                      <div className="editor-tabs">
                        {openFiles.map((f) => (
                          <div
                            key={f.path}
                            className={`editor-tab ${f.path === splitActiveFile ? "active" : ""}`}
                            onClick={() => setSplitActiveFile(f.path)}
                            onMouseDown={(e) => handleTabMouseDown(f.path, e)}
                          >
                            <span>{f.dirty ? "\u25CF " : ""}{f.name}</span>
                            <span
                              className="close"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeFile(f.path);
                              }}
                            >
                              &times;
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="editor-content-inner">
                      {rightFile ? (
                        renderFileView(rightFile)
                      ) : (
                        <ShortcutsScreen />
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {openFiles.length > 0 && (
                    <div className="editor-tabs">
                      {openFiles.map((f) => (
                        <div
                          key={f.path}
                          className={`editor-tab ${f.path === activeFile ? "active" : ""}`}
                           onClick={() => setActiveFile(f.path)}
                           onMouseDown={(e) => handleTabMouseDown(f.path, e)}
                         >
                          <span>{f.dirty ? "\u25CF " : ""}{f.name}</span>
                          {isMarkdownFile(f.path) && (
                            <span
                              className={`md-preview-toggle ${markdownPreviewFiles.has(f.path) ? "active" : ""}`}
                              title={markdownPreviewFiles.has(f.path) ? "Hide preview" : "Show preview"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleMarkdownPreview(f.path);
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M14.85 3H1.15C.52 3 0 3.52 0 4.15v7.7C0 12.48.52 13 1.15 13h13.7c.63 0 1.15-.52 1.15-1.15v-7.7C16 3.52 15.48 3 14.85 3zM9 11H7V8L5.5 9.92 4 8v3H2V5h2l1.5 2L7 5h2v6zm2.99.5L9.5 8H11V5h2v3h1.5l-2.51 3.5z"/>
                              </svg>
                            </span>
                          )}
                          <span
                            className="close"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeFile(f.path);
                            }}
                          >
                            &times;
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className={`editor-content ${currentFile && markdownPreviewFiles.has(currentFile.path) ? "md-split" : ""}`}>
                    {currentFile ? (
                      isNotebookFile(currentFile.path) ? (
                        renderFileView(currentFile)
                      ) : (
                        <>
                          <Editor
                            key={currentFile.path}
                            filePath={currentFile.path}
                            content={currentFile.content}
                            onChange={(content) => updateFileContent(currentFile.path, content)}
                            onSave={() => saveFile(currentFile.path)}
                            revealLine={revealLine?.filePath === currentFile.path ? revealLine.lineNumber : undefined}
                            onRevealConsumed={() => setRevealLine(null)}
                          />
                          {markdownPreviewFiles.has(currentFile.path) && (
                            <div className="markdown-preview-pane">
                              <MarkdownContent text={currentFile.content} />
                            </div>
                          )}
                        </>
                      )
                    ) : (
                      <ShortcutsScreen />
                    )}
                  </div>
                </>
              )}
            </div>

            {hasBrowser && (
              <>
                <ResizableHandle
                  direction="horizontal"
                  onDrag={makeResizeHandler(setBrowserPts, 20, 80, editorMainRef, "width", 100, true)}
                  onDragEnd={() => setResizeEpoch((e) => e + 1)}
                />
                <div className="browser-pane" style={{ flex: ratioFlex(browserPts) }}>
                  {!editorTerminalId && <BrowserPanel url={browserUrl!} onClose={closeBrowser} resizeEpoch={resizeEpoch} />}
                </div>
              </>
            )}
          </div>

          </TerminalWorkspace>

        </div>

        {showGit && <ResizableHandle direction="horizontal"
          onDrag={makeResizeHandler(setGitPts, 18, 45, mainAreaRef, "width", 100, true)}
          onDragEnd={() => setResizeEpoch((e) => e + 1)} />}
        <WorkspaceGitPanel rootPath={rootPath} open={showGit} onToggle={() => { setShowGit((value) => !value); setResizeEpoch((e) => e + 1); }} style={{ flex: ratioFlex(gitPts) }} />

        {hasChat && (
          <>
            <ResizableHandle
              direction="horizontal"
              onDrag={makeResizeHandler(setChatPts, 15, 55, mainAreaRef, "width", 100, true)}
              onDragEnd={() => setResizeEpoch((e) => e + 1)}
            />
          </>
        )}
        <ChatPanel onRunShell={runShellCommand} onClose={() => setShowChat(false)} onOpenUrl={openInBrowser} rootPath={rootPath} style={{ flex: ratioFlex(chatPts), display: hasChat ? undefined : "none" }} onOpenAgentManager={() => setShowAgentManager(true)} />
      </div>

      {secretStorageWarning && <div role="alert">{secretStorageWarning}</div>}
      <StatusBar showChat={showChat} onToggleChat={() => setShowChat(!showChat)} rootPath={rootPath} />

      <ModelProvidersPanel visible={showModelProviders} onClose={() => setShowModelProviders(false)} />
      <ChatModelPanel visible={showChatModel} onClose={() => setShowChatModel(false)} />
      <FIMModelPanel visible={showFIMModel} onClose={() => setShowFIMModel(false)} />
      <AgentSessionsPanel visible={showAgentSessions} rootPath={rootPath} onClose={() => setShowAgentSessions(false)} />
      <McpPanel visible={showMcp} onClose={() => setShowMcp(false)} rootPath={rootPath} />
      <ToolsPanel visible={showTools} onClose={() => setShowTools(false)} rootPath={rootPath} />
      <HooksPanel visible={showHooks} onClose={() => setShowHooks(false)} rootPath={rootPath} />
      <RlhfPanel visible={showRlhf} onClose={() => setShowRlhf(false)} />
      <SwitchyardPanel visible={showSwitchyard} onClose={() => setShowSwitchyard(false)} rootPath={rootPath} />
      <FaqPanel visible={showFaq} onClose={() => setShowFaq(false)} rootPath={rootPath} />
      <EditorSettings visible={showSettings} onClose={() => setShowSettings(false)} />

      <AgentManager
        visible={showAgentManager}
        onClose={() => {
          setShowAgentManager(false);
          setAgentManagerInitialTab(undefined);
        }}
        rootPath={rootPath}
        onAgentsChanged={() => setAgentRefreshKey((k) => k + 1)}
        onOpenFile={openFile}
        initialTab={agentManagerInitialTab}
      />

      {showTermMemory && (
        <TerminalMemoryOverlay
          lastCommand={lastCommandRef.current}
          onDismiss={() => setShowTermMemory(false)}
        />
      )}
    </div>
  );
}
