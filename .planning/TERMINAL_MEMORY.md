# Terminal Memory Feature — Feasibility Analysis & Implementation Plan

> **Feature**: Ctrl+T,M (chord) in the terminal shows top 5 used commands + command categories overlay;
> pressing **S** inside the overlay enters save mode to save the last command under a category.

---

## Executive Summary

**Feasibility: HIGH** — This feature is architecturally sound, requires no new external dependencies, and follows
established patterns already present in the codebase (chord keyboard shortcuts, localStorage, Rust shared state,
JSON file persistence). Estimated effort: **~400-500 lines total** across frontend and backend.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React/TypeScript)                                │
│                                                             │
│  Terminal.tsx              TerminalMemoryOverlay.tsx         │
│  ┌──────────────────┐     ┌─────────────────────────────┐   │
│  │ onData() buffer   │────▶│ Top 5 Commands list        │   │
│  │ tracks keystrokes │     │ Category list (tags)       │   │
  │  │ detects Enter \r  │     │ S key enters save prompt   │   │
  │  └────────┬─────────┘     └──────────┬──────────────────┘   │
  │           │                          │                       │
  │           │  invoke("record_command")│ invoke("save_cmd_cat")│
  │           ▼                          ▼                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  App.tsx                                              │  │
  │  │  - Ctrl+T,M → show overlay (setState)                 │  │
  │  │  - S (in overlay) → enter save mode                   │  │
│  │  - Escape → hide overlay                              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri invoke()
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Rust Backend (src-tauri/src/)                               │
│                                                              │
│  terminal_memory.rs           main.rs                        │
│  ┌──────────────────────┐    ┌────────────────────────────┐  │
│  │ struct TermMemoryDB  │    │ register commands          │  │
│  │ JSON file persistence│    │ manage(State<TermMemory>)  │  │
│  │ record_command()     │    │ add to invoke_handler[]    │  │
│  │ get_top_commands()   │    │                            │  │
│  │ get_categories()     │    │                            │  │
│  │ save_command_cat()   │    │                            │  │
│  └──────────────────────┘    └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 2. Data Model

```typescript
// Frontend types (TerminalMemory.tsx)
interface CommandRecord {
  command: string;           // e.g. "docker ps -a"
  category: string;          // e.g. "docker", "git", "files"
  timestamp: number;         // epoch ms
  count: number;             // how many times used
}

interface TermMemoryState {
  commands: CommandRecord[];
  categories: string[];      // e.g. ["docker", "git", "files", "network", ...]
}
```

```rust
// Rust structs (terminal_memory.rs)
#[derive(Serialize, Deserialize)]
struct CommandRecord {
    command: String,
    category: String,
    timestamp: u64,
    count: u32,
}

#[derive(Serialize, Deserialize)]
struct TermMemoryDB {
    commands: Vec<CommandRecord>,
    categories: Vec<String>,
}
```

Storage: JSON file at `~/.config/nolock/terminal-memory.json` (Linux) or
`$HOME/Library/Application Support/nolock/terminal-memory.json` (macOS) or
similar platform-appropriate path via `dirs` crate or `std::env::var("HOME")`.

## 3. Files to Create / Modify

### New Files

| # | File | Lines | Purpose |
|---|------|-------|---------|
| 1 | `src/components/TerminalMemoryOverlay.tsx` | ~180 | Overlay component: top 5 commands, categories list, save-input mode |
| 2 | `src/components/__tests__/TerminalMemoryOverlay.test.tsx` | ~80 | Tests for overlay rendering, keyboard navigation, save flow |
| 3 | `src-tauri/src/terminal_memory.rs` | ~250 | Rust module: data model, persistence, all Tauri commands |
| 4 | `.planning/TERMINAL_MEMORY.md` | (this) | Design document |

### Existing Files to Modify

