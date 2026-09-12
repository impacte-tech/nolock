// ---------------------------------------------------------------------------
// Notebook component tests — mocked Monaco + Tauri IPC.
//
// Verifies the full run → output render chain:
//   click run → kernel_start → kernel_run → outputs written → rendered.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, createEvent, act } from "@testing-library/react";
import { mockInvoke, mockListen, setupLocalStorageMocks } from "../../test/tauri-mock";

// ---- Monaco mock -----------------------------------------------------------
// Shared registry of created editors so tests can simulate typing.
const monacoState = vi.hoisted(() => ({
  editors: [] as Array<Record<string, any>>,
  registrations: [] as Array<{ provider: any; dispose: any }>,
}));

vi.mock("monaco-editor", () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn(() => {
      const state = { text: "" };
      const contentListeners: Array<() => void> = [];
      const editor = {
        getValue: vi.fn(() => state.text),
        setValue: vi.fn((v: string) => {
          state.text = v;
        }),
        onDidChangeModelContent: vi.fn((cb: () => void) => {
          contentListeners.push(cb);
          return { dispose: vi.fn() };
        }),
        onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
        addCommand: vi.fn(),
        focus: vi.fn(),
        dispose: vi.fn(),
        getModel: vi.fn(() => null),
        hasTextFocus: vi.fn(() => false),
        trigger: vi.fn(),
        /** Simulate the user typing: update the model text, fire content change. */
        _type: (text: string) => {
          state.text = text;
          contentListeners.forEach((cb) => cb());
        },
      };
      monacoState.editors.push(editor);
      return editor;
    }),
  },
  languages: {
    registerInlineCompletionsProvider: vi.fn((_language, provider) => {
      const registration = { provider, dispose: vi.fn() };
      monacoState.registrations.push(registration);
      return registration;
    }),
  },
  KeyMod: { CtrlCmd: 256, Shift: 512 },
  KeyCode: { Enter: 3, KeyS: 4, Period: 5 },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
}));

import Notebook from "../Notebook";

