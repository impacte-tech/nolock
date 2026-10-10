import { useCallback, useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { invoke } from "@tauri-apps/api/core";
import { appendToChatInput } from "./ChatPanel";
import { base64ToUint8Array, buildQuote, normalizePdfSelection } from "../lib/pdf";
import "../styles/pdf-preview.css";

// pdf.js parses documents on a worker thread. The worker is bundled by Vite
// (`?worker`) and instantiated lazily — a single shared instance for every
// open PDF, created on first use so importing the module stays side-effect
// free (tests, SSR).
let workerStarted = false;
function ensureWorker(): void {
  if (workerStarted) return;
  GlobalWorkerOptions.workerPort = new PdfjsWorker();
  workerStarted = true;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.2;
/** How far outside the viewport a page starts rendering (pre-scroll buffer). */
const LAZY_ROOT_MARGIN = "400px";

// Runtime assets vendored into `public/pdfjs/` (copied from pdfjs-dist at the
// pinned version). `standardFontDataUrl` is required to draw the 14 base PDF
// fonts that generators routinely leave un-embedded (LaTeX/Word exports).
// Served from the app root by `vite dev`, the desktop bundle, and
// nolock-server's static handler alike.
//
// NOTE: pdf.js's CJK `cmaps/` are intentionally NOT vendored. Adding all 169
// cmap files (~1.7 MB) to the embedded asset bundle reproducibly breaks the
// `tauri://` protocol on Linux (the whole window renders black), so CJK PDFs
// fall back to pdf.js's built-in handling. Re-add `cMapUrl`/`cMapPacked` here
// only if that upstream issue is resolved.
const PDFJS_STANDARD_FONTS_URL = "/pdfjs/standard_fonts/";

interface Props {
  /** Absolute workspace path of the PDF (used for chat quotes / a11y labels). */
  path: string;
  /** Raw file bytes, base64-encoded (from the `read_file_base64` command). */
  base64: string;
  /** Called before quoting into the chat so the app can reveal the panel. */
  onRequestChat?: () => void;
}

/**
 * PDF viewer for the editor pane — the binary-file counterpart of the
 * markdown preview. Each page is rendered to a crisp canvas (device-pixel
 * aware) with pdf.js's selectable text layer on top, so text can be selected,
 * copied, and quoted straight into the agent chat for studying.
 */
export default function PdfPreview({ path, base64, onRequestChat }: Props) {
  const fileName = path.split("/").pop() || path;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [isFitWidth, setIsFitWidth] = useState(true);
  /** Natural (scale-1) width of page 1 — the reference for fit-width zoom. */
  const basePageWidthRef = useRef<number | null>(null);

  // --- Load the document ---------------------------------------------------
  useEffect(() => {
    if (!base64) {
      setError("Empty PDF file.");
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        ensureWorker();
        const task = getDocument({
          data: base64ToUint8Array(base64),
          standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
        });
        loaded = await task.promise;
        if (cancelled) {
          loaded.destroy().catch(() => {});
          return;
        }
        const firstPage = await loaded.getPage(1);
        const basePageWidth = firstPage.getViewport({ scale: 1 }).width;
        basePageWidthRef.current = basePageWidth;
        setScale(fitWidthScale(basePageWidth));
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(describePdfError(e));
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy().catch(() => {});
    };
  }, [base64]);

  /**
   * Scale that fits the (unrotated) page width into the visible pane width.
   * Assumes uniform page sizes for the fit computation — pdf.js still renders
   * every page at its true size.
   */
  function fitWidthScale(basePageWidth: number): number {
    const pane = scrollRef.current?.clientWidth ?? 800;
    const available = Math.max(240, pane - 48); // page padding + shadow breathing room
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, available / basePageWidth));
  }

  // --- Keep fit-width pages fitted when the pane is resized -----------------
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (isFitWidth && basePageWidthRef.current != null) {
          setScale(fitWidthScale(basePageWidthRef.current));
        }
      }, 120);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [isFitWidth]);

  // --- Zoom ------------------------------------------------------------------
  const zoomBy = useCallback((factor: number) => {
    setIsFitWidth(false);
    setScale((current) =>
      current == null ? current : Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)),
    );
  }, []);

  const zoomFit = useCallback(() => {
    setIsFitWidth(true);
    if (basePageWidthRef.current != null) {
      setScale(fitWidthScale(basePageWidthRef.current));
    }
  }, []);

  // --- Selection tracking (copy / quote to chat) -----------------------------
  const [selection, setSelection] = useState<{ text: string; page: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !rootRef.current) {
        setSelection(null);
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor || !rootRef.current.contains(anchor)) {
        setSelection(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setSelection(null);
        return;
      }
      const pageEl =
        anchor.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element).closest("[data-page-number]")
          : anchor.parentElement?.closest("[data-page-number]");
      const page = pageEl?.getAttribute("data-page-number");
      setSelection({ text, page: page ? Number(page) : null });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const copySelection = useCallback(async () => {
    if (!selection) return;
    const text = normalizePdfSelection(selection.text);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Selection copied.");
    } catch {
      setNotice("Could not access the clipboard.");
    }
  }, [selection]);

  const askInChat = useCallback(() => {
    if (!selection) return;
    const quote = buildQuote(fileName, selection.page, selection.text);
    // Reveal the chat first (it stays mounted — hidden via display) so the
    // user sees the quoted text land in the input.
    onRequestChat?.();
    if (appendToChatInput(quote)) {
      setNotice("Quoted into agent chat.");
    } else {
      navigator.clipboard
        .writeText(quote)
        .then(() => setNotice("Quote copied — open agent chat to paste it."))
        .catch(() => setNotice("Could not quote into chat or clipboard."));
    }
    // Collapse the consumed selection.
    document.getSelection()?.removeAllRanges();
  }, [selection, fileName, onRequestChat]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  const pageCount = doc?.numPages ?? 0;

  return (
    <div className="pdf-preview" ref={rootRef}>
      <div className="pdf-toolbar">
        <span className="pdf-title" title={path}>
          {fileName}
        </span>
        <span className="pdf-toolbar-group">
          <button
            className="pdf-btn"
            onClick={() => zoomBy(1 / SCALE_STEP)}
            disabled={!doc}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="pdf-zoom-label">{scale ? `${Math.round(scale * 100)}%` : "…"}</span>
          <button
            className="pdf-btn"
            onClick={() => zoomBy(SCALE_STEP)}
            disabled={!doc}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
          <button className="pdf-btn" onClick={zoomFit} disabled={!doc} title="Fit page width">
            Fit
          </button>
        </span>
        <span className="pdf-toolbar-group">
          <button className="pdf-btn" onClick={copySelection} disabled={!selection} title="Copy selected text">
            Copy
          </button>
          <button
            className="pdf-btn pdf-btn-accent"
            onClick={askInChat}
            disabled={!selection}
            title="Quote the selected text into the agent chat input"
          >
            Ask in chat
          </button>
        </span>
        {doc && <span className="pdf-pages-label">{pageCount} {pageCount === 1 ? "page" : "pages"}</span>}
      </div>

      {notice && <div className="pdf-notice">{notice}</div>}

      <div className="pdf-scroll" ref={scrollRef}>
        {error ? (
          <div className="pdf-error">
            <p>Could not render this PDF.</p>
            <p className="pdf-error-detail">{error}</p>
          </div>
        ) : !doc ? (
          <div className="pdf-loading">Loading PDF…</div>
        ) : scale != null ? (
          <div className="pdf-pages">
            {Array.from({ length: pageCount }, (_, i) => (
              <PdfPage key={i + 1} pdf={doc} pageNumber={i + 1} scale={scale} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single page — lazily rendered when scrolled near the viewport
// ---------------------------------------------------------------------------

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}

function PdfPage({ pdf, pageNumber, scale }: PdfPageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(pageNumber <= 2);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const [failed, setFailed] = useState(false);

  // Start rendering once the page scrolls near the viewport.
  useEffect(() => {
    if (near) return;
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    (async () => {
      try {
        const page: PDFPageProxy = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        setDims({ width: viewport.width, height: viewport.height });

        const canvas = canvasRef.current;
        const textDiv = textRef.current;
        if (!canvas || !textDiv) return;

        // Crisp canvas: render at device pixels, display at CSS pixels.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTaskRef.current?.cancel();
        textLayerRef.current?.cancel();
        textDiv.replaceChildren();

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;

        // Selectable text layer on top of the canvas — this is what makes
        // copy/paste from the PDF possible.
        const layer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textDiv,
          viewport,
        });
        textLayerRef.current = layer;
        await layer.render();
      } catch (e) {
        const name = (e as { name?: string })?.name ?? "";
        if (!cancelled && !name.includes("RenderingCancelled") && !name.includes("Abort")) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      textLayerRef.current?.cancel();
    };
  }, [pdf, pageNumber, scale, near]);

  return (
    <div
      className={`pdf-page${failed ? " pdf-page-failed" : ""}`}
      ref={wrapRef}
      data-page-number={pageNumber}
      style={{
        width: dims ? `${dims.width}px` : undefined,
        height: dims ? `${dims.height}px` : undefined,
        // pdf.js TextLayer positions its spans with calc(var(--scale-factor) * Npx).
        "--scale-factor": scale,
      } as React.CSSProperties}
    >
      <canvas ref={canvasRef} aria-label={`Page ${pageNumber}`} />
      <div className="textLayer" ref={textRef} />
      {!dims && <div className="pdf-page-placeholder">Page {pageNumber}</div>}
      {failed && <div className="pdf-page-error">Page {pageNumber} failed to render</div>}
    </div>
  );
}

function describePdfError(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (/password/i.test(raw)) return "This PDF is password-protected.";
  if (/InvalidPDF|invalid pdf/i.test(raw)) return "The file does not look like a valid PDF.";
  return raw;
}
