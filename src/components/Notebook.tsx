// ---------------------------------------------------------------------------
// Notebook — native .ipynb viewer/editor with Colab-style rendering
//
// Layout (mirrors Google Colab's structure, in nolock's dark theme):
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ● [env select ▾] [Connect/Interrupt/⟳] │ [▶ Run all] [+ Code]│
//   ├──────────────────────────────────────────────────────────────┤
//   │ [▶]  ┌────────────────────────────────────────────┐ [↑][↓][✕]│
//   │ [ 1] │ x = 1 + 1                                  │         │
//   │      └────────────────────────────────────────────┘         │
//   │      │ hi                                                   │
//   │      │ 2                                                    │
//   └──────────────────────────────────────────────────────────────┘
//
// Each code cell is a lightweight auto-height Monaco editor (python). Cells
// run against a persistent Python kernel process (see src-tauri pykernel.rs)
// spawned from the selected virtual environment. Outputs stream live and are
// persisted into the notebook JSON on completion (Jupyter-style).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import { MarkdownContent } from "./ChatPanel";
import Select from "./Select";
import {
  type NotebookCell,
  type NotebookJson,
  type NotebookOutput,
  createCodeCell,
  createMarkdownCell,
  makeCellId,
  parseNotebook,
  serializeNotebook,
  sourceToString,
  stringToSource,
} from "../lib/notebook";

// ---------------------------------------------------------------------------
// IPC types (mirror the Rust serde camelCase structs in pykernel.rs)
// ---------------------------------------------------------------------------

interface PythonEnv {
  name: string;
  pythonPath: string;
  kind: string;
  version: string;
}

interface KernelOutput {
  kind: string; // "result" | "display"
  mime: string;
  data: string;
}

interface KernelError {
  ename: string;
  evalue: string;
  traceback: string[];
}

interface RunResult {
  status: string; // "ok" | "error" | "timeout"
  execCount: number | null;
  stdout: string;
  stderr: string;
  outputs: KernelOutput[];
  error: KernelError | null;
  elapsedMs: number;
}

interface KernelStreamEvent {
  kernelId: string;
  runId: string;
  kind: string; // "stdout" | "stderr"
  text: string;
}

interface KernelDiedEvent {
  kernelId: string;
  pid: number;
}

type KernelStatus = "stopped" | "starting" | "ready" | "busy" | "dead";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Monaco theme — same palette as Editor.tsx (idempotent re-definition). */
let notebookThemeDefined = false;
function ensureMonacoTheme() {
  if (notebookThemeDefined) return;
  monaco.editor.defineTheme("nolock-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editorSuggestWidget.background": "#1e1e1e",
      "editorSuggestWidget.border": "#333333",
      "editorSuggestWidget.foreground": "#ffffff",
      "editorSuggestWidget.selectedBackground": "#2a2d2e",
      "editorSuggestWidget.highlightForeground": "#569cd6",
    },
  });
  notebookThemeDefined = true;
}

/** Convert a kernel RunResult into nbformat cell outputs. */
function toNbformatOutputs(result: RunResult): NotebookOutput[] {
  const outputs: NotebookOutput[] = [];
  if (result.stdout) {
    outputs.push({ output_type: "stream", name: "stdout", text: stringToSource(result.stdout) });
  }
  if (result.stderr) {
    outputs.push({ output_type: "stream", name: "stderr", text: stringToSource(result.stderr) });
  }
  for (const o of result.outputs) {
    if (o.kind === "result") {
      outputs.push({
        output_type: "execute_result",
        execution_count: result.execCount,
        data: { [o.mime]: o.data },
      });
    } else if (o.kind === "display") {
      outputs.push({ output_type: "display_data", data: { [o.mime]: o.data } });
    }
  }
  if (result.error) {
    outputs.push({
      output_type: "error",
      ename: result.error.ename,
      evalue: result.error.evalue,
      traceback: result.error.traceback,
    });
  }
  return outputs;
}

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M2.5 1.2v9.6L10.5 6z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Cell editor — lightweight auto-height Monaco instance
// ---------------------------------------------------------------------------

