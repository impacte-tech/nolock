// ---------------------------------------------------------------------------
// katexFonts — KaTeX woff2 fonts inlined as data URIs (via Vite ?inline).
//
// The PDF export inlines katex.min.css, whose @font-face rules reference
// fonts/ relative paths that do not exist next to the exported .html file.
// Without these data URIs, glyphs that only exist in the KaTeX fonts
// (\neq, \mathbb letters, big operators, ...) print as missing-glyph boxes.
// Derived from node_modules/katex/dist/fonts — regenerate if katex upgrades.
// ---------------------------------------------------------------------------
import KaTeX_AMS_Regular_woff2 from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import KaTeX_Caligraphic_Bold_woff2 from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import KaTeX_Caligraphic_Regular_woff2 from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import KaTeX_Fraktur_Bold_woff2 from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import KaTeX_Fraktur_Regular_woff2 from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import KaTeX_Main_Bold_woff2 from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import KaTeX_Main_BoldItalic_woff2 from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import KaTeX_Main_Italic_woff2 from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import KaTeX_Main_Regular_woff2 from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import KaTeX_Math_BoldItalic_woff2 from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import KaTeX_Math_Italic_woff2 from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import KaTeX_SansSerif_Bold_woff2 from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import KaTeX_SansSerif_Italic_woff2 from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import KaTeX_SansSerif_Regular_woff2 from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import KaTeX_Script_Regular_woff2 from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import KaTeX_Size1_Regular_woff2 from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import KaTeX_Size2_Regular_woff2 from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import KaTeX_Size3_Regular_woff2 from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import KaTeX_Size4_Regular_woff2 from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import KaTeX_Typewriter_Regular_woff2 from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";

export const KATEX_FONTS: Record<string, string> = {
  "KaTeX_AMS-Regular": KaTeX_AMS_Regular_woff2,
  "KaTeX_Caligraphic-Bold": KaTeX_Caligraphic_Bold_woff2,
  "KaTeX_Caligraphic-Regular": KaTeX_Caligraphic_Regular_woff2,
  "KaTeX_Fraktur-Bold": KaTeX_Fraktur_Bold_woff2,
  "KaTeX_Fraktur-Regular": KaTeX_Fraktur_Regular_woff2,
  "KaTeX_Main-Bold": KaTeX_Main_Bold_woff2,
  "KaTeX_Main-BoldItalic": KaTeX_Main_BoldItalic_woff2,
  "KaTeX_Main-Italic": KaTeX_Main_Italic_woff2,
  "KaTeX_Main-Regular": KaTeX_Main_Regular_woff2,
  "KaTeX_Math-BoldItalic": KaTeX_Math_BoldItalic_woff2,
  "KaTeX_Math-Italic": KaTeX_Math_Italic_woff2,
  "KaTeX_SansSerif-Bold": KaTeX_SansSerif_Bold_woff2,
  "KaTeX_SansSerif-Italic": KaTeX_SansSerif_Italic_woff2,
  "KaTeX_SansSerif-Regular": KaTeX_SansSerif_Regular_woff2,
  "KaTeX_Script-Regular": KaTeX_Script_Regular_woff2,
  "KaTeX_Size1-Regular": KaTeX_Size1_Regular_woff2,
  "KaTeX_Size2-Regular": KaTeX_Size2_Regular_woff2,
  "KaTeX_Size3-Regular": KaTeX_Size3_Regular_woff2,
  "KaTeX_Size4-Regular": KaTeX_Size4_Regular_woff2,
  "KaTeX_Typewriter-Regular": KaTeX_Typewriter_Regular_woff2,
};

/** Replace katex.min.css relative font URLs with the inlined data URIs. */
export function inlineKatexFonts(css: string): string {
  return css.replace(/url\((fonts\/[^)]+?\.woff2)\)/g, (m, rel: string) => {
    const name = rel.replace("fonts/", "").replace(".woff2", "");
    return KATEX_FONTS[name] ? `url(${KATEX_FONTS[name]})` : m;
  });
}
