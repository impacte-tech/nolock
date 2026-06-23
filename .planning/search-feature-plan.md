# File Search Feature — Implementation Plan

## Overview
Add a VS Code-inspired "Search in Files" feature to nolock, allowing users to search and optionally replace text across all files in the currently open folder.

## Requirements
1. Activated by `Ctrl+F` chord → `S` (inspired by VS Code's `Ctrl+Shift+F`)
2. Traditional term search across the entire open folder (open folder is a hard requirement)
3. Replace functionality similar to VS Code (replace single match or replace all)

---

## Architecture

### 1. Rust Backend Commands (`src-tauri/src/main.rs`)

Two new Tauri commands are needed:

#### `search_in_files`
```
Input:  { rootPath: string, query: string, matchCase?: boolean, useRegex?: boolean }
Output: { results: SearchMatch[] }

SearchMatch {
  filePath: string
  lineNumber: number
  lineContent: string
  matchStart: number
  matchEnd: number
}
```
- Walks directory recursively from `rootPath`
- Skips: `.git/`, `node_modules/`, `target/`, `.ruff_cache/`, and hidden files (`.` prefix)
- Skips binary files (check for null bytes in first 4KB)
- Performs case-sensitive or case-insensitive matching
- Supports plain text or regex matching
- Reads each file line-by-line, finds all matches
- Returns up to a configurable max (e.g., 5000 matches)

#### `replace_in_files`
```
Input:  { rootPath: string, query: string, replacement: string, matchCase?: boolean, useRegex?: boolean, targetFiles?: string[] }
Output: { filesChanged: number, replacementsMade: number }
```
- Same directory walk as search
- Performs replacement on disk for each match
- If `targetFiles` is provided, only operates on those files
- Returns count of files changed and total replacements made

### 2. SearchPanel React Component (`src/components/SearchPanel.tsx`)

A new panel rendered as a sidebar (similar to ChatPanel) with these states:

#### States
| State | Condition | Visual |
|-------|-----------|--------|
| **Empty** | No folder open | Message: "Open a folder to search" |
| **Idle** | Folder open, no query entered | Prompt: "Type a search term" |
| **Searching** | Query entered, debounce waiting / backend call in flight | "Searching..." indicator |
| **Results** | Matches found | Grouped file tree with match lines |
| **No Results** | Search complete, 0 matches | "No results found" message |
| **Error** | Backend error | Error message with retry |

#### Component Features
- **Search input** at top with debounce (300ms)
- **Options row**: Match Case toggle, Use Regex toggle
- **Replace mode toggle** (expand/collapse replace UI)
- **Replace input** + "Replace All" button (shown in replace mode)
- **Results list** grouped by file:
  - File header (collapsible, shows file path + match count)
  - Each match: line number + highlighted line content
  - Click match → open file at that line
- **Collapse All / Expand All** buttons for result groups
- **Close button** (X) to dismiss the panel

### 3. App.tsx Integration

#### New State
```typescript
const [showSearch, setShowSearch] = useState(false);
```

#### Keyboard Shortcut (Chord)
Add a new chord prefix `"F"`:
- `Ctrl+F` → enter chord mode (waiting for second key)
- `S` → toggle search panel

Implementation in the existing `handleKeyDown`:
```typescript
// In chordPrefix === "F" block:
if (e.key === "s" || e.key === "S") {
  e.preventDefault();
  setChordPrefix(null);
  setShowSearch((v) => !v);
  return;
}
```

Add `"F"` to the chord state machine (alongside existing `"A"` and `"T"`).

#### Layout Integration
The search panel replaces or sits alongside the file explorer. Two options:

**Option A (Recommended) — Replace Explorer tab**:
- Add a toggle in the explorer header to switch between "Explorer" and "Search" views
- This matches VS Code's behavior where Search replaces the explorer sidebar
- The search panel uses the same sidebar slot as FileExplorer

**Option B — New separate panel**:
- Add search as a new panel on the right side or as an overlay
- More complex layout; less VS Code-like

We'll go with **Option A** for now. The file explorer gets a tab bar with "Explorer" and "Search" tabs.

Actually, re-reading the requirements: "should allow the traditional term search across the open folder". Let's think about what layout makes sense.

Looking at VS Code: Search is in the sidebar (same location as file explorer), toggled via a tab. The search sidebar has:
- Search input at top
- Replace input (expandable)
- Results below

The cleanest integration for nolock is to add a "Search" tab in the explorer header area. When search is active, the file tree is replaced by the search results panel.

**Revised integration**:
- The `FileExplorer` component gets a mode toggle: "explorer" | "search"
- When in "search" mode, the SearchPanel is rendered instead of the file tree
- The entire sidebar (explorer panel) stays in the layout
- Shortcut `Ctrl+F, S` switches to search mode; pressing again switches back to explorer
- Or: We add search as a separate panel toggled via shortcut

Actually, the simplest approach that doesn't break the existing layout:
- Search is a separate panel that appears in place of the explorer (like in VS Code)
- When Ctrl+F,S is pressed, if search is not showing, replace explorer with search
- When Ctrl+F,S is pressed again, or Escape is pressed, switch back to explorer

Even simpler: Search becomes a tab within the explorer sidebar. The explorer header gets two tabs: "Explorer" and "Search".

Let's go with **a tab-based approach** in the sidebar.

### 4. Editor Line Navigation

When clicking a search result, we need to:
1. Open the file (via existing `openFile`)
2. Navigate to the specific line in the Editor

To support this, the `Editor` component needs a way to accept a "go to line" instruction. Several options:

**Option A — Prop-based**:
Add props to Editor: `revealLine?: number` and `revealColumn?: number`. When these props change, the editor scrolls to that position.

```typescript
// In Editor.tsx useEffect
if (revealLine !== undefined && editor) {
  editor.revealLineInCenter(revealLine);
  editor.setPosition({ lineNumber: revealLine, column: revealColumn || 1 });
  editor.focus();
}
```

**Option B — Event-based**:
Use a custom event or a ref-based imperative handle.

**Option C — Global state / context**:
Store "pending navigation" in a shared context or in App.tsx state.

We'll go with **Option A** — simple prop-based approach.

### 5. Files to Create/Modify

#### New Files
| File | Purpose |
|------|---------|
| `src/components/SearchPanel.tsx` | Search UI component |

#### Modified Files
| File | Changes |
|------|---------|
| `src-tauri/src/main.rs` | Add `search_in_files` and `replace_in_files` commands |
| `src/App.tsx` | Add search state, keyboard chord `Ctrl+F`, layout integration |
| `src/components/Editor.tsx` | Add `revealLine`/`revealColumn` props for navigation |
| `src/components/FileExplorer.tsx` | Add "Search" tab toggle (optional, or keep separate) |
| `src/styles.css` | Add search panel CSS classes |
| `src/components/ShortcutsScreen.tsx` | Add search shortcut to the shortcuts grid |

---

## Detailed Implementation Steps

### Step 1: Rust Backend (`src-tauri/src/main.rs`)

Add after the existing file system commands:

```rust
#[derive(serde::Serialize)]
struct SearchMatch {
    file_path: String,
    line_number: usize,
    line_content: String,
    match_start: usize,
    match_end: usize,
}

#[derive(serde::Deserialize)]
struct SearchRequest {
    root_path: String,
    query: String,
    #[serde(default)]
    match_case: bool,
    #[serde(default)]
    use_regex: bool,
}

#[derive(serde::Deserialize)]
struct ReplaceRequest {
    root_path: String,
    query: String,
    replacement: String,
    #[serde(default)]
    match_case: bool,
    #[serde(default)]
    use_regex: bool,
    #[serde(default)]
    target_files: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
struct ReplaceResult {
    files_changed: usize,
    replacements_made: usize,
}

#[tauri::command]
fn search_in_files(req: SearchRequest) -> Result<Vec<SearchMatch>, String> {
    // Walk directory, skip hidden/binary dirs, search each file
    // ...
}

#[tauri::command]
fn replace_in_files(req: ReplaceRequest) -> Result<ReplaceResult, String> {
    // Walk directory, perform replacements
    // ...
}
```

### Step 2: SearchPanel Component

Create `src/components/SearchPanel.tsx`:

- Props: `rootPath`, `onOpenFile` (handles navigating to file+line), `onClose`
- State: `query`, `results`, `searching`, `matchCase`, `useRegex`, `replaceMode`, `replacement`
- On query change: debounce 300ms, then call `invoke("search_in_files", {...})`
- Render results grouped by file path
- Each result clickable → calls `onOpenFile(filePath, lineNumber)`

### Step 3: Editor Navigation

Add props to Editor:
```typescript
interface Props {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
  revealLine?: number;
  revealColumn?: number;
}
```

In the useEffect, when `revealLine` changes:
```typescript
if (revealLine !== undefined && editorRef.current) {
  editorRef.current.revealLineInCenter(revealLine);
  editorRef.current.setPosition({ lineNumber: revealLine, column: revealColumn || 1 });
}
```

### Step 4: App.tsx Integration

```typescript
// New state
const [showSearch, setShowSearch] = useState(false);

// In keyboard handler - add "F" chord prefix
if (e.ctrlKey && !e.shiftKey && e.key === "f") {
  e.preventDefault();
  // Toggle chord
  if (chordPrefix === "F") {
    setChordPrefix(null);
  } else {
    setChordPrefix("F");
    setTimeout(() => setChordPrefix(null), 1500);
  }
  return;
}

// In chordPrefix === "F" block
if (chordPrefix === "F") {
  if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    setChordPrefix(null);
    setShowSearch((v) => !v);
    return;
  }
}

// Search result click handler
const handleSearchResultClick = useCallback((filePath: string, lineNumber: number) => {
  // Open file, then navigate to line
  const fileName = filePath.split("/").pop() || filePath;
  openFile(filePath, fileName);
  setRevealLine({ filePath, lineNumber });
}, [openFile]);

// Pass revealLine to Editor
// ...
```

---

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| No folder open | SearchPanel shows "Open a folder to search" message |
| Query too short (< 2 chars) | Don't trigger search |
| Binary file encountered | Skip silently |
| File read error (permissions) | Skip file, continue |
| Very large file (> 10MB) | Skip file (show warning count) |
| Empty search results | Show "No results found" |
| Backend unavailable | Show error with retry button |
| Replace on read-only files | Skip file, report in result |
| Regex syntax error | Show inline error in search input |
| Too many results (> 5000) | Truncate results, show warning |
| File deleted between search and replace | Handle gracefully |

---

## Performance Considerations

1. **Search**: Run on a blocking thread (Tauri commands are async by default, but we should use `tokio::task::spawn_blocking` for heavy I/O)
2. **Debounce**: 300ms debounce on search input to avoid flooding backend
3. **Directory walk**: Skip `node_modules`, `.git`, `target` early
4. **Binary detection**: Check first 4KB for null bytes; skip if found
5. **File size limit**: Skip files > 10MB
6. **Result limit**: Cap at 5000 results to avoid UI lag
7. **Lazy result rendering**: Only render visible matches (virtual list if needed)

---

## Future Enhancements (Out of Scope for v1)

- Search in only "Open Editors" (currently open files)
- Files to exclude / include patterns (glob-based filtering)
- Preview changes before replacing (diff view)
- Search history
- Search across git-tracked files only
- Find references / symbol search (would need language server)
