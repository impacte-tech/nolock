# Frontend Implementation Status

| # | Component | File | Lines | Implemented | Tests | Status |
|---|-----------|------|-------|-------------|-------|--------|
| 1 | **App** (root) | `src/App.tsx` | 532 | Full layout, keyboard shortcuts, resize logic | `App.test.tsx` (11 tests) | ✅ |
| 2 | **Editor** | `src/components/Editor.tsx` | 238 | Monaco editor, AI FITM inline completions, gate-based debounce | — | ✅ |
| 3 | **FileExplorer** | `src/components/FileExplorer.tsx` | 176 | Tree browser, dir expansion, file colors, hidden-filter | `getFileColor.test.ts` (21 tests) | ✅ |
| 4 | **BrowserPanel** | `src/components/BrowserPanel.tsx` | 356 | Native webview (GtkOverlay/JS fallback), URL toolbar, rAF position polling | `BrowserPanel.test.tsx` (6 tests) | ✅ |
| 5 | **ChatPanel** | `src/components/ChatPanel.tsx` | 414 | Markdown rendering, tool calls display, multi-backend AI chat, @mention file references with FileAutocomplete, context tracker (SVG circle), `/clear` command, clear-all button | `ChatPanel.test.tsx`, `MarkdownContent.test.tsx`, `ToolCallBlock.test.tsx` | ✅ |
| 5b | **FileAutocomplete** | `src/components/FileAutocomplete.tsx` | 144 | @mention file dropdown, keyboard navigation, directory expansion, filtered search | — | ✅ |
| 6 | **Terminal** | `src/components/Terminal.tsx` | 157 | xterm.js + Rust PTY, multi-tab, resize | — | ✅ |
| 7 | **MenuBar** | `src/components/MenuBar.tsx` | 64 | Dropdown menus, click-outside-to-close | `MenuBar.test.tsx` | ✅ |
| 8 | **StatusBar** | `src/components/StatusBar.tsx` | 74 | Backend status, model info, chat toggle | `StatusBar.test.tsx` | ✅ |
| 9 | **AISettings** | `src/components/AISettings.tsx` | 199 | Modal: backend selection, models, API key, agent tools | `AISettings.test.tsx` (12 tests) | ✅ |
| 10 | **ResizableHandle** | `src/components/ResizableHandle.tsx` | 84 | Drag-to-resize dividers (horizontal/vertical) | — | ✅ |
| 11 | **Utilities** | `src/__tests__/getLanguage.test.ts` | — | Language detection from file extension | 19 tests | ✅ |
| 12 | **Utilities** | `src/__tests__/getFileColor.test.ts` | — | File color by extension | 21 tests | ✅ |
| — | **Styles** | `src/styles.css` | 1186 | Full dark theme, all component styles | — | ✅ |

---

## Missing / Incomplete Frontend Items

| Item | Priority | Notes |
|------|----------|-------|
| Editor context menu (right-click) | Low | Monaco provides some built-in; custom actions could be added |
| Find/Replace in Editor | Low | Monaco has built-in Ctrl+F; no custom UI needed |
| Drag-and-drop file from Explorer → Editor tab | Low | Minor UX improvement |
| Tab reordering in Editor | Low | Nice-to-have UX |
| Terminal theme customization | Low | Currently hardcoded dark theme |
