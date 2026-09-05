// ---------------------------------------------------------------------------
// notebook — nbformat (.ipynb) types, parsing and serialization
//
// The raw JSON string is the source of truth in App state (OpenFile.content).
// This module parses it into typed cells, normalizes legacy shapes (string
// sources, missing cell ids, missing outputs) and serializes back to
// nbformat-compatible JSON (1-space indent, like Jupyter).
// ---------------------------------------------------------------------------

export interface NotebookMetadata {
  [key: string]: unknown;
}

export interface NotebookOutput {
  output_type: string;
  [key: string]: unknown;
}

export interface BaseCell {
  id: string;
  metadata: Record<string, unknown>;
}

export interface CodeCell extends BaseCell {
  cell_type: "code";
  source: string[];
  outputs: NotebookOutput[];
  execution_count: number | null;
}

export interface MarkdownCell extends BaseCell {
  cell_type: "markdown";
  source: string[];
}

export interface RawCell extends BaseCell {
  cell_type: "raw";
  source: string[];
}

export type NotebookCell = CodeCell | MarkdownCell | RawCell;

export interface NotebookJson {
  cells: NotebookCell[];
  metadata: NotebookMetadata;
  nbformat: number;
  nbformat_minor: number;
}

export interface ParseResult {
  notebook: NotebookJson | null;
  error: string | null;
  /** True when the parser had to add ids / normalize shapes. */
  normalized: boolean;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** nbformat cell ids: 1-64 chars of [a-zA-Z0-9-_]. */
export function makeCellId(): string {
  return (
    "cell-" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

// ---------------------------------------------------------------------------
// Source helpers — nbformat stores source as string | string[] (lines with \n)
// ---------------------------------------------------------------------------

export function sourceToString(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((l) => String(l)).join("");
  return "";
}

/**
 * Split a string into nbformat source lines, keeping the trailing "\n" on
 * every line except the last. "" → [""] (nbformat never stores empty arrays).
 */
export function stringToSource(s: string): string[] {
  if (s === "") return [""];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      lines.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

function normalizeSource(raw: unknown): string[] {
  if (typeof raw === "string") return stringToSource(raw);
  if (Array.isArray(raw)) return raw.map((l) => String(l));
  return [""];
}

export function parseNotebook(content: string): ParseResult {
  // Strip a UTF-8 BOM if present (some editors write one).
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  // Empty (or whitespace-only) files — e.g. freshly created via the file
  // explorer or `touch` — open as a brand-new empty notebook. `normalized`
  // is true so the skeleton gets persisted into the file on open.
  if (content.trim() === "") {
    return { notebook: createEmptyNotebook(), error: null, normalized: true };
  }
  try {
    const parsed = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray(parsed.cells)
    ) {
      return {
        notebook: null,
        error: "Not a notebook — missing a top-level `cells` array.",
        normalized: false,
      };
    }

    let normalized = false;

    const cells: NotebookCell[] = parsed.cells.map((raw: Record<string, unknown>) => {
      const cellType = raw.cell_type;
      let id = typeof raw.id === "string" && raw.id ? raw.id : "";
      if (!id) {
        id = makeCellId();
        normalized = true;
      }
      const metadata =
        typeof raw.metadata === "object" && raw.metadata !== null
          ? (raw.metadata as Record<string, unknown>)
          : ((normalized = true), {});

      if (cellType === "code") {
        const outputs = Array.isArray(raw.outputs)
          ? (raw.outputs as NotebookOutput[])
          : ((normalized = true), []);
        const executionCount =
          typeof raw.execution_count === "number" ? raw.execution_count : null;
        return {
          id,
          cell_type: "code",
          source: normalizeSource(raw.source),
          outputs,
          execution_count: executionCount,
          metadata,
        } satisfies CodeCell;
      }
      if (cellType === "markdown" || cellType === "raw") {
        return {
          id,
          cell_type: cellType,
          source: normalizeSource(raw.source),
          metadata,
        } satisfies MarkdownCell | RawCell;
      }
      // Unknown cell type — preserve as raw.
      normalized = true;
      return {
        id,
        cell_type: "raw",
        source: normalizeSource(raw.source),
        metadata,
      } satisfies RawCell;
    });

    const hasMetadata = typeof parsed.metadata === "object" && parsed.metadata !== null;
    if (!hasMetadata) normalized = true;
    const notebook: NotebookJson = {
      cells,
      metadata: hasMetadata ? parsed.metadata : {},
      nbformat: typeof parsed.nbformat === "number" ? parsed.nbformat : 4,
      nbformat_minor:
        typeof parsed.nbformat_minor === "number" ? parsed.nbformat_minor : 5,
    };
    return { notebook, error: null, normalized };
  } catch (e) {
    return {
      notebook: null,
      error: e instanceof Error ? e.message : String(e),
      normalized: false,
    };
  }
}

export function serializeNotebook(nb: NotebookJson): string {
  return JSON.stringify(nb, null, 1) + "\n";
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createCodeCell(source = ""): CodeCell {
  return {
    id: makeCellId(),
    cell_type: "code",
    source: stringToSource(source),
    outputs: [],
    execution_count: null,
    metadata: {},
  };
}

export function createMarkdownCell(source = ""): MarkdownCell {
  return {
    id: makeCellId(),
    cell_type: "markdown",
    source: stringToSource(source),
    metadata: {},
  };
}

export function createEmptyNotebook(): NotebookJson {
  return {
    cells: [createCodeCell()],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function isNotebookFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return false; // no extension (or hidden file like ".ipynb")
  return path.slice(dot + 1).toLowerCase() === "ipynb";
}