interface CellEditorProps {
  cellId: string;
  value: string;
  onChange: (value: string) => void;
  /** Shift+Enter — run and advance */
  onRun: () => void;
  /** Ctrl+Enter — run in place */
  onRunNoAdvance: () => void;
  editorRegistry: MutableRefObject<Map<string, monaco.editor.IStandaloneCodeEditor>>;
  pendingFocusRef: MutableRefObject<string | null>;
  onSaveRef: MutableRefObject<() => void>;
}

function CellEditor({
  cellId,
  value,
  onChange,
  onRun,
  onRunNoAdvance,
  editorRegistry,
  pendingFocusRef,
  onSaveRef,
}: CellEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const cbs = useRef({ onChange, onRun, onRunNoAdvance });
  cbs.current = { onChange, onRun, onRunNoAdvance };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureMonacoTheme();

    const editor = monaco.editor.create(host, {
      value,
      language: "python",
      theme: "nolock-dark",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      minimap: { enabled: false },
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      renderLineHighlight: "none",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      folding: false,
      scrollbar: { vertical: "hidden", horizontalScrollbarSize: 4, alwaysConsumeMouseWheel: false },
      guides: { indentation: false, highlightActiveIndentation: false },
      padding: { top: 6, bottom: 6 },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    editorRegistry.current.set(cellId, editor);

    // Propagate typing into the notebook state. Without this, code typed in
    // the cell never leaves the Monaco model and runs execute empty sources.
    const contentSub = editor.onDidChangeModelContent(() => {
      cbs.current.onChange(editor.getValue());
    });

    const sizeSub = editor.onDidContentSizeChange((e) => {
      if (hostRef.current) {
        hostRef.current.style.height = Math.max(26, e.contentHeight) + "px";
      }
    });

    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => cbs.current.onRun());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => cbs.current.onRunNoAdvance());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());

    if (pendingFocusRef.current === cellId) {
      pendingFocusRef.current = null;
      editor.focus();
    }

    return () => {
      contentSub.dispose();
      sizeSub.dispose();
      editorRegistry.current.delete(cellId);
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId]);

  // Sync external value changes (e.g. undo at notebook level) into the model.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && ed.getValue() !== value) {
      ed.setValue(value);
    }
  }, [value]);

  return <div className="nb-code-editor" ref={hostRef} />;
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function OutputView({ output }: { output: NotebookOutput }) {
  const type = output.output_type;

  if (type === "stream") {
    const text = sourceToString(output.text);
    return (
      <pre className={`nb-out-stream${output.name === "stderr" ? " stderr" : ""}`}>{text}</pre>
    );
  }

  if (type === "execute_result" || type === "display_data") {
    const data = output.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") return null;
    if (typeof data["image/png"] === "string" && data["image/png"]) {
      return <img className="nb-out-image" alt="notebook output" src={`data:image/png;base64,${data["image/png"]}`} />;
    }
    if (typeof data["image/jpeg"] === "string" && data["image/jpeg"]) {
      return <img className="nb-out-image" alt="notebook output" src={`data:image/jpeg;base64,${data["image/jpeg"]}`} />;
    }
    if (typeof data["image/svg+xml"] === "string" && data["image/svg+xml"]) {
      return <div className="nb-out-svg" dangerouslySetInnerHTML={{ __html: String(data["image/svg+xml"]) }} />;
    }
    if (typeof data["text/html"] === "string" && data["text/html"]) {
      return <div className="nb-out-html" dangerouslySetInnerHTML={{ __html: String(data["text/html"]) }} />;
    }
    if (typeof data["text/markdown"] === "string" && data["text/markdown"]) {
      return <div className="nb-out-md"><MarkdownContent text={String(data["text/markdown"])} /></div>;
    }
    if (data["application/json"] !== undefined && data["application/json"] !== null) {
      const json = data["application/json"];
      return (
        <pre className="nb-out-text">
          {typeof json === "string" ? json : JSON.stringify(json, null, 2)}
        </pre>
      );
    }
    if (typeof data["text/plain"] === "string" && data["text/plain"]) {
      return <pre className="nb-out-text">{String(data["text/plain"])}</pre>;
    }
    return null;
  }

  if (type === "error") {
    const tb = Array.isArray(output.traceback)
      ? (output.traceback as unknown[]).map(String).join("\n")
      : "";
    return (
      <pre className="nb-out-error">
        {tb || `${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`}
      </pre>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cell view
// ---------------------------------------------------------------------------

interface CellViewProps {
  cell: NotebookCell;
  running: boolean;
  liveOutputs?: NotebookOutput[];
  onSourceChange: (cellId: string, src: string) => void;
  onRun: (cellId: string, advance: boolean) => void;
  onMove: (cellId: string, delta: -1 | 1) => void;
  onDelete: (cellId: string) => void;
  editorRegistry: MutableRefObject<Map<string, monaco.editor.IStandaloneCodeEditor>>;
  pendingFocusRef: MutableRefObject<string | null>;
  onSaveRef: MutableRefObject<() => void>;
}

function CellView({
  cell,
  running,
  liveOutputs,
  onSourceChange,
  onRun,
  onMove,
  onDelete,
  editorRegistry,
  pendingFocusRef,
  onSaveRef,
}: CellViewProps) {
  const [editingMd, setEditingMd] = useState(false);
  const source = sourceToString(cell.source);

  const gutter = (
    <div className="nb-gutter">
      <button
        className={`nb-run-btn${running ? " busy" : ""}`}
        title="Run cell (Shift+Enter)"
        onClick={() => onRun(cell.id, true)}
        disabled={running}
      >
        {running ? <span className="nb-spinner" /> : <PlayIcon />}
      </button>
      {cell.cell_type === "code" && (
        <span className="nb-exec-count" title="Execution count">
          {cell.execution_count != null ? `[${cell.execution_count}]` : "[ ]"}
        </span>
      )}
    </div>
  );

  const actions = (
    <div className="nb-cell-actions">
      <button title="Move cell up" onClick={() => onMove(cell.id, -1)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 3l5 5H9v7H7v-7H3z" />
        </svg>
      </button>
      <button title="Move cell down" onClick={() => onMove(cell.id, 1)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 13L3 8h4V1h2v7h4z" />
        </svg>
      </button>
      <button title="Delete cell" onClick={() => onDelete(cell.id)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M3 1.5L8 6.5l5-5 1 1-5 5 5 5-1 1-5-5-5 5-1-1 5-5-5-5z" />
        </svg>
      </button>
    </div>
  );

  if (cell.cell_type === "markdown") {
    return (
      <div className="nb-cell nb-md" onDoubleClick={() => setEditingMd(true)}>
        {gutter}
        <div className="nb-cell-body">
          {editingMd ? (
            <textarea
              className="nb-md-editor"
              autoFocus
              value={source}
              rows={Math.max(2, source.split("\n").length)}
              onChange={(e) => onSourceChange(cell.id, e.target.value)}
              onBlur={() => setEditingMd(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingMd(false);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                  e.preventDefault();
                  setEditingMd(false);
                  onRun(cell.id, true);
                }
              }}
              placeholder="# Markdown cell — **bold**, `code`, lists…"
              spellCheck={false}
            />
          ) : (
            <div className="nb-md-rendered">
              {source.trim() ? (
                <MarkdownContent text={source} />
              ) : (
                <span className="nb-md-empty">Double-click to add text</span>
              )}
            </div>
          )}
        </div>
        {actions}
      </div>
    );
  }

  if (cell.cell_type !== "code") {
    // Unknown/raw cell types render as inert raw text.
    return (
      <div className="nb-cell nb-raw">
        {gutter}
        <div className="nb-cell-body">
          <pre className="nb-out-text">{source}</pre>
        </div>
        {actions}
      </div>
    );
  }

  const outputs = liveOutputs ?? cell.outputs;
  return (
    <div className={`nb-cell nb-code${running ? " running" : ""}`}>
      {gutter}
      <div className="nb-cell-body">
        <CellEditor
          cellId={cell.id}
          value={source}
          onChange={(v) => onSourceChange(cell.id, v)}
          onRun={() => onRun(cell.id, true)}
          onRunNoAdvance={() => onRun(cell.id, false)}
          editorRegistry={editorRegistry}
          pendingFocusRef={pendingFocusRef}
          onSaveRef={onSaveRef}
        />
        {outputs.length > 0 && (
          <div className="nb-outputs">
            {outputs.map((o, i) => (
              <OutputView key={i} output={o} />
            ))}
          </div>
        )}
      </div>
      {actions}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface NotebookProps {
  filePath: string;
  /** Raw .ipynb JSON string (source of truth, owned by App state). */
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
  rootPath: string;
}

export default function Notebook({ filePath, content, onChange, onSave, rootPath }: NotebookProps) {
  const kernelId = useMemo(() => `nb:${filePath}`, [filePath]);

  // --- parsed notebook -----------------------------------------------------
  const { notebook, error: parseError, normalized } = useMemo(
    () => parseNotebook(content),
    [content]
  );
  const nbRef = useRef<NotebookJson | null>(notebook);
  nbRef.current = notebook;

  // Persist normalization (added cell ids, normalized sources) once.
  useEffect(() => {
    if (notebook && normalized) {
      onChange(serializeNotebook(notebook));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook, normalized]);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // --- environments --------------------------------------------------------
  const [envs, setEnvs] = useState<PythonEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string>("");
  const selectedEnvRef = useRef(selectedEnv);
  selectedEnvRef.current = selectedEnv;
  const [envCreatorOpen, setEnvCreatorOpen] = useState(false);
  const [envName, setEnvName] = useState("");
  const [creatingEnv, setCreatingEnv] = useState(false);

  const loadEnvs = useCallback(async () => {
    try {
      const list: PythonEnv[] = await invoke("python_list_envs", { rootPath });
      setEnvs(list);
      setSelectedEnv((prev) => {
        if (prev && list.some((e) => e.pythonPath === prev)) return prev;
        const saved = localStorage.getItem("nolock.notebook.env");
        if (saved && list.some((e) => e.pythonPath === saved)) return saved;
        const preferred = list.find((e) => e.kind === "venv") ?? list[0];
        return preferred?.pythonPath ?? "";
      });
    } catch (e) {
      console.error("[notebook] failed to list python envs:", e);
    }
  }, [rootPath]);

  useEffect(() => {
    loadEnvs();
  }, [loadEnvs]);

  // --- kernel lifecycle ----------------------------------------------------
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>("stopped");
  const kernelStatusRef = useRef<KernelStatus>("stopped");
  const updateKernelStatus = useCallback((status: KernelStatus) => {
    kernelStatusRef.current = status;
    setKernelStatus(status);
  }, []);
  const pidRef = useRef<number | null>(null);
  const [kernelError, setKernelError] = useState<string | null>(null);
  // In-flight start promise — prevents double-spawn races (e.g. Shift+Enter
  // twice, or run-all while connecting): a second kernel_start would KILL the
  // first kernel mid-handshake and break the in-flight run.
  const startingPromiseRef = useRef<Promise<void> | null>(null);

  const ensureKernel = useCallback(async (): Promise<void> => {
    if (kernelStatusRef.current === "ready" || kernelStatusRef.current === "busy") return;
    if (startingPromiseRef.current) return startingPromiseRef.current;

    const start = async (): Promise<void> => {
      const env =
        envs.find((e) => e.pythonPath === selectedEnvRef.current) ??
        envs.find((e) => e.kind === "venv") ??
        envs[0];
      if (!env) {
        throw new Error("No Python environment available — create one with + Env");
      }
      const cwd = filePath.includes("/")
        ? filePath.slice(0, filePath.lastIndexOf("/"))
        : rootPath || ".";
      updateKernelStatus("starting");
      console.log("[notebook] starting kernel:", env.pythonPath, "cwd:", cwd);
      try {
        const info = await invoke<{ pid: number; pythonVersion: string }>("kernel_start", {
          kernelId,
          pythonPath: env.pythonPath,
          cwd,
        });
        pidRef.current = info.pid;
        console.log("[notebook] kernel ready, pid:", info.pid, "python:", info.pythonVersion);
        updateKernelStatus("ready");
      } catch (e) {
        updateKernelStatus("dead");
        throw e;
      }
    };

    const p = start().finally(() => {
      startingPromiseRef.current = null;
    });
    startingPromiseRef.current = p;
    return p;
  }, [envs, selectedEnv, filePath, rootPath, kernelId, updateKernelStatus]);

  const restartKernel = useCallback(async () => {
    setKernelError(null);
    try {
      await invoke("kernel_stop", { kernelId });
    } catch {
      /* ignore */
    }
    pidRef.current = null;
    updateKernelStatus("stopped");
    try {
      await ensureKernel();
    } catch (e) {
      setKernelError(String(e));
    }
  }, [kernelId, ensureKernel]);

  const interruptKernel = useCallback(async () => {
    try {
      await invoke("kernel_interrupt", { kernelId });
    } catch (e) {
      setKernelError(String(e));
    }
  }, [kernelId]);

  // --- cell editing --------------------------------------------------------
  // `nbRef` is the component's authoritative view of the notebook. It must be
  // updated SYNCHRONOUSLY on every emit: async flows (kernel runs) emit new
  // content and then immediately perform follow-up edits (e.g. the Colab
  // "run last cell → append a fresh cell" step) before React has re-rendered
  // with the new `content` prop. Without this, those follow-ups read a stale
  // notebook and wipe the outputs that were just written.
  const emitCells = useCallback(
    (cells: NotebookCell[]) => {
      const nb = nbRef.current;
      if (!nb) return;
      const nextNb: NotebookJson = { ...nb, cells };
      nbRef.current = nextNb;
      onChange(serializeNotebook(nextNb));
    },
    [onChange]
  );

  const setCellSource = useCallback(
    (cellId: string, src: string) => {
      const nb = nbRef.current;
      if (!nb) return;
      emitCells(nb.cells.map((c) => (c.id === cellId ? { ...c, source: stringToSource(src) } : c)));
    },
    [emitCells]
  );

  const setCellOutputs = useCallback(
    (cellId: string, outputs: NotebookOutput[], execCount: number | null) => {
      const nb = nbRef.current;
      if (!nb) return;
      emitCells(
        nb.cells.map((c) =>
          c.id === cellId && c.cell_type === "code"
            ? { ...c, outputs, execution_count: execCount }
            : c
        )
      );
    },
    [emitCells]
  );

  const pendingFocusRef = useRef<string | null>(null);
  const editorRegistryRef = useRef<Map<string, monaco.editor.IStandaloneCodeEditor>>(new Map());

  const addCell = useCallback(
    (type: "code" | "markdown", afterCellId?: string) => {
      const nb = nbRef.current;
      if (!nb) return;
      const cell = type === "code" ? createCodeCell() : createMarkdownCell();
      const idx = afterCellId
        ? nb.cells.findIndex((c) => c.id === afterCellId) + 1
        : nb.cells.length;
      const next = [...nb.cells.slice(0, idx), cell, ...nb.cells.slice(idx)];
      pendingFocusRef.current = cell.id;
      emitCells(next);
    },
    [emitCells]
  );

  const deleteCell = useCallback(
    (cellId: string) => {
      const nb = nbRef.current;
      if (!nb) return;
      if (nb.cells.length === 1) {
        emitCells([createCodeCell()]);
        return;
      }
      emitCells(nb.cells.filter((c) => c.id !== cellId));
    },
    [emitCells]
  );

  const moveCell = useCallback(
    (cellId: string, delta: -1 | 1) => {
      const nb = nbRef.current;
      if (!nb) return;
      const idx = nb.cells.findIndex((c) => c.id === cellId);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= nb.cells.length) return;
      const next = [...nb.cells];
      [next[idx], next[target]] = [next[target], next[idx]];
      emitCells(next);
    },
    [emitCells]
  );

  // --- execution -----------------------------------------------------------
  const [runningCellIds, setRunningCellIds] = useState<Set<string>>(new Set());
  const [liveOutputs, setLiveOutputs] = useState<Record<string, NotebookOutput[]>>({});
  const runIdToCellRef = useRef<Map<string, string>>(new Map());

  const runCell = useCallback(
    async (cellId: string, advance: boolean) => {
      const nb = nbRef.current;
      if (!nb) return;
      const idx = nb.cells.findIndex((c) => c.id === cellId);
      if (idx < 0) return;
      const cell = nb.cells[idx];
      if (cell.cell_type !== "code") return;

      console.log("[notebook] run cell", cellId.slice(0, 12), "advance:", advance);
      setKernelError(null);
      try {
        await ensureKernel();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[notebook] kernel start failed:", msg);
        setKernelError(msg);
        // Surface the failure inside the cell too — a toolbar banner alone
        // reads as "nothing happened".
        setLiveOutputs((prev) => ({
          ...prev,
          [cellId]: [
            {
              output_type: "error",
              ename: "KernelError",
              evalue: msg,
              traceback: [`KernelError: ${msg}`],
            },
          ],
        }));
        return;
      }

      const runId = makeCellId();
      runIdToCellRef.current.set(runId, cellId);
      setRunningCellIds((prev) => new Set(prev).add(cellId));
      setLiveOutputs((prev) => ({ ...prev, [cellId]: [] }));
      updateKernelStatus("busy");

      try {
        const result: RunResult = await invoke("kernel_run", {
          kernelId,
          runId,
          code: sourceToString(cell.source),
          timeoutSecs: null,
        });
        console.log(
          "[notebook] run finished:",
          result.status,
          "outputs:",
          result.outputs.length,
          "stdout:",
          JSON.stringify(result.stdout).slice(0, 80)
        );
        setCellOutputs(cellId, toNbformatOutputs(result), result.execCount);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[notebook] kernel_run failed:", msg);
        setKernelError(msg);
        updateKernelStatus("dead");
        setLiveOutputs((prev) => ({
          ...prev,
          [cellId]: [
            {
              output_type: "error",
              ename: "KernelError",
              evalue: msg,
              traceback: [`KernelError: ${msg}`],
            },
          ],
        }));
      } finally {
        runIdToCellRef.current.delete(runId);
        setRunningCellIds((prev) => {
          const next = new Set(prev);
          next.delete(cellId);
          return next;
        });
        // Drop the transient live outputs — but keep a KernelError entry that
        // was written by the catch block (it's the user's only inline signal).
        setLiveOutputs((prev) => {
          const current = prev[cellId];
          if (current?.length === 1 && current[0].output_type === "error" && current[0].ename === "KernelError") {
            return prev; // keep the inline kernel error visible
          }
          const { [cellId]: _drop, ...rest } = prev;
          return rest;
        });
        if (kernelStatusRef.current !== "dead") {
          updateKernelStatus(runIdToCellRef.current.size > 0 ? "busy" : "ready");
        }
      }

      if (advance) {
        const cells = nbRef.current?.cells ?? [];
        const next = cells[idx + 1];
        if (next) {
          if (next.cell_type === "code") {
            editorRegistryRef.current.get(next.id)?.focus();
          } else {
            document
              .getElementById(`nb-cell-${next.id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        } else {
          // Colab behaviour: running the last cell appends a fresh code cell.
          addCell("code", cellId);
        }
      }
    },
    [ensureKernel, kernelId, updateKernelStatus, setCellOutputs, addCell]
  );

  const runAll = useCallback(async () => {
    const nb = nbRef.current;
    if (!nb) return;
    const codeIds = nb.cells.filter((c) => c.cell_type === "code").map((c) => c.id);
    for (const id of codeIds) {
      await runCell(id, false);
    }
  }, [runCell]);

  // --- kernel events -------------------------------------------------------
  useEffect(() => {
    const subscriptions: Array<Promise<() => void>> = [
      listen<KernelStreamEvent>("kernel-output", (event) => {
        const { kernelId: kid, runId, kind, text } = event.payload;
        if (kid !== kernelId) return;
        const cellId = runIdToCellRef.current.get(runId);
        if (!cellId) return;
        setLiveOutputs((prev) => {
          const current = prev[cellId] ?? [];
          const last = current[current.length - 1];
          const name = kind === "stderr" ? "stderr" : "stdout";
          let next: NotebookOutput[];
          if (last && last.output_type === "stream" && last.name === name) {
            next = [
              ...current.slice(0, -1),
              { ...last, text: [...(last.text as string[]), text] },
            ];
          } else {
            next = [...current, { output_type: "stream", name, text: [text] }];
          }
          return { ...prev, [cellId]: next };
        });
      }),
      listen<KernelDiedEvent>("kernel-died", (event) => {
        if (event.payload.kernelId === kernelId && event.payload.pid === pidRef.current) {
          updateKernelStatus("dead");
        }
      }),
    ];
    return () => {
      subscriptions.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [kernelId, updateKernelStatus]);

  // --- environment creation ------------------------------------------------
  const createEnv = useCallback(async () => {
    if (!rootPath || !envName.trim()) return;
    setCreatingEnv(true);
    setKernelError(null);
    try {
      const env: PythonEnv = await invoke("python_create_env", { rootPath, name: envName });
      setEnvCreatorOpen(false);
      setEnvName("");
      await loadEnvs();
      setSelectedEnv(env.pythonPath);
      localStorage.setItem("nolock.notebook.env", env.pythonPath);
    } catch (e) {
      setKernelError(String(e));
    } finally {
      setCreatingEnv(false);
    }
  }, [envName, rootPath, loadEnvs]);

  // --- global Ctrl+S (when focus is outside Monaco) -------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // --- render ---------------------------------------------------------------
  if (!notebook) {
    return (
      <div className="notebook">
        <div className="nb-parse-error">
          <strong>Failed to parse notebook:</strong> {parseError}
        </div>
        <textarea
          className="nb-raw-json"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  const envOptions = envs.map((e) => ({
    value: e.pythonPath,
    label: `${e.name} · ${e.version.replace(/^Python /, "")} · ${e.kind}`,
  }));
  const busy = runningCellIds.size > 0;

  return (
    <div className="notebook">
      <div className="nb-toolbar">
        <span className={`nb-kernel-dot ${kernelStatus}`} title={`Kernel: ${kernelStatus}`} />
        <Select
          value={selectedEnv}
          onChange={(v) => {
            setSelectedEnv(v);
            localStorage.setItem("nolock.notebook.env", v);
          }}
          options={envOptions}
          placeholder="Python environment…"
          style={{ minWidth: 240 }}
        />
        {kernelStatus === "ready" || kernelStatus === "busy" ? (
          <>
            <button
              className="nb-btn"
              onClick={interruptKernel}
              disabled={!busy}
              title="Interrupt execution (SIGINT)"
            >
              ■ Interrupt
            </button>
            <button
              className="nb-btn"
              onClick={restartKernel}
              title="Restart kernel — clears all cell state"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 3a5 5 0 1 0 4.9 6h-1.6A3.5 3.5 0 1 1 8 4.5V7l4-3.5L8 0v3z" />
              </svg>
              Restart
            </button>
          </>
        ) : (
          <button
            className="nb-btn accent"
            onClick={() => ensureKernel().catch((e) => setKernelError(String(e)))}
            title="Start the Python kernel for this notebook"
          >
            Connect
          </button>
        )}
        <span className="nb-toolbar-sep" />
        <button className="nb-btn accent" onClick={runAll} title="Run all code cells">
          <PlayIcon /> Run all
        </button>
        <button className="nb-btn" onClick={() => addCell("code")} title="Add code cell">
          + Code
        </button>
        <button className="nb-btn" onClick={() => addCell("markdown")} title="Add text cell">
          + Text
        </button>
        <button className="nb-btn" onClick={() => onSaveRef.current()} title="Save (Ctrl+S)">
          Save
        </button>
        <span className="nb-toolbar-spacer" />
        {envCreatorOpen ? (
          <span className="nb-env-creator">
            <input
              autoFocus
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createEnv();
                if (e.key === "Escape") setEnvCreatorOpen(false);
              }}
              placeholder="env name"
              spellCheck={false}
            />
            <button className="nb-btn accent" onClick={createEnv} disabled={creatingEnv}>
              {creatingEnv ? "Creating…" : "Create"}
            </button>
            <button className="nb-btn" onClick={() => setEnvCreatorOpen(false)}>
              ✕
            </button>
          </span>
        ) : (
          <button
            className="nb-btn subtle"
            onClick={() => setEnvCreatorOpen(true)}
            title="Create a new virtual environment (.venvs/<name>)"
          >
            + Env
          </button>
        )}
      </div>

      {kernelError && <div className="nb-kernel-error">⚠ {kernelError}</div>}

      <div className="nb-cells">
        {notebook.cells.map((cell) => (
          <CellView
            key={cell.id}
            cell={cell}
            running={runningCellIds.has(cell.id)}
            liveOutputs={liveOutputs[cell.id]}
            onSourceChange={setCellSource}
            onRun={runCell}
            onMove={moveCell}
            onDelete={deleteCell}
            editorRegistry={editorRegistryRef}
            pendingFocusRef={pendingFocusRef}
            onSaveRef={onSaveRef}
          />
        ))}
      </div>
    </div>
  );
}