const NOTEBOOK_JSON = JSON.stringify({
  cells: [
    {
      id: "cell-title",
      cell_type: "markdown",
      metadata: {},
      source: ["# HW 1 — Polynomial functions"],
    },
    {
      id: "cell-abc",
      cell_type: "code",
      metadata: {},
      outputs: [],
      execution_count: null,
      source: ["print('hello from kernel')"],
    },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

const ENV = {
  name: "test-venv",
  pythonPath: "/usr/bin/python3",
  kind: "system",
  version: "Python 3.11.4",
};

describe("Notebook — cell reordering", () => {
  async function setup() {
    setupLocalStorageMocks();
    setupInvokeMocks({ status: "ok" });
    monacoState.editors.length = 0;
    const original = JSON.parse(NOTEBOOK_JSON);
    original.cells[1].metadata = { tags: ["hide"], custom: "preserved" };
    original.cells[1].execution_count = 7;
    original.cells[1].outputs = [{ output_type: "stream", name: "stdout", text: ["saved output"] }];
    original.cells.push({ id: "cell-raw", cell_type: "raw", metadata: {}, source: ["Raw notes"] });
    let content = JSON.stringify(original);
    const onChange = vi.fn((next: string) => { content = next; });
    const props = { filePath: "/tmp/reorder.ipynb", onChange, onSave: vi.fn(), rootPath: "/tmp" };
    const view = render(<Notebook {...props} content={content} />);
    await act(async () => {});
    const sync = () => view.rerender(<Notebook {...props} content={content} />);
    const row = (id: string) => view.container.querySelector(`[data-cell-id="${id}"]`)!;
    const order = () => Array.from(view.container.querySelectorAll(".nb-cell-row"), (el) => el.getAttribute("data-cell-id"));
    const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    const drag = (id: string) => fireEvent.dragStart(row(id).querySelector(".nb-drag-handle")!, { dataTransfer: transfer });
    const dropEvent = (type: "dragOver" | "drop", id: string, before: boolean) => {
      const event = createEvent[type](row(id), { dataTransfer: transfer });
      // jsdom has no layout or DragEvent coordinates. The row midpoint is zero.
      Object.defineProperty(event, "clientY", { value: before ? -1 : 1 });
      fireEvent(row(id), event);
    };
    return { ...view, original, onChange, sync, row, order, drag, dropEvent, saved: () => JSON.parse(content) };
  }

  it("moves cells in both directions with buttons and disables notebook boundaries", async () => {
    const t = await setup();
    expect(t.row("cell-title").querySelector('[title="Move cell up"]')).toBeDisabled();
    expect(t.row("cell-raw").querySelector('[title="Move cell down"]')).toBeDisabled();
    fireEvent.click(t.row("cell-abc").querySelector('[title="Move cell up"]')!);
    t.sync();
    expect(t.order()).toEqual(["cell-abc", "cell-title", "cell-raw"]);
    fireEvent.click(t.row("cell-abc").querySelector('[title="Move cell down"]')!);
    t.sync();
    expect(t.saved()).toEqual(t.original);
  });

  it("drags across mixed cell types, preserves edits and outputs, and keeps editors mounted", async () => {
    const t = await setup();
    const editor = monacoState.editors[0];
    act(() => editor._type("print('edited')"));
    t.sync();
    t.drag("cell-abc");
    t.dropEvent("dragOver", "cell-raw", false);
    expect(t.row("cell-raw")).toHaveClass("nb-drop-after");
    t.dropEvent("drop", "cell-raw", false);
    t.sync();
    expect(t.order()).toEqual(["cell-title", "cell-raw", "cell-abc"]);
    expect(t.saved().cells[2]).toEqual({ ...t.original.cells[1], source: ["print('edited')"] });
    expect(t.container.querySelector(".nb-drop-after")).toBeNull();
    t.drag("cell-abc");
    t.dropEvent("dragOver", "cell-title", true);
    expect(t.row("cell-title")).toHaveClass("nb-drop-before");
    t.dropEvent("drop", "cell-title", true);
    t.sync();
    expect(t.order()).toEqual(["cell-abc", "cell-title", "cell-raw"]);
    expect(monacoState.editors).toHaveLength(1);
    expect(editor.dispose).not.toHaveBeenCalled();
    expect(t.saved().metadata).toEqual(t.original.metadata);
  });

  it("ignores external, self, unchanged and cancelled drops", async () => {
    const t = await setup();
    t.onChange.mockClear();
    t.dropEvent("drop", "cell-raw", false);
    t.drag("cell-title");
    t.dropEvent("drop", "cell-title", false);
    t.drag("cell-title");
    t.dropEvent("drop", "cell-abc", true);
    t.drag("cell-title");
    t.dropEvent("dragOver", "cell-raw", false);
    fireEvent.dragEnd(t.row("cell-title").querySelector(".nb-drag-handle")!);
    expect(t.container.querySelector(".nb-drop-after")).toBeNull();
    t.dropEvent("drop", "cell-raw", false);
    expect(t.onChange).not.toHaveBeenCalled();
  });
});

function setupInvokeMocks(runResult: Record<string, unknown>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "python_list_envs":
        return [ENV];
      case "kernel_start":
        return { pid: 4242, pythonVersion: "3.11.4" };
      case "kernel_run":
        return runResult;
      case "kernel_stop":
      case "kernel_interrupt":
        return null;
      default:
        throw new Error(`unexpected invoke: ${cmd}`);
    }
  });
}

