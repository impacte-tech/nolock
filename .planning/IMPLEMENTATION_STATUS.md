# nolock — Implementation Status

> **Project**: nolock (formerly ZenCode)
> **Type**: Tauri v2 desktop IDE with AI integration
> **Frontend**: React 18 + TypeScript + Vite + Monaco Editor + xterm.js
> **Backend**: Rust (tauri v2, reqwest, portable-pty, wry/gtk)
> **Tests**: Vitest (117 frontend tests) + Rust `#[cfg(test)]` + Rust integration tests
> **All tests passing**: ✅ Yes (117/117 frontend, Rust tests all pass)

---

## Overall Progress

| Layer | Status | Notes |
|-------|--------|-------|
| Frontend Components | ✅ Complete | 9 components, all functional |
| Rust Backend Commands | ✅ Complete | Filesystem, PTY, AI, Browser |
| Native Browser Overlay | ✅ Complete | GtkOverlay+Fixed on Linux, JS fallback |
| AI Fill-In-The-Middle | ✅ Complete | FITM inline completions with gate-based debounce |
| AI Agent Chat | ✅ Complete | Multi-turn chat with tool-calling loop |
| Chat: @mention File References | ✅ Complete | FileAutocomplete dropdown, file chips, auto-context injection |
| Chat: Context Tracker & Cleanup | ✅ Complete | SVG circular progress indicator, token counting via `js-tiktoken`, clear-all button, `/clear` slash command |
| Chat: Dynamic Max Tokens | ✅ Complete | Rust `get_model_info` command fetches context length from Ollama `/api/show`; falls back to model info, num_ctx, or default |
| Tool System | ✅ Complete | web_fetch, read_file, list_directory |
| Multi-Panel Layout | ✅ Complete | Flexbox proportional resizing |
| Keyboard Shortcuts | ✅ Complete | Full chord system (Ctrl+A, C / I) |
| localStorage Migration | ✅ Complete | zencode.* -> nolock.* keys |
| App Icons | ✅ Complete | PNG (32/128/256), ICO, ICNS |
| Tests | ✅ Complete | 10 frontend suites + Rust unit tests |
| Branding/Logo | ✅ Complete | SVG assets, all icons in place |

---

## Key Metrics

- **Total source files**: 13 TypeScript/TSX + 2 Rust + 1 CSS
- **Frontend test files**: 10
- **Frontend tests**: 117 (all passing)
- **Rust test modules**: `main.rs` (unit tests) + `browser.rs` (unit tests)
- **Rust backend commands**: 11 (read_file, write_file, list_directory, get_model_info, ai_complete, ai_chat, pty_spawn, pty_write, pty_resize, pty_kill, browser)
- **Latest build**: `(current)` — feat: dynamic max tokens from Ollama `/api/show`
