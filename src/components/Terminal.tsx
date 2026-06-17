import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TerminalInstance {
  id: string;
  label: string;
  active: boolean;
}

interface TerminalViewProps {
  instance: TerminalInstance;
  rootPath: string;
  lastCommandRef?: React.MutableRefObject<string>;
}

export default function TerminalView({ instance, rootPath, lastCommandRef }: TerminalViewProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const lineBuffer = useRef<string>("");

  useEffect(() => {
    if (!termRef.current) return;

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
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

    // Wait a tick for layout to settle
    requestAnimationFrame(() => {
      fit.fit();
    });
    fitAddon.current = fit;

    const { cols, rows } = term;

    // Listen for PTY output from Rust backend
    const unlisten = listen<{ id: string; data: string }>("pty-output", (event) => {
      if (event.payload.id === instance.id) {
        term.write(event.payload.data);
      }
    });

    const unlistenExit = listen<string>("pty-exit", (event) => {
      if (event.payload === instance.id) {
        term.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
      }
    });

    // Spawn PTY via Rust backend
    invoke("pty_spawn", {
      id: instance.id,
      shell: null as string | null,
      cwd: rootPath || null as string | null,
      cols,
      rows,
    }).catch((e) => {
      term.write(`\r\n\x1b[31mFailed to start shell: ${String(e)}\x1b[0m\r\n`);
    });

    // Terminal input -> PTY
    const dataDisposable = term.onData((data: string) => {
      // Always forward keystroke to PTY first (fire-and-forget)
      invoke("pty_write", { id: instance.id, data }).catch(() => {});

      // ---- Track commands for Terminal Memory feature -------------------
      // Wrap in try-catch to prevent any tracking error from breaking
      // xterm.js's internal onData pipeline and losing keystrokes.
      try {
        if (data === "\r") {
          // Enter pressed — submit the buffered line as a command
          const cmd = lineBuffer.current.trim();
          if (cmd.length > 0) {
            invoke("record_command", { command: cmd }).catch(() => {});
            if (lastCommandRef) {
              lastCommandRef.current = cmd;
            }
          }
          lineBuffer.current = "";
        } else if (data === "\x7f") {
          // Backspace
          lineBuffer.current = lineBuffer.current.slice(0, -1);
        } else if (data === "\x15") {
          // Ctrl+U — clear line
          lineBuffer.current = "";
        } else if (data === "\x03") {
          // Ctrl+C — clear line (interrupt)
          lineBuffer.current = "";
        } else if (data === "\x04") {
          // Ctrl+D — no effect on buffer, but don't add to it
        } else if (data.length === 1 && data >= " ") {
          // Printable character
          lineBuffer.current += data;
        }
        // All other sequences (arrow keys, home, end, etc.) are ignored
        // since they navigate history but don't change the current line
      } catch (e) {
        console.error("[Terminal Memory] tracking error:", e);
      }
    });

    // Resize handler
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      invoke("pty_resize", { id: instance.id, cols, rows }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unlisten.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      invoke("pty_kill", { id: instance.id }).catch(() => {});
      term.dispose();
    };
  }, [rootPath, instance.id]);

  return <div ref={termRef} style={{ width: "100%", height: "100%", padding: "2px 4px" }} />;
}

// ---------------------------------------------------------------------------
// Terminal Panel — manages multiple terminal tabs
// ---------------------------------------------------------------------------

interface PanelProps {
  instances: TerminalInstance[];
  activeId: string | null;
  rootPath: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  style?: React.CSSProperties;
  lastCommandRef?: React.MutableRefObject<string>;
}

export function TerminalPanel({ instances, activeId, rootPath, onSelect, onClose, style, lastCommandRef }: PanelProps) {
  if (instances.length === 0) return null;

  return (
    <div className="terminal-container" style={style}>
      <div className="terminal-header">
        <div className="terminal-tabs">
          {instances.map((inst) => (
            <div
              key={inst.id}
              className={`terminal-tab ${inst.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(inst.id)}
            >
              <span>{inst.label}</span>
              <span
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(inst.id);
                }}
              >
                &times;
              </span>
            </div>
          ))}
        </div>
        <span />
      </div>
      <div className="terminal-body">
        {instances.map((inst) => (
          <div
            key={inst.id}
            style={{ display: inst.id === activeId ? "block" : "none", width: "100%", height: "100%" }}
          >
            <TerminalView instance={inst} rootPath={rootPath} lastCommandRef={lastCommandRef} />
          </div>
        ))}
      </div>
    </div>
  );
}