| # | File | Changes | Est. Lines |
|---|------|---------|------------|
| 1 | `src/components/Terminal.tsx` | Add keystroke buffer to `TerminalView`, track commands, expose `lastCommand` ref, invoke `record_command` on Enter | ~60 |
| 2 | `src/App.tsx` | Add `chordPrefix` state ('A'|'T'|null), Ctrl+T,M chord handler for overlay, Ctrl+T,T for new terminal | ~50 |
| 3 | `src/styles.css` | Styles for the overlay component, categories, save-input | ~80 |
| 4 | `src-tauri/src/main.rs` | Add `mod terminal_memory;`, `manage(terminal_memory::TermMemory::new())`, register commands in `invoke_handler![]` | ~20 |
| 5 | `src/__tests__/App.test.tsx` | Add tests for new keyboard shortcuts | ~30 |

## 4. Detailed Implementation Steps

### Step 1: Rust Backend — `src-tauri/src/terminal_memory.rs` (~250 lines)

```rust
use std::sync::Mutex;
use std::collections::HashMap;

struct TermMemory {
    db: Mutex<TermMemoryDB>,
    db_path: Mutex<std::path::PathBuf>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TermMemoryDB {
    commands: Vec<CommandRecord>,
    categories: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CommandRecord {
    command: String,
    category: String,
    timestamp: u64,
    count: u32,
}

impl TermMemory {
    fn new() -> Self { ... }
    fn load_or_create(path: &std::path::Path) -> TermMemoryDB { ... }
    fn save(&self) { ... }
}

#[tauri::command]
fn record_command(state: tauri::State<TermMemory>, command: String) -> Result<(), String> {
    // 1. Lock DB
    // 2. Find existing command (fuzzy or exact match)
    // 3. If found, increment count, update timestamp; if not, add new record
    // 4. If no category, assign "uncategorized"
    // 5. Save to file
}

#[tauri::command]
fn get_top_commands(state: tauri::State<TermMemory>) -> Result<Vec<CommandRecord>, String> {
    // 1. Lock DB
    // 2. Sort by count desc, take top 5
    // 3. Return as Vec<CommandRecord>
}

#[tauri::command]
fn get_command_categories(state: tauri::State<TermMemory>) -> Result<Vec<String>, String> {
    // 1. Lock DB
    // 2. Return categories list
}

#[tauri::command]
fn save_command_category(
    state: tauri::State<TermMemory>,
    command: String,
    category: String,
) -> Result<(), String> {
    // 1. Lock DB
    // 2. Update the matching command record's category
    // 3. Add category to categories list if new
    // 4. Save
}
```

### Step 2: Terminal Keystroke Buffer — `src/components/Terminal.tsx` (~60 lines added)

In the `TerminalView` component's `useEffect`:

```typescript
// Add a ref to buffer keystrokes
const lineBufferRef = useRef<string>("");

// In onData handler:
const dataDisposable = term.onData((data: string) => {
  // Forward to PTY (existing)
  invoke("pty_write", { id: instance.id, data }).catch(() => {});

  // --- NEW: Track commands ---
  // Carriage return = Enter pressed = command submitted
  if (data === "\r") {
    const cmd = lineBufferRef.current.trim();
    if (cmd.length > 0) {
      invoke("record_command", { command: cmd }).catch(() => {});
    }
    lineBufferRef.current = "";
  }
  // Backspace / delete
  else if (data === "\x7f") {
    lineBufferRef.current = lineBufferRef.current.slice(0, -1);
  }
  // Ctrl+U (clear line)
  else if (data === "\x15") {
    lineBufferRef.current = "";
  }
  // Printable characters + tabs
  else if (data.length === 1 || data === "\t") {
    lineBufferRef.current += data;
  }
  // Note: arrow keys, home/end, etc. (escape sequences) are ignored
  // which is fine — they navigate history but don't change the current
  // line buffer in a way we can track without full terminal emulation.
});
```

Also expose `lastCommand` via a ref so the overlay can access it for save mode:

