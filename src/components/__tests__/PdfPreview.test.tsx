/**
 * PdfPreview tests — the component is exercised with a fully mocked
 * pdfjs-dist (no canvas / worker in jsdom). Focus: document lifecycle UI
 * (loading → pages / error) and the selection → copy / quote-to-chat flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ---- Module mocks -----------------------------------------------------------

const getDocumentMock = vi.fn();
const appendToChatInputMock = vi.fn((_text: string) => true);

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {} as { workerPort?: unknown },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
  TextLayer: class {
    constructor(_opts: unknown) {}
    render() {
      return Promise.resolve();
    }
    cancel() {}
  },
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?worker", () => ({
  default: class {
    constructor() {}
  },
}));

vi.mock("../ChatPanel", () => ({
  appendToChatInput: (text: string) => appendToChatInputMock(text),
}));

import PdfPreview from "../PdfPreview";

// ---- Helpers ----------------------------------------------------------------

/** A pdf.js page stub good enough for PdfPage's render path. */
function makePage(width = 612, height = 792) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      scale,
      rotation: 0,
    }),
    streamTextContent: () => ({}) as ReadableStream,
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  };
}

function makeDoc(numPages: number) {
  return {
    numPages,
    getPage: (n: number) => Promise.resolve(makePage()),
    destroy: () => Promise.resolve(),
  };
}

const B64 = btoa("%PDF-fake");

function mockSelection(text: string, anchorInRoot = true) {
  const anchor = anchorInRoot
    ? (() => {
        const span = document.createElement("span");
        span.textContent = "anchor";
        document.querySelector(".pdf-page .textLayer")?.appendChild(span);
        return span;
      })()
    : document.body;
  const fake = {
    isCollapsed: false,
    anchorNode: anchor,
    toString: () => text,
    removeAllRanges: () => {},
  } as unknown as Selection;
  return vi.spyOn(document, "getSelection").mockReturnValue(fake);
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  appendToChatInputMock.mockReturnValue(true);
  getDocumentMock.mockReset();
});

// ---- Tests ------------------------------------------------------------------

describe("PdfPreview", () => {
  it("shows a loading state while the document parses", async () => {
    getDocumentMock.mockReturnValue({
      promise: new Promise(() => {}), // never settles
    });
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    expect(screen.getByText("Loading PDF…")).toBeInTheDocument();
  });

  it("shows a friendly error when the PDF cannot be parsed", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.reject(new Error("InvalidPDF: bad header")),
    });
    render(<PdfPreview path="/w/broken.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/Could not render this PDF/)).toBeInTheDocument());
    expect(screen.getByText(/does not look like a valid PDF/)).toBeInTheDocument();
  });

  it("reports password-protected PDFs", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.reject(new Error("PasswordException: password required")),
    });
    render(<PdfPreview path="/w/secret.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/password-protected/)).toBeInTheDocument());
  });

  it("renders one placeholder page div per document page", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(3)) });
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/3 pages/)).toBeInTheDocument());
    expect(document.querySelectorAll(".pdf-page")).toHaveLength(3);
    expect(screen.queryByText("Loading PDF…")).not.toBeInTheDocument();
  });

  it("scales the first page to fit the pane width", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(1)) });
    const { container } = render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/1 page$/)).toBeInTheDocument());
    // jsdom panes have clientWidth 0 → the fit computation clamps the usable
    // width to 240px → 240/612 ≈ 39%.
    const label = container.querySelector(".pdf-zoom-label");
    expect(label?.textContent).toBe("39%");
  });

  it("Copy sends the reflowed selection to the clipboard", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(1)) });
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/1 page$/)).toBeInTheDocument());

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    mockSelection("Amortized\ncost is O(1).\n\nNext para.");
    fireEvent(document, new Event("selectionchange"));

    // React batches the state update triggered by the native event — wait for
    // the actions to enable before clicking.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Amortized cost is O(1).\n\nNext para."),
    );
  });

  it("Ask in chat quotes the selection with page + file into the chat input", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(2)) });
    const onRequestChat = vi.fn();
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} onRequestChat={onRequestChat} />);
    await waitFor(() => expect(screen.getByText(/2 pages/)).toBeInTheDocument());

    mockSelection("Recall that\nmemory is flat.");
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ask in chat" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask in chat" }));
    expect(onRequestChat).toHaveBeenCalledTimes(1);
    expect(appendToChatInputMock).toHaveBeenCalledWith(
      "From `lecture.pdf` (page 1):\n> Recall that memory is flat.",
    );
  });

  it("falls back to the clipboard when the chat panel is closed", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(1)) });
    appendToChatInputMock.mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/1 page$/)).toBeInTheDocument());

    mockSelection("Some text");
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ask in chat" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask in chat" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("> Some text")));
    expect(screen.getByText(/Quote copied/)).toBeInTheDocument();
  });

  it("selection outside the preview keeps the actions disabled", async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(makeDoc(1)) });
    render(<PdfPreview path="/w/lecture.pdf" base64={B64} />);
    await waitFor(() => expect(screen.getByText(/1 page$/)).toBeInTheDocument());

    // Anchor outside the preview (document.body) → ignored.
    const spy = vi.spyOn(document, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: document.body,
      toString: () => "outside",
      removeAllRanges: () => {},
    } as unknown as Selection);
    fireEvent(document, new Event("selectionchange"));

    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask in chat" })).toBeDisabled();
    spy.mockRestore();
  });
});
