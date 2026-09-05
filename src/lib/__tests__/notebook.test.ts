import { describe, expect, it } from "vitest";
import {
  createCodeCell,
  createEmptyNotebook,
  isNotebookFile,
  makeCellId,
  parseNotebook,
  serializeNotebook,
  sourceToString,
  stringToSource,
} from "../notebook";

describe("stringToSource", () => {
  it("splits lines keeping trailing newlines", () => {
    expect(stringToSource("a\nb")).toEqual(["a\n", "b"]);
  });

  it("keeps a single trailing newline as its own line", () => {
    expect(stringToSource("a\n")).toEqual(["a\n"]);
  });

  it("returns [''] for empty strings (nbformat never stores empty arrays)", () => {
    expect(stringToSource("")).toEqual([""]);
  });

  it("handles multi-line sources", () => {
    expect(stringToSource("x = 1\ny = 2\nz = 3")).toEqual([
      "x = 1\n",
      "y = 2\n",
      "z = 3",
    ]);
  });
});

describe("sourceToString", () => {
  it("joins array sources without adding newlines", () => {
    expect(sourceToString(["a\n", "b"])).toBe("a\nb");
  });

  it("passes strings through", () => {
    expect(sourceToString("print(1)")).toBe("print(1)");
  });

  it("returns empty string for unknown shapes", () => {
    expect(sourceToString(null)).toBe("");
    expect(sourceToString(42)).toBe("");
  });
});

describe("parseNotebook", () => {
  it("parses a valid notebook with array sources", () => {
    const json = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 3,
          id: "abc123",
          metadata: {},
          outputs: [
            { output_type: "stream", name: "stdout", text: ["hi\n"] },
          ],
          source: ["x = 1\n", "x"],
        },
      ],
      metadata: { kernelspec: { name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5,
    });
    const { notebook, error, normalized } = parseNotebook(json);
    expect(error).toBeNull();
    expect(normalized).toBe(false);
    expect(notebook).not.toBeNull();
    expect(notebook!.nbformat).toBe(4);
    expect(notebook!.cells).toHaveLength(1);
    const cell = notebook!.cells[0];
    expect(cell.cell_type).toBe("code");
    expect(cell.id).toBe("abc123");
    if (cell.cell_type === "code") {
      expect(cell.outputs).toHaveLength(1);
      expect(cell.execution_count).toBe(3);
    }
    expect(sourceToString(cell.source)).toBe("x = 1\nx");
  });

  it("normalizes string sources into arrays", () => {
    const json = JSON.stringify({
      cells: [{ cell_type: "markdown", metadata: {}, source: "# Title\nbody" }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 4,
    });
    const { notebook, normalized } = parseNotebook(json);
    expect(normalized).toBe(true);
    expect(notebook!.cells[0].source).toEqual(["# Title\n", "body"]);
  });

  it("assigns ids to legacy cells without ids", () => {
    const json = JSON.stringify({
      cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["1"] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 0,
    });
    const { notebook, normalized } = parseNotebook(json);
    expect(normalized).toBe(true);
    expect(notebook!.cells[0].id).toBeTruthy();
  });

  it("reports errors for invalid JSON", () => {
    const { notebook, error } = parseNotebook("{not json");
    expect(notebook).toBeNull();
    expect(error).toBeTruthy();
  });

  it("reports errors for non-notebook JSON", () => {
    const { notebook, error } = parseNotebook('{"foo": 1}');
    expect(notebook).toBeNull();
    expect(error).toContain("cells");
  });

  it("opens empty files as a fresh notebook (normalized for persistence)", () => {
    for (const content of ["", "   ", "\n\n", "\uFEFF"]) {
      const { notebook, error, normalized } = parseNotebook(content);
      expect(error).toBeNull();
      expect(normalized).toBe(true);
      expect(notebook!.nbformat).toBe(4);
      expect(notebook!.cells).toHaveLength(1);
      expect(notebook!.cells[0].cell_type).toBe("code");
    }
  });

  it("strips a leading BOM before parsing", () => {
    const inner = JSON.stringify({
      cells: [
        { cell_type: "code", id: "bomcell", execution_count: null, metadata: {}, outputs: [], source: ["1"] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    const { notebook, error, normalized } = parseNotebook("\uFEFF" + inner);
    expect(error).toBeNull();
    expect(normalized).toBe(false);
    expect(notebook!.cells).toHaveLength(1);
  });

  it("defaults missing metadata and nbformat fields", () => {
    const json = JSON.stringify({ cells: [] });
    const { notebook, normalized } = parseNotebook(json);
    expect(normalized).toBe(true);
    expect(notebook!.nbformat).toBe(4);
    expect(notebook!.metadata).toEqual({});
  });
});

describe("serializeNotebook", () => {
  it("round-trips through parse", () => {
    const nb = createEmptyNotebook();
    nb.cells.push({
      ...createCodeCell("print('hello')"),
      execution_count: 7,
      outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n"] }],
    });
    const serialized = serializeNotebook(nb);
    const { notebook, error, normalized } = parseNotebook(serialized);
    expect(error).toBeNull();
    expect(normalized).toBe(false);
    expect(notebook!.cells).toHaveLength(2);
    expect(sourceToString(notebook!.cells[1].source)).toBe("print('hello')");
    expect(serializeNotebook(notebook!)).toBe(serialized);
  });

  it("ends with a trailing newline and 1-space indent", () => {
    const out = serializeNotebook(createEmptyNotebook());
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n "cells": [');
  });
});

describe("factories", () => {
  it("creates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeCellId()));
    expect(ids.size).toBe(50);
  });

  it("creates empty code cells", () => {
    const cell = createCodeCell();
    expect(cell.cell_type).toBe("code");
    expect(cell.source).toEqual([""]);
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
  });

  it("creates empty notebooks with one code cell", () => {
    const nb = createEmptyNotebook();
    expect(nb.nbformat).toBe(4);
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0].cell_type).toBe("code");
  });
});

describe("isNotebookFile", () => {
  it("detects .ipynb files case-insensitively", () => {
    expect(isNotebookFile("/a/b/analysis.ipynb")).toBe(true);
    expect(isNotebookFile("NOTEBOOK.IPYNB")).toBe(true);
  });

  it("rejects other files", () => {
    expect(isNotebookFile("main.py")).toBe(false);
    expect(isNotebookFile("notebook.json")).toBe(false);
    expect(isNotebookFile("ipynb")).toBe(false);
  });
});