```typescript
// Add to TerminalViewProps:
interface TerminalViewProps {
  instance: TerminalInstance;
  rootPath: string;
  lastCommandRef: React.MutableRefObject<string>;
}
```

### Step 3: Overlay Component — `src/components/TerminalMemoryOverlay.tsx` (~180 lines)

```typescript
interface TermMemOverlayProps {
  topCommands: CommandRecord[];
  categories: string[];
  lastCommand: string;
  saveMode: boolean;           // true when waiting for category input
  onSelectCategory: (cat: string) => void;
  onCreateCategory: (cat: string) => void;
  onDismiss: () => void;
}

function TerminalMemoryOverlay({ ... }: TermMemOverlayProps) {
  // Render:
  //   - Header: "Terminal Memory"
  //   - Section 1: Top 5 Commands (with counts and categories)
  //   - Section 2: Categories as clickable tags
  //   - If saveMode: input field at bottom asking "Save as category:"
  //     with autocomplete from existing categories
  //   - Keyboard: up/down to navigate, Enter to select, Escape to dismiss
  //   - S key (in view mode): enter save mode
}
```

### Step 4: Keyboard Shortcut Integration — `src/App.tsx` (~50 lines added)

```typescript
// New state
const [showTermMemory, setShowTermMemory] = useState(false);
const [termMemorySaveMode, setTermMemorySaveMode] = useState(false);
const [lastCommand, setLastCommand] = useState("");
const [topCommands, setTopCommands] = useState<CommandRecord[]>([]);
const [categories, setCategories] = useState<string[]>([]);

// In handleKeyDown:
// Ctrl+Tab — show terminal memory overlay
if (e.ctrlKey && !e.shiftKey && e.key === "Tab") {
  e.preventDefault();
  if (showTermMemory) {
    setShowTermMemory(false);
  } else {
    // Fetch data via invoke
    invoke("get_top_commands").then(setTopCommands);
    invoke("get_command_categories").then(setCategories);
    setShowTermMemory(true);
  }
  return;
}

// Ctrl+Tab+S — enter save mode
if (showTermMemory && e.key === "s") {
  e.preventDefault();
  setTermMemorySaveMode(true);
  return;
}

// Escape — dismiss overlay
if (showTermMemory && e.key === "Escape") {
  setShowTermMemory(false);
  setTermMemorySaveMode(false);
  return;
}
```

Render the overlay conditionally:

```tsx
{showTermMemory && (
  <TerminalMemoryOverlay
    topCommands={topCommands}
    categories={categories}
    lastCommand={lastCommand}
    saveMode={termMemorySaveMode}
    onSelectCategory={(cat) => {
      invoke("save_command_category", { command: lastCommand, category: cat });
      setShowTermMemory(false);
      setTermMemorySaveMode(false);
    }}
    onCreateCategory={(cat) => {
      invoke("save_command_category", { command: lastCommand, category: cat });
      setShowTermMemory(false);
      setTermMemorySaveMode(false);
    }}
    onDismiss={() => {
      setShowTermMemory(false);
      setTermMemorySaveMode(false);
    }}
  />
)}
```

### Step 5: CSS Styles — `src/styles.css` (~80 lines added)

```css
.term-memory-overlay {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 480px;
  max-height: 60vh;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  z-index: 5000;
  display: flex;
  flex-direction: column;
  padding: 16px;
}

/* ... etc */
```

### Step 6: Register Backend Commands — `src-tauri/src/main.rs` (~20 lines)

```rust
mod terminal_memory;

// In run():
.manage(terminal_memory::TermMemory::new())

// In invoke_handler![]:
terminal_memory::record_command,
terminal_memory::get_top_commands,
terminal_memory::get_command_categories,
terminal_memory::save_command_category,
```

## 5. Key Technical Challenges & Mitigations

