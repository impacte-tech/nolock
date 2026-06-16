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

export const editor = {
  createModel: () => ({
    dispose: () => {},
    onDidChangeContent: () => () => {},
    getValue: () => "",
    getValueInRange: () => "",
    getLineCount: () => 1,
    getLineMaxColumn: () => 1,
  }),
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
