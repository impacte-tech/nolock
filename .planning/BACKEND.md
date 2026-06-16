# Backend (Rust) Implementation Status

## `src-tauri/src/main.rs` (934 lines)

| Command / Module | Lines | Status | Notes |
|-----------------|-------|--------|-------|
| `read_file` | 14-16 | ✅ | Simple file read |
| `write_file` | 18-21 | ✅ | Simple file write |
| `list_directory` | 23-52 | ✅ | Dir-first, case-insensitive sort, hidden-file filter |
| `DirEntry` struct | 54-59 | ✅ | Serialization struct |
| PTY: `pty_spawn` | 76-165 | ✅ | Spawns shell via portable-pty, reader thread emits events |
| PTY: `pty_write` | 173-189 | ✅ | Writes to PTY master |
| PTY: `pty_resize` | 191-213 | ✅ | Resizes PTY dimensions |
| PTY: `pty_kill` | 215-224 | ✅ | Kills child process |
| AI: `CompletionRequest` | 230-239 | ✅ | Deserialization struct |
| AI: `ChatRequest` / `ChatResult` | 247-272 | ✅ | Deserialization/serialization structs |
| AI: `build_tool_schemas` | 278-338 | ✅ | Builds JSON tool schemas for OpenAI-compatible APIs |
| AI: `execute_tool` | 340-405 | ✅ | Executes web_fetch, read_file, list_directory |
| AI: `ollama_chat_with_tools` | 411-547 | ✅ | Multi-iteration tool-calling loop (max 10 iters) |
| AI: `ai_complete` | 549-713 | ✅ | FITM for Ollama, llama.cpp, OpenRouter, OpenCode |
| AI: `ai_chat` | 715-897 | ✅ | Multi-backend chat with optional tool calling |
| `run()` / `main()` | 899-933 | ✅ | Tauri builder, plugin registration, command registration |
| Tests | 938-1134 | ✅ | Directory sorting, tool schemas, file I/O, execute_tool error paths |

## `src-tauri/src/browser.rs` (369 lines)

| Module / Command | Lines | Status | Notes |
|------------------|-------|--------|-------|
| Linux impl (`imp` module) | 20-281 | ✅ | GtkOverlay + GtkFixed approach |
| `create_browser_webview` | 146-211 | ✅ | Sets up overlay (once), positions Fixed, builds wry WebView |
| `close_browser_webview` | 215-231 | ✅ | Drops webview, keeps infrastructure |
| `update_browser_webview` | 234-280 | ✅ | Repositions Fixed + updates webview bounds |
| Non-Linux stubs | 285-328 | ✅ | Returns error, frontend falls back to JS API |
| Tests | 332-365 | ✅ | BrowserState new/is_send/is_sync, command existence |
| Public re-exports | 367-369 | ✅ | `pub use imp::*` |

## `src-tauri/Cargo.toml`

| Dependency | Version | Purpose |
|------------|---------|---------|
| tauri | 2.11.2 | App framework |
| tauri-plugin-fs | 2.5.1 | Filesystem plugin |
| tauri-plugin-shell | 2.3.5 | Shell plugin |
| tauri-plugin-dialog | 2.7.1 | Dialog plugin |
| serde / serde_json | 1.0 | JSON serialization |
| reqwest | 0.12.28 | HTTP client (AI backends + web_fetch tool) |
| portable-pty | 0.8.1 | PTY terminal support |
| gtk (Linux) | 0.18.2 | GtkOverlay + GtkFixed for browser overlay |
| wry (Linux) | 0.55.1 | Native webview rendering |

---

## Missing / Incomplete Backend Items

| Item | Priority | Notes |
|------|----------|-------|
| OpenRouter tool-calling | Medium | Currently only Ollama has the multi-iteration tool loop; OpenRouter gets tools in the request but no loop |
| `ai_chat` for llamacpp with tools | Low | Would need prompt engineering instead of structured tool calls |
| Browser panel forward/back navigation | Low | Currently navigate only via URL entry or reload |
| PTY shell configuration (custom shell path) | Low | Currently reads SHELL env var; UI control not exposed |
| File watcher for Explorer auto-refresh | Medium | Currently requires manual Ctrl+R refresh |
| Unsaved file close confirmation | Medium | No dirty-file dialog when closing tabs |
