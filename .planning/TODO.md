# TODO — Remaining Work & Future Enhancements

## 🔴 High Priority

- [ ] **Unsaved file close confirmation** — Show dialog when closing a dirty file tab
- [ ] **File watcher for Explorer auto-refresh** — Watch filesystem for changes (inotify on Linux, ReadDirectoryChanges on Windows, FSEvents on macOS)
- [ ] **OpenRouter tool-calling loop** — Currently only Ollama has the multi-iteration tool loop. OpenRouter (OpenAI-compatible) should also support it.

## 🟡 Medium Priority

- [ ] **Dirty file indicator in tab + "Save All"** — Show bullet on dirty tabs; add save-all command
- [ ] **Editor: multiple cursors / selection enhancements** — Monaco has these built-in, but keyboard shortcuts could be documented
- [ ] **Browser: forward/back navigation buttons** — Currently only reload and URL entry
- [ ] **Chat: streaming responses** — Currently sends full message, no SSE streaming
- [ ] **Chat: message persistence** — Save chat history to localStorage or file
- [ ] **Settings: model discovery** — Auto-detect available models from Ollama (`/api/tags`)
- [x] **Window icon in taskbar** — Fixed! Added `image-png` feature to tauri, set icon via `setup` hook using `WebviewWindow::set_icon()` (Rust: `tauri::image::Image::from_bytes` + `set_icon`)

## 🟢 Low Priority

- [ ] **Custom shell path** — UI to configure terminal shell (currently reads SHELL env var)
- [ ] **Terminal theme customization** — Currently hardcoded dark colors
- [ ] **Editor font family/Size settings** — Currently hardcoded
- [ ] **Tab reordering** — Drag tabs to reorder in editor
- [ ] **Right-click context menu in editor** — Monaco has built-in, but custom actions could be added
- [ ] **Drag-and-drop from Explorer → Editor** — Minor UX improvement
- [ ] **StatusBar: file encoding / line ending info** — Common IDE feature
- [ ] **Splash screen** — Loading state while app initializes

## 🧪 Testing Gaps

- [ ] **Rust: ollama_chat_with_tools mock tests** — Simulate tool-calling loop with mock HTTP server
- [ ] **Rust: PTY integration tests** — Need Tauri test runtime
- [ ] **Frontend: Terminal component tests** — xterm.js needs jsdom canvas mock
- [ ] **Frontend: ResizableHandle tests** — Drag simulation
- [ ] **Frontend: Editor tests** — Monaco needs full DOM
- [ ] **E2E tests** — Playwright or similar for full Tauri app testing

---

## Recently Completed (last 3 commits)

- `bdb81e5` — feat: resizing panels around Editor
  - Added `ResizableHandle` component
  - Proportional flexbox resizing with `ratioFlex()` helper
  - Resize drag handlers for all panels (explorer, chat, terminal, browser)
  - Resize epoch system for browser webview repositioning
  - CSS styles for handles (horizontal + vertical dividers)

- `676211b` — chore: reforce test coverage
  - Added/fixed test files for App, BrowserPanel, AISettings, etc.

- `cb5e473` — Browser working version - to improve dynamic sizing
  - Native browser webview via GtkOverlay + GtkFixed (Linux)
  - JS Webview API fallback (macOS/Windows)
  - rAF-based position polling for accurate overlay
