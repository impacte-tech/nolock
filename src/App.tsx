import { useState, useCallback, useEffect } from "react";
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

  return (
    <div className="app">
      {chordPending && (
        <div className="chord-hint">
          Waiting for second key... (press <strong>I</strong> for AI Settings)
        </div>
      )}

      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title">Zencode</span>
      </div>

      <MenuBar menus={menus} />

      <div className="main-area">
        <FileExplorer
          onFileOpen={openFile}
          rootPath={rootPath}
          setRootPath={setRootPath}
          visible={showExplorer}
          refreshKey={refreshKey}
        />

        <div className="editor-area">
          <div className={`editor-main ${browserUrl ? "split" : ""}`}>
            <div className="editor-pane">
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
                    <span className="big-icon">Z</span>
                    <span>Zencode</span>
                    <span style={{ fontSize: 12, marginTop: 4 }}>
                      {rootPath ? "Open a file to start editing" : "File \u2192 Open Folder to get started"}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {browserUrl && (
              <div className="browser-pane">
                <BrowserPanel url={browserUrl} onClose={closeBrowser} />
              </div>
            )}
          </div>

          <TerminalPanel
            instances={terminals}
            activeId={activeTermId}
            rootPath={rootPath}
            onSelect={setActiveTermId}
            onClose={closeTerminal}
          />
        </div>

        {showChat && <ChatPanel onClose={() => setShowChat(false)} onOpenUrl={openInBrowser} />}
      </div>

      <StatusBar showChat={showChat} onToggleChat={() => setShowChat(!showChat)} />

      <AISettings visible={showAISettings} onClose={() => setShowAISettings(false)} />
    </div>
  );
}
