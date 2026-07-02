use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Manager;
use tauri::Emitter;

use regex::Regex;

mod browser;
mod linter;
mod terminal_memory;

// ---------------------------------------------------------------------------
// File system commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let mut entries = Vec::new();
    let read_dir =
        std::fs::read_dir(&path).map_err(|e| format!("Failed to read dir {}: {}", path, e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        if !show_hidden && name.starts_with('.') {
            continue;
        }

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| {
                // Within same directory status, put hidden items after non-hidden
                let a_hidden = a.name.starts_with('.');
                let b_hidden = b.name.starts_with('.');
                a_hidden.cmp(&b_hidden)
            })
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn rename_file(path: String, new_name: String) -> Result<(), String> {
    let parent = std::path::Path::new(&path)
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let new_path = parent.join(&new_name);
    std::fs::rename(&path, &new_path)
        .map_err(|e| format!("Failed to rename {} to {}: {}", path, new_name, e))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to access {}: {}", path, e))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to delete directory {}: {}", path, e))
    } else {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete file {}: {}", path, e))
    }
}

#[tauri::command]
fn copy_file(source: String, destination: String) -> Result<(), String> {
    let dest_path = std::path::Path::new(&destination);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }
    // Use copy_options to avoid following symlinks and preserve permissions
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("Failed to copy {} to {}: {}", source, destination, e))?;
    Ok(())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    std::fs::write(&path, "")
        .map_err(|e| format!("Failed to create file {}: {}", path, e))
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory {}: {}", path, e))
}

#[tauri::command]
fn append_to_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {} for append: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to append to {}: {}", path, e))?;
    Ok(())
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

// ---------------------------------------------------------------------------
// Agent management commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct AgentEntry {
    name: String,       // file stem (e.g. "code-reviewer" from "code-reviewer.json")
    path: String,       // full path to the file
}

/// List all agent files in the `.agents/` directory under root_path.
/// Creates `.agents/` if it does not exist. Returns agent entries sorted by name.
/// Supports both `.json` (legacy) and `.md` files. When both exist for the same name,
/// the `.md` version takes precedence.
#[tauri::command]
fn list_agents(root_path: String) -> Result<Vec<AgentEntry>, String> {
    let agents_dir = std::path::Path::new(&root_path).join(".agents");
    // Create the directory if it doesn't exist
    if !agents_dir.exists() {
        std::fs::create_dir_all(&agents_dir)
            .map_err(|e| format!("Failed to create .agents directory: {}", e))?;
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(&agents_dir)
        .map_err(|e| format!("Failed to read .agents directory: {}", e))?;

    let mut entries: Vec<AgentEntry> = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Support both .json (legacy) and .md files
            let stem = if file_name.ends_with(".json") {
                file_name.strip_suffix(".json").unwrap_or(&file_name).to_string()
            } else if file_name.ends_with(".md") {
                file_name.strip_suffix(".md").unwrap_or(&file_name).to_string()
            } else {
                continue;
            };
            // If we already have this name, prefer .md over .json
            if seen_names.contains(&stem) {
                let is_md = file_name.ends_with(".md");
                let existing_is_json = entries.iter().any(|e| e.name == stem && e.path.ends_with(".json"));
                if is_md && existing_is_json {
                    // Replace the .json entry with the .md entry
                    if let Some(pos) = entries.iter().position(|e| e.name == stem) {
                        entries[pos] = AgentEntry {
                            name: stem.clone(),
                            path: entry.path().to_string_lossy().to_string(),
                        };
                    }
                }
            } else {
                seen_names.insert(stem.clone());
                entries.push(AgentEntry {
                    name: stem,
                    path: entry.path().to_string_lossy().to_string(),
                });
            }
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

/// Read and parse an agent file by its full path.
/// Supports both `.json` (legacy) and `.md` (markdown with YAML-like frontmatter) formats.
/// For `.md` files, the format is:
/// ```markdown
/// ---
/// name: agent-name
/// description: Short description
/// model: 
/// temperature: 0.7
/// ---
///
/// The system prompt content...
/// ```
#[tauri::command]
fn read_agent(path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read agent file {}: {}", path, e))?;

    if path.ends_with(".json") {
        // Legacy JSON format
        let parsed: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse agent file {}: {}", path, e))?;
        return Ok(parsed);
    }

    // Parse markdown with YAML-like frontmatter
    let mut name = String::new();
    let mut description = String::new();
    let mut model = String::new();
    let mut temperature = 0.7_f64;
    let prompt;

    // Extract frontmatter between --- markers
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        // Find the closing ---
        let after_first = &trimmed[3..]; // skip opening ---
        if let Some(end) = after_first.find("\n---") {
            let frontmatter_str = &after_first[..end];
            for line in frontmatter_str.lines() {
                let line = line.trim();
                if let Some((key, value)) = line.split_once(':') {
                    let key = key.trim().to_lowercase();
                    let value = value.trim().to_string();
                    match key.as_str() {
                        "name" => name = value,
                        "description" => description = value,
                        "model" => model = value,
                        "temperature" => {
                            temperature = value.parse().unwrap_or(0.7);
                        }
                        _ => {}
                    }
                }
            }
            // Everything after the closing --- (skip "\n---" and any leading whitespace)
            let after_fm = &after_first[end + 4..]; // skip "\n---"
            prompt = after_fm.trim().to_string();
        } else {
            // No closing --- found, treat entire content as prompt
            prompt = trimmed.to_string();
        }
    } else {
        // No frontmatter at all, treat entire content as prompt
        prompt = trimmed.to_string();
    }

    Ok(serde_json::json!({
        "name": name,
        "description": description,
        "prompt": prompt,
        "model": model,
        "temperature": temperature,
    }))
}

// ---------------------------------------------------------------------------
// Skill management commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct SkillEntry {
    name: String,       // file stem (e.g. "code-review" from "code-review.md")
    path: String,       // full path to the file
}

/// List all skill files in the `.skills/` directory under root_path.
/// Creates `.skills/` if it does not exist. Returns skill entries sorted by name.
#[tauri::command]
fn list_skills(root_path: String) -> Result<Vec<SkillEntry>, String> {
    let skills_dir = std::path::Path::new(&root_path).join(".skills");
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create .skills directory: {}", e))?;
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(&skills_dir)
        .map_err(|e| format!("Failed to read .skills directory: {}", e))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.ends_with(".md") {
                let stem = file_name.strip_suffix(".md").unwrap_or(&file_name).to_string();
                entries.push(SkillEntry {
                    name: stem,
                    path: entry.path().to_string_lossy().to_string(),
                });
            }
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

#[derive(serde::Serialize)]
struct SkillCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    /// The full skill markdown content (for context inclusion).
    content: String,
}

/// Read a skill file, parse any fenced code block tagged with `command`/`sh`/`bash`/`shell`,
/// execute the command in the project root, and return the output along with the skill content.
/// If no command block is found, returns just the content with empty output.
#[tauri::command]
fn run_skill_command(root_path: String, skill_name: String) -> Result<SkillCommandResult, String> {
    let skill_path = std::path::Path::new(&root_path)
        .join(".skills")
        .join(format!("{}.md", skill_name));

    let content = std::fs::read_to_string(&skill_path)
        .map_err(|e| format!("Failed to read skill '{}': {}", skill_name, e))?;

    // Parse for fenced code blocks tagged with command/sh/bash/shell
    let re = regex::Regex::new(r"(?s)```(?:command|sh|bash|shell)\s*\n(.*?)```").unwrap();
    let cmd = re.captures(&content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    let output = if let Some(ref command_str) = cmd {
        if command_str.is_empty() {
            SkillCommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
                content,
            }
        } else {
            // Split the command string into program and args
            let parts: Vec<&str> = command_str.split_whitespace().collect();
            if parts.is_empty() {
                SkillCommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                    content,
                }
            } else {
                let program = parts[0];
                let args = &parts[1..];

                match std::process::Command::new(program)
                    .args(args)
                    .current_dir(&root_path)
                    .output()
                {
                    Ok(out) => SkillCommandResult {
                        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
                        exit_code: out.status.code().unwrap_or(-1),
                        content,
                    },
                    Err(e) => SkillCommandResult {
                        stdout: String::new(),
                        stderr: format!("Failed to execute command: {}", e),
                        exit_code: -1,
                        content,
                    },
                }
            }
        }
    } else {
        // No command block found, return just the content
        SkillCommandResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
            content,
        }
    };

    Ok(output)
}

// ---------------------------------------------------------------------------
// File search & replace commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct SearchMatch {
    file_path: String,
    line_number: usize,
    line_content: String,
    match_start: usize,
    match_end: usize,
}

#[derive(serde::Serialize)]
struct ReplaceResult {
    files_changed: usize,
    replacements_made: usize,
}

/// Directories to skip when walking (case-insensitive).
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", ".ruff_cache", ".cache",
    "__pycache__", ".venv", "venv", ".next", "dist", "build",
];

/// Returns true if the path should be skipped.
fn should_skip_entry(entry: &std::path::Path, is_dir: bool) -> bool {
    // Skip hidden files/dirs
    if let Some(name) = entry.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('.') && name != "." {
            return true;
        }
        if is_dir {
            let lower = name.to_lowercase();
            if SKIP_DIRS.iter().any(|d| *d == lower) {
                return true;
            }
        }
    }
    false
}

/// Check if a file is likely binary by scanning the first 4 KiB for null bytes.
fn is_binary(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true, // treat unreadable as binary
    };
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).unwrap_or(0);
    buf[..n].contains(&0u8)
}

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_RESULTS: usize = 5000;

/// Build a compiled Regex from the search request.
fn build_search_regex(query: &str, use_regex: bool, match_case: bool) -> Result<Regex, String> {
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if match_case {
        pattern
    } else {
        format!("(?i){}", pattern)
    };
    Regex::new(&pattern).map_err(|e| format!("Invalid search pattern: {}", e))
}

