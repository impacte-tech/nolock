import { describe, expect, it } from "vitest";
import { base64ToUint8Array, buildQuote, isPdfFile, normalizePdfSelection } from "../pdf";

describe("isPdfFile", () => {
  it("detects .pdf case-insensitively", () => {
    expect(isPdfFile("/w/lecture.pdf")).toBe(true);
    expect(isPdfFile("/w/SLIDES.PDF")).toBe(true);
    expect(isPdfFile("/w/mixed.Pdf")).toBe(true);
  });

  it("rejects other files", () => {
    expect(isPdfFile("/w/notes.md")).toBe(false);
    expect(isPdfFile("/w/main.tsx")).toBe(false);
    expect(isPdfFile("/w/noextension")).toBe(false);
  });
});

describe("base64ToUint8Array", () => {
  it("decodes bytes", () => {
    // "%PDF-1.4" base64
    const bytes = base64ToUint8Array("JVBERi0xLjQ=");
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  });

  it("round-trips arbitrary binary", () => {
    const original = Uint8Array.from({ length: 256 }, (_, i) => i);
    const base64 = btoa(String.fromCharCode(...original));
    expect(base64ToUint8Array(base64)).toEqual(original);
  });
});

describe("normalizePdfSelection", () => {
  it("joins lines broken mid-sentence", () => {
    expect(normalizePdfSelection("Big-O analysis is\nused to describe\ncosts.")).toBe(
      "Big-O analysis is used to describe costs.",
    );
  });

  it("de-hyphenates words split across lines", () => {
    expect(normalizePdfSelection("pseudoran-\ndom functions")).toBe("pseudorandom functions");
  });

  it("preserves paragraph breaks on blank lines", () => {
    expect(normalizePdfSelection("First paragraph.\n\nSecond paragraph.")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("trims whitespace-only lines and drops empty paragraphs", () => {
    expect(normalizePdfSelection("  line one  \n   \nline two\n\n \n")).toBe(
      "line one line two",
    );
  });
});

describe("buildQuote", () => {
  it("formats a page-referenced blockquote", () => {
    const quote = buildQuote("lecture01.pdf", 3, "Amortized\ncost is O(1).");
    expect(quote).toBe('From `lecture01.pdf` (page 3):\n> Amortized cost is O(1).');
  });

  it("omits the page when unknown", () => {
    const quote = buildQuote("slides.pdf", null, "hello");
    expect(quote).toBe("From `slides.pdf`:\n> hello");
  });

  it("keeps multi-paragraph selections as separate quoted lines", () => {
    const quote = buildQuote("a.pdf", 2, "Para one.\n\nPara two.");
    expect(quote).toBe("From `a.pdf` (page 2):\n> Para one.\n> \n> Para two.");
  });
});
