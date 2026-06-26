import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import FileExplorer from "./components/FileExplorer";
import Editor from "./components/Editor";
import { TerminalPanel, type TerminalInstance } from "./components/Terminal";
import ChatPanel from "./components/ChatPanel";
import BrowserPanel from "./components/BrowserPanel";
import MenuBar from "./components/MenuBar";
import AISettings from "./components/AISettings";
import EditorSettings from "./components/EditorSettings";
import TerminalMemoryOverlay from "./components/TerminalMemoryOverlay";
import AgentManager from "./components/AgentManager";
import StatusBar from "./components/StatusBar";
import ResizableHandle from "./components/ResizableHandle";
import ShortcutsScreen from "./components/ShortcutsScreen";
import SearchPanel from "./components/SearchPanel";
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

let termCounter = 0;

export default function App() {
  // --- Files ---
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // --- Panels ---
  const [showExplorer, setShowExplorer] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // --- Agent Manager ---
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [agentRefreshKey, setAgentRefreshKey] = useState(0);

  // --- Search ---
  const [showSearch, setShowSearch] = useState(false);

  // --- Editor line navigation (from search results) ---
  const [revealLine, setRevealLine] = useState<{ filePath: string; lineNumber: number } | null>(null);

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
  const [rootPath, setRootPath] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);

  // --- Terminals ---
  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);

  // --- Chord state: null | 'A' | 'T'
  // 'A' = waiting for second key after Ctrl+A (AI shortcuts)
  // 'T' = waiting for second key after Ctrl+T (Terminal shortcuts)
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

  const createTerminal = useCallback(() => {
    termCounter++;
    const id = `term-${termCounter}`;
    const label = `Terminal ${termCounter}`;
    const inst: TerminalInstance = { id, label, active: true };
    setTerminals((prev) => [...prev, inst]);
    setActiveTermId(id);
  }, []);

  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActiveTermId((prev) => {
      if (prev !== id) return prev;
      const remaining = terminals.filter((t) => t.id !== id);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [terminals]);

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
      if (activeFile === filePath) {
        const remaining = openFiles.filter((f) => f.path !== filePath);
        setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
      }
    },
    [openFiles, activeFile]
  );

  const updateFileContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, content, dirty: true } : f))
    );
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
      // ---- Chord dispatch -------------------------------------------------
      // If we're waiting for a second chord key, handle it first (regardless
      // of modifier keys on the second press — that matches the existing
      // Ctrl+A, C pattern where C is pressed without modifiers).
      if (chordPrefix !== null) {
        // Any keypress that isn't a valid second key cancels the chord
        if (chordPrefix === "A") {
          if (e.key === "c") {
            e.preventDefault();
            setChordPrefix(null);
            setShowChat((v) => !v);
            return;
          }
          if (e.key === "g") {
            e.preventDefault();
            setChordPrefix(null);
            setShowAgentManager(true);
            return;
          }
          if (e.key === "i") {
            e.preventDefault();
            setChordPrefix(null);
            setShowAISettings(true);
            return;
          }
        }

        if (chordPrefix === "T") {
          if (e.key === "t" || e.key === "T") {
            e.preventDefault();
            setChordPrefix(null);
            createTerminal();
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
          if (e.key === "e" || e.key === "E") {
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

      // ---- Defensive: always prevent Ctrl+S / Cmd+S from reaching ----
      // the webview's native "Save Page" handler, which can cause the
      // app to close in some Tauri v2 environments (notably Linux/GTK).
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";

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

      // Ctrl+Shift+B — Toggle Browser
      if (e.ctrlKey && e.shiftKey && e.key === "B") {
        e.preventDefault();
        if (browserUrl) {
          closeBrowser();
        } else {
          setBrowserUrl("https://google.com");
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

      // Ctrl+Shift+I — Direct AI Settings access
      if (e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        setShowAISettings(true);
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
        if (showAISettings) setShowAISettings(false);
        if (showSettings) setShowSettings(false);
        if (showTermMemory) {
          setShowTermMemory(false);
        }
        return;
      }

      if (isInput) return;
    };

    // Use capture phase so the handler fires BEFORE xterm.js and other
    // element-level keydown listeners can intercept/consume the event.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [openFolder, refreshFolder, createTerminal, showAISettings, showSettings, showAgentManager, chordPrefix, browserUrl, closeBrowser, showTermMemory, showSearch]);

  // --- Menu ---
  const menus = [
    {
      label: "File Explorer",
      items: [
        { label: "Open Folder", action: openFolder, shortcut: "Ctrl+F, O" },
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
        { label: "New Terminal", action: createTerminal, shortcut: "Ctrl+T, T" },
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
        { label: "Toggle Browser", action: () => browserUrl ? closeBrowser() : setBrowserUrl("https://google.com"), shortcut: "Ctrl+Shift+B" },
      ],
    },
    {
      label: "AI Integrations",
      items: [
        { label: "Toggle Agent Chat", action: () => setShowChat((v) => !v), shortcut: "Ctrl+A, C" },
        { label: "Manage Agents...", action: () => setShowAgentManager(true), shortcut: "Ctrl+A, G" },
        { label: "Settings...", action: () => setShowAISettings(true), shortcut: "Ctrl+A, I" },
      ],
    },
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
  const outerSidePanels = (hasExplorer ? explorerPts : 0) + (hasChat ? chatPts : 0);
  const editorPts = Math.max(15, 100 - outerSidePanels);

  return (
    <div className="app">
      {chordPrefix && (
        <div className="chord-hint">
          {chordPrefix === "A" ? (
            <>Waiting for second key... (press <strong>C</strong> for Chat, <strong>G</strong> for Agents, <strong>I</strong> for AI Settings)</>
          ) : chordPrefix === "T" ? (
            <>Waiting for second key... (press <strong>T</strong> for Terminal, <strong>M</strong> for Memory)</>
          ) : chordPrefix === "E" ? (
            <>Waiting for second key... (press <strong>E</strong> for Explorer, <strong>S</strong> for Editor Settings)</>
          ) : (
            <>Waiting for second key... (press <strong>S</strong> for Search, <strong>O</strong> for Open Folder, <strong>E</strong> for Explorer, <strong>R</strong> for Refresh)</>
          )}
        </div>
      )}

      <MenuBar
        menus={menus}
        logo={<img src={nolockLogo} alt="nolock" className="menubar-logo-img" />}
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
                onFileOpen={openFile}
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
          <div className={`editor-main ${hasBrowser ? "split" : ""}`} ref={editorMainRef}
            style={hasTerminal ? { flex: ratioFlex(100 - terminalPts) } : undefined}
          >
            <div
              className="editor-pane"
              style={{
                flex: hasBrowser ? ratioFlex(100 - browserPts) : "1 1 0",
              }}
            >
              {openFiles.length > 0 && (
                <div className="editor-tabs">
                  {openFiles.map((f) => (
                    <div
                      key={f.path}
                      className={`editor-tab ${f.path === activeFile ? "active" : ""}`}
                      onClick={() => setActiveFile(f.path)}
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

              <div className="editor-content">
                {currentFile ? (
                  <Editor
                    key={currentFile.path}
                    filePath={currentFile.path}
                    content={currentFile.content}
                    onChange={(content) => updateFileContent(currentFile.path, content)}
                    onSave={() => saveFile(currentFile.path)}
                    revealLine={revealLine?.filePath === currentFile.path ? revealLine.lineNumber : undefined}
                    onRevealConsumed={() => setRevealLine(null)}
                  />
                ) : (
                  <ShortcutsScreen />
                )}
              </div>
            </div>

            {hasBrowser && (
              <>
                <ResizableHandle
                  direction="horizontal"
                  onDrag={makeResizeHandler(setBrowserPts, 20, 80, editorMainRef, "width", 100, true)}
                  onDragEnd={() => setResizeEpoch((e) => e + 1)}
                />
                <div className="browser-pane" style={{ flex: ratioFlex(browserPts) }}>
                  <BrowserPanel url={browserUrl!} onClose={closeBrowser} resizeEpoch={resizeEpoch} />
                </div>
              </>
            )}
          </div>

          {hasTerminal && (
            <>
              <ResizableHandle
                direction="vertical"
                onDrag={makeResizeHandler(setTerminalPts, 8, 65, editorAreaRef, "height", 100, true)}
                onDragEnd={() => setResizeEpoch((e) => e + 1)}
              />
              <TerminalPanel
                instances={terminals}
                activeId={activeTermId}
                rootPath={rootPath}
                onSelect={setActiveTermId}
                onClose={closeTerminal}
                style={{ flex: ratioFlex(terminalPts) }}
                lastCommandRef={lastCommandRef}
              />
            </>
          )}
        </div>

        {hasChat && (
          <>
            <ResizableHandle
              direction="horizontal"
              onDrag={makeResizeHandler(setChatPts, 15, 55, mainAreaRef, "width", 100, true)}
              onDragEnd={() => setResizeEpoch((e) => e + 1)}
            />
            <ChatPanel onClose={() => setShowChat(false)} onOpenUrl={openInBrowser} rootPath={rootPath} style={{ flex: ratioFlex(chatPts) }} onOpenAgentManager={() => setShowAgentManager(true)} />
          </>
        )}
      </div>

      <StatusBar showChat={showChat} onToggleChat={() => setShowChat(!showChat)} />

      <AISettings visible={showAISettings} onClose={() => setShowAISettings(false)} />
      <EditorSettings visible={showSettings} onClose={() => setShowSettings(false)} />

      <AgentManager
        visible={showAgentManager}
        onClose={() => setShowAgentManager(false)}
        rootPath={rootPath}
        onAgentsChanged={() => setAgentRefreshKey((k) => k + 1)}
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