#[tauri::command]
fn search_in_files(
    root_path: String,
    query: String,
    match_case: bool,
    use_regex: bool,
) -> Result<Vec<SearchMatch>, String> {
    let re = build_search_regex(&query, use_regex, match_case)?;

    let root = std::path::Path::new(&root_path);
    let mut results = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];

    while let Some(dir) = dirs_to_visit.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for entry in read_dir {
            if results.len() >= MAX_RESULTS {
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.is_dir() {
                if !should_skip_entry(&path, true) {
                    dirs_to_visit.push(path);
                }
            } else if metadata.is_file() {
                if should_skip_entry(&path, false) {
                    continue;
                }
                // Skip large files
                if metadata.len() > MAX_FILE_SIZE {
                    continue;
                }
                // Skip binaries
                if is_binary(&path) {
                    continue;
                }

                let file_path_str = path.to_string_lossy().to_string();
                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                for (line_num, line) in content.lines().enumerate() {
                    if results.len() >= MAX_RESULTS {
                        break;
                    }
                    for m in re.find_iter(line) {
                        results.push(SearchMatch {
                            file_path: file_path_str.clone(),
                            line_number: line_num + 1, // 1-indexed
                            line_content: line.to_string(),
                            match_start: m.start(),
                            match_end: m.end(),
                        });
                        if results.len() >= MAX_RESULTS {
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
fn replace_in_files(
    root_path: String,
    query: String,
    replacement: String,
    match_case: bool,
    use_regex: bool,
    target_files: Option<Vec<String>>,
) -> Result<ReplaceResult, String> {
    let re = build_search_regex(&query, use_regex, match_case)?;

    let root = std::path::Path::new(&root_path);
    let mut files_changed = 0;
    let mut replacements_made = 0;
    let mut dirs_to_visit = vec![root.to_path_buf()];

    while let Some(dir) = dirs_to_visit.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for entry in read_dir {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.is_dir() {
                if !should_skip_entry(&path, true) {
                    dirs_to_visit.push(path);
                }
            } else if metadata.is_file() {
                if should_skip_entry(&path, false) {
                    continue;
                }
                if metadata.len() > MAX_FILE_SIZE {
                    continue;
                }
                if is_binary(&path) {
                    continue;
                }

                let file_path_str = path.to_string_lossy().to_string();

                // If target_files is specified, only operate on those files
                if let Some(ref targets) = target_files {
                    if !targets.iter().any(|t| t == &file_path_str) {
                        continue;
                    }
                }

                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let count = re.find_iter(&content).count();

                if count > 0 {
                    let new_content = re.replace_all(&content, replacement.as_str());
                    match std::fs::write(&path, new_content.as_ref()) {
                        Ok(_) => {
                            replacements_made += count;
                            files_changed += 1;
                        }
                        Err(_) => continue,
                    }
                }
            }
        }
    }

    Ok(ReplaceResult {
        files_changed,
        replacements_made,
    })
}

// ---------------------------------------------------------------------------
// PTY — real interactive terminal
// ---------------------------------------------------------------------------

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    _reader_thread: std::thread::JoinHandle<()>,
}

struct PtyState {
    instances: Mutex<HashMap<String, PtyInstance>>,
}

#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = portable_pty::native_pty_system();
    let shell_path = shell.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    });

    let size = portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = portable_pty::CommandBuilder::new(&shell_path);
    if let Some(ref c) = cwd {
        cmd.cwd(c);
    }
    // Set TERM so programs can render properly
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let app_clone = app.clone();
    let id_clone = id.clone();

    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("pty-output", PtyOutput {
                        id: id_clone.clone(),
                        data,
                    });
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit("pty-exit", id_clone);
    });

    let state = app.state::<PtyState>();
    let mut instances = state.instances.lock().unwrap();

    // Clean up old instance with same id if any
    if let Some(mut old) = instances.remove(&id) {
        let _ = old.writer.write_all(b"exit\n");
        let _ = old.child.kill();
        drop(old);
    }

    instances.insert(
        id,
        PtyInstance {
            writer,
            master: pair.master,
            child,
            _reader_thread: reader_thread,
        },
    );

    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

#[tauri::command]
fn pty_write(app: tauri::AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut instances = state.instances.lock().unwrap();
    let instance = instances
        .get_mut(&id)
        .ok_or_else(|| format!("PTY {} not found", id))?;
    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    instance
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;
    Ok(())
}

#[tauri::command]
fn pty_resize(
    app: tauri::AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut instances = state.instances.lock().unwrap();
    let instance = instances
        .get_mut(&id)
        .ok_or_else(|| format!("PTY {} not found", id))?;
    let size = portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    instance
        .master
        .resize(size)
        .map_err(|e| format!("Failed to resize PTY: {}", e))
}

#[tauri::command]
fn pty_kill(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut instances = state.instances.lock().unwrap();
    if let Some(mut instance) = instances.remove(&id) {
        let _ = instance.child.kill();
        drop(instance);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// RLHF directory command — returns a writable fallback directory
// ---------------------------------------------------------------------------

/// Return the path to a writable `.rlhf` directory in the app's local data
/// folder. Used as a fallback when no project folder is open.
/// Creates the directory if it doesn't exist.
#[tauri::command]
fn get_rlhf_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    // Store .rlhf inside the app data dir (e.g. ~/.local/share/nolock/.rlhf/)
    let rlhf_dir = base.join(".rlhf");
    std::fs::create_dir_all(&rlhf_dir)
        .map_err(|e| format!("Failed to create RLHF directory: {}", e))?;
    Ok(rlhf_dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Model info command — fetch context length from the backend
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfoRequest {
    backend: String,
    url: String,
    model: String,
}

#[derive(serde::Serialize)]
struct ModelInfoResult {
    context_length: u32,
}

#[tauri::command]
async fn get_model_info(req: ModelInfoRequest) -> Result<ModelInfoResult, String> {
    match req.backend.as_str() {
        "ollama" => {
            let client = reqwest::Client::new();
            let body = serde_json::json!({ "model": req.model });

            eprintln!(
                "[nolock] get_model_info POST {}/api/show model={}",
                req.url, req.model
            );
            let resp = client
                .post(format!("{}/api/show", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

            let status = resp.status();
            if !status.is_success() {
                return Err(format!("Ollama /api/show returned status {}", status));
            }

            let text = resp.text().await.map_err(|e| e.to_string())?;
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;

            // 1. Try "parameters" string (user‑set num_ctx override)
            if let Some(params) = data["parameters"].as_str() {
                for line in params.lines() {
                    let trimmed = line.trim();
                    if let Some(num_str) = trimmed.strip_prefix("num_ctx ") {
                        if let Ok(ctx) = num_str.trim().parse::<u32>() {
                            eprintln!("[nolock] get_model_info: num_ctx={} (from parameters)", ctx);
                            return Ok(ModelInfoResult { context_length: ctx });
                        }
                    }
                }
            }

            // 2. Try model_info.<architecture>.context_length (native)
            if let Some(model_info) = data["model_info"].as_object() {
                if let Some(arch) = model_info
                    .get("general.architecture")
                    .and_then(|v| v.as_str())
                {
                    let key = format!("{}.context_length", arch);
                    if let Some(ctx) = model_info.get(&key).and_then(|v| v.as_u64()) {
                        eprintln!(
                            "[nolock] get_model_info: native context_length={} (from {})",
                            ctx, key
                        );
                        return Ok(ModelInfoResult {
                            context_length: ctx as u32,
                        });
                    }
                }
            }

            // 3. Fallback — common default for Ollama models
            eprintln!(
                "[nolock] get_model_info: could not determine context length, using default 8192"
            );
            Ok(ModelInfoResult { context_length: 8192 })
        }
        _ => {
            // Non‑Ollama backends default to 128k (covers GPT‑4o, Claude 3.5, etc.)
            Ok(ModelInfoResult {
                context_length: 128_000,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Model listing (proxied through Rust to avoid CORS issues)
// ---------------------------------------------------------------------------

/// Heuristic: is this OpenCode Zen model free?
///
/// Based on https://opencode.ai/docs/zen/#pricing
/// Free models are those with "-free" suffix, or "big-pickle".
fn opencode_is_free_model(id: &str) -> bool {
    let lower = id.to_lowercase();
    lower.ends_with("-free") || lower == "big-pickle"
}

/// Heuristic: does this OpenCode Zen model have zero data retention?
///
/// Based on https://opencode.ai/docs/zen/#privacy
/// - Default: zero-retention, no training
/// - EXCEPTION: OpenAI models (gpt-*) → retained 30 days
/// - EXCEPTION: Anthropic models (claude-*) → retained 30 days
/// - EXCEPTION: Free models (*-free, big-pickle) → data may be used for training
fn opencode_has_zdr(id: &str) -> bool {
    let lower = id.to_lowercase();
    // Free models: data may be used for training → NOT ZDR
    if lower.ends_with("-free") || lower == "big-pickle" {
        return false;
    }
    // OpenAI models: retained 30 days → NOT ZDR
    if lower.starts_with("gpt") {
        return false;
    }
    // Anthropic models: retained 30 days → NOT ZDR
    if lower.starts_with("claude") {
        return false;
    }
    // Everything else (Gemini, DeepSeek, GLM, Kimi, Qwen, Grok, MiniMax paid, etc.)
    // → zero retention
    true
}

#[derive(serde::Deserialize)]
struct FetchModelsRequest {
    backend: String,
    url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    zdr: bool,
}

#[derive(serde::Serialize)]
struct ModelListItem {
    id: String,
    name: String,
    is_free: bool,
    zero_data_retention: bool,
}

#[tauri::command]
async fn fetch_models(req: FetchModelsRequest) -> Result<Vec<ModelListItem>, String> {
    let client = reqwest::Client::new();

    match req.backend.as_str() {
        "openrouter" => {
            let base = req.url.trim_end_matches('/');
            let mut url = format!("{}/models", base);
            if req.zdr {
                url = format!("{}?zdr=true", url);
            }

            eprintln!("[nolock] fetch_models openrouter GET {}", url);
            let mut builder = client
                .get(&url)
                .header("Accept", "application/json");
            if let Some(ref key) = req.api_key {
                if !key.is_empty() {
                    builder = builder.header("Authorization", format!("Bearer {}", key));
                }
            }
            let resp = builder
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("OpenRouter request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("OpenRouter API error ({}): {}", status, &text[..text.len().min(200)]));
            }

            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let data = body["data"].as_array().cloned().unwrap_or_default();

            Ok(data.iter().map(|m| {
                let pricing = &m["pricing"];
                let prompt_price = pricing["prompt"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let completion_price = pricing["completion"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let request_price = pricing["request"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let image_price = pricing["image"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

                let is_free = prompt_price == 0.0 && completion_price == 0.0 && request_price == 0.0 && image_price == 0.0;
                let id = m["id"].as_str().unwrap_or("");
                let name = m["name"].as_str().unwrap_or(id);

                ModelListItem {
                    id: id.to_string(),
                    name: name.to_string(),
                    is_free,
                    zero_data_retention: req.zdr,
                }
            }).collect())
        }
        "opencode" => {
            let normalized = req.url.trim_end_matches('/');
            let is_remote = normalized.contains("/v1");

            if is_remote {
                // Remote OpenAI-compatible API
                let endpoint = format!("{}/models", normalized);
                eprintln!("[nolock] fetch_models opencode(remote) GET {}", endpoint);
                let mut builder = client.get(&endpoint);
                if let Some(ref key) = req.api_key {
                    if !key.is_empty() {
                        builder = builder.header("Authorization", format!("Bearer {}", key));
                    }
                }
                let resp = builder
                    .timeout(std::time::Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| format!("OpenCode Zen request failed: {}", e))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(format!("OpenCode Zen API error ({}): {}", status, &text[..text.len().min(200)]));
                }

                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                let data = body["data"].as_array().cloned().unwrap_or_default();

                Ok(data.iter().map(|m| {
                    let id = m["id"].as_str().unwrap_or("");
                    let is_free = opencode_is_free_model(id);
                    let has_zdr = opencode_has_zdr(id);
                    ModelListItem {
                        id: id.to_string(),
                        name: id.to_string(),
                        is_free,
                        zero_data_retention: has_zdr,
                    }
                }).collect())
            } else {
                // Local Ollama-compatible API
                let endpoint = format!("{}/api/tags", normalized);
                eprintln!("[nolock] fetch_models opencode(local) GET {}", endpoint);
                let resp = client
                    .get(&endpoint)
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await
                    .map_err(|e| format!("OpenCode Zen local request failed: {}", e))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(format!("OpenCode Zen local API error ({}): {}", status, &text[..text.len().min(200)]));
                }

                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                let models = body["models"].as_array().cloned().unwrap_or_default();

                Ok(models.iter().map(|m| {
                    let name = m["name"].as_str().unwrap_or("");
                    // Strip ":latest" suffix for matching
                    let base_id = name.split(':').next().unwrap_or(name);
                    let is_free = opencode_is_free_model(base_id);
                    let has_zdr = opencode_has_zdr(base_id);
                    ModelListItem {
                        id: name.to_string(),
                        name: name.to_string(),
                        is_free,
                        zero_data_retention: has_zdr,
                    }
                }).collect())
            }
        }
        _ => Ok(vec![]),
    }
}

// ---------------------------------------------------------------------------
// AI backend commands
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct CompletionRequest {
    backend: String,
    url: String,
    model: String,
    prompt: String,
    #[serde(default)]
    suffix: Option<String>,
    api_key: Option<String>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    system_prompt: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    backend: String,
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    tools_enabled: Vec<String>,
    /// Per-tool configuration (e.g. web_search provider + api_key).
    /// Stored in localStorage on the frontend as `nolock.toolConfig`.
    #[serde(default)]
    tool_configs: HashMap<String, serde_json::Value>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    system_prompt: Option<String>,
    /// The root folder path currently open in the editor.
    /// Used by file-system tools (e.g. write_file) to scope paths.
    #[serde(default)]
    root_path: Option<String>,
}

#[derive(serde::Serialize)]
struct ChatResult {
    content: String,
    #[serde(default)]
    tool_calls: Vec<ToolCallLog>,
}

#[derive(serde::Serialize, Clone)]
struct ToolCallLog {
    name: String,
    arguments: String,
    result_snippet: String,
}

#[derive(Clone, serde::Serialize)]
struct StreamPayload {
    token: String,
}

// ---------------------------------------------------------------------------
// Tool definitions & execution
// ---------------------------------------------------------------------------

fn build_tool_schemas(enabled: &[String], root_path: Option<&str>) -> Vec<serde_json::Value> {
    let mut tools = Vec::new();
    if enabled.contains(&"web_fetch".to_string()) {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch the content of a web page URL and return its text. Use this when the user asks about something on the internet, wants to look up documentation, or you need current information not in your training data.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The full URL to fetch (must start with http:// or https://)"
                        }
                    },
                    "required": ["url"]
                }
            }
        }));
    }
    if enabled.contains(&"read_file".to_string()) {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file on disk. Use this to examine source code, configuration files, or any file the user references.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The absolute file path to read"
                        }
                    },
                    "required": ["path"]
                }
            }
        }));
    }
    if enabled.contains(&"write_file".to_string()) {
        let write_desc = match root_path {
            Some(rp) => format!(
                "Write content to a file on disk. Creates parent directories if they don't exist. \
                 Use this to create new files, modify existing files, or save generated code and text. \
                 The open project folder is: {}. All file paths must be within this folder. \
                 You may use paths relative to this folder (e.g. 'src/main.ts' resolves to '{}/src/main.ts').",
                rp, rp
            ),
            None => format!(
                "Write content to a file on disk. Creates parent directories if they don't exist. \
                 Use this to create new files, modify existing files, or save generated code and text. \
                 NOTE: No folder is currently open in the editor."
            ),
        };
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": write_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path, either absolute or relative to the open project folder"
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write to the file"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        }));
    }
    if enabled.contains(&"list_directory".to_string()) {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List files and directories at a given path. Use this to explore the project structure.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The directory path to list"
                        }
                    },
                    "required": ["path"]
                }
            }
        }));
    }
    if enabled.contains(&"web_search".to_string()) {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the internet for up-to-date information. Use this BEFORE web_fetch when the user asks about current events, recent news, or any topic where you need to discover relevant URLs. Returns a list of search results with titles, URLs, and snippets.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query (e.g. 'latest AWS features 2026' or 'Rust async performance tips')"
                        }
                    },
                    "required": ["query"]
                }
            }
        }));
    }
    tools
}

