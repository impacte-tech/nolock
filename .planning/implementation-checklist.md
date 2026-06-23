# File Search Feature - Implementation Checklist

## Files to Create

### `src/components/SearchPanel.tsx`
- [ ] Search input with 300ms debounce
- [ ] Match case / use regex toggle options
- [ ] Replace mode toggle + replace input
- [ ] "Replace All" button with confirmation
- [ ] Results tree grouped by file path
- [ ] Each result: line number + highlighted content
- [ ] Click result → callback to open file at line
- [ ] States: empty, idle, searching, results, no-results, error
- [ ] Escape key to close panel

## Files to Modify

### `src-tauri/src/main.rs`
- [ ] Add `SearchMatch` struct (filePath, lineNumber, lineContent, matchStart, matchEnd)
- [ ] Add `SearchRequest` struct
- [ ] Add `ReplaceRequest` struct
- [ ] Add `ReplaceResult` struct (filesChanged, replacementsMade)
- [ ] Add `search_in_files` command (walk dir, search, return matches)
- [ ] Add `replace_in_files` command (walk dir, replace, return counts)
- [ ] Skip dirs: .git, node_modules, target, hidden dirs
- [ ] Skip binary files, files > 10MB
- [ ] Cap results at 5000

### `src/App.tsx`
- [ ] Add `showSearch` state
- [ ] Add `revealLine` state (for editor navigation)
- [ ] Add keyboard chord: `Ctrl+F` → `S` to toggle search
- [ ] Add `"F"` chord prefix handler (alongside A, T)
- [ ] Render SearchPanel in sidebar (tabs with Explorer)
- [ ] Handle search result click → open file + navigate to line
- [ ] Pass `revealLine` to Editor component
- [ ] Add Escape handler to close search
- [ ] Add menu item for search

### `src/components/Editor.tsx`
- [ ] Add `revealLine?: number` prop
- [ ] Add `revealColumn?: number` prop
- [ ] When revealLine changes: `editor.revealLineInCenter()` + `editor.setPosition()`

### `src/components/FileExplorer.tsx`
- [ ] Optionally add "Explorer" / "Search" tab toggle in header
- [ ] When search mode, show SearchPanel instead of file tree

### `src/components/ShortcutsScreen.tsx`
- [ ] Add "Search" group with `Ctrl+F, S` shortcut

### `src/styles.css`
- [ ] Add `.search-panel` base styles
- [ ] Add `.search-input`, `.search-options`, `.search-results`
- [ ] Add `.search-result-file`, `.search-result-line`
- [ ] Add `.search-result-highlight` (match highlighting)
- [ ] Add `.search-replace-bar` styles
- [ ] Add `.explorer-tabs` for Explorer/Search tab toggle
- [ ] Add dark theme overrides
