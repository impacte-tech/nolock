// ---------------------------------------------------------------------------
// Terminal Memory — records terminal commands, tracks frequency, and manages
// user-assigned categories. Persisted as JSON in ~/.config/nolock/terminal-memory.json
// ---------------------------------------------------------------------------

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandRecord {
    pub command: String,
    pub category: String,
    pub timestamp: u64,
    pub count: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TermMemoryDB {
    commands: Vec<CommandRecord>,
    categories: Vec<String>,
}

impl TermMemoryDB {
    fn empty() -> Self {
        TermMemoryDB {
            commands: Vec::new(),
            categories: vec!["uncategorized".to_string()],
        }
    }
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct TermMemory {
    db: Mutex<TermMemoryDB>,
    db_path: Mutex<PathBuf>,
}

impl TermMemory {
    pub fn new() -> Self {
        let path = Self::default_path();
        let db = Self::load_or_create(&path);
        TermMemory {
            db: Mutex::new(db),
            db_path: Mutex::new(path),
        }
    }

    fn default_path() -> PathBuf {
        // Use $HOME/.config/nolock/terminal-memory.json
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        let mut path = PathBuf::from(&home);
        path.push(".config");
        path.push("nolock");
        path
    }

    fn load_or_create(path: &PathBuf) -> TermMemoryDB {
        let file_path = path.join("terminal-memory.json");
        if file_path.exists() {
            match fs::read_to_string(&file_path) {
                Ok(content) => {
                    if let Ok(db) = serde_json::from_str::<TermMemoryDB>(&content) {
                        return db;
                    }
                    eprintln!("[terminal_memory] Corrupt DB, creating fresh");
                }
                Err(e) => {
                    eprintln!("[terminal_memory] Failed to read DB: {}", e);
                }
            }
        }
        // Ensure directory exists
        let _ = fs::create_dir_all(path);
        TermMemoryDB::empty()
    }

    fn save(&self) {
        let path = self.db_path.lock().unwrap().clone();
        let db = self.db.lock().unwrap();
        let file_path = path.join("terminal-memory.json");
        let _ = fs::create_dir_all(&path);
        match serde_json::to_string_pretty(&*db) {
            Ok(json) => {
                if let Err(e) = fs::write(&file_path, &json) {
                    eprintln!("[terminal_memory] Failed to write DB: {}", e);
                }
            }
            Err(e) => {
                eprintln!("[terminal_memory] Failed to serialize DB: {}", e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Record that a command was executed. Increments count if it already exists,
/// otherwise adds a new entry with category "uncategorized".
#[tauri::command]
pub fn record_command(state: tauri::State<'_, TermMemory>, command: String) -> Result<(), String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut db = state.db.lock().map_err(|e| e.to_string())?;

    // Check if command already exists (exact match on trimmed)
    if let Some(existing) = db.commands.iter_mut().find(|c| c.command == trimmed) {
        existing.count = existing.count.saturating_add(1);
        existing.timestamp = now;
    } else {
        db.commands.push(CommandRecord {
            command: trimmed,
            category: "uncategorized".to_string(),
            timestamp: now,
            count: 1,
        });
    }

    drop(db);
    state.save();
    Ok(())
}

/// Returns the top 5 most frequently used commands, sorted by count descending.
#[tauri::command]
pub fn get_top_commands(state: tauri::State<'_, TermMemory>) -> Result<Vec<CommandRecord>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut sorted = db.commands.clone();
    sorted.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| b.timestamp.cmp(&a.timestamp))
    });
    sorted.truncate(5);
    Ok(sorted)
}

/// Returns all known categories.
#[tauri::command]
pub fn get_command_categories(state: tauri::State<'_, TermMemory>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.categories.clone())
}

/// Assign (or re-assign) a category to a command.
/// If the category is new, it is automatically added to the categories list.
#[tauri::command]
pub fn save_command_category(
    state: tauri::State<'_, TermMemory>,
    command: String,
    category: String,
) -> Result<(), String> {
    let cat = category.trim().to_string();
    if cat.is_empty() {
        return Err("Category cannot be empty".to_string());
    }

    let mut db = state.db.lock().map_err(|e| e.to_string())?;

    // Update the command record
    if let Some(record) = db.commands.iter_mut().find(|c| c.command == command) {
        record.category = cat.clone();
    } else {
        // Command not found — still possible to create a record for it
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        db.commands.push(CommandRecord {
            command,
            category: cat.clone(),
            timestamp: now,
            count: 0,
        });
    }

    // Add category if new
    if !db.categories.contains(&cat) {
        db.categories.push(cat);
        db.categories.sort();
    }

    drop(db);
    state.save();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a TermMemory with a unique temp path for testing.
    /// Each test gets its own subdirectory based on the test name to avoid
    /// cross-contamination between tests.
    fn test_memory(name: &str) -> TermMemory {
        let mut path = std::env::temp_dir();
        path.push("nolock_term_memory_test");
        path.push(name);
        let _ = fs::create_dir_all(&path);

        // Clear any previous test DB
        let db_path = path.join("terminal-memory.json");
        let _ = fs::remove_file(&db_path);

        let db = TermMemoryDB::empty();
        TermMemory {
            db: Mutex::new(db),
            db_path: Mutex::new(path),
        }
    }

    /// Helper: invoke record_command logic directly on a TermMemory without
    /// going through tauri::State. This avoids the unsafe transmute and makes
    /// the tests completely self-contained.
    fn record_on(mem: &TermMemory, command: &str) -> Result<(), String> {
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut db = mem.db.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = db.commands.iter_mut().find(|c| c.command == trimmed) {
            existing.count = existing.count.saturating_add(1);
            existing.timestamp = now;
        } else {
            db.commands.push(CommandRecord {
                command: trimmed,
                category: "uncategorized".to_string(),
                timestamp: now,
                count: 1,
            });
        }
        drop(db);
        mem.save();
        Ok(())
    }

    fn save_cat_on(mem: &TermMemory, command: &str, category: &str) -> Result<(), String> {
        let cat = category.trim().to_string();
        if cat.is_empty() {
            return Err("Category cannot be empty".to_string());
        }
        let mut db = mem.db.lock().map_err(|e| e.to_string())?;
        if let Some(record) = db.commands.iter_mut().find(|c| c.command == command) {
            record.category = cat.clone();
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            db.commands.push(CommandRecord {
                command: command.to_string(),
                category: cat.clone(),
                timestamp: now,
                count: 0,
            });
        }
        if !db.categories.contains(&cat) {
            db.categories.push(cat);
            db.categories.sort();
        }
        drop(db);
        mem.save();
        Ok(())
    }

    fn top_commands_on(mem: &TermMemory) -> Vec<CommandRecord> {
        let db = mem.db.lock().unwrap();
        let mut sorted = db.commands.clone();
        sorted.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| b.timestamp.cmp(&a.timestamp))
        });
        sorted.truncate(5);
        sorted
    }

    fn categories_on(mem: &TermMemory) -> Vec<String> {
        let db = mem.db.lock().unwrap();
        db.categories.clone()
    }

    #[test]
    fn test_record_and_retrieve() {
        let mem = test_memory("record_and_retrieve");

        record_on(&mem, "docker ps").unwrap();
        record_on(&mem, "git status").unwrap();
        record_on(&mem, "ls -la").unwrap();

        let top = top_commands_on(&mem);
        assert_eq!(top.len(), 3);
        let cmds: Vec<&str> = top.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"docker ps"));
        assert!(cmds.contains(&"git status"));
        assert!(cmds.contains(&"ls -la"));
    }

    #[test]
    fn test_record_increments_count() {
        let mem = test_memory("increments_count");

        record_on(&mem, "docker ps").unwrap();
        record_on(&mem, "docker ps").unwrap();
        record_on(&mem, "docker ps").unwrap();

        let top = top_commands_on(&mem);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].command, "docker ps");
        assert_eq!(top[0].count, 3);
    }

    #[test]
    fn test_top_five_only() {
        let mem = test_memory("top_five_only");

        for i in 0..8 {
            record_on(&mem, &format!("cmd_{}", i)).unwrap();
        }

        let top = top_commands_on(&mem);
        assert_eq!(top.len(), 5);
    }

    #[test]
    fn test_save_category() {
        let mem = test_memory("save_category");

        record_on(&mem, "docker ps").unwrap();
        save_cat_on(&mem, "docker ps", "docker").unwrap();

        let top = top_commands_on(&mem);
        assert_eq!(top[0].category, "docker");

        let cats = categories_on(&mem);
        assert!(cats.contains(&"docker".to_string()));
    }

    #[test]
    fn test_new_category_auto_added() {
        let mem = test_memory("new_category");

        record_on(&mem, "kubectl get pods").unwrap();
        save_cat_on(&mem, "kubectl get pods", "kubernetes").unwrap();

        let cats = categories_on(&mem);
        assert!(cats.contains(&"kubernetes".to_string()));
    }

    #[test]
    fn test_empty_db() {
        let mem = test_memory("empty_db");
        let top = top_commands_on(&mem);
        assert!(top.is_empty());
    }

    #[test]
    fn test_empty_command_ignored() {
        let mem = test_memory("empty_command");
        assert!(record_on(&mem, "   ").is_ok());
        let top = top_commands_on(&mem);
        assert!(top.is_empty());
    }

    #[test]
    fn test_persistence_roundtrip() {
        let mem = test_memory("persistence");

        record_on(&mem, "echo hello").unwrap();
        record_on(&mem, "ls").unwrap();
        save_cat_on(&mem, "echo hello", "shell").unwrap();

        let path = mem.db_path.lock().unwrap().clone();
        // save() is called automatically by record_on and save_cat_on
        drop(mem);

        let loaded_db = TermMemory::load_or_create(&path);
        assert_eq!(loaded_db.commands.len(), 2);
        assert!(loaded_db.categories.contains(&"shell".to_string()));

        // Cleanup
        let file_path = path.join("terminal-memory.json");
        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn test_save_category_empty_rejected() {
        let mem = test_memory("empty_category");
        record_on(&mem, "some cmd").unwrap();
        let result = save_cat_on(&mem, "some cmd", "  ");
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_commands_same_category() {
        let mem = test_memory("same_category");

        record_on(&mem, "git status").unwrap();
        record_on(&mem, "git add .").unwrap();
        record_on(&mem, "git commit").unwrap();

        save_cat_on(&mem, "git status", "git").unwrap();
        save_cat_on(&mem, "git add .", "git").unwrap();
        save_cat_on(&mem, "git commit", "git").unwrap();

        let top = top_commands_on(&mem);
        assert_eq!(top.len(), 3);
        for cmd in &top {
            assert_eq!(cmd.category, "git");
        }
    }
}