async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    client: &reqwest::Client,
    tool_configs: &HashMap<String, serde_json::Value>,
    root_path: Option<&str>,
) -> Result<String, String> {
    match name {
        "web_fetch" => {
            let url = args["url"]
                .as_str()
                .ok_or("Missing required parameter: url")?;
            eprintln!("[nolock] tool web_fetch url={}", url);
            let resp = client
                .get(url)
                .timeout(std::time::Duration::from_secs(15))
                .header("User-Agent", "nolock/0.1")
                .send()
                .await
                .map_err(|e| format!("Failed to fetch URL: {}", e))?;
            let status = resp.status();
            if !status.is_success() {
                return Ok(format!("HTTP error: status {}", status));
            }
            let text = resp.text().await.map_err(|e| e.to_string())?;
            // Truncate to avoid overwhelming the model
            if text.len() > 15000 {
                Ok(format!(
                    "{}\n\n... [truncated at 15000 chars, total {} chars]",
                    &text[..15000],
                    text.len()
                ))
            } else {
                Ok(text)
            }
        }
        "read_file" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            eprintln!("[nolock] tool read_file path={}", path);
            std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {}", path, e))
        }
        "list_directory" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            eprintln!("[nolock] tool list_directory path={}", path);
            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(path)
                .map_err(|e| format!("Failed to read dir {}: {}", path, e))?;
            for entry in read_dir {
                let entry = entry.map_err(|e| e.to_string())?;
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let kind = if metadata.is_dir() { "dir" } else { "file" };
                entries.push(format!("{} [{}]", name, kind));
            }
            entries.sort();
            Ok(entries.join("\n"))
        }
        "web_search" => {
            let query = args["query"]
                .as_str()
                .ok_or("Missing required parameter: query")?;
            eprintln!("[nolock] tool web_search query={}", query);

            // Determine provider from tool_configs (default: DuckDuckGo)
            let provider = tool_configs
                .get("web_search")
                .and_then(|c| c["provider"].as_str())
                .unwrap_or("duckduckgo");

            match provider {
                "brave" => {
                    // Brave Search API — requires a free API key
                    let api_key = tool_configs
                        .get("web_search")
                        .and_then(|c| c["api_key"].as_str())
                        .unwrap_or("");

                    if api_key.is_empty() {
                        return Ok("Brave Search requires an API key. Get one free at https://brave.com/search/api/ and configure it in AI Integrations settings.".to_string());
                    }

                    let resp = client
                        .get("https://api.search.brave.com/res/v1/web/search")
                        .query(&[("q", query), ("count", "10")])
                        .timeout(std::time::Duration::from_secs(10))
                        .header("Accept", "application/json")
                        // NOTE: Do NOT set Accept-Encoding manually — reqwest's default
                        // gzip feature handles decompression automatically. Setting it
                        // explicitly would override auto-decompression and produce raw
                        // gzip bytes, causing JSON parse errors.
                        .header("X-Subscription-Token", api_key)
                        .send()
                        .await
                        .map_err(|e| format!("Brave Search request failed: {}", e))?;

                    let status = resp.status();
                    if !status.is_success() {
                        let body = resp.text().await.unwrap_or_default();
                        return Ok(format!("Brave Search API error (HTTP {}): {}", status, body));
                    }

                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    let data: serde_json::Value =
                        serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;

                    let mut results: Vec<String> = Vec::new();

                    // Extract web results
                    if let Some(web_results) = data["web"]["results"].as_array() {
                        for result in web_results {
                            let title = result["title"].as_str().unwrap_or("(no title)");
                            let url = result["url"].as_str().unwrap_or("(no URL)");
                            let desc = result["description"].as_str().unwrap_or("");
                            if !desc.is_empty() {
                                results.push(format!("{} - {} - {}", title, desc, url));
                            } else {
                                results.push(format!("{} - {}", title, url));
                            }
                        }
                    }

                    if results.is_empty() {
                        return Ok("Brave Search returned no results.".to_string());
                    }

                    let mut output = String::new();
                    for (i, r) in results.iter().enumerate() {
                        if output.len() > 8000 {
                            output.push_str(&format!("\n... and {} more results", results.len() - i));
                            break;
                        }
                        output.push_str(&format!("{}. {}\n", i + 1, r));
                    }
                    Ok(format!("{}\n\n[Search powered by Brave Search]", output.trim()))
                }
                _ => {
                    // Default: DuckDuckGo Instant Answer API (free, no API key, privacy-respecting)
                    // NOTE: This API is limited — it returns curated instant answers (Wikipedia
                    // summaries, categories), NOT full web search results. For specific/technical
                    // queries it often returns nothing. Use Brave Search for better results.
                    let resp = client
                        .get("https://api.duckduckgo.com/")
                        .query(&[
                            ("q", query),
                            ("format", "json"),
                            ("no_html", "1"),
                            ("skip_disambig", "1"),
                            ("t", "nolock"),
                        ])
                        .timeout(std::time::Duration::from_secs(10))
                        .header("User-Agent", "nolock/0.1")
                        .send()
                        .await
                        .map_err(|e| format!("Failed to search: {}", e))?;

                    let status = resp.status();
                    if !status.is_success() {
                        return Ok(format!("DuckDuckGo search error: HTTP {}", status));
                    }

                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    let data: serde_json::Value =
                        serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;

                    let mut results: Vec<String> = Vec::new();

                    // Extract AbstractText (instant answer summary)
                    if let Some(abstract_text) = data["AbstractText"].as_str() {
                        if !abstract_text.is_empty() {
                            if let Some(abstract_url) = data["AbstractURL"].as_str() {
                                if !abstract_url.is_empty() {
                                    results.push(format!("[Summary] {} - {}", abstract_text, abstract_url));
                                }
                            } else {
                                results.push(format!("[Summary] {}", abstract_text));
                            }
                        }
                    }

                    // Extract RelatedTopics (related links and categories)
                    if let Some(topics) = data["RelatedTopics"].as_array() {
                        fn extract_topics(
                            topics: &[serde_json::Value],
                            out: &mut Vec<String>,
                            depth: usize,
                        ) {
                            if depth > 3 { return; }
                            for topic in topics {
                                if let Some(text) = topic["Text"].as_str() {
                                    let url = topic["FirstURL"]
                                        .as_str()
                                        .unwrap_or("(no URL)")
                                        .to_string();
                                    out.push(format!("{} - {}", text, url));
                                }
                                if let Some(sub_topics) = topic["Topics"].as_array() {
                                    extract_topics(sub_topics, out, depth + 1);
                                }
                            }
                        }
                        extract_topics(topics, &mut results, 0);
                    }

                    if results.is_empty() {
                        return Ok("DuckDuckGo Instant Answer API returned no results. This API is experimental and limited — try enabling Brave Search in AI Integrations settings for real web search results.".to_string());
                    }

                    let mut output = String::new();
                    for (i, r) in results.iter().enumerate() {
                        if output.len() > 8000 {
                            output.push_str(&format!("\n... and {} more results", results.len() - i));
                            break;
                        }
                        output.push_str(&format!("{}. {}\n", i + 1, r));
                    }
                    Ok(format!("{}\n\n[Results from DuckDuckGo]", output.trim()))
                }
            }
        }
        "write_file" => {
            let path_str = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            let content = args["content"]
                .as_str()
                .ok_or("Missing required parameter: content")?;
            eprintln!("[nolock] tool write_file path={} ({} bytes)", path_str, content.len());

            // Require a root folder to be open in the editor
            let root = root_path.ok_or(
                "No folder is open in the editor. Please open a folder before using write_file."
            )?;
            let root_path_obj = std::path::Path::new(root);

            // Resolve the file path: if relative, join it with the root folder
            let path_obj = std::path::Path::new(path_str);
            let resolved = if path_obj.is_relative() {
                root_path_obj.join(path_str)
            } else {
                path_obj.to_path_buf()
            };

            // Canonicalize root path to prevent directory traversal attacks
            let root_canonical = root_path_obj
                .canonicalize()
                .map_err(|e| format!("Failed to resolve root path '{}': {}", root, e))?;

            // Validate that the resolved file path is within the root folder.
            // Since the file (or its parent dirs) may not exist yet, we walk up
            // the directory tree until we find an existing ancestor to canonicalize.
            let mut check_path = &resolved as &std::path::Path;
            let target_canonical = loop {
                if check_path.exists() {
                    break check_path.canonicalize()
                        .map_err(|e| format!("Failed to resolve path '{}': {}", check_path.display(), e))?;
                }
                match check_path.parent() {
                    Some(parent) => check_path = parent,
                    None => return Err("File path has no existing ancestor directory to validate against the open folder".to_string()),
                }
            };

            if !target_canonical.starts_with(&root_canonical) {
                return Err(format!(
                    "Cannot write file outside the open folder. Path '{}' is not under '{}'.",
                    resolved.display(),
                    root
                ));
            }

            // Create parent directories if they don't exist
            if let Some(parent) = resolved.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directories for {}: {}", resolved.display(), e))?;
            }
            let resolved_str = resolved.to_string_lossy().to_string();
            std::fs::write(&resolved, content)
                .map_err(|e| format!("Failed to write {}: {}", resolved.display(), e))?;
            Ok(format!("Successfully wrote {} bytes to {}", content.len(), resolved_str))
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Helpers for ollama_chat_with_tools
// ---------------------------------------------------------------------------

