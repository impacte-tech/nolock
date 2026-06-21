import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { getSecret } from "../lib/secrets";

// Configure Monaco workers
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") {
      return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
    }
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
    }
    return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
  },
};

interface Props {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", html: "html", css: "css",
    json: "json", md: "markdown", yaml: "yaml", yml: "yaml",
    toml: "toml", sh: "shell", bash: "shell", dockerfile: "dockerfile",
  };
  return map[ext] || "plaintext";
}

// ---------------------------------------------------------------------------
// FITM Inline Completion Provider with gate-based debounce
//
// How it works:
//   - Every keystroke sets _ready = false (gate closed) and starts a timer
//   - After DEBOUNCE_MS of silence, timer fires → _ready = true (gate opens)
//   - Monaco calls provideInlineCompletions on many events (typing, cursor
//     moves, scroll, etc.) — but we only proceed when the gate is open.
//   - After one successful request the gate closes again until next pause.
//
// This guarantees exactly ONE request per typing pause, no matter how often
// Monaco calls us.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;

class AiInlineCompletionProvider implements monaco.languages.InlineCompletionsProvider {
  private _requestCounter = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _editor: monaco.editor.IStandaloneCodeEditor | null = null;

  // Gate: only allow one request per debounce window
  private _ready = false;

  setEditor(editor: monaco.editor.IStandaloneCodeEditor) {
    this._editor = editor;
  }

  dispose() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Called on every content change — closes the gate and restarts the timer */
  onContentChange() {
    // Close the gate immediately
    this._ready = false;

    // Reset timer
    if (this._timer) {
      clearTimeout(this._timer);
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      this._ready = true;

      // Ask Monaco to re-evaluate inline suggestions now that gate is open
      this._editor?.trigger("ai", "editor.action.inlineSuggest.trigger", null);
    }, DEBOUNCE_MS);
  }

  async provideInlineCompletions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    _context: monaco.languages.InlineCompletionContext,
    token: monaco.CancellationToken
  ): Promise<monaco.languages.InlineCompletions> {
    // Gate check — if not ready, skip immediately (no API call)
    if (!this._ready) {
      return { items: [] };
    }

    // Consume the gate so we don't fire again until next pause
    this._ready = false;

    // --- Build prefix (code before cursor, last 4000 chars) ---
    const fullPrefix = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });

    if (fullPrefix.trim().length < 5) {
      return { items: [] };
    }

    const prefix = fullPrefix.length > 4000 ? fullPrefix.slice(-4000) : fullPrefix;

    // --- Build suffix (next 20 lines after cursor for FITM) ---
    const totalLines = model.getLineCount();
    const suffixEndLine = Math.min(position.lineNumber + 20, totalLines);
    const suffix = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: suffixEndLine,
      endColumn: model.getLineMaxColumn(suffixEndLine),
    });

    const requestId = ++this._requestCounter;

    try {
      const backend = localStorage.getItem("nolock.backend") || "ollama";
      const url = localStorage.getItem("nolock.url") || "http://localhost:11434";
      const completionModel = localStorage.getItem("nolock.completionModel") || "";
      const apiKey = (await getSecret("apiKey")) ?? localStorage.getItem("nolock.apiKey") ?? "";

      if (!completionModel) {
        return { items: [] };
      }

      const text: string = await invoke("ai_complete", {
        req: {
          backend,
          url,
          model: completionModel,
          prompt: prefix,
          suffix: suffix || null,
          apiKey: apiKey || null,
        },
      });

      // Discard stale responses
      if (token.isCancellationRequested || requestId !== this._requestCounter) {
        return { items: [] };
      }

      if (!text) return { items: [] };

      const cleaned = text.trimStart();
      if (!cleaned) return { items: [] };

      return {
        items: [
          {
            insertText: cleaned,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          },
        ],
      };
    } catch {
      return { items: [] };
    }
  }

  freeInlineCompletions(): void {}
}

export default function Editor({ filePath, content, onChange, onSave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Use a ref so the Ctrl+S command always calls the latest onSave (avoids stale closure)
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!containerRef.current) return;

    // Disable all TypeScript/JavaScript diagnostics — Monaco ships with full
    // semantic validation, syntax validation, and suggestion diagnostics (e.g.
    // unreachable code detection) enabled by default, which surfaces lint-style
    // errors for any untyped JS/TS code. nolock intentionally omits this layer
    // so that developers can add their own linting setup (ESLint, TypeScript
    // strict mode, etc.) without interference from the editor's built-in checker.
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });

    const model = monaco.editor.createModel(content, getLanguage(filePath));
    const editor = monaco.editor.create(containerRef.current, {
      model,
      theme: "vs-dark",
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      lineNumbers: "on",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      automaticLayout: true,
      inlineSuggest: { enabled: true },
      wordWrap: "on",
    });

    editorRef.current = editor;

    // Register debounced AI completion provider
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);
    monaco.languages.registerInlineCompletionsProvider("*", provider);

    // Content changes → debounce gate
    model.onDidChangeContent(() => {
      provider.onContentChange();
      onChange(model.getValue());
    });

    // Ctrl+S to save — read from ref to avoid stale closure.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      try {
        onSaveRef.current();
      } catch (err) {
        console.error("[Editor] Save handler threw synchronously:", err);
      }
    });

    // ---- Defensive: prevent native Ctrl+S in the webview -----------------
    //
    // PROBLEM: In some Tauri v2 environments (in particular Linux/GTK), the
    // webview's native "Save Page" Ctrl+S handler can cause the app window
    // to close when it intercepts the keystroke.  Monaco *should* call
    // preventDefault() when it matches a keybinding, but this doesn't always
    // work reliably in every webview configuration.
    //
    // SOLUTION: Register a capture‑phase keydown listener on the document
    // that calls preventDefault() for Ctrl+S / Cmd+S before the event ever
    // reaches the browser's default handling.  We do NOT stop propagation,
    // so Monaco's own handler still fires normally.
    //
    const preventNativeSave = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        // Intercept before any browser/webview native save handling
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", preventNativeSave, true);

    editor.focus();

    return () => {
      provider.dispose();
      editor.dispose();
      model.dispose();
      document.removeEventListener("keydown", preventNativeSave, true);
    };
  }, [filePath]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