describe("Notebook — run flow shows outputs", () => {
  beforeEach(() => {
    monacoState.editors.length = 0;
  });

  it("propagates typed code from the editor into the kernel run", async () => {
    setupLocalStorageMocks();
    setupInvokeMocks({
      status: "ok",
      execCount: 1,
      stdout: "typed ran\n",
      stderr: "",
      outputs: [],
      error: null,
      elapsedMs: 1,
    });

    const { container } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={NOTEBOOK_JSON}
        onChange={vi.fn()}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    // Simulate the user typing into the cell editor
    expect(monacoState.editors.length).toBeGreaterThan(0);
    const cellEditor = monacoState.editors[monacoState.editors.length - 1];
    cellEditor._type("print('typed code')");

    fireEvent.click(container.querySelectorAll(".nb-run-btn")[0]);

    // The kernel must receive the TYPED code, not the original source
    await waitFor(() => {
      const runCalls = mockInvoke.mock.calls.filter((c: any[]) => c[0] === "kernel_run");
      expect(runCalls.length).toBeGreaterThan(0);
      const last = runCalls[runCalls.length - 1];
      expect(last[1]).toMatchObject({ code: "print('typed code')" });
    });
  });

  it("renders kernel stdout + result after running a cell", async () => {
    setupLocalStorageMocks();
    setupInvokeMocks({
      status: "ok",
      execCount: 1,
      stdout: "hello from kernel\n",
      stderr: "",
      outputs: [{ kind: "result", mime: "text/plain", data: "42" }],
      error: null,
      elapsedMs: 5,
    });

    // Simulate the real App round-trip: onChange updates the content prop.
    let content = NOTEBOOK_JSON;
    const onChange = vi.fn((next: string) => {
      content = next;
    });
    const { container, rerender } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );
    const rerenderWithCurrent = () =>
      rerender(
        <Notebook
          filePath="/tmp/proj/test.ipynb"
          content={content}
          onChange={onChange}
          onSave={vi.fn()}
          rootPath="/tmp/proj"
        />,
      );

    // Wait for envs to load and the run button to be enabled
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", { rootPath: "/tmp/proj" });
    });

    // Click the cell's run button (gutter play button)
    const runButtons = container.querySelectorAll(".nb-run-btn");
    expect(runButtons.length).toBeGreaterThan(0);
    fireEvent.click(runButtons[0]);

    // kernel_start then kernel_run must have been invoked
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "kernel_run",
        expect.objectContaining({
          kernelId: "nb:/tmp/proj/test.ipynb",
          code: "print('hello from kernel')",
        }),
      );
    });

    // Simulate the App re-render with the updated content (real App behaviour)
    rerenderWithCurrent();

    // The output must appear in the DOM
    await waitFor(() => {
      expect(screen.getByText(/hello from kernel/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    // Outputs must be persisted through onChange with nbformat shapes
    const lastChange = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    const parsed = JSON.parse(lastChange);
    const cell = parsed.cells.find((c: any) => c.id === "cell-abc");
    expect(cell.execution_count).toBe(1);
    const stream = cell.outputs.find((o: any) => o.output_type === "stream");
    expect(stream).toBeTruthy();
    expect(stream.name).toBe("stdout");
    const result = cell.outputs.find((o: any) => o.output_type === "execute_result");
    expect(result).toBeTruthy();
    expect(result.data["text/plain"]).toBe("42");
  });

  it("renders error outputs when the cell fails", async () => {
    setupLocalStorageMocks();
    setupInvokeMocks({
      status: "error",
      execCount: 1,
      stdout: "",
      stderr: "",
      outputs: [],
      error: {
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: ["Traceback (most recent call last):", "ZeroDivisionError: division by zero"],
      },
      elapsedMs: 3,
    });

    let content = NOTEBOOK_JSON;
    const onChange = vi.fn((next: string) => {
      content = next;
    });
    const { container, rerender } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    fireEvent.click(container.querySelectorAll(".nb-run-btn")[0]);

    // Simulate the App re-render with updated content
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    rerender(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      const err = container.querySelector(".nb-out-error");
      expect(err).toBeTruthy();
      expect(err!.textContent).toContain("ZeroDivisionError");
    });
  });

  it("shows live streamed stdout while the cell is running", async () => {    setupLocalStorageMocks();
    // kernel_run that never resolves — outputs must still stream via events
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "python_list_envs") return [ENV];
      if (cmd === "kernel_start") return { pid: 1, pythonVersion: "3" };
      if (cmd === "kernel_run") return new Promise(() => {}); // hang
      return null;
    });

    // Capture the kernel-output handler so we can emit stream events
    let streamHandler: ((e: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(async (event: string, handler: any) => {
      if (event === "kernel-output") streamHandler = handler;
      return vi.fn();
    });

    const { container } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={NOTEBOOK_JSON}
        onChange={vi.fn()}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    fireEvent.click(container.querySelectorAll(".nb-run-btn")[0]);

    // Wait until kernel_run is in flight, then emit a stream event
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("kernel_run", expect.anything());
    });
    await waitFor(() => expect(streamHandler).not.toBeNull());

    // Find the runId → cellId mapping by emitting with the runId the component used
    // The component registers runId before invoking; emit a chunk for any runId
    // registered — we read it from the invoke args.
    // mockInvoke accumulates calls across tests in this file — take the LAST
    // kernel_run call (this test's), not the first.
    const runCalls = mockInvoke.mock.calls.filter((c: any[]) => c[0] === "kernel_run");
    const runId = (runCalls[runCalls.length - 1][1] as any).runId;
    streamHandler!({
      payload: {
        kernelId: "nb:/tmp/proj/test.ipynb",
        runId,
        kind: "stdout",
        text: "live chunk\n",
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/live chunk/)).toBeInTheDocument();
    });
  });

  it("shows a kernel failure inline in the cell (not only the toolbar banner)", async () => {
    setupLocalStorageMocks();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "python_list_envs") return [ENV];
      if (cmd === "kernel_start") {
        return Promise.reject(new Error("Failed to spawn Python kernel (/usr/bin/python3): no such file"));
      }
      if (cmd === "kernel_run") return new Promise(() => {});
      return null;
    });

    const { container } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={NOTEBOOK_JSON}
        onChange={vi.fn()}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    fireEvent.click(container.querySelectorAll(".nb-run-btn")[0]);

    // The failure must be visible inside the cell as an error output
    await waitFor(() => {
      const err = container.querySelector(".nb-out-error");
      expect(err).toBeTruthy();
      expect(err!.textContent).toContain("KernelError");
      expect(err!.textContent).toContain("Failed to spawn Python kernel");
    });
  });

  it("typesets text/latex outputs via KaTeX and persists a single mimebundle", async () => {
    setupLocalStorageMocks();
    setupInvokeMocks({
      status: "ok",
      execCount: 2,
      stdout: "",
      stderr: "",
      outputs: [
        { kind: "result", mime: "text/latex", data: "$$x^{2} + 2 x$$" },
        { kind: "result", mime: "text/plain", data: "x**2 + 2*x" },
      ],
      error: null,
      elapsedMs: 2,
    });

    let content = NOTEBOOK_JSON;
    const onChange = vi.fn((next: string) => {
      content = next;
    });
    const { container, rerender } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });
    fireEvent.click(container.querySelectorAll(".nb-run-btn")[0]);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    rerender(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    // KaTeX typeset markup renders inline
    await waitFor(() => {
      const latex = container.querySelector(".nb-out-latex");
      expect(latex).toBeTruthy();
      expect(latex!.querySelector(".katex")).toBeTruthy();
    });

    // Persisted as ONE execute_result with a combined mimebundle (Colab shape)
    const parsed = JSON.parse(content);
    const cell = parsed.cells.find((c: any) => c.id === "cell-abc");
    expect(cell.outputs).toHaveLength(1);
    expect(cell.outputs[0].output_type).toBe("execute_result");
    expect(cell.outputs[0].data["text/latex"]).toBe("$$x^{2} + 2 x$$");
    expect(cell.outputs[0].data["text/plain"]).toBe("x**2 + 2*x");
  });

  it("exports a self-contained printable HTML next to the notebook and opens it", async () => {
    setupLocalStorageMocks();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "python_list_envs") return [ENV];
      return null;
    });

    const { container } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={NOTEBOOK_JSON}
        onChange={vi.fn()}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    const exportBtn = container.querySelector(
      'button[title*="Export as a self-contained"]',
    ) as HTMLButtonElement | null;
    expect(exportBtn).toBeTruthy();
    fireEvent.click(exportBtn!);

    await waitFor(() => {
      const wf = mockInvoke.mock.calls.find((c: any[]) => c[0] === "write_file");
      expect(wf).toBeTruthy();
      const args = wf![1] as { path: string; content: string };
      expect(args.path).toBe("/tmp/proj/test.html");
      expect(args.content).toContain("<!DOCTYPE html>");
      // KaTeX is inlined so the file renders math offline. (Font data URIs
      // are asserted at lib level — vitest's css:false empties ?raw CSS
      // imports in the component test environment.)
      expect(args.content).toContain(".katex");
      // Document title comes from the notebook's first markdown heading,
      // never from the file name
      expect(args.content).toContain("<title>HW 1 — Polynomial functions</title>");
      expect(args.content).not.toContain("test.ipynb");
      expect(args.content).not.toContain("nb-title");
      // Code cell with prompt + source, escaped
      expect(args.content).toContain("In [ ]:");
      expect(args.content).toContain("print('hello from kernel')");
    });
    // The export must open the file via the open_path command (the shell
    // plugin's `open` rejects bare filesystem paths).
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("open_path", { path: "/tmp/proj/test.html" });
    });
  });

  it("excludes cells tagged hide from the exported HTML", async () => {
    setupLocalStorageMocks();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "python_list_envs") return [ENV];
      return null;
    });

    const hiddenNotebook = JSON.stringify({
      cells: [
        {
          id: "cell-helper",
          cell_type: "code",
          metadata: { tags: ["hide"] },
          outputs: [],
          execution_count: 1,
          source: ["SECRET_HELPER = 'never print me'"],
        },
        {
          id: "cell-answer",
          cell_type: "markdown",
          metadata: {},
          source: ["# The visible answer"],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });

    const { container } = render(
      <Notebook
        filePath="/tmp/proj/test.ipynb"
        content={hiddenNotebook}
        onChange={vi.fn()}
        onSave={vi.fn()}
        rootPath="/tmp/proj"
      />,
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("python_list_envs", expect.anything());
    });

    // The hidden cell is dimmed in the UI
    expect(container.querySelector(".nb-cell.nb-hidden")).toBeTruthy();

    const exportBtn = container.querySelector(
      'button[title*="Export as a self-contained"]',
    ) as HTMLButtonElement | null;
    expect(exportBtn).toBeTruthy();
    fireEvent.click(exportBtn!);

    // mockInvoke accumulates calls across tests — take the LAST write_file.
    await waitFor(() => {
      const wfCalls = mockInvoke.mock.calls.filter((c: any[]) => c[0] === "write_file");
      expect(wfCalls.length).toBeGreaterThan(0);
      const args = wfCalls[wfCalls.length - 1][1] as { path: string; content: string };
      expect(args.content).toContain("The visible answer");
      expect(args.content).not.toContain("SECRET_HELPER");
    });
  });
});


it("wires code cells to debounced FIM and Ctrl+. and disposes registrations", () => {
  setupLocalStorageMocks();
  setupInvokeMocks({ status: "ok" });
  monacoState.editors.length = 0;
  monacoState.registrations.length = 0;
  vi.useFakeTimers();
  try {
    const { unmount } = render(<Notebook filePath="/tmp/test.ipynb" content={NOTEBOOK_JSON}
      onChange={vi.fn()} onSave={vi.fn()} rootPath="/tmp" />);
    // The markdown cell has no FIM registration.
    expect(monacoState.registrations).toHaveLength(1);
    const editor = monacoState.editors[0];
    editor._type("result = ");
    vi.advanceTimersByTime(499);
    expect(editor.trigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(editor.trigger).toHaveBeenCalledWith("ai", "editor.action.inlineSuggest.trigger", null);
    const shortcut = editor.addCommand.mock.calls.find(([key]: [number]) => key === (256 | 5));
    expect(shortcut).toBeDefined();
    shortcut[1]();
    expect(editor.trigger).toHaveBeenCalledTimes(2);
    editor._type("result = sum(");
    unmount();
    expect(monacoState.registrations[0].dispose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    expect(editor.trigger).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
