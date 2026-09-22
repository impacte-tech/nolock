# Vendored KaTeX runtime files

Copied verbatim from `node_modules/katex/dist` at **katex 0.18.6** so that no
source file deep-imports `katex/dist/*` from node_modules. Deep imports broke
fresh clones whose `node_modules` was missing, partial, or resolved a different
katex version (see commits "Vendor KaTeX woff2 fonts…" and "Vendor KaTeX
runtime files…").

| File | Used by | How |
|---|---|---|
| `katex.min.css` | Notebook.tsx | side-effect stylesheet import + `?raw` (PDF export), via the `vendored-katex` plugin in `vite.config.ts` |
| `katex.min.js` | Notebook.tsx | `?raw` — embedded as `<script>` in exported HTML, via the plugin |
| `auto-render.min.js` | Notebook.tsx | `?raw` — embedded as `<script>` in exported HTML, via the plugin |
| `auto-render.mjs` | src/lib/math.ts | direct relative ESM import |
| `auto-render.d.mts` | (TypeScript) | hand-written types for `auto-render.mjs` |

Deliberate edits (re-apply after every refresh):

1. `auto-render.mjs` line 1 was changed from `import katex from '../katex.mjs'`
   to `import katex from "katex"` so it binds to the katex package's public
   entry (stable across katex versions) instead of a file that only exists
   inside the katex dist layout.
2. `katex.min.css`: every `@font-face` keeps only the
   `url(fonts/…​.woff2) format("woff2")` source — the legacy
   `,url(fonts/…​.woff) format("woff"),url(fonts/…​.ttf) format("truetype")`
   fallbacks are stripped. Only the 20 `.woff2` files are vendored in
   `src/assets/katex/fonts/` (every supported browser takes the woff2 entry
   first; the woff/ttf copies were pure dead weight — 60 files/1.1MB → 20
   files/296KB).

The vendored woff2 fonts live in `src/assets/katex-fonts/` (inlined as data
URIs for the PDF export via `scripts/gen-katex-fonts.cjs`) AND as loose files in
`src/assets/katex/fonts/` (sibling of `katex.min.css`, whose relative
`url(fonts/…)` references must resolve for the LIVE app — Vite bundles them).
Both are the katex 0.18.6 dist fonts.

## Refreshing after a katex upgrade

```sh
npm install katex@<new-version>
cp node_modules/katex/dist/katex.min.js node_modules/katex/dist/katex.min.css src/assets/katex/
cp node_modules/katex/dist/contrib/auto-render.mjs node_modules/katex/dist/contrib/auto-render.min.js src/assets/katex/
# re-apply BOTH deliberate edits above (auto-render.mjs import + css format strip)
rm -f src/assets/katex/fonts/*
cp node_modules/katex/dist/fonts/*.woff2 src/assets/katex/fonts/
cp node_modules/katex/dist/fonts/*.woff2 src/assets/katex-fonts/
node scripts/gen-katex-fonts.cjs
# update the "katex X.Y.Z" references in this README
```