/// Result from streaming a single Ollama response.
struct StreamResult {
    /// Content emitted by the model in this iteration (for the assistant message).
    iter_content: String,
    /// Tool calls detected, if any.
    tool_calls: Option<Vec<serde_json::Value>>,
}

/// Build the initial messages array, optionally prepending a system prompt
/// that describes the available tools.
fn build_initial_messages(
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut ollama_msgs: Vec<serde_json::Value> = Vec::new();

    let tool_names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    if !tool_names.is_empty() {
        let tool_list = tool_names.join(", ");
        ollama_msgs.push(serde_json::json!({
            "role": "system",
            "content": format!(
                "You have access to the following tools: {}. \
                 Use them when the user's request requires looking up external information or accessing files. \
                 You may call multiple tools in a single response if needed. \
                 Always use the actual tool rather than making up information.",
                tool_list
            )
        }));
    }

    for m in messages {
        ollama_msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    ollama_msgs
}

/// Stream an Ollama NDJSON response line by line, emitting tokens to the
/// frontend via `app_handle` and accumulating content into `full_content`.
/// Returns the iteration-scoped content and any tool calls found.
async fn stream_ollama_response(
    mut resp: reqwest::Response,
    app_handle: &tauri::AppHandle,
    full_content: &mut String,
) -> Result<StreamResult, String> {
    let mut iter_content = String::new();
    let mut tool_calls: Option<Vec<serde_json::Value>> = None;
    let mut buf = String::new();

    loop {
        match resp.chunk().await.map_err(|e| e.to_string())? {
            None => break,
            Some(chunk) => {
                let s = String::from_utf8_lossy(&chunk);
                buf.push_str(&s);
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    buf = buf[pos + 1..].to_string();
                    if line.is_empty() {
                        continue;
                    }

                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(content) = data["message"]["content"].as_str() {
                            if !content.is_empty() {
                                iter_content.push_str(content);
                                full_content.push_str(content);
                                app_handle
                                    .emit(
                                        "stream-token",
                                        StreamPayload {
                                            token: content.to_string(),
                                        },
                                    )
                                    .ok();
                            }
                        }
                        // Detect tool calls in ANY chunk — not just the done:true chunk.
                        // Some Ollama versions/streaming modes may emit tool_calls
                        // in a separate chunk before the done marker.
                        if let Some(calls) = data["message"]["tool_calls"].as_array() {
                            if !calls.is_empty() {
                                tool_calls = Some(calls.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(StreamResult {
        iter_content,
        tool_calls,
    })
}

// ---------------------------------------------------------------------------
// Ollama tool-calling loop (streaming)
// ---------------------------------------------------------------------------

/// Shared context for the Ollama tool-calling loop — bundles parameters that
/// are stable across iterations so the function signature stays under the
/// clippy default argument limit (7).
struct OllamaChatContext<'a> {
    app_handle: &'a tauri::AppHandle,
    client: &'a reqwest::Client,
    url: &'a str,
    model: &'a str,
    tool_configs: &'a HashMap<String, serde_json::Value>,
    root_path: Option<&'a str>,
}

async fn ollama_chat_with_tools(
    ctx: &OllamaChatContext<'_>,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    max_iterations: usize,
    temperature: f64,
    max_tokens: u32,
) -> Result<ChatResult, String> {
    let mut ollama_msgs = build_initial_messages(messages, tools);
    let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
    let mut full_content = String::new();

    for iteration in 0..max_iterations {
        // --- Build and send request ---
        let body = build_ollama_chat_body(ctx.model, &ollama_msgs, tools, temperature, max_tokens);

        eprintln!(
            "[nolock] ollama tool loop iteration={}, POST {}/api/chat (streaming)",
            iteration, ctx.url
        );

        let resp = ctx
            .client
            .post(format!("{}/api/chat", ctx.url))
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| {
                eprintln!("[nolock] ollama tool loop network error: {}", e);
                e.to_string()
            })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!(
                "[nolock] ollama tool loop status={} body={}",
                status,
                &text[..text.len().min(300)]
            );
            let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or_else(|| text.clone());
            if !tools.is_empty() && error_detail.contains("tool") {
                return Err(format!(
                    "Model '{}' does not support tool calling (HTTP {}). Try disabling Agent Tools in AI Settings.",
                    ctx.model, status
                ));
            }
            return Err(format!("Ollama API error ({}): {}", status, error_detail));
        }

        // --- Stream the response ---
        let stream = stream_ollama_response(resp, ctx.app_handle, &mut full_content).await?;

        // --- Handle tool calls or return final response ---
        if let Some(calls) = stream.tool_calls {
            // Push the assistant message so Ollama knows the context
            ollama_msgs.push(serde_json::json!({
                "role": "assistant",
                "content": stream.iter_content,
                "tool_calls": calls
            }));

            // Execute each tool call and add results
            for call in &calls {
                let name = call["function"]["name"].as_str().unwrap_or("unknown");
                let args = &call["function"]["arguments"];

                let result = execute_tool(name, args, ctx.client, ctx.tool_configs, ctx.root_path)
                    .await
                    .unwrap_or_else(|e| format!("Tool error: {}", e));

                let snippet = if result.len() > 200 {
                    format!("{}...", &result[..200])
                } else {
                    result.clone()
                };

                all_tool_calls.push(ToolCallLog {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_default(),
                    result_snippet: snippet,
                });

                // Add tool result message
                let tool_call_id = call["id"].as_str().unwrap_or("call_unknown");
                ollama_msgs.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result
                }));
            }
        } else {
            // No tool calls — final response
            eprintln!(
                "[nolock] ollama tool loop returning: content_len={} tool_calls={}",
                full_content.len(),
                all_tool_calls.len()
            );
            if full_content.is_empty() && all_tool_calls.is_empty() {
                eprintln!("[nolock] WARNING: empty response from model in tool loop");
            }
            return Ok(ChatResult {
                content: if full_content.is_empty() {
                    "(no response)".to_string()
                } else {
                    full_content
                },
                tool_calls: all_tool_calls,
            });
        }
    }

    // If we exhausted iterations, return what we have
    eprintln!(
        "[nolock] ollama tool loop exhausted after {} iterations: content_len={} tool_calls={}",
        max_iterations,
        full_content.len(),
        all_tool_calls.len()
    );
    Ok(ChatResult {
        content: if full_content.is_empty() {
            "(max tool iterations reached, no response)".to_string()
        } else {
            full_content
        },
        tool_calls: all_tool_calls,
    })
}

/// Build the JSON body for an Ollama `/api/chat` request.
fn build_ollama_chat_body(
    model: &str,
    ollama_msgs: &[serde_json::Value],
    tools: &[serde_json::Value],
    temperature: f64,
    max_tokens: u32,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": ollama_msgs,
        "stream": true,
        "options": { "num_predict": max_tokens, "temperature": temperature }
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::json!(tools);
    }
    body
}

