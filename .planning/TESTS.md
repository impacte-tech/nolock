# Test Coverage

## Frontend (Vitest) — 117 tests, all passing ✅

| Test File | Tests | Covers |
|-----------|-------|--------|
| `src/__tests__/App.test.tsx` | 11 | Root app: rendering, menu bar, status bar, keyboard shortcuts (chord system, Ctrl+T, Ctrl+Shift+B, Ctrl+Shift+I, Ctrl+E, Ctrl+O), chat-to-browser navigation |
| `src/__tests__/getFileColor.test.ts` | 21 | File color mapping for all supported extensions |
| `src/__tests__/getLanguage.test.ts` | 19 | Language detection for all supported file extensions |
| `src/components/__tests__/AISettings.test.tsx` | 12 | Backend selection, model input fields, tool toggles, save/load localStorage |
| `src/components/__tests__/BrowserPanel.test.tsx` | 6 | Rendering, URL input, close button, Rust command fallback, empty URL |
| `src/components/__tests__/ChatPanel.test.tsx` | — | Chat message rendering, send button |
| `src/components/__tests__/MarkdownContent.test.tsx` | — | Markdown rendering via `marked` |
| `src/components/__tests__/ToolCallBlock.test.tsx` | 8 | Expand/collapse tool calls, rendering tool names/args/results |
| `src/components/__tests__/MenuBar.test.tsx` | — | Menu rendering, click-to-open, hover navigation |
| `src/components/__tests__/StatusBar.test.tsx` | — | Backend status display, model names, Chat/Hide Chat toggle |

## Rust (built-in `#[cfg(test)]`) — all passing ✅

### `main.rs` tests

| Test | Type | What it covers |
|------|------|----------------|
| `test_directory_sorting` | Unit | Dir-first + case-insensitive sort |
| `test_directory_hidden_files_filtered` | Unit | Hidden file (dot prefix) filtering |
| `test_build_tool_schemas_empty` | Unit | Empty tool list → no schemas |
| `test_build_tool_schemas_single` | Unit | Single tool schema generation |
| `test_build_tool_schemas_multiple` | Unit | Multiple tool schemas (web_fetch, read_file, list_directory) |
| `test_build_tool_schemas_unknown_tool_ignored` | Unit | Unknown tool IDs are ignored |
| `test_tool_schema_has_required_url` | Unit | web_fetch schema has `url` in required params |
| `test_execute_tool_unknown_name` | Async | Error on unknown tool name |
| `test_execute_tool_web_fetch_missing_url` | Async | Error when web_fetch called without URL |
| `test_execute_tool_read_file_nonexistent` | Async | Error when reading nonexistent file |
| `test_execute_tool_list_directory_nonexistent` | Async | Error when listing nonexistent dir |
| `test_write_and_read_file` | Unit | Round-trip file write + read |
| `test_read_file_nonexistent` | Unit | Error when reading missing file |
| `test_list_directory_temp` | Unit | Full directory listing with temp dir |

### `browser.rs` tests

| Test | Type | What it covers |
|------|------|----------------|
| `test_browser_state_new` | Unit | BrowserState::new() is infallible |
| `test_browser_state_is_send_sync` | Unit | Compile-time Send + Sync assertions |
| `test_command_functions_exist` | Unit | All 3 browser commands exist by name |

---

## Coverage Gaps

| Area | Gap | Priority |
|------|-----|----------|
| `Terminal.tsx` | No tests (requires xterm.js canvas) | Low |
| `ResizableHandle.tsx` | No tests (mouse event simulation needed) | Low |
| `Editor.tsx` | No tests (Monaco requires full DOM) | Low |
| Rust `ollama_chat_with_tools` | No mock-based tests for tool loop | Medium |
| Rust PTY commands | No integration tests (requires Tauri runtime) | Medium |
| E2E / integration | No Playwright/Cypress tests | Medium |
