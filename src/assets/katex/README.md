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

The one deliberate edit: `auto-render.mjs` line 1 was changed from
`import katex from '../katex.mjs'` to `import katex from "katex"` so it binds
to the katex package's public entry (stable across katex versions) instead of
a file that only exists inside the katex dist layout.

The vendored woff2 fonts these stylesheets reference live in
`src/assets/katex-fonts/`.

## Refreshing after a katex upgrade

```sh
npm install katex@<new-version>
cp node_modules/katex/dist/katex.min.js node_modules/katex/dist/katex.min.css src/assets/katex/
cp node_modules/katex/dist/contrib/auto-render.mjs node_modules/katex/dist/contrib/auto-render.min.js src/assets/katex/
# re-apply the one-line import patch to auto-render.mjs (see above)
cp node_modules/katex/dist/fonts/*.woff2 src/assets/katex-fonts/
node scripts/gen-katex-fonts.cjs
# update the "katex X.Y.Z" references in this README
```