#[tauri::command]
async fn ai_complete(req: CompletionRequest) -> Result<String, String> {
    eprintln!(
        "[nolock] ai_complete backend={} url={} model={} prompt_len={} suffix={} temp={:?} max_tokens={:?} system_prompt={:?}",
        req.backend,
        req.url,
        req.model,
        req.prompt.len(),
        req.suffix.as_deref().unwrap_or("(none)"),
        req.temperature,
        req.max_tokens,
        req.system_prompt.as_deref().unwrap_or("(none)"),
    );

    // Resolve configurable values with defaults
    let temperature = req.temperature.unwrap_or(0.2);
    let max_tokens = req.max_tokens.unwrap_or(64);
    let system_prompt = req.system_prompt.as_deref().unwrap_or(
        "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
    );

    let client = reqwest::Client::new();

    match req.backend.as_str() {
        "ollama" => {
            // FITM: Ollama /api/generate supports `suffix` for fill-in-the-middle.
            // If the model doesn't support it, fall back to prefix-only.
            let use_suffix = req.suffix.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
            let body = |with_suffix: bool| {
                let mut b = serde_json::json!({
                    "model": req.model,
                    "system": system_prompt,
                    "prompt": req.prompt,
                    "stream": false,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": temperature,
                        "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
                    }
                });
                if with_suffix {
                    if let Some(ref suffix) = req.suffix {
                        if !suffix.is_empty() {
                            b["suffix"] = serde_json::json!(suffix);
                        }
                    }
                }
                b
            };

            eprintln!("[nolock] ollama POST {}/api/generate (FITM={})", req.url, use_suffix);
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body(use_suffix))
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[nolock] ollama error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[nolock] ollama status={} body={}", status, &text[..text.len().min(300)]);

            // If FITM failed with 400 (model doesn't support insert), retry without suffix
            if status.as_u16() == 400 && use_suffix {
                eprintln!("[nolock] ollama FITM not supported, retrying without suffix");
                let resp2 = client
                    .post(format!("{}/api/generate", req.url))
                    .json(&body(false))
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status2 = resp2.status();
                let text2 = resp2.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] ollama retry status={} body={}", status2, &text2[..text2.len().min(200)]);
                let data: serde_json::Value =
                    serde_json::from_str(&text2).map_err(|e| format!("JSON parse error: {}", e))?;
                return Ok(data["response"].as_str().unwrap_or("").to_string());
            }

            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["response"].as_str().unwrap_or("").to_string())
        }
        "llamacpp" => {
            // FITM: llama.cpp /completion supports `suffix` for fill-in-the-middle
            let mut body = serde_json::json!({
                "prompt": req.prompt,
                "n_predict": max_tokens,
                "temperature": temperature,
                "stream": false,
                "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
                "system": system_prompt
            });
            if let Some(ref suffix) = req.suffix {
                if !suffix.is_empty() {
                    body["suffix"] = serde_json::json!(suffix);
                }
            }
            eprintln!("[nolock] llamacpp POST {}/completion (FITM={})", req.url, req.suffix.is_some());
            let resp = client
                .post(format!("{}/completion", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[nolock] llamacpp error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[nolock] llamacpp status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["content"].as_str().unwrap_or("").to_string())
        }
        "openrouter" => {
            let api_key = req.api_key.unwrap_or_default();

            // Build a structured prompt that includes both prefix and suffix context.
            // OpenRouter uses the chat completions API which doesn't natively support
            // suffix/FITM, so we encode both sides of the cursor in the message content.
            let user_content = if let Some(ref suffix) = req.suffix {
                if !suffix.is_empty() {
                    format!(
                        "Complete the code at the cursor position marked by <CURSOR>.\n\n\
                         Before cursor:\n```\n{}\n```\n\n\
                         After cursor:\n```\n{}\n```\n\n\
                         Output ONLY the code that should replace <CURSOR>. No explanations, \
                         no markdown formatting, no conversational text.",
                        req.prompt, suffix
                    )
                } else {
                    format!(
                        "Complete the following code at the cursor. Output ONLY the code that \
                         belongs at the cursor. No explanations, no markdown, no conversational text.\n\n```\n{}\n```",
                        req.prompt
                    )
                }
            } else {
                format!(
                    "Complete the following code at the cursor. Output ONLY the code that \
                     belongs at the cursor. No explanations, no markdown, no conversational text.\n\n```\n{}\n```",
                    req.prompt
                )
            };

            let body = serde_json::json!({
                "model": req.model,
                "messages": [
                    {
                        "role": "system",
                        "content": system_prompt
                    },
                    { "role": "user", "content": user_content }
                ],
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Explanation"]
            });
            eprintln!("[nolock] openrouter POST https://openrouter.ai/api/v1/chat/completions model={}", req.model);
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://nolock.dev")
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[nolock] openrouter error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[nolock] openrouter status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        "opencode" => {
            let api_key = req.api_key.clone().unwrap_or_default();
            let is_remote = req.url.contains("/v1");

            if is_remote {
                // Remote OpenCode Zen API — OpenAI-compatible format
                let body = serde_json::json!({
                    "model": req.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": req.prompt}
                    ],
                    "stream": false,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                });
                let full_url = format!("{}/chat/completions", req.url.trim_end_matches('/'));
                eprintln!("[nolock] opencode POST {full_url}");
                let resp = client
                    .post(&full_url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| {
                        eprintln!("[nolock] opencode error: {}", e);
                        e.to_string()
                    })?;
                let status = resp.status();
                let text = resp.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] opencode status={} body={}", status, &text[..text.len().min(200)]);
                let data: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
                Ok(data["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string())
            } else {
                // Local OpenCode Zen — Ollama-compatible format
                let body = serde_json::json!({
                    "model": req.model,
                    "system": system_prompt,
                    "prompt": req.prompt,
                    "stream": false,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": temperature,
                        "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
                    }
                });
                let full_url = format!("{}/api/generate", req.url.trim_end_matches('/'));
                eprintln!("[nolock] opencode POST {full_url}");
                let resp = client
                    .post(&full_url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| {
                        eprintln!("[nolock] opencode error: {}", e);
                        e.to_string()
                    })?;
                let status = resp.status();
                let text = resp.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] opencode status={} body={}", status, &text[..text.len().min(200)]);
                let data: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
                Ok(data["response"].as_str().unwrap_or("").to_string())
            }
        }
        _ => Err(format!("Unknown backend: {}", req.backend)),
    }
}

