// ---------------------------------------------------------------------------
// Tests for macOS keyboard shortcut interception in the Editor component.
//
// On macOS, WKWebView handles Cmd+Z / Cmd+A / Cmd+Y at the NSResponder level
// before keydown events reach JavaScript.  The Editor registers capture-phase
// listeners to intercept these shortcuts and route them to Monaco's own
// undo / redo / selectAll actions instead.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { mockInvoke, mockListen } from "../../test/tauri-mock";

// Save original execCommand so we can restore it
const origExecCommand = document.execCommand;

function mockExecCommand() {
  document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
}

function restoreExecCommand() {
  document.execCommand = origExecCommand;
}

// ---------------------------------------------------------------------------
// We capture the mock editor instance returned by monaco.editor.create so
// we can assert on .trigger() calls.
// ---------------------------------------------------------------------------
let mockEditor: any;

vi.mock("monaco-editor", () => {
  mockEditor = {
    dispose: vi.fn(),
    focus: vi.fn(),
    trigger: vi.fn(),
    addCommand: vi.fn(),
    onDidChangeModelContent: vi.fn(() => vi.fn()),
    getModel: vi.fn(() => ({
      getValue: vi.fn(() => ""),
      dispose: vi.fn(),
      getLineCount: vi.fn(() => 1),
      getLineMaxColumn: vi.fn(() => 1),
    })),
    getValue: vi.fn(() => ""),
    layout: vi.fn(),
    hasTextFocus: vi.fn(() => true),
    hasWidgetFocus: vi.fn(() => true),
  };

  return {
    editor: {
      create: vi.fn(() => mockEditor),
      createModel: vi.fn(() => ({
        dispose: vi.fn(),
        getValue: vi.fn(() => ""),
        onDidChangeContent: vi.fn(() => vi.fn()),
        getValueInRange: vi.fn(() => ""),
        getLineCount: vi.fn(() => 1),
        getLineMaxColumn: vi.fn(() => 1),
      })),
      setModelMarkers: vi.fn(),
      defineTheme: vi.fn(),
    },
    languages: {
      typescript: {
        typescriptDefaults: {
          setDiagnosticsOptions: vi.fn(),
        },
        javascriptDefaults: {
          setDiagnosticsOptions: vi.fn(),
        },
      },
      registerInlineCompletionsProvider: vi.fn(),
      InlineCompletionTriggerKind: { Automatic: 0 },
    },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    KeyCode: {
      KeyS: 49,
      KeyZ: 52,
      KeyY: 53,
      KeyA: 31,
      Period: 52,
    },
    MarkerSeverity: { Error: 1, Warning: 2, Info: 3 },
    Range: class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    Position: class Position {
      constructor(
        public lineNumber: number,
        public column: number,
      ) {}
    },
  };
});

const { default: Editor } = await import("../Editor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the Editor and ensure hasTextFocus is set to the desired value. */
function renderEditor(hasFocus = true) {
  // Always explicitly set hasTextFocus — vi.clearAllMocks() only clears
  // call data, not mockReturnValue, so a prior test's mockReturnValue
  // would leak into subsequent tests.
  mockEditor.hasTextFocus.mockReturnValue(hasFocus);

  const result = render(
    <Editor
      filePath="/test/file.ts"
      content="hello world"
      onChange={vi.fn()}
      onSave={vi.fn()}
    />,
  );

  return result;
}

/** Dispatch a synthetic keydown event and return spies for assertions. */
function dispatchKeydown(
  target: EventTarget,
  props: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  },
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: props.key,
    metaKey: props.metaKey ?? false,
    ctrlKey: props.ctrlKey ?? false,
    shiftKey: props.shiftKey ?? false,
  });
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  Object.defineProperty(event, "preventDefault", { value: preventDefault });
  Object.defineProperty(event, "stopPropagation", { value: stopPropagation });
  target.dispatchEvent(event);
  return { event, preventDefault, stopPropagation };
}

