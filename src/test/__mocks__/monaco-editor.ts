// ---------------------------------------------------------------------------
// Mock for monaco-editor — used as a Vite resolve.alias during tests.
//
// The real package has no `main` / `exports` (only `module`), which causes
// Vite's static analysis to fail during the transform phase.  This file is
// swapped in at module‑resolution time so tests can load components that
// depend on monaco-editor (e.g. Editor.tsx → App.tsx).
//
// NOTE: Do NOT import from "monaco-editor" here (even for types) — that would
// create a circular resolution that defeats the purpose of the alias.
// ---------------------------------------------------------------------------

// ---- editor ----------------------------------------------------------------

// Track created models so getValueInRange can return actual content
const models = new Map<symbol, { text: string; language: string }>();

export const editor = {
  createModel: (text: string, language?: string) => {
    const id = Symbol("model-id");
    models.set(id, { text: text || "", language: language || "plaintext" });
    return {
      _modelId: id,
      dispose: () => { models.delete(id); },
      onDidChangeContent: () => () => {},
      getValue: () => models.get(id)?.text ?? "",
      getValueInRange: (range: any) => {
        const full = models.get(id)?.text ?? "";
        if (!range) return full;
        const lines = full.split("\n");
        const startLine = range.startLineNumber ?? 1;
        const startCol = range.startColumn ?? 1;
        const endLine = range.endLineNumber ?? startLine;
        const endCol = range.endColumn ?? (lines[startLine - 1]?.length ?? 0) + 1;

        if (startLine === endLine) {
          const line = lines[startLine - 1] ?? "";
          return line.slice(startCol - 1, endCol - 1);
        }

        const parts: string[] = [];
        for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
          if (i === startLine - 1) {
            parts.push(lines[i].slice(startCol - 1));
          } else if (i === endLine - 1) {
            parts.push(lines[i].slice(0, endCol - 1));
          } else {
            parts.push(lines[i]);
          }
        }
        return parts.join("\n");
      },
      getLineCount: () => {
        const t = models.get(id)?.text ?? "";
        return t ? t.split("\n").length : 1;
      },
      getLineMaxColumn: (_lineNumber: number) => {
        const t = models.get(id)?.text ?? "";
        return t ? t.split("\n")[_lineNumber - 1]?.length + 1 || 1 : 1;
      },
    };
  },
  create: () => ({
    dispose: () => {},
    focus: () => {},
    trigger: () => {},
    addCommand: () => {},
    onDidChangeModelContent: () => () => {},
    getModel: () => null,
    getValue: () => "",
    layout: () => {},
  }),
  setTheme: () => {},
  defineTheme: () => {},
};

// ---- languages -------------------------------------------------------------

export const languages = {
  registerInlineCompletionsProvider: () => ({ dispose: () => {} }),
  InlineCompletionTriggerKind: { Automatic: 0 },
};

// ---- Range -----------------------------------------------------------------

export class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

// ---- KeyMod / KeyCode ------------------------------------------------------

export const KeyMod = { CtrlCmd: 1 } as const;
export const KeyCode = { KeyS: 49 } as const;

// ---- Position --------------------------------------------------------------

export class Position {
  constructor(public lineNumber: number, public column: number) {}
}
