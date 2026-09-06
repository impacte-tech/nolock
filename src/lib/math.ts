// ---------------------------------------------------------------------------
// math — shared KaTeX auto-rendering for markdown surfaces
// (agent chat, notebook markdown cells, notebook HTML export)
// ---------------------------------------------------------------------------

import renderMathInElement from "katex/dist/contrib/auto-render.mjs";

export interface AutoRenderOptions {
  delimiters?: Array<{ left: string; right: string; display: boolean }>;
  ignoredTags?: string[];
  throwOnError?: boolean;
  [key: string]: unknown;
}

/** Delimiter set matching Colab/Jupyter: display $$…$$ and \[…\], inline \(…\) and $…$. */
export const MATH_DELIMITERS: Array<{ left: string; right: string; display: boolean }> = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false },
];

/**
 * Best-effort KaTeX auto-render over a rendered markdown element.
 * Never throws — on any failure the plain markdown stays visible.
 * <code>/<pre> blocks are ignored by default, so `$` in code stays literal.
 */
export function renderMath(element: HTMLElement, options?: AutoRenderOptions): void {
  try {
    renderMathInElement(element, {
      delimiters: MATH_DELIMITERS,
      throwOnError: false,
      ...options,
    });
  } catch {
    /* math rendering is best-effort */
  }
}

// --- Markdown/LaTeX interference protection ---------------------------------
//
// The markdown stage (marked) runs BEFORE KaTeX and mangles LaTeX:
//   - `_{x \sim D}` underscores are consumed as emphasis markers, splitting
//     the formula across <em> boundaries so auto-render's $…$ span no longer
//     matches within one text node;
//   - `\,` (thin space) is un-escaped into a literal comma.
// The fix: mask every math span out of the source before markdown parsing
// with placeholders that marked ignores, then restore them into the HTML.

const MATH_SPAN_RE =
  /(\$\$[\s\S]*?\$\$)|(\\\[[\s\S]*?\\\])|(\$[^$\n]*?\$)|(\\\([\s\S]*?\\\))/g;

function escapeHtmlLocal(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Replace math spans ($$…$$, \[…\], $…$, \(…\)) with `@@NZMATH<n>@@`
 * placeholders that the markdown parser leaves untouched. Apply
 * `restore()` to the resulting HTML to put the (HTML-escaped) math back.
 */
export function protectMath(
  src: string,
): { masked: string; restore: (html: string) => string } {
  const segments: string[] = [];
  const masked = src.replace(MATH_SPAN_RE, (m) => {
    const index = segments.push(m) - 1;
    return `@@NZMATH${index}@@`;
  });
  return {
    masked,
    restore: (html: string) =>
      html.replace(
        /@@NZMATH(\d+)@@/g,
        (_, i) => escapeHtmlLocal(segments[Number(i)] ?? ""),
      ),
  };
}
