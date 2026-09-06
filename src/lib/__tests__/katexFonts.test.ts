// ---------------------------------------------------------------------------
// Tests for lib/katexFonts + lib/math (math protection & font inlining)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { inlineKatexFonts, KATEX_FONTS } from "../katexFonts";
import { protectMath, renderMath } from "../math";

describe("inlineKatexFonts", () => {
  it("replaces every relative font URL with a woff2 data URI", () => {
    const synthetic = `
      @font-face { src: url(fonts/KaTeX_Main-Regular.woff2) format("woff2"); }
      @font-face { src: url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"); }
    `;
    const out = inlineKatexFonts(synthetic);
    expect((out.match(/data:font\/woff2;base64,/g) || []).length).toBe(2);
    expect(out).not.toContain("url(fonts/");
  });

  it("covers the full KaTeX font set", () => {
    expect(Object.keys(KATEX_FONTS).length).toBeGreaterThanOrEqual(20);
    for (const value of Object.values(KATEX_FONTS)) {
      expect(value.startsWith("data:font/woff2;base64,")).toBe(true);
    }
  });
});

describe("protectMath", () => {
  const F2 =
    "$\\displaystyle \\mathbb{P}_{x \\sim D}\\left[f(x) \\neq g(x)\\right] = " +
    "\\frac{1 - \\mathbb{E}_{x \\sim D}\\left[f(x)\\,g(x)\\right]}{2}.$";

  it("masks math spans with placeholders and restores them exactly", () => {
    const { masked, restore } = protectMath(F2);
    expect(masked).not.toContain("\\mathbb");
    expect(masked).toContain("@@NZMATH0@@");
    expect(restore(masked)).toBe(F2);
  });

  it("restores math after simulated markdown processing", () => {
    const { masked, restore } = protectMath(F2);
    // simulate a markdown stage that mangles underscores and \, — the masked
    // form contains none of them, so it passes through unharmed
    const processed = masked.replace(/_/g, "").replace(/\\,/g, ",");
    const restored = restore(processed);
    expect(restored).toBe(F2);
  });

  it("handles display $$…$$ blocks spanning multiple lines", () => {
    const src = "intro\n\n$$\nx^2\n$$\n\noutro";
    const { masked, restore } = protectMath(src);
    expect(masked).toContain("@@NZMATH0@@");
    expect(restore(masked)).toBe(src);
  });
});
