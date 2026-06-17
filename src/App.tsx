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
import StatusBar from "./components/StatusBar";
import ResizableHandle from "./components/ResizableHandle";
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

      // When `invert` is true, negate the delta so that dragging toward the
      // controlled panel makes it shrink instead of grow.  This is needed
      // when the controlled panel sits on the opposite side of the drag
      // direction (e.g. the explorer handle: explorer is left of the divider,
      // so dragging right should shrink explorer, not grow it).
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

  // --- Chord state for Ctrl+Shift+A, I ---
  const [chordPending, setChordPending] = useState(false);

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

  const currentFile = openFiles.find((f) => f.path === activeFile);

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ---- Defensive: always prevent Ctrl+S / Cmd+S from reaching ----
      // the webview's native "Save Page" handler, which can cause the
      // app to close in some Tauri v2 environments (notably Linux/GTK).
      // Monaco's own keybinding handler (in Editor.tsx) is responsible
      // for the actual save operation; this is a safety net to prevent
      // the window from closing even if that listener doesn't fire.
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

      // Ctrl+T — New Terminal
      if (e.ctrlKey && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        createTerminal();
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

      // Ctrl+A — Chord prefix for AI shortcuts
      if (e.ctrlKey && !e.shiftKey && e.key === "a") {
        e.preventDefault();
        if (chordPending) {
          setChordPending(false);
        } else {
          setChordPending(true);
          setTimeout(() => {
            setChordPending(false);
          }, 1500);
        }
        return;
      }

      if (chordPending && e.key === "c") {
        e.preventDefault();
        setChordPending(false);
        setShowChat((v) => !v);
        return;
      }

      if (chordPending && e.key === "i") {
        e.preventDefault();
        setChordPending(false);
        setShowAISettings(true);
        return;
      }

      if (e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        setShowAISettings(true);
        return;
      }

      if (e.ctrlKey && !e.shiftKey && e.key === "e") {
        e.preventDefault();
        setShowExplorer((v) => !v);
        return;
      }

      if (e.key === "Escape") {
        if (showAISettings) setShowAISettings(false);
        return;
      }

      if (isInput) return;
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openFolder, refreshFolder, createTerminal, showAISettings, chordPending, browserUrl, closeBrowser]);

  // --- Menu ---
  const menus = [
    {
      label: "File Explorer",
      items: [
        { label: "Open Folder", action: openFolder, shortcut: "Ctrl+O" },
        { label: "Refresh Explorer", action: refreshFolder, shortcut: "Ctrl+R" },
        { label: "Toggle Explorer", action: () => setShowExplorer((v) => !v), shortcut: "Ctrl+E" },
      ],
    },
    {
      label: "Terminal",
      items: [
        { label: "New Terminal", action: createTerminal, shortcut: "Ctrl+T" },
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
        { label: "Settings...", action: () => setShowAISettings(true), shortcut: "Ctrl+A, I" },
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
      {chordPending && (
        <div className="chord-hint">
          Waiting for second key... (press <strong>I</strong> for AI Settings)
        </div>
      )}

      <div className="titlebar" data-tauri-drag-region>
        <img src={nolockLogo} alt="nolock" className="titlebar-logo" />
      </div>

      <MenuBar menus={menus} />

      <div className="main-area" ref={mainAreaRef}>
        {hasExplorer && (
          <>
            <FileExplorer
              onFileOpen={openFile}
              rootPath={rootPath}
              setRootPath={setRootPath}
              visible={true}
              refreshKey={refreshKey}
              style={{ flex: ratioFlex(explorerPts) }}
            />
            <ResizableHandle
              direction="horizontal"
              onDrag={makeResizeHandler(setExplorerPts, 8, 50, mainAreaRef, "width", 100, true)}
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
                  />
                ) : (
                  <div className="empty-state">
                    <img src={nolockLogo} alt="nolock" className="empty-state-logo" />
                    <span>nolock</span>
                    <span style={{ fontSize: 12, marginTop: 4 }}>
                      {rootPath ? "Open a file to start editing" : "File \u2192 Open Folder to get started"}
                    </span>
                  </div>
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
            <ChatPanel onClose={() => setShowChat(false)} onOpenUrl={openInBrowser} rootPath={rootPath} style={{ flex: ratioFlex(chatPts) }} />
          </>
        )}
      </div>

      <StatusBar showChat={showChat} onToggleChat={() => setShowChat(!showChat)} />

      <AISettings visible={showAISettings} onClose={() => setShowAISettings(false)} />
    </div>
  );
}