/** Dispatch a synthetic beforeinput event on the given target. */
function dispatchBeforeInput(target: EventTarget, inputType: string) {
  const event = new Event("beforeinput", { bubbles: true, cancelable: true });
  const preventDefault = vi.fn();
  Object.defineProperty(event, "inputType", { value: inputType });
  Object.defineProperty(event, "preventDefault", { value: preventDefault });
  target.dispatchEvent(event);
  return { event, preventDefault };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Editor — macOS keyboard shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  // ---- Cmd+Z (undo) ---------------------------------------------------

  describe("Cmd+Z → undo", () => {
    it("calls editor.trigger('keyboard', 'undo', null) when editor has focus", () => {
      renderEditor();
      const { preventDefault, stopPropagation } = dispatchKeydown(document, {
        key: "z",
        metaKey: true,
      });

      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "undo",
        null,
      );
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("does NOT call trigger when editor lacks focus", () => {
      renderEditor(false);
      dispatchKeydown(document, { key: "z", metaKey: true });

      expect(mockEditor.trigger).not.toHaveBeenCalled();
    });
  });

  // ---- Cmd+Shift+Z (redo) ---------------------------------------------

  describe("Cmd+Shift+Z → redo", () => {
    it("calls editor.trigger('keyboard', 'redo', null)", () => {
      renderEditor();
      const { preventDefault, stopPropagation } = dispatchKeydown(document, {
        key: "Z",
        metaKey: true,
        shiftKey: true,
      });

      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "redo",
        null,
      );
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });
  });

  // ---- Cmd+Y (redo) ---------------------------------------------------

  describe("Cmd+Y → redo", () => {
    it("calls editor.trigger('keyboard', 'redo', null)", () => {
      renderEditor();
      const { preventDefault, stopPropagation } = dispatchKeydown(document, {
        key: "y",
        metaKey: true,
      });

      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "redo",
        null,
      );
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });
  });

  // ---- Cmd+A (selectAll) -----------------------------------------------

  describe("Cmd+A → selectAll", () => {
    it("calls editor.trigger('keyboard', 'selectAll', null) when editor has focus", () => {
      renderEditor();
      const { preventDefault, stopPropagation } = dispatchKeydown(document, {
        key: "a",
        metaKey: true,
      });

      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "editor.action.selectAll",
        null,
      );
      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("does NOT call trigger when editor lacks focus", () => {
      renderEditor(false);
      dispatchKeydown(document, { key: "a", metaKey: true });

      expect(mockEditor.trigger).not.toHaveBeenCalled();
    });
  });

  // ---- Cmd+S (save — prevented but not forwarded to trigger) -----------

  describe("Cmd+S → prevent default (no trigger)", () => {
    it("calls preventDefault but does NOT call trigger", () => {
      renderEditor();
      const { preventDefault } = dispatchKeydown(document, {
        key: "s",
        metaKey: true,
      });

      expect(preventDefault).toHaveBeenCalled();
      // Cmd+S is handled by addCommand, not the capture listener
      expect(mockEditor.trigger).not.toHaveBeenCalled();
    });
  });

  // ---- Ctrl variants (Linux/Windows) -----------------------------------

  describe("Ctrl+Z → NOT intercepted by capture listener", () => {
    it("does NOT call trigger from the capture listener", () => {
      renderEditor();
      dispatchKeydown(document, { key: "z", ctrlKey: true });

      // Ctrl+Z has ctrlKey=true, metaKey=false — the capture guard
      // requires metaKey && !ctrlKey, so this event passes through
      expect(mockEditor.trigger).not.toHaveBeenCalled();
    });
  });

  // ---- beforeinput: native historyUndo / historyRedo -------------------

  describe("beforeinput — native undo/redo prevention", () => {
    it("prevents historyUndo input events", () => {
      const { container } = renderEditor();
      // Dispatch on the component's root div, which has the beforeinput listener
      const target = container.firstElementChild!;
      const { preventDefault } = dispatchBeforeInput(target, "historyUndo");

      expect(preventDefault).toHaveBeenCalled();
    });

    it("prevents historyRedo input events", () => {
      const { container } = renderEditor();
      const target = container.firstElementChild!;
      const { preventDefault } = dispatchBeforeInput(target, "historyRedo");

      expect(preventDefault).toHaveBeenCalled();
    });

    it("does NOT prevent other input types", () => {
      const { container } = renderEditor();
      const target = container.firstElementChild!;
      const { preventDefault } = dispatchBeforeInput(target, "insertText");

      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  // ---- Tauri native event listeners (macOS Rust layer) -----------------

  describe("Tauri native event listeners", () => {
    /** Find the callback registered for a given Tauri event name. */
    function findListener(eventName: string): (...args: any[]) => void {
      const entry = mockListen.mock.calls.find(
        ([name]: [string]) => name === eventName,
      );
      expect(entry).toBeDefined();
      return entry![1] as (...args: any[]) => void;
    }

    beforeEach(() => {
      mockExecCommand();
    });

    afterEach(() => {
      restoreExecCommand();
    });

    it("native-cmd-z triggers editor undo when editor has focus", () => {
      renderEditor();
      const cb = findListener("native-cmd-z");
      mockEditor.trigger.mockClear();
      cb();
      expect(mockEditor.trigger).toHaveBeenCalledWith("keyboard", "undo", null);
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    it("native-cmd-y triggers editor redo when editor has focus", () => {
      renderEditor();
      const cb = findListener("native-cmd-y");
      mockEditor.trigger.mockClear();
      cb();
      expect(mockEditor.trigger).toHaveBeenCalledWith("keyboard", "redo", null);
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    it("native-cmd-shift-z triggers editor redo when editor has focus", () => {
      renderEditor();
      const cb = findListener("native-cmd-shift-z");
      mockEditor.trigger.mockClear();
      cb();
      expect(mockEditor.trigger).toHaveBeenCalledWith("keyboard", "redo", null);
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    it("native-cmd-a triggers editor selectAll when editor has focus", () => {
      renderEditor();
      const cb = findListener("native-cmd-a");
      mockEditor.trigger.mockClear();
      cb();
      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "editor.action.selectAll",
        null,
      );
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    it("does nothing when editor lacks focus", () => {
      renderEditor(false);

      const cbZ = findListener("native-cmd-z");
      mockEditor.trigger.mockClear();
      cbZ();
      expect(mockEditor.trigger).not.toHaveBeenCalled();

      const cbA = findListener("native-cmd-a");
      cbA();
      expect(mockEditor.trigger).not.toHaveBeenCalled();
    });
  });

  // ---- Key case variants -----------------------------------------------

  describe("key case variants", () => {
    it("handles uppercase Z for Cmd+Z", () => {
      renderEditor();
      dispatchKeydown(document, { key: "Z", metaKey: true });
      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "undo",
        null,
      );
    });

    it("handles uppercase A for Cmd+A", () => {
      renderEditor();
      dispatchKeydown(document, { key: "A", metaKey: true });
      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "editor.action.selectAll",
        null,
      );
    });

    it("handles uppercase Y for Cmd+Y", () => {
      renderEditor();
      dispatchKeydown(document, { key: "Y", metaKey: true });
      expect(mockEditor.trigger).toHaveBeenCalledWith(
        "keyboard",
        "redo",
        null,
      );
    });
  });
});