| Challenge | Mitigation |
|-----------|------------|
| **Command capture accuracy**: PTY sends raw bytes; shell editing (arrow keys, Ctrl+W, tab completion) corrupts line buffer | Accept best-effort tracking. Use `onData` buffer that handles `\r`, `\x7f` (backspace), `\x15` (Ctrl+U). More advanced editing sequences are shell-specific and out of scope. The feature is still useful with ~80% accuracy. |
| **Ctrl+Tab browser conflict**: Browsers/terminals use Ctrl+Tab for tab switching | `e.preventDefault()` works in Tauri's webview. The terminal (xterm.js) does not capture Ctrl+Tab by default — it passes through to the DOM. |
| **Overlay focus vs terminal focus**: When overlay is open, keystrokes should not reach the PTY | Render overlay as a fixed modal that captures focus. On dismiss, re-focus the terminal. Use `term.focus()` on the xterm instance. |
| **Persistence location**: Cross-platform config dir | Use `dirs::data_dir()` in Rust (or `$HOME/.config` on Linux, `~/Library/Application Support` on macOS). |
| **Concurrent PTY instances**: Multiple terminal tabs | Each tab has its own `id`. Track commands per `instance.id` in the frontend buffer. The backend records commands globally (no per-instance distinction needed — a command is a command). |

## 6. Testing Strategy

### Rust Backend Tests (in `terminal_memory.rs`)

| Test | Type | Coverage |
|------|------|----------|
| `test_record_and_retrieve` | Unit | Record a command, retrieve top commands, verify ordering |
| `test_record_increments_count` | Unit | Same command recorded twice → count=2 |
| `test_save_category` | Unit | Save a category, verify it appears in categories list |
| `test_empty_db` | Unit | No commands recorded → empty lists |
| `test_persistence_roundtrip` | Unit | Write to temp file, read back, verify integrity |
| `test_max_five_commands` | Unit | Record 10 commands, verify only top 5 returned |
| `test_unknown_category_added` | Unit | Save with new category → category auto-added to list |

### Frontend Tests

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `TerminalMemoryOverlay.test.tsx` | ~6 | Renders top commands, shows categories, save input appears on `s` key, dismisses on Escape, keyboard navigation |
| `App.test.tsx` | ~3 | Ctrl+Tab shows overlay, Ctrl+Tab+S enters save mode, Escape hides overlay |

## 7. Effort Estimate

| Component | Est. Hours | Complexity |
|-----------|------------|------------|
| Rust backend (`terminal_memory.rs`) | 3-4h | Medium |
| Frontend overlay component | 2-3h | Medium |
| Terminal keystroke tracking | 1-2h | Medium-High |
| Keyboard shortcut integration | 1h | Low |
| CSS styles | 0.5h | Low |
| Tests (Rust + Frontend) | 2-3h | Medium |
| **Total** | **~10-14h** | **Moderate** |

## 8. Future Enhancements (Out of Scope for v1)

- **Fuzzy matching**: Match commands by similarity (e.g., `docker ps` ≈ `docker ps -a`)
- **Shell integration**: Hook into bash `PROMPT_COMMAND` or zsh `preexec` for 100% accurate command capture
- **Frequency decay**: Older commands get lower weight so top 5 reflects recent usage
- **Category stats**: Show how many commands per category, most-used category
- **Export/import**: Share command memory across machines

---

## 9. Conclusion

**The Terminal Memory feature is very feasible** given the current architecture:

1. **Pattern reuse**: The existing chord shortcut system (Ctrl+A, C / I) maps directly to the Ctrl+Tab, S pattern.
2. **State management**: `useState` in App.tsx + Rust `Mutex<TermMemoryDB>` follows established PtyState patterns.
3. **Persistence**: JSON file in config dir is simple and reliable.
4. **No new dependencies**: Everything uses existing crates (`serde`, `serde_json`, `std::fs`) and npm packages.
5. **Incremental adoption**: The feature can be shipped with best-effort command capture (documented limitation) and improved later.

**Recommendation**: Greenlit for implementation. Start with the Rust backend (data model + persistence), then the frontend overlay, then wire up keyboard shortcuts and tests.
