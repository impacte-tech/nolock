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
      try {
        if (data === "\r") {
          const cmd = lineBuffer.current.trim();
          if (cmd.length > 0) {
            invoke("record_command", { command: cmd }).catch(() => {});
            if (lastCommandRef) {
              lastCommandRef.current = cmd;
            }
          }
          lineBuffer.current = "";
        } else if (data === "\x7f") {
          lineBuffer.current = lineBuffer.current.slice(0, -1);
        } else if (data === "\x15") {
          lineBuffer.current = "";
        } else if (data === "\x03") {
          lineBuffer.current = "";
        } else if (data === "\x04") {
          // Ctrl+D — no effect on buffer
        } else if (data.length === 1 && data >= " ") {
          lineBuffer.current += data;
        }
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
// Terminal Panel — manages terminal tabs with stacking support
// ---------------------------------------------------------------------------

export type TermLayoutMode = "single" | "stacked";

export interface TerminalStackLayout {
  /** Ordered list of terminal IDs currently visible in the stack (1–3 items). */
  stackedIds: string[];
  /** Flex-grow ratios for each stacked terminal (length = stackedIds.length). */
  ratios: number[];
}

interface PanelProps {
  instances: TerminalInstance[];
  activeId: string | null;
  rootPath: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  style?: React.CSSProperties;
  lastCommandRef?: React.MutableRefObject<string>;
  /** Stack layout — when non-null, multiple terminals are shown simultaneously. */
  stackLayout: TerminalStackLayout | null;
  /** Callback to toggle a terminal in/out of the stack. */
  onToggleStack?: (id: string) => void;
  /** Callback when a resize handle between stacked terminals is dragged. */
  onStackRatioChange?: (index: number, newRatio: number) => void;
  /** Container ref for measuring during resize. */
  stackContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function TerminalPanel({
  instances,
  activeId,
  rootPath,
  onSelect,
  onClose,
  style,
  lastCommandRef,
  stackLayout,
  onToggleStack,
  onStackRatioChange,
  stackContainerRef,
}: PanelProps) {
  if (instances.length === 0) return null;

  const stackedIds = stackLayout?.stackedIds ?? [];
  const ratios = stackLayout?.ratios ?? [];
  const isStacked = stackedIds.length > 1;

  return (
    <div className="terminal-container" style={style}>
      <div className="terminal-header">
        <div className="terminal-tabs">
          {instances.map((inst) => {
            const isStackedHere = stackedIds.includes(inst.id);
            return (
              <div
                key={inst.id}
                className={`terminal-tab ${inst.id === activeId ? "active" : ""} ${isStackedHere ? "stacked" : ""}`}
                onClick={() => onSelect(inst.id)}
              >
                <span>{inst.label}</span>
                {instances.length >= 2 && onToggleStack && (
                  <span
                    className={`terminal-tab-stack-btn ${isStackedHere ? "active" : ""}`}
                    title={isStackedHere ? "Unstack this terminal" : "Stack this terminal"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStack(inst.id);
                    }}
                  >
                    &#8862;
                  </span>
                )}
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
            );
          })}
        </div>
        <span />
      </div>

      <div
        className={`terminal-body ${isStacked ? "stacked" : ""}`}
        ref={stackContainerRef as React.RefObject<HTMLDivElement>}
      >
        {isStacked ? (
          stackedIds.map((id, idx) => {
            const inst = instances.find((i) => i.id === id);
            if (!inst) return null;

            const elements: React.ReactNode[] = [];

            // Resize handle between stacked panes (not before the first)
            if (idx > 0 && onStackRatioChange) {
              elements.push(
                <TerminalStackHandle
                  key={`handle-${id}`}
                  onDrag={(delta) => {
                    const container = stackContainerRef?.current;
                    if (!container) return;
                    const totalHeight = container.getBoundingClientRect().height;
                    const available = totalHeight - (stackedIds.length - 1) * 5;
                    if (available <= 0) return;
                    const ptsDelta = (delta / available) * 100;
                    const newRatio = Math.max(10, Math.min(80, ratios[idx] + ptsDelta));
                    onStackRatioChange(idx, newRatio);
                  }}
                />
              );
            }

            elements.push(
              <div
                key={`pane-${id}`}
                className={`terminal-stack-pane ${inst.id === activeId ? "active" : ""}`}
                style={{ flex: ratioFlex(ratios[idx] || 33) }}
                onClick={() => onSelect(id)}
              >
                <div className="terminal-stack-pane-header">
                  <span className="terminal-stack-pane-label">{inst.label}</span>
                  <span
                    className="terminal-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(id);
                    }}
                  >
                    &times;
                  </span>
                </div>
                <TerminalView instance={inst} rootPath={rootPath} lastCommandRef={lastCommandRef} />
              </div>
            );

            return elements;
          })
        ) : (
          instances.map((inst) => (
            <div
              key={`single-${inst.id}`}
              style={{ display: inst.id === activeId ? "block" : "none", width: "100%", height: "100%" }}
            >
              <TerminalView instance={inst} rootPath={rootPath} lastCommandRef={lastCommandRef} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: resize handle between stacked terminal panes
// ---------------------------------------------------------------------------

function TerminalStackHandle({ onDrag }: { onDrag: (delta: number) => void }) {
  const handleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;

      const onMouseMove = (ev: MouseEvent) => {
        onDrag(ev.clientY - startY);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    handle.addEventListener("mousedown", onMouseDown);
    return () => handle.removeEventListener("mousedown", onMouseDown);
  }, [onDrag]);

  return <div ref={handleRef} className="terminal-stack-handle" />;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function ratioFlex(grow: number): string {
  return `${grow} 1 0`;
}
