/**
 * PDF preview helpers — pure functions shared by the PdfPreview component.
 *
 * PDFs are rendered with pdf.js (`pdfjs-dist`). The file's bytes reach the
 * frontend base64-encoded (via the `read_file_base64` command) because the
 * regular `read_file` command is UTF-8 text-only and rejects binary files.
 */

/** Decodes a base64 string into the bytes pdf.js needs (`getDocument({ data })`). */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** True when the file looks like a PDF we can preview. */
export function isPdfFile(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "pdf";
}

/**
 * Reflows text copied out of a rendered PDF page.
 *
 * The selectable text layer is one absolutely-positioned span per text run,
 * so a browser selection yields a hard newline at (roughly) every visual
 * line — including mid-sentence. Collapse those into flowing paragraphs:
 * single newlines become spaces (de-hyphenating "-\n" breaks), and blank
 * lines / big gaps become real paragraph breaks.
 */
export function normalizePdfSelection(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    // A blank line (two+ newlines) separates paragraphs — keep the break.
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .reduce((acc, line) => {
          if (!acc) return line;
          // De-hyphenate words broken across lines: "exam-\nple" → "example".
          if (acc.endsWith("-")) return `${acc.slice(0, -1)}${line}`;
          return `${acc} ${line}`;
        }, ""),
    )
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.join("\n\n");
}

/**
 * Formats a PDF selection as a chat-ready quote with a page reference, so
 * the agent knows exactly which part of the study material is being discussed.
 */
export function buildQuote(fileName: string, pageNumber: number | null, text: string): string {
  const cleaned = normalizePdfSelection(text);
  const source =
    pageNumber != null ? `From \`${fileName}\` (page ${pageNumber}):` : `From \`${fileName}\`:`;
  const quoted = cleaned
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${source}\n${quoted}`;
}
