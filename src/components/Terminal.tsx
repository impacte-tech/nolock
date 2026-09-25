import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveSessionId, trackTerminal, flushTerminalActivity } from "../lib/terminalSessions";
import { nanoid } from "nanoid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TerminalInstance {
  id: string;
  label: string;
  active: boolean;
  rootPath?: string;
  /** Claimed once, including across layout remounts, to avoid replaying commands. */
  initialCommand?: { current: string | null };
}

interface TerminalViewProps {
  instance: TerminalInstance;
  rootPath: string;
  lastCommandRef?: React.MutableRefObject<string>;
  recording?: boolean;
  /** True while this terminal is the selected one — the view focuses itself on activation. */
  active?: boolean;
}

export default function TerminalView({ instance, rootPath, recording = false, active = false }: TerminalViewProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const termInstance = useRef<Terminal | null>(null);

  const cwd = instance.rootPath ?? rootPath;
  const sessionId = useActiveSessionId(cwd);
  const context = useRef({ sessionId, recording, label: instance.label });
  context.current = { sessionId, recording, label: instance.label };
  const track = (kind: "opened" | "attached" | "input" | "output" | "exited" | "closed" | "recording-on" | "recording-off", text?: string) => {
    trackTerminal(cwd, context.current.sessionId, { terminalId: instance.id, label: context.current.label.slice(0, 128), kind, ...(text === undefined ? {} : { text }) });
  };
  useEffect(() => { track("attached"); }, [sessionId]);
  const wasRecording = useRef(false);
  useEffect(() => {
    if (wasRecording.current !== recording) track(recording ? "recording-on" : "recording-off");
    wasRecording.current = recording;
  }, [recording]);
  useEffect(() => {
    if (active) termInstance.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!termRef.current) return;

    const ptyId = `${instance.id}-${nanoid()}`;
    const term = new Terminal({
      theme: {
        background: "#000000",
        foreground: "#cdd6f4",
        cursor: "#89b4fa",
        selectionBackground: "#45475a",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    termInstance.current = term;
    term.write("[Nolock] Full terminal access. Project MCPs and agent session tracking: codex | claude | opencode\r\n");

    // Wait a tick for layout to settle
    requestAnimationFrame(() => {
      fit.fit();
    });
    fitAddon.current = fit;

    const { cols, rows } = term;

    let exited = false;
    // Listen for PTY output from Rust backend
    const unlisten = listen<{ id: string; data: string }>("pty-output", (event) => {
      if (event.payload.id === ptyId) {
        term.write(event.payload.data);
        if (context.current.recording) track("output", event.payload.data);
      }
    });

    const unlistenExit = listen<string>("pty-exit", (event) => {
      if (event.payload === ptyId) {
        exited = true;
        track("exited");
        term.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
      }
    });

    let disposed = false;
    // Register listeners before spawning so even short commands retain output.
    void Promise.all([unlisten, unlistenExit]).then(async () => {
      if (disposed) return;
      const command = instance.initialCommand?.current ?? null;
      if (instance.initialCommand) instance.initialCommand.current = null;
      await invoke<void>("pty_spawn", {
        id: ptyId, shell: null, command,
        cwd: cwd || null, cols, rows,
      });
      if (disposed) await invoke("pty_kill", { id: ptyId });
      else { track("opened"); term.focus(); }
    }).catch((e) => {
      if (!disposed) term.write(`\r\n\x1b[31mFailed to start shell: ${String(e)}\x1b[0m\r\n`);
    });

    const dataDisposable = term.onData((data: string) => {
      invoke("pty_write", { id: ptyId, data }).catch(() => {});
      if (/[\r\n]/.test(data)) track("input");
    });

    // Resize handler
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      invoke("pty_resize", { id: ptyId, cols, rows }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(termRef.current);

    return () => {
      disposed = true;
      track("closed");
      void flushTerminalActivity();
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unlisten.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      invoke("pty_kill", { id: ptyId }).catch(() => {});
      termInstance.current = null;
      term.dispose();
    };
  }, [cwd, instance.id]);

  return <div ref={termRef} style={{ width: "100%", height: "100%", padding: "2px 4px" }} />;
}

function TerminalIcon({ kind }: { kind: "add" | "arrange" | "expand" | "restore" | "record" | "close" }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">{kind === "add" ? <path d="M8 3v10M3 8h10" /> : kind === "close" ? <path d="m4 4 8 8m0-8-8 8" /> : kind === "record" ? <circle cx="8" cy="8" r="4" /> : kind === "arrange" ? <><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10M8 8h6"/></> : kind === "expand" ? <path d="M9 2h5v5M14 2 7 9M6 3H2v11h11v-4"/> : <><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 10h12M8 4v4m-2-2 2 2 2-2"/></>}</svg>;
}

export type TerminalLayout = "tabs" | "columns" | "grid";
export function nextTerminalLayout(layout: TerminalLayout): TerminalLayout {
  return layout === "tabs" ? "columns" : layout === "columns" ? "grid" : "tabs";
}
const TERMINAL_LAYOUT_KEY = "nolock:terminal-layout";
function loadTerminalLayout(): TerminalLayout {
  try {
    const stored = localStorage.getItem(TERMINAL_LAYOUT_KEY);
    return stored === "columns" || stored === "grid" ? stored : "tabs";
  } catch {
    return "tabs";
  }
}
interface WorkspaceProps {
  instances: TerminalInstance[];
  activeId: string | null;
  editorTerminalId: string | null;
  rootPath: string;
  terminalPercent: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
  onEditorTerminal: (id: string | null) => void;
  onRename: (id: string, label: string) => void;
  children: React.ReactNode;
  resizeHandle: React.ReactNode;
}
/** Every PTY view keeps the same React parent/key. Layout is CSS-only. */
export function TerminalWorkspace({ instances, activeId, editorTerminalId, rootPath, terminalPercent, onSelect, onClose, onCreate, onEditorTerminal, onRename, children, resizeHandle }: WorkspaceProps) {
  const [layout, setLayoutState] = useState<TerminalLayout>(loadTerminalLayout);
  const setLayout = useCallback((next: TerminalLayout) => {
    setLayoutState(next);
    try { localStorage.setItem(TERMINAL_LAYOUT_KEY, next); } catch { /* storage unavailable */ }
  }, []);
  const [recorded, setRecorded] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const failed = (event: Event) => { setError((event as CustomEvent<string>).detail); setRecorded(new Set()); };
    window.addEventListener("nolock:terminal-tracking-error", failed);
    return () => window.removeEventListener("nolock:terminal-tracking-error", failed);
  }, []);
  const promoted = instances.some((t) => t.id === editorTerminalId) ? editorTerminalId : null;
  const lower = instances.filter((t) => t.id !== promoted);
  const selected = lower.some((t) => t.id === activeId) ? activeId : lower[0]?.id;
  const columns = layout === "tabs" ? 1 : layout === "columns" ? Math.max(1, lower.length) : Math.max(1, Math.ceil(Math.sqrt(lower.length)));
  const rows = layout === "grid" ? Math.max(1, Math.ceil(lower.length / columns)) : 1;
  const hasLower = lower.length > 0;
  const gridRows = instances.length === 0 ? "minmax(0, 1fr)" : hasLower
    ? `minmax(0, ${100-terminalPercent}fr) 5px auto repeat(${rows}, minmax(0, ${terminalPercent / rows}fr))`
    : "minmax(0, 1fr) auto";
  return <div className="terminal-workspace" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: gridRows }}>
    <div className="terminal-editor-slot" style={{ gridRow: 1, gridColumn: "1 / -1", display: promoted ? "none" : "flex" }}>{children}</div>
    {hasLower && <div style={{ gridRow: 2, gridColumn: "1 / -1" }}>{resizeHandle}</div>}
    {instances.length > 0 && <div className="terminal-workspace-toolbar" style={{ gridRow: hasLower ? 3 : 2, gridColumn: "1 / -1" }}>
      <div className="terminal-workspace-tabs" role="tablist" aria-label="Terminals">
        {instances.map((t) => <button type="button" role="tab" aria-selected={t.id === activeId} key={t.id} onClick={() => onSelect(t.id)} onDoubleClick={() => setRenaming(t.id)} title="Double-click to rename">{t.label}{t.id === promoted ? " ↗" : ""}</button>)}
      </div>
      <span className="terminal-count">{instances.length} terminals</span>
      <button className="terminal-icon-button" type="button" onClick={onCreate} title="New terminal" aria-label="New terminal"><TerminalIcon kind="add" /></button>
      <button className="terminal-icon-button" type="button" onClick={() => setLayout(nextTerminalLayout(layout))} disabled={lower.length < 2} title={`Arrange terminals · ${layout} (click to cycle)`} aria-label={`Arrange: ${layout}`}><TerminalIcon kind="arrange" /></button>
      {error && <span role="alert" title={error}>Tracking failed <button className="terminal-icon-button" type="button" onClick={() => setError("")} aria-label="Dismiss tracking error"><TerminalIcon kind="close" /></button></span>}
    </div>}
    {instances.map((inst) => {
      const inEditor = inst.id === promoted;
      const index = lower.findIndex((t) => t.id === inst.id);
      const visible = inEditor || layout !== "tabs" || inst.id === selected;
      return <div key={inst.id} className={`terminal-workspace-pane ${inst.id === activeId ? "active" : ""}`} style={{
        display: visible ? "flex" : "none",
        gridRow: inEditor ? 1 : 4 + Math.floor(index / columns),
        gridColumn: inEditor ? "1 / -1" : 1 + (index % columns),
      }} onFocusCapture={() => onSelect(inst.id)} onMouseDown={() => onSelect(inst.id)}>
        <div className="terminal-pane-controls">
          {renaming === inst.id ? <input autoFocus aria-label={`Name for ${inst.id}`} value={inst.label} maxLength={80} onChange={(e) => onRename(inst.id, e.target.value)} onBlur={() => setRenaming(null)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setRenaming(null); }} /> : <span className="terminal-pane-name" title="Double-click to rename" onDoubleClick={() => setRenaming(inst.id)}>{inst.label}</span>}
          <button className="terminal-icon-button terminal-record" type="button" aria-label={recorded.has(inst.id) ? "Stop recording" : "Record transcript"} aria-pressed={recorded.has(inst.id)} title={recorded.has(inst.id) ? "Stop recording transcript" : "Record transcript — output may contain secrets"} onClick={() => setRecorded((prev) => { const next = new Set(prev); next.has(inst.id) ? next.delete(inst.id) : next.add(inst.id); return next; })}><TerminalIcon kind="record" /></button>
          <button className="terminal-icon-button" type="button" aria-label={inEditor ? "Show files" : `Move ${inst.label} to editor`} title={inEditor ? "Restore file editor" : "Move terminal to editor"} aria-pressed={inEditor} onClick={() => onEditorTerminal(inEditor ? null : inst.id)}><TerminalIcon kind={inEditor ? "restore" : "expand"} /></button>
          <button className="terminal-icon-button" type="button" aria-label={`Close ${inst.label}`} title="Close terminal" onClick={() => onClose(inst.id)}><TerminalIcon kind="close" /></button>
        </div>
        <div className="terminal-emulator-slot"><TerminalView instance={inst} rootPath={rootPath} active={inst.id === activeId} recording={recorded.has(inst.id)} /></div>
      </div>;
    })}
  </div>;
}
