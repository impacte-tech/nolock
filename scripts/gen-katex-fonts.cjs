// Generator for src/lib/katexFonts.ts. Reads the KaTeX woff2 fonts vendored in
// src/assets/katex-fonts (copied once from node_modules/katex@0.18.6/dist/fonts
// so that katexFonts.ts never imports from node_modules) and emits one `?inline`
// import per font + the CSS rewriter that swaps relative font URLs in
// katex.min.css for the inlined data URIs.
//
// To refresh after a katex upgrade:
//   cp node_modules/katex/dist/fonts/*.woff2 src/assets/katex-fonts/
//   node scripts/gen-katex-fonts.cjs
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const fontDir = path.join(root, "src", "assets", "katex-fonts");
const importBase = "../assets/katex-fonts";
const files = fs
  .readdirSync(fontDir)
  .filter((f) => f.endsWith(".woff2"))
  .sort();

const varName = (n) => "KaTeX_" + n.replace("KaTeX_", "").replace(/-/g, "_").replace(/\./g, "_");

let out = `// ---------------------------------------------------------------------------
// katexFonts — KaTeX woff2 fonts inlined as data URIs (via Vite ?inline).
//
// The PDF export inlines katex.min.css, whose @font-face rules reference
// fonts/ relative paths that do not exist next to the exported .html file.
// Without these data URIs, glyphs that only exist in the KaTeX fonts
// (\\neq, \\mathbb letters, big operators, ...) print as missing-glyph boxes.
// The woff2 files are vendored in src/assets/katex-fonts (copied from
// katex@0.18.6) so this module never deep-imports from node_modules —
// regenerate via scripts/gen-katex-fonts.cjs if katex upgrades.
// ---------------------------------------------------------------------------\n`;

for (const n of files) {
  out += `import ${varName(n)} from "${importBase}/${n}?inline";\n`;
}

out += "\nexport const KATEX_FONTS: Record<string, string> = {\n";
for (const n of files) {
  out += `  "${n.replace(".woff2", "")}": ${varName(n)},\n`;
}
out += "};\n\n";

out += `/** Replace katex.min.css relative font URLs with the inlined data URIs. */
export function inlineKatexFonts(css: string): string {
  return css.replace(/url\\((fonts\\/[^)]+?\\.woff2)\\)/g, (m, rel: string) => {
    const name = rel.replace("fonts/", "").replace(".woff2", "");
    return KATEX_FONTS[name] ? \`url(\${KATEX_FONTS[name]})\` : m;
  });
}
`;

fs.writeFileSync(path.join(root, "src", "lib", "katexFonts.ts"), out);
console.log(`wrote src/lib/katexFonts.ts with ${files.length} fonts`);
