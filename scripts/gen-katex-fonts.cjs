// One-off generator: creates src/lib/katexFonts.ts with ?inline imports for
// every KaTeX woff2 font + a CSS rewriter that swaps relative font URLs for
// the inlined data URIs.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const fontDir = path.join(root, "node_modules", "katex", "dist", "fonts");
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
// Derived from node_modules/katex/dist/fonts — regenerate if katex upgrades.
// ---------------------------------------------------------------------------\n`;

for (const n of files) {
  out += `import ${varName(n)} from "katex/dist/fonts/${n}?inline";\n`;
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