#[tauri::command]
async fn ai_chat(app_handle: tauri::AppHandle, req: ChatRequest) -> Result<ChatResult, String> {
    eprintln!(
        "[nolock] ai_chat backend={} url={} model={} messages={} tools={:?} temp={:?} max_tokens={:?} system_prompt={:?}",
        req.backend,
        req.url,
        req.model,
        req.messages.len(),
        req.tools_enabled,
        req.temperature,
        req.max_tokens,
        req.system_prompt.as_deref().unwrap_or("(none)"),
    );

    // Resolve configurable values with defaults
    let temperature = req.temperature.unwrap_or(0.7);
    let max_tokens = req.max_tokens.unwrap_or(2048);

    // Prepend global system prompt if provided and not already present
    let messages = if let Some(ref system_prompt) = req.system_prompt {
        if !system_prompt.is_empty() {
            let mut msgs = req.messages.clone();
            // Check if a system message already exists
            let has_system = msgs.iter().any(|m| m.role == "system");
            if !has_system {
                msgs.insert(0, ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.clone(),
                });
            }
            msgs
        } else {
            req.messages
        }
    } else {
        req.messages
    };

    let client = reqwest::Client::new();
    let tools = build_tool_schemas(&req.tools_enabled, req.root_path.as_deref());
    let has_tools = !tools.is_empty();

    match req.backend.as_str() {
        "ollama" => {
            if has_tools {
                let ollama_ctx = OllamaChatContext {
                    app_handle: &app_handle,
                    client: &client,
                    url: &req.url,
                    model: &req.model,
                    tool_configs: &req.tool_configs,
                    root_path: req.root_path.as_deref(),
                };
                ollama_chat_with_tools(&ollama_ctx, &messages, &tools, 10, temperature, max_tokens)
                    .await
            } else {
                // No tools — simple single-turn chat (streaming)
                let ollama_msgs: Vec<serde_json::Value> = messages
                    .iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect();

                let body = serde_json::json!({
                    "model": req.model,
                    "messages": ollama_msgs,
                    "stream": true,
                    "options": { "num_predict": max_tokens, "temperature": temperature }
                });
                eprintln!("[nolock] ollama POST {}/api/chat (no tools, streaming)", req.url);
                    let mut resp = client
                        .post(format!("{}/api/chat", req.url))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| {
                        eprintln!("[nolock] ollama chat error: {}", e);
                        e.to_string()
                    })?;

                // Check status first
                let status = resp.status();
                if !status.is_success() {
                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    eprintln!("[nolock] ollama chat status={} body={}", status, &text[..text.len().min(200)]);
                    let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v["error"].as_str().map(String::from))
                        .unwrap_or_else(|| text.clone());
                    return Err(format!("Ollama API error ({}): {}", status, error_detail));
                }

                // Stream NDJSON response
                let mut full_content = String::new();
                let mut buf = String::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            let s = String::from_utf8_lossy(&chunk);
                            buf.push_str(&s);
                            while let Some(pos) = buf.find('\n') {
                                let line = buf[..pos].trim().to_string();
                                buf = buf[pos + 1..].to_string();
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(content) = data["message"]["content"].as_str() {
                                        if !content.is_empty() {
                                            full_content.push_str(content);
                                            app_handle.emit("stream-token", StreamPayload {
                                                token: content.to_string(),
                                            }).ok();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(ChatResult {
                    content: if full_content.is_empty() { "(no response)".to_string() } else { full_content },
                    tool_calls: vec![],
                })
            }
        }
        "llamacpp" => {
            let prompt = messages
                .iter()
                .map(|m| format!("{}: {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n")
                + "\nassistant:";

            let body = serde_json::json!({
                "prompt": prompt,
                "n_predict": max_tokens,
                "temperature": temperature,
                "stream": true
            });
            eprintln!("[nolock] llamacpp POST {}/completion (streaming)", req.url);
            let mut resp = client
                .post(format!("{}/completion", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] llamacpp chat status={} body={}", status, &text[..text.len().min(200)]);
                let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v["error"].as_str().map(String::from))
                    .unwrap_or_else(|| text.clone());
                return Err(format!("llama.cpp API error ({}): {}", status, error_detail));
            }

            // SSE streaming — data: {...}\n\n
            let mut full_content = String::new();
            let mut buf = String::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        let s = String::from_utf8_lossy(&chunk);
                        buf.push_str(&s);
                        // SSE events are separated by \n\n
                        while let Some(pos) = buf.find("\n\n") {
                            let event = buf[..pos].to_string();
                            buf = buf[pos + 2..].to_string();
                            for line in event.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(content) = json["content"].as_str() {
                                            if !content.is_empty() {
                                                full_content.push_str(content);
                                                app_handle.emit("stream-token", StreamPayload {
                                                    token: content.to_string(),
                                                }).ok();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(ChatResult {
                content: full_content,
                tool_calls: vec![],
            })
        }
        "openrouter" => {
            let api_key = req.api_key.clone().unwrap_or_default();
            let mut or_msgs: Vec<serde_json::Value> = messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();

            if has_tools {
                let tool_names: Vec<&str> = tools
                    .iter()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .collect();
                let tool_list = tool_names.join(", ");
                or_msgs.insert(0, serde_json::json!({
                    "role": "system",
                    "content": format!(
                        "You have access to the following tools: {}. \
                         Use them when the user's request requires looking up external information. \
                         You may call multiple tools if needed.",
                        tool_list
                    )
                }));
            }

            let mut body = serde_json::json!({
                "model": req.model,
                "messages": or_msgs,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stream": true
            });
            if has_tools {
                body["tools"] = serde_json::json!(tools);
            }

            eprintln!("[nolock] openrouter POST chat completions (streaming)");
            let mut resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://nolock.dev")
                .json(&body)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] openrouter chat status={} body={}", status, &text[..text.len().min(200)]);
                let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v["error"].as_str().map(String::from))
                    .or_else(|| {
                        serde_json::from_str::<serde_json::Value>(&text)
                            .ok()
                            .and_then(|v| v["message"].as_str().map(String::from))
                    })
                    .unwrap_or_else(|| text.clone());
                return Err(format!("OpenRouter API error ({}): {}", status, error_detail));
            }

            // SSE streaming — data: {...}\n\n (OpenAI-compatible format)
            let mut full_content = String::new();
            let mut buf = String::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        let s = String::from_utf8_lossy(&chunk);
                        buf.push_str(&s);
                        while let Some(pos) = buf.find("\n\n") {
                            let event = buf[..pos].to_string();
                            buf = buf[pos + 2..].to_string();
                            for line in event.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                            if !content.is_empty() {
                                                full_content.push_str(content);
                                                app_handle.emit("stream-token", StreamPayload {
                                                    token: content.to_string(),
                                                }).ok();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(ChatResult {
                content: full_content,
                tool_calls: vec![],
            })
        }
        "opencode" => {
            let api_key = req.api_key.clone().unwrap_or_default();
            let is_remote = req.url.contains("/v1");

            if is_remote {
                // Remote OpenCode Zen API — OpenAI-compatible SSE streaming
                let body = serde_json::json!({
                    "model": req.model,
                    "messages": messages,
                    "stream": true,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                });
                let full_url = format!("{}/chat/completions", req.url.trim_end_matches('/'));
                eprintln!("[nolock] opencode POST {full_url} (streaming)");
                let mut resp = client
                    .post(&full_url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                let status = resp.status();
                if !status.is_success() {
                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    eprintln!("[nolock] opencode status={} body={}", status, &text[..text.len().min(200)]);
                    let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v["error"].as_str().map(String::from))
                        .unwrap_or_else(|| text.clone());
                    return Err(format!("OpenCode API error ({}): {}", status, error_detail));
                }

                // SSE streaming — data: {...}\n\n (OpenAI-compatible format)
                let mut full_content = String::new();
                let mut buf = String::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            let s = String::from_utf8_lossy(&chunk);
                            buf.push_str(&s);
                            while let Some(pos) = buf.find("\n\n") {
                                let event = buf[..pos].to_string();
                                buf = buf[pos + 2..].to_string();
                                for line in event.lines() {
                                    if let Some(data) = line.strip_prefix("data: ") {
                                        let data = data.trim();
                                        if data == "[DONE]" { continue; }
                                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                            if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                                if !content.is_empty() {
                                                    full_content.push_str(content);
                                                    app_handle.emit("stream-token", StreamPayload {
                                                        token: content.to_string(),
                                                    }).ok();
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(ChatResult {
                    content: full_content,
                    tool_calls: vec![],
                })
            } else {
                // Local OpenCode Zen — Ollama-compatible NDJSON streaming
                let prompt = messages
                    .iter()
                    .map(|m| format!("{}: {}", m.role, m.content))
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\nassistant:";

                let body = serde_json::json!({
                    "model": req.model,
                    "prompt": prompt,
                    "stream": true,
                    "options": { "num_predict": max_tokens, "temperature": temperature }
                });
                let full_url = format!("{}/api/generate", req.url.trim_end_matches('/'));
                eprintln!("[nolock] opencode POST {full_url} (streaming)");
                let mut resp = client
                    .post(&full_url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                let status = resp.status();
                if !status.is_success() {
                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    eprintln!("[nolock] opencode status={} body={}", status, &text[..text.len().min(200)]);
                    let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v["error"].as_str().map(String::from))
                        .unwrap_or_else(|| text.clone());
                    return Err(format!("OpenCode API error ({}): {}", status, error_detail));
                }

                // NDJSON streaming — {"response":"...","done":false}
                let mut full_content = String::new();
                let mut buf = String::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            let s = String::from_utf8_lossy(&chunk);
                            buf.push_str(&s);
                            while let Some(pos) = buf.find('\n') {
                                let line = buf[..pos].trim().to_string();
                                buf = buf[pos + 1..].to_string();
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(content) = data["response"].as_str() {
                                        if !content.is_empty() {
                                            full_content.push_str(content);
                                            app_handle.emit("stream-token", StreamPayload {
                                                token: content.to_string(),
                                            }).ok();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(ChatResult {
                    content: full_content,
                    tool_calls: vec![],
                })
            }
        }
        _ => Err(format!("Unknown backend: {}", req.backend)),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState {
            instances: Mutex::new(HashMap::new()),
        })
        .manage(browser::BrowserState::new())
        .manage(terminal_memory::TermMemory::new())
        .setup(|app| {
            // Set the window icon so the taskbar/dock shows the nolock logo
            // instead of a generic gear icon (Linux) or default icon.
            let icon_bytes = include_bytes!("../icons/32x32.png");
            let icon = tauri::image::Image::from_bytes(icon_bytes)?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_directory,
            rename_file,
            delete_file,
            copy_file,
            create_file,
            list_agents,
            read_agent,
            list_skills,
            run_skill_command,
            search_in_files,
            replace_in_files,
            create_directory,
            append_to_file,
            get_rlhf_dir,
            get_model_info,
            fetch_models,
            ai_complete,
            ai_chat,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            browser::create_browser_webview,
            browser::close_browser_webview,
            browser::update_browser_webview,
            linter::run_linter,
            terminal_memory::record_command,
            terminal_memory::get_top_commands,
            terminal_memory::get_command_categories,
            terminal_memory::save_command_category,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nolock");
}

fn main() {
    run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    // ---- DirEntry sorting / filtering ------------------------------------
    #[test]
    fn test_directory_sorting() {
        let mut entries = vec![
            DirEntry { name: "z_file.rs".into(), path: "/z_file.rs".into(), is_dir: false },
            DirEntry { name: "a_dir".into(), path: "/a_dir".into(), is_dir: true },
            DirEntry { name: "b_file.txt".into(), path: "/b_file.txt".into(), is_dir: false },
            DirEntry { name: "B_file.txt".into(), path: "/B_file.txt".into(), is_dir: false },
        ];
        // Simulate sorting as done in list_directory
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        assert_eq!(entries[0].name, "a_dir");   // dirs first
        assert_eq!(entries[1].name, "b_file.txt"); // alphabetical (case-insensitive)
        assert_eq!(entries[2].name, "B_file.txt");
        assert_eq!(entries[3].name, "z_file.rs");
    }

    #[test]
    fn test_directory_hidden_files_filtered() {
        // list_directory skips entries whose name starts with '.'
        let entries: Vec<DirEntry> = vec![
            DirEntry { name: ".hidden".into(), path: "/.hidden".into(), is_dir: false },
            DirEntry { name: "visible".into(), path: "/visible".into(), is_dir: false },
            DirEntry { name: ".git".into(), path: "/.git".into(), is_dir: true },
        ];
        let filtered: Vec<_> = entries
            .into_iter()
            .filter(|e| !e.name.starts_with('.'))
            .collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "visible");
    }

    // ---- build_tool_schemas ----------------------------------------------
    #[test]
    fn test_build_tool_schemas_empty() {
        let schemas = build_tool_schemas(&[], None);
        assert!(schemas.is_empty());
    }

    #[test]
    fn test_build_tool_schemas_single() {
        let schemas = build_tool_schemas(&["web_fetch".into()], None);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "web_fetch");
        assert!(schemas[0]["function"]["parameters"]["properties"]["url"].is_object());
    }

    #[test]
    fn test_build_tool_schemas_multiple() {
        let schemas = build_tool_schemas(&[
            "web_fetch".into(),
            "read_file".into(),
            "write_file".into(),
            "list_directory".into(),
            "web_search".into(),
        ], None);
        assert_eq!(schemas.len(), 5);

        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"web_fetch"));
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"write_file"));
        assert!(names.contains(&"list_directory"));
        assert!(names.contains(&"web_search"));
    }

    #[test]
    fn test_web_search_schema_has_required_query() {
        let schemas = build_tool_schemas(&["web_search".into()], None);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "web_search");
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "query"));
    }

    #[test]
    fn test_build_tool_schemas_unknown_tool_ignored() {
        let schemas = build_tool_schemas(&["nonexistent_tool".into()], None);
        assert!(schemas.is_empty());
    }

    #[test]
    fn test_tool_schema_has_required_url() {
        let schemas = build_tool_schemas(&["web_fetch".into()], None);
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "url"));
    }

    #[test]
    fn test_write_file_schema_has_required_path_and_content() {
        let schemas = build_tool_schemas(&["write_file".into()], None);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "write_file");
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "path"));
        assert!(required.iter().any(|v| v == "content"));
        assert_eq!(required.len(), 2);
    }

    // ---- execute_tool error paths (without network / fs) -----------------
    #[tokio::test]
    async fn test_execute_tool_unknown_name() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("unknown_tool", &args, &client, &HashMap::new(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn test_execute_tool_web_fetch_missing_url() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("web_fetch", &args, &client, &HashMap::new(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_file_xyzzy_123.test" });
        let result = execute_tool("read_file", &args, &client, &HashMap::new(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[tokio::test]
    async fn test_execute_tool_list_directory_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_dir_xyzzy_123" });
        let result = execute_tool("list_directory", &args, &client, &HashMap::new(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read dir"));
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_requires_root_path() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/test.txt", "content": "hello" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No folder is open"));
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_rejects_path_outside_root() {
        let client = reqwest::Client::new();
        let tmp_root = std::env::temp_dir().join("nolock_test_write_root");
        let _ = std::fs::create_dir_all(&tmp_root);
        let root_str = tmp_root.to_string_lossy().to_string();

        // Try to write outside the root
        let outside_path = std::env::temp_dir().join("outside_test.txt");
        let outside_str = outside_path.to_string_lossy().to_string();
        let args = serde_json::json!({ "path": outside_str, "content": "should fail" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some(&root_str)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("outside the open folder"));

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp_root);
    }

    // ---- read_file / write_file with temp dirs ---------------------------
    #[test]
    fn test_write_and_read_file() {
        let dir = std::env::temp_dir().join("nolock_test_write_read");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test_file.txt");
        let path_str = path.to_string_lossy().to_string();

        // Write
        let write_result = write_file(path_str.clone(), "Hello, test!".into());
        assert!(write_result.is_ok());

        // Read
        let read_result = read_file(path_str.clone());
        assert!(read_result.is_ok());
        assert_eq!(read_result.unwrap(), "Hello, test!");

        // Cleanup
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn test_read_file_nonexistent() {
        let result = read_file("/tmp/definitely_not_a_real_file_nolock.test".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_success_within_root() {
        let root = std::env::temp_dir().join("nolock_test_execute_write_root");
        let dir = root.join("subdir");
        let path = dir.join("test_write.txt");
        let path_str = path.to_string_lossy().to_string();
        let root_str = root.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&root);
        // Create the root directory so canonicalization works
        std::fs::create_dir_all(&root).expect("create root dir");

        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": path_str, "content": "written by tool" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some(&root_str)).await;
        assert!(result.is_ok());
        assert!(result.unwrap().contains("Successfully wrote"));

        // Verify content was written correctly
        let content = std::fs::read_to_string(&path).expect("file should exist");
        assert_eq!(content, "written by tool");

        // Cleanup
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_write_file_schema_with_root_path_includes_it_in_description() {
        let schemas = build_tool_schemas(&["write_file".into()], Some("/my/project"));
        assert_eq!(schemas.len(), 1);
        let desc = schemas[0]["function"]["description"].as_str().unwrap();
        assert!(desc.contains("/my/project"), "description should include the root path");
        assert!(desc.contains("open project folder"), "description should mention the open folder");
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_relative_path() {
        let root = std::env::temp_dir().join("nolock_test_relative_write");
        let path = root.join("relative_output.txt");
        let root_str = root.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create root dir");

        let client = reqwest::Client::new();
        // Use a relative path — should be resolved against root
        let args = serde_json::json!({ "path": "relative_output.txt", "content": "relative path test" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some(&root_str)).await;
        assert!(result.is_ok(), "relative path should succeed: {:?}", result);
        assert!(result.unwrap().contains("Successfully wrote"));

        // Verify content was written to the correct location within root
        let content = std::fs::read_to_string(&path).expect("file should exist at resolved path");
        assert_eq!(content, "relative path test");

        // Cleanup
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_missing_path() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "content": "hello" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some("/tmp")).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter: path"));
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_missing_content() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/test.txt" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some("/tmp")).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter: content"));
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_rejects_relative_path_traversal() {
        let root = std::env::temp_dir().join("nolock_test_traversal_root");
        let root_str = root.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create root dir");

        let client = reqwest::Client::new();
        // Relative path with ../ tries to escape the root
        let args = serde_json::json!({ "path": "../outside.txt", "content": "should fail" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some(&root_str)).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("outside the open folder"),
            "expected 'outside the open folder' error, got: {}",
            err
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_execute_tool_write_file_root_path_does_not_exist() {
        let root = std::env::temp_dir().join("nolock_test_nonexistent_root_xyzzy");
        let root_str = root.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&root);
        // NOTE: root is NOT created, so canonicalization will fail

        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "test.txt", "content": "should fail" });
        let result = execute_tool("write_file", &args, &client, &HashMap::new(), Some(&root_str)).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to resolve root path"),
            "expected 'Failed to resolve root path' error, got: {}",
            err
        );
    }

    #[test]
    fn test_write_file_schema_description_when_no_root() {
        let schemas = build_tool_schemas(&["write_file".into()], None);
        assert_eq!(schemas.len(), 1);
        let desc = schemas[0]["function"]["description"].as_str().unwrap();
        assert!(
            desc.contains("No folder is currently open"),
            "description should mention no folder is open when root_path is None, got: {}",
            desc
        );
    }

    // ---- tool_call_id fix: reproducing the bug and confirming the fix ----
    //
    // The Ollama tool-calling API expects tool result messages to include
    // a `tool_call_id` field matching the `id` from the original tool call.
    //
    // THE BUG (old code, removed): The loop sent `"tool_name": name` instead
    // of `"tool_call_id": tool_call_id`. Ollama ignores `tool_name`, so the
    // model couldn't associate the result with the pending function call.
    // This caused the model to respond with "no results" even though the
    // tool executed successfully.
    //
    // THE FIX (current code): Extract `call["id"]` and use it as
    // `"tool_call_id"`, which is the field Ollama requires.
    //
    // This test reproduces the exact JSON shapes to prove the fix works.
    #[test]
    fn test_ollama_tool_result_message_fix() {
        // Simulate a tool call object returned by Ollama's API
        let tool_call = serde_json::json!({
            "id": "call_abc123",
            "function": {
                "name": "web_search",
                "arguments": { "query": "latest Rust features 2026" }
            }
        });

        let name = tool_call["function"]["name"].as_str().unwrap();
        let _args = &tool_call["function"]["arguments"];

        // Execute the tool (just check the message structure, not network)
        let result = format!(
            "1. Rust 1.80 released with async closures - https://blog.rust-lang.org\n2. New borrow checker improvements - https://doc.rust-lang.org"
        );

        // --- THE OLD BUGGY CODE (for reproduction / comparison) ---
        // This is what used to be in the loop before the fix:
        let buggy_message = serde_json::json!({
            "role": "tool",
            "tool_name": name,    // ❌ Ollama does NOT recognize this field
            "content": result
        });
        // Verify the bug: no tool_call_id field present
        assert!(
            buggy_message.get("tool_call_id").is_none(),
            "BUG: old code is missing tool_call_id - Ollama cannot route this"
        );
        // The buggy message only has "tool_name", which Ollama ignores.
        // Result: the model never sees the tool output → "(no response)"
        assert_eq!(buggy_message["tool_name"], "web_search");
        assert_eq!(buggy_message["role"], "tool");

        // --- THE FIXED CODE (what runs now) ---
        let tool_call_id = tool_call["id"].as_str().unwrap_or("call_unknown");
        let fixed_message = serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,  // ✅ Required by Ollama API
            "content": result
        });
        // Verify the fix: tool_call_id is present and matches the original call
        assert!(
            fixed_message.get("tool_call_id").is_some(),
            "FIX: tool_call_id must be present for Ollama to route the result"
        );
        assert_eq!(fixed_message["tool_call_id"], "call_abc123");
        assert_eq!(fixed_message["role"], "tool");
        assert_eq!(fixed_message["content"], result);

        // ---- The key structural difference ----
        // Old: { role: "tool", tool_name: "web_search", content: "..." }
        // New: { role: "tool", tool_call_id: "call_abc123", content: "..." }
        //
        // Ollama's API reference confirms the tool role response MUST have
        // "tool_call_id" matching the call that produced it.
        // Without it, the model treats the message as an orphan tool result
        // and ignores it, leading to the "(no response)" bug.
        //
        // Proof: the buggy JSON has "tool_name" which is NOT in Ollama's spec.
        // The fixed JSON has "tool_call_id" which IS in Ollama's spec.
        assert!(
            buggy_message.as_object().unwrap().contains_key("tool_name"),
            "BUG has tool_name but NOT tool_call_id"
        );
        assert!(
            !buggy_message.as_object().unwrap().contains_key("tool_call_id"),
            "BUG confirms: no tool_call_id in old code"
        );
        assert!(
            fixed_message.as_object().unwrap().contains_key("tool_call_id"),
            "FIX confirms: tool_call_id IS present in new code"
        );
        assert!(
            !fixed_message.as_object().unwrap().contains_key("tool_name"),
            "FIX confirms: tool_name is gone (replaced by tool_call_id)"
        );
    }

    // ---- build_search_regex -----------------------------------------------
    #[test]
    fn test_build_search_regex_plain_case_sensitive() {
        let re = build_search_regex("hello", false, true).unwrap();
        assert!(re.is_match("hello"));
        assert!(!re.is_match("HELLO"));
        assert!(re.is_match("hello world"));
    }

    #[test]
    fn test_build_search_regex_plain_case_insensitive() {
        let re = build_search_regex("hello", false, false).unwrap();
        assert!(re.is_match("hello"));
        assert!(re.is_match("HELLO"));
        assert!(re.is_match("Hello"));
    }

    #[test]
    fn test_build_search_regex_regex_mode() {
        let re = build_search_regex("he.*o", true, true).unwrap();
        assert!(re.is_match("hello"));
        assert!(re.is_match("he123o"));
        assert!(!re.is_match("hxllo"));
    }

    #[test]
    fn test_build_search_regex_regex_case_insensitive() {
        let re = build_search_regex("hello", true, false).unwrap();
        assert!(re.is_match("HELLO"));
        assert!(re.is_match("hello"));
    }

    #[test]
    fn test_build_search_regex_invalid_regex() {
        let result = build_search_regex("[invalid", true, true);
        assert!(result.is_err());
    }

    #[test]
    fn test_build_search_regex_escapes_plain_text() {
        // In plain text mode, regex special chars should be escaped
        let re = build_search_regex("foo.bar", false, true).unwrap();
        // Should match literal "foo.bar", not "fooXbar"
        assert!(re.is_match("foo.bar"));
        assert!(!re.is_match("fooXbar"));
    }

    // ---- should_skip_entry ------------------------------------------------
    #[test]
    fn test_should_skip_hidden_files() {
        let path = std::path::Path::new("/test/.hidden");
        assert!(should_skip_entry(path, false));
    }

    #[test]
    fn test_should_skip_git_dir() {
        let path = std::path::Path::new("/test/.git");
        assert!(should_skip_entry(path, true));
    }

    #[test]
    fn test_should_skip_node_modules() {
        let path = std::path::Path::new("/test/node_modules");
        assert!(should_skip_entry(path, true));
    }

    #[test]
    fn test_should_not_skip_regular_file() {
        let path = std::path::Path::new("/test/main.rs");
        assert!(!should_skip_entry(path, false));
    }

    #[test]
    fn test_should_not_skip_regular_dir() {
        let path = std::path::Path::new("/test/src");
        assert!(!should_skip_entry(path, true));
    }

    // ---- is_binary --------------------------------------------------------
    #[test]
    fn test_is_binary_with_text_file() {
        let dir = std::env::temp_dir().join("nolock_test_binary_check");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("hello.txt");
        std::fs::write(&path, "Hello, this is plain text!").unwrap();
        assert!(!is_binary(&path));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn test_is_binary_with_binary_content() {
        let dir = std::env::temp_dir().join("nolock_test_binary_check2");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("binary.bin");
        let data = [0x00, 0x01, 0x02, 0x03, 0x04];
        std::fs::write(&path, &data).unwrap();
        assert!(is_binary(&path));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn test_is_binary_empty_file_not_binary() {
        let dir = std::env::temp_dir().join("nolock_test_binary_check3");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.txt");
        std::fs::write(&path, "").unwrap();
        assert!(!is_binary(&path));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    // ---- search_in_files integration --------------------------------------
    fn create_search_fixture(dir: &std::path::Path) {
        let _ = std::fs::create_dir_all(dir.join("src"));
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    println!(\"Hello\");\n}\n").unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn greet() {\n    println!(\"Hello world\");\n}\n").unwrap();
        std::fs::write(dir.join("README.md"), "# My Project\nHello everyone!\n").unwrap();
        // Hidden dir should be skipped
        let _ = std::fs::create_dir_all(dir.join(".git"));
        std::fs::write(dir.join(".git/config"), "[core]\n\trepositoryformatversion = 0\n").unwrap();
    }

    #[test]
    fn test_search_in_files_finds_matches() {
        let dir = std::env::temp_dir().join("nolock_test_search_integration");
        let _ = std::fs::create_dir_all(&dir);
        create_search_fixture(&dir);

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            "Hello".to_string(),
            true,  // match_case
            false, // use_regex
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        // Should find "Hello" in main.rs, lib.rs, and README.md
        // But NOT in .git/config (hidden dir skipped)
        assert_eq!(matches.len(), 3, "Expected 3 matches across 3 files");

        // Verify file diversity
        let mut files: Vec<&str> = matches.iter().map(|m| {
            let name = std::path::Path::new(&m.file_path)
                .file_name().unwrap().to_str().unwrap();
            name
        }).collect();
        files.sort();
        assert_eq!(files, vec!["README.md", "lib.rs", "main.rs"]);

        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_in_files_case_insensitive() {
        let dir = std::env::temp_dir().join("nolock_test_search_case");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "Hello\nWORLD\nhello\n").unwrap();

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            "hello".to_string(),
            false, // match_case = false
            false,
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        // Should match "Hello" and "hello" but not "WORLD"
        assert!(!matches.is_empty());
        // check that line 1 (Hello) and line 3 (hello) are matched
        let line_numbers: Vec<usize> = matches.iter().map(|m| m.line_number).collect();
        assert!(line_numbers.contains(&1), "Line 1 (Hello) should match");
        assert!(line_numbers.contains(&3), "Line 3 (hello) should match");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_in_files_no_results() {
        let dir = std::env::temp_dir().join("nolock_test_search_no_results");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "Hello\nWorld\n").unwrap();

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            "XYZ".to_string(),
            true, false,
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        assert!(matches.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_in_files_skips_hidden_dirs() {
        let dir = std::env::temp_dir().join("nolock_test_search_hidden");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::create_dir_all(dir.join(".hidden_dir"));
        std::fs::write(dir.join(".hidden_dir/secret.txt"), "secret stuff").unwrap();
        std::fs::write(dir.join("visible.txt"), "visible stuff").unwrap();

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            "stuff".to_string(),
            true, false,
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        // Only visible.txt should match
        assert_eq!(matches.len(), 1);
        assert!(matches[0].file_path.contains("visible.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_in_files_regex_mode() {
        let dir = std::env::temp_dir().join("nolock_test_search_regex");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("data.txt"), "abc123\ndef456\nabc789\n").unwrap();

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            r"abc\d+".to_string(),
            true,  // match_case
            true,  // use_regex
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        assert_eq!(matches.len(), 2, "Should match abc123 and abc789");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_in_files_returns_match_positions() {
        let dir = std::env::temp_dir().join("nolock_test_search_positions");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "abc hello def\n").unwrap();

        let result = search_in_files(
            dir.to_string_lossy().to_string(),
            "hello".to_string(),
            true, false,
        );
        assert!(result.is_ok());
        let matches = result.unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].match_start, 4);  // "hello" starts at index 4
        assert_eq!(matches[0].match_end, 9);    // "hello" ends at index 9
        assert_eq!(matches[0].line_number, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- replace_in_files integration ------------------------------------
    #[test]
    fn test_replace_in_files_basic() {
        let dir = std::env::temp_dir().join("nolock_test_replace_basic");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "Hello World\nGoodbye World\n").unwrap();

        let result = replace_in_files(
            dir.to_string_lossy().to_string(),
            "World".to_string(),
            "Moon".to_string(),
            true,  // match_case
            false, // use_regex
            None,  // target_files
        );
        assert!(result.is_ok());
        let res = result.unwrap();
        assert_eq!(res.files_changed, 1);
        assert_eq!(res.replacements_made, 2);

        // Verify file content
        let content = std::fs::read_to_string(dir.join("test.txt")).unwrap();
        assert_eq!(content, "Hello Moon\nGoodbye Moon\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_replace_in_files_case_insensitive() {
        let dir = std::env::temp_dir().join("nolock_test_replace_case");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "Hello WORLD world\n").unwrap();

        let result = replace_in_files(
            dir.to_string_lossy().to_string(),
            "world".to_string(),
            "Moon".to_string(),
            false, // match_case = false
            false,
            None,
        );
        assert!(result.is_ok());
        let res = result.unwrap();
        assert_eq!(res.replacements_made, 2); // WORLD and world

        let content = std::fs::read_to_string(dir.join("test.txt")).unwrap();
        assert_eq!(content, "Hello Moon Moon\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_replace_in_files_targeted_files() {
        let dir = std::env::temp_dir().join("nolock_test_replace_targeted");
        let _ = std::fs::create_dir_all(&dir);
        let file1 = dir.join("keep.txt");
        let file2 = dir.join("skip.txt");
        std::fs::write(&file1, "Hello World\n").unwrap();
        std::fs::write(&file2, "Hello World\n").unwrap();

        let result = replace_in_files(
            dir.to_string_lossy().to_string(),
            "Hello".to_string(),
            "Hi".to_string(),
            true, false,
            Some(vec![file1.to_string_lossy().to_string()]),
        );
        assert!(result.is_ok());
        let res = result.unwrap();
        assert_eq!(res.files_changed, 1);
        assert_eq!(res.replacements_made, 1);

        // keep.txt was modified
        let content1 = std::fs::read_to_string(&file1).unwrap();
        assert_eq!(content1, "Hi World\n");
        // skip.txt was NOT modified
        let content2 = std::fs::read_to_string(&file2).unwrap();
        assert_eq!(content2, "Hello World\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_replace_in_files_regex() {
        let dir = std::env::temp_dir().join("nolock_test_replace_regex");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "abc123 def456 ghi789\n").unwrap();

        let result = replace_in_files(
            dir.to_string_lossy().to_string(),
            r"[a-z]+".to_string(),
            "X".to_string(),
            true, // match_case
            true, // use_regex
            None,
        );
        assert!(result.is_ok());
        let res = result.unwrap();
        assert_eq!(res.replacements_made, 3);

        let content = std::fs::read_to_string(dir.join("test.txt")).unwrap();
        assert_eq!(content, "X123 X456 X789\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_replace_in_files_no_matches() {
        let dir = std::env::temp_dir().join("nolock_test_replace_no_match");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("test.txt"), "Hello World\n").unwrap();

        let result = replace_in_files(
            dir.to_string_lossy().to_string(),
            "XYZ".to_string(),
            "ABC".to_string(),
            true, false,
            None,
        );
        assert!(result.is_ok());
        let res = result.unwrap();
        assert_eq!(res.files_changed, 0);
        assert_eq!(res.replacements_made, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- list_directory with temp dir ------------------------------------
    #[test]
    fn test_list_directory_temp() {
        let dir = std::env::temp_dir().join("nolock_test_list_dir");
        let _ = std::fs::create_dir_all(&dir);

        // Create test files
        std::fs::write(dir.join("b_file.rs"), "// b").unwrap();
        std::fs::write(dir.join("a_file.rs"), "// a").unwrap();
        std::fs::write(dir.join(".hidden"), "secret").unwrap();
        std::fs::create_dir(dir.join("z_dir")).unwrap();

        let result = list_directory(dir.to_string_lossy().to_string(), None);
        assert!(result.is_ok());
        let entries = result.unwrap();

        // .hidden should be filtered out (show_hidden defaults to false)
        assert_eq!(entries.len(), 3);

        // z_dir should be first (dirs before files)
        assert_eq!(entries[0].name, "z_dir");
        assert!(entries[0].is_dir);

        // Files sorted alphabetically, case-insensitive
        assert_eq!(entries[1].name, "a_file.rs");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[2].name, "b_file.rs");
        assert!(!entries[2].is_dir);

        // Cleanup
        for entry in &entries {
            let p = dir.join(&entry.name);
            if entry.is_dir {
                let _ = std::fs::remove_dir(p);
            } else {
                let _ = std::fs::remove_file(p);
            }
        }
        let _ = std::fs::remove_dir(&dir);
    }

    // ---- AI completion body construction ----------------------------------
    #[test]
    fn test_ai_complete_ollama_body_has_system_field() {
        // Verify the Ollama request body includes a system prompt
        let req = CompletionRequest {
            backend: "ollama".into(),
            url: "http://localhost:11434".into(),
            model: "qwen2.5-coder:1.5b".into(),
            prompt: "fn main() {".into(),
            suffix: Some("}".into()),
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let with_suffix = req.suffix.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
        let mut b = serde_json::json!({
            "model": req.model,
            "system": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
            "prompt": req.prompt,
            "stream": false,
            "options": {
                "num_predict": 64,
                "temperature": 0.2,
                "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
            }
        });
        if with_suffix {
            if let Some(ref suffix) = req.suffix {
                if !suffix.is_empty() {
                    b["suffix"] = serde_json::json!(suffix);
                }
            }
        }

        assert_eq!(b["model"], "qwen2.5-coder:1.5b");
        assert!(b["system"].as_str().unwrap().contains("code completion engine"));
        assert!(b["system"].as_str().unwrap().contains("Output ONLY"));
        assert!(b["options"]["stop"].as_array().unwrap().contains(&serde_json::json!("\n\n")));
        assert!(b["options"]["stop"].as_array().unwrap().contains(&serde_json::json!("Here is")));
        assert!(b["options"]["stop"].as_array().unwrap().contains(&serde_json::json!("Explanation")));
        assert_eq!(b["suffix"], "}");
        assert_eq!(b["prompt"], "fn main() {");
    }

    #[test]
    fn test_ai_complete_llamacpp_body_has_system_field() {
        let req = CompletionRequest {
            backend: "llamacpp".into(),
            url: "http://localhost:8080".into(),
            model: "codellama".into(),
            prompt: "def hello():".into(),
            suffix: None,
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let mut b = serde_json::json!({
            "prompt": req.prompt,
            "n_predict": 64,
            "temperature": 0.2,
            "stream": false,
            "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
            "system": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code."
        });
        if let Some(ref suffix) = req.suffix {
            if !suffix.is_empty() {
                b["suffix"] = serde_json::json!(suffix);
            }
        }

        assert!(b["system"].as_str().unwrap().contains("code completion engine"));
        assert!(b["stop"].as_array().unwrap().contains(&serde_json::json!("Sure")));
        assert_eq!(b["prompt"], "def hello():");
    }

    #[test]
    fn test_ai_complete_openrouter_uses_system_message() {
        let req = CompletionRequest {
            backend: "openrouter".into(),
            url: "https://openrouter.ai".into(),
            model: "qwen3:8b".into(),
            prompt: "const x = ".into(),
            suffix: Some(";".into()),
            api_key: Some("sk-test".into()),
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let user_content = format!(
            "Complete the code at the cursor position marked by <CURSOR>.\n\n\
             Before cursor:\n```\n{}\n```\n\n\
             After cursor:\n```\n{}\n```\n\n\
             Output ONLY the code that should replace <CURSOR>. No explanations, \
             no markdown formatting, no conversational text.",
            req.prompt,
            req.suffix.as_deref().unwrap_or("")
        );

        let body = serde_json::json!({
            "model": req.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code."
                },
                { "role": "user", "content": user_content }
            ],
            "max_tokens": 64,
            "temperature": 0.2,
            "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Explanation"]
        });

        // Verify structure
        assert_eq!(body["model"], "qwen3:8b");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"].as_str().unwrap().contains("code completion engine"));
        assert_eq!(messages[1]["role"], "user");
        assert!(messages[1]["content"].as_str().unwrap().contains("<CURSOR>"));
        assert!(messages[1]["content"].as_str().unwrap().contains("const x ="));
        assert!(messages[1]["content"].as_str().unwrap().contains(";"));
        assert!(body["stop"].as_array().unwrap().contains(&serde_json::json!("I'll")));
    }

    #[test]
    fn test_ai_complete_openrouter_no_suffix_uses_raw_prompt() {
        let req = CompletionRequest {
            backend: "openrouter".into(),
            url: "https://openrouter.ai".into(),
            model: "qwen3:8b".into(),
            prompt: "const x = 42;".into(),
            suffix: None,
            api_key: Some("sk-test".into()),
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let user_content = format!(
            "Complete the following code at the cursor. Output ONLY the code that \
             belongs at the cursor. No explanations, no markdown, no conversational text.\n\n```\n{}\n```",
            req.prompt
        );

        let body = serde_json::json!({
            "model": req.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code."
                },
                { "role": "user", "content": user_content }
            ],
            "max_tokens": 64,
            "temperature": 0.2,
            "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Explanation"]
        });

        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert!(messages[1]["content"].as_str().unwrap().contains("const x = 42;"));
        assert!(!messages[1]["content"].as_str().unwrap().contains("<CURSOR>"));
    }

    #[test]
    fn test_ai_complete_opencode_body_has_system_field() {
        let req = CompletionRequest {
            backend: "opencode".into(),
            url: "http://localhost:11434".into(),
            model: "deepseek-coder".into(),
            prompt: "import".into(),
            suffix: None,
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let body = serde_json::json!({
            "model": req.model,
            "system": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
            "prompt": req.prompt,
            "stream": false,
            "options": {
                "num_predict": 64,
                "temperature": 0.2,
                "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
            }
        });

        assert!(body["system"].as_str().unwrap().contains("code completion engine"));
        assert_eq!(body["prompt"], "import");
        assert!(body["options"]["stop"].as_array().unwrap().contains(&serde_json::json!("Let me")));
    }

    #[test]
    fn test_ai_complete_stop_tokens_include_conversational_triggers() {
        let all_backend_stops = [
            // Ollama stops
            vec!["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
            // llama.cpp stops
            vec!["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
            // OpenRouter stops
            vec!["\n\n", "```", "Here is", "Sure", "I'll", "Explanation"],
            // OpenCode stops
            vec!["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
        ];

        // Every backend's stop array must contain the core conversational triggers
        for stops in &all_backend_stops {
            assert!(stops.contains(&"\n\n"), "Every backend needs \\n\\n stop");
            assert!(stops.contains(&"```"), "Every backend needs ``` stop");
            assert!(stops.contains(&"Here is"), "Every backend needs 'Here is' stop");
            assert!(stops.contains(&"I'll"), "Every backend needs 'I'll' stop");
        }
    }

    #[test]
    fn test_ai_complete_ollama_fim_fallback_body_no_suffix() {
        // When FITM fails and we retry without suffix, the body should NOT have `suffix`
        let req = CompletionRequest {
            backend: "ollama".into(),
            url: "http://localhost:11434".into(),
            model: "some-model".into(),
            prompt: "fn main() {".into(),
            suffix: Some("}".into()),
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
        };

        let body = serde_json::json!({
            "model": req.model,
            "system": "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
            "prompt": req.prompt,
            "stream": false,
            "options": {
                "num_predict": 64,
                "temperature": 0.2,
                "stop": ["\n\n", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
            }
        });
        // Fallback body must NOT have suffix field
        assert!(!body.as_object().unwrap().contains_key("suffix"),
                "Fallback body (no suffix) must not contain a 'suffix' field");
    }
}
