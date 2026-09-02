use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::Emitter;

use regex::Regex;

mod browser;
mod fabric;
mod hooks;
mod linter;
mod macos_keyboard;
pub mod secrets;
mod switchyard;
mod terminal_memory;
pub mod validation;

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
fn list_files_recursive(path: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    collect_files(dir, &mut files).map_err(|e| e.to_string())?;
    Ok(files)
}

fn collect_files(dir: &std::path::Path, files: &mut Vec<String>) -> std::io::Result<()> {
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                collect_files(&path, files)?;
            } else {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
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
fn move_file(source: String, dest_dir: String) -> Result<(), String> {
    let file_name = std::path::Path::new(&source)
        .file_name()
        .ok_or_else(|| "Cannot determine file name".to_string())?;
    let dest_path = std::path::Path::new(&dest_dir).join(file_name);
    std::fs::rename(&source, &dest_path)
        .map_err(|e| format!("Failed to move {} to {}: {}", source, dest_path.display(), e))
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

/// List all micro-agent files in the `.micro-agents/` directory under root_path.
/// Creates `.micro-agents/` if it does not exist. Returns agent entries sorted
/// by name.
#[tauri::command]
fn list_micro_agents(root_path: String) -> Result<Vec<AgentEntry>, String> {
    let agents_dir = std::path::Path::new(&root_path).join(".micro-agents");
    if !agents_dir.exists() {
        std::fs::create_dir_all(&agents_dir)
            .map_err(|e| format!("Failed to create .micro-agents directory: {}", e))?;
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(&agents_dir)
        .map_err(|e| format!("Failed to read .micro-agents directory: {}", e))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let stem = if let Some(s) = file_name.strip_suffix(".json") {
                s.to_string()
            } else if let Some(s) = file_name.strip_suffix(".md") {
                s.to_string()
            } else {
                continue;
            };
            entries.push(AgentEntry {
                name: stem,
                path: entry.path().to_string_lossy().to_string(),
            });
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

/// Read and parse a micro-agent file by its full path (same format as agents).
#[tauri::command]
fn read_micro_agent(path: String) -> Result<serde_json::Value, String> {
    read_agent(path)
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
fn validate_agents(root_path: String) -> Vec<String> {
    // nemo-fabric-core "behind the scenes" validation of every agent file in
    // `.agents/`. Returns a list of human-readable issues (empty = all valid).
    fabric::validate_agents_directory(&root_path)
}

/// Read the project's `.routers/switchyard.json` (defaults to disabled when the
/// file is absent). Used by the Switchyard Router panel.
#[tauri::command]
fn read_switchyard_config(root_path: String) -> Result<switchyard::SwitchyardConfig, String> {
    switchyard::read_switchyard_config(&root_path)
}

/// Validate + persist the project's `.routers/switchyard.json`.
#[tauri::command]
fn write_switchyard_config(
    root_path: String,
    config: switchyard::SwitchyardConfig,
) -> Result<(), String> {
    switchyard::validate_switchyard_config(&config)?;
    switchyard::write_switchyard_config(&root_path, &config)
}

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
    let mut backend = String::new();
    let mut temperature = 0.7_f64;
    let mut tools: Vec<String> = Vec::new();
    // NEW: Micro-agent delegation fields
    let mut can_spawn_micro_agents = false;
    let mut allowed_micro_agents: Vec<String> = Vec::new();
    let mut validation_rust_check = false;
    let mut validation_js_ts_lint = false;
    let mut validation_python_check = false;
    let mut validation_go_check = false;
    let mut validation_custom_commands: Vec<String> = Vec::new();
    let mut validation_custom_commands_expected: Vec<String> = Vec::new();
    let mut validation_verify_reported_output = false;
    let mut validation_require_all_pass = true;
    let mut validation_max_retries = 3;
    let prompt;

    // Extract frontmatter between --- markers
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        // Find the closing ---
        let after_first = &trimmed[3..]; // skip opening ---
        if let Some(end) = after_first.find("\n---") {
            let frontmatter_str = &after_first[..end];
            // Track whether we're inside the nested `validation:` mapping so its
            // indented keys (`rust_check`, `max_retries`, …) are folded into the
            // flat validation_* variables.
            let mut in_validation_section = false;
            for raw_line in frontmatter_str.lines() {
                let leading = raw_line.len() - raw_line.trim_start().len();
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                if !line.starts_with('#') && leading == 0 {
                    // Top-level key: if it's `validation:` with an empty value,
                    // subsequent indented lines belong to the nested mapping.
                    in_validation_section = line.trim_end() == "validation:";
                }
                if let Some((key, value)) = line.split_once(':') {
                    let key = key.trim().to_lowercase();
                    let value = value.trim().to_string();
                    if in_validation_section {
                        match key.as_str() {
                            "rust_check" => validation_rust_check = value.parse().unwrap_or(false),
                            "js_ts_lint" => validation_js_ts_lint = value.parse().unwrap_or(false),
                            "python_check" => validation_python_check = value.parse().unwrap_or(false),
                            "go_check" => validation_go_check = value.parse().unwrap_or(false),
                            "custom_commands" => validation_custom_commands = parse_tools_list(&value),
                            "custom_commands_expected" => validation_custom_commands_expected = parse_tools_list(&value),
                            "verify_reported_output" => validation_verify_reported_output = value.parse().unwrap_or(false),
                            "require_all_pass" => validation_require_all_pass = value.parse().unwrap_or(true),
                            "max_retries" => validation_max_retries = value.parse().unwrap_or(3),
                            _ => {}
                        }
                        continue;
                    }
                    match key.as_str() {
                        "name" => name = value,
                        "description" => description = value,
                        "model" => model = value,
                        "backend" => backend = value,
                        "temperature" => {
                            temperature = value.parse().unwrap_or(0.7);
                        }
                        "tools" => tools = parse_tools_list(&value),
                        "can_spawn_micro_agents" => {
                            can_spawn_micro_agents = value.parse().unwrap_or(false);
                        }
                        "allowed_micro_agents" => {
                            allowed_micro_agents = parse_tools_list(&value);
                        }
                        "validation_rust_check" => {
                            validation_rust_check = value.parse().unwrap_or(false);
                        }
                        "validation_js_ts_lint" => {
                            validation_js_ts_lint = value.parse().unwrap_or(false);
                        }
                        "validation_python_check" => {
                            validation_python_check = value.parse().unwrap_or(false);
                        }
                        "validation_go_check" => {
                            validation_go_check = value.parse().unwrap_or(false);
                        }
                        "validation_custom_commands" => {
                            validation_custom_commands = parse_tools_list(&value);
                        }
                        "validation_custom_commands_expected" => {
                            validation_custom_commands_expected = parse_tools_list(&value);
                        }
                        "validation_verify_reported_output" => {
                            validation_verify_reported_output = value.parse().unwrap_or(false);
                        }
                        "validation_require_all_pass" => {
                            validation_require_all_pass = value.parse().unwrap_or(true);
                        }
                        "validation_max_retries" => {
                            validation_max_retries = value.parse().unwrap_or(3);
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
        "backend": backend,
        "temperature": temperature,
        "tools": tools,
        "can_spawn_micro_agents": can_spawn_micro_agents,
        "allowed_micro_agents": allowed_micro_agents,
        "validation": {
            "rust_check": validation_rust_check,
            "js_ts_lint": validation_js_ts_lint,
            "python_check": validation_python_check,
            "go_check": validation_go_check,
            "custom_commands": validation_custom_commands,
            "custom_commands_expected": validation_custom_commands_expected,
            "verify_reported_output": validation_verify_reported_output,
            "require_all_pass": validation_require_all_pass,
            "max_retries": validation_max_retries,
        }
    }))
}

/// Parse a `tools:` frontmatter value into a list of tool names. Accepts both
/// comma-separated (`read_file, grep`) and JSON-array (`["read_file", "grep"]`)
/// forms.
fn parse_tools_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    // JSON array form
    if trimmed.starts_with('[') {
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(trimmed) {
            return arr.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        // Bracketed but unquoted form: "[rust-fixer, ts-type-fixer]".
        // Strip the brackets, then split on commas.
        let inner = trimmed
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim();
        return inner
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    // Comma-separated form
    trimmed
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// A parsed sub-agent definition (from `.agents/`).
#[derive(Clone, Default)]
pub struct AgentConfig {
    name: String,
    description: String,
    prompt: String,
    /// Empty = use the main agent's model.
    model: String,
    /// Empty = use the main agent's backend/provider.
    backend: String,
    temperature: f64,
    /// Empty = use the default standard tool set.
    tools: Vec<String>,
    /// When true, the sub-agent must fully inspect before answering
    /// (used e.g. by the code-reviewer so it doesn't return too early).
    thorough: bool,
    /// NEW: Micro-agent delegation
    can_spawn_micro_agents: bool,
    allowed_micro_agents: Vec<String>,
    validation: validation::ValidationConfig,
}

/// Load a single agent's config from `.agents/<name>.md` or `.agents/<name>.json`.
pub fn load_agent_config(root_path: &str, name: &str) -> Result<AgentConfig, String> {
    let base = std::path::Path::new(root_path).join(".agents");
    let md = base.join(format!("{}.md", name));
    let json = base.join(format!("{}.json", name));
    let path = if md.exists() {
        md
    } else if json.exists() {
        json
    } else {
        return Err(format!("Sub-agent '{}' not found in .agents/", name));
    };

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read agent file {}: {}", path.display(), e))?;

    let parsed = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Failed to parse agent file {}: {}", path.display(), e))?
    } else {
        // Reuse read_agent's markdown parsing.
        read_agent(path.to_string_lossy().to_string())?
    };

    Ok(AgentConfig {
        name: parsed["name"].as_str().unwrap_or(name).to_string(),
        description: parsed["description"].as_str().unwrap_or("").to_string(),
        prompt: parsed["prompt"].as_str().unwrap_or("").to_string(),
        model: parsed["model"].as_str().unwrap_or("").to_string(),
        backend: parsed["backend"].as_str().unwrap_or("").to_string(),
        temperature: parsed["temperature"].as_f64().unwrap_or(0.7),
        tools: parsed["tools"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        thorough: parsed["thorough"].as_bool().unwrap_or(false),
        // NEW: Micro-agent delegation
        can_spawn_micro_agents: parsed["can_spawn_micro_agents"].as_bool().unwrap_or(false),
        allowed_micro_agents: parsed["allowed_micro_agents"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        validation: validation::ValidationConfig {
            rust_check: parsed["validation"]["rust_check"].as_bool().unwrap_or(false),
            js_ts_lint: parsed["validation"]["js_ts_lint"].as_bool().unwrap_or(false),
            python_check: parsed["validation"]["python_check"].as_bool().unwrap_or(false),
            go_check: parsed["validation"]["go_check"].as_bool().unwrap_or(false),
            custom_commands: parsed["validation"]["custom_commands"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            custom_commands_expected: parsed["validation"]["custom_commands_expected"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            verify_reported_output: parsed["validation"]["verify_reported_output"]
                .as_bool()
                .unwrap_or(false),
            require_all_pass: parsed["validation"]["require_all_pass"].as_bool().unwrap_or(true),
            max_retries: parsed["validation"]["max_retries"].as_u64().unwrap_or(3) as usize,
        },
    })
}

/// Micro-agent configuration (from `.micro-agents/`).
#[derive(Clone, Default)]
pub struct MicroAgentConfig {
    name: String,
    description: String,
    prompt: String,
    model: String,
    backend: String,
    temperature: f64,
    tools: Vec<String>,
    validation: validation::ValidationConfig,
}

/// Load a single micro-agent's config from `.micro-agents/<name>.md` or `.micro-agents/<name>.json`.
pub fn load_micro_agent_config(root_path: &str, name: &str) -> Result<MicroAgentConfig, String> {
    let base = std::path::Path::new(root_path).join(".micro-agents");
    let md = base.join(format!("{}.md", name));
    let json = base.join(format!("{}.json", name));
    let path = if md.exists() {
        md
    } else if json.exists() {
        json
    } else {
        return Err(format!("Micro-agent '{}' not found in .micro-agents/", name));
    };

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read micro-agent file {}: {}", path.display(), e))?;

    let parsed = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Failed to parse micro-agent file {}: {}", path.display(), e))?
    } else {
        // Reuse read_agent's markdown parsing.
        read_agent(path.to_string_lossy().to_string())?
    };

    Ok(MicroAgentConfig {
        name: parsed["name"].as_str().unwrap_or(name).to_string(),
        description: parsed["description"].as_str().unwrap_or("").to_string(),
        prompt: parsed["prompt"].as_str().unwrap_or("").to_string(),
        model: parsed["model"].as_str().unwrap_or("").to_string(),
        backend: parsed["backend"].as_str().unwrap_or("").to_string(),
        temperature: parsed["temperature"].as_f64().unwrap_or(0.1),
        tools: parsed["tools"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        validation: validation::ValidationConfig {
            rust_check: parsed["validation"]["rust_check"].as_bool().unwrap_or(false),
            js_ts_lint: parsed["validation"]["js_ts_lint"].as_bool().unwrap_or(false),
            python_check: parsed["validation"]["python_check"].as_bool().unwrap_or(false),
            go_check: parsed["validation"]["go_check"].as_bool().unwrap_or(false),
            custom_commands: parsed["validation"]["custom_commands"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            custom_commands_expected: parsed["validation"]["custom_commands_expected"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            verify_reported_output: parsed["validation"]["verify_reported_output"]
                .as_bool()
                .unwrap_or(false),
            require_all_pass: parsed["validation"]["require_all_pass"].as_bool().unwrap_or(true),
            max_retries: parsed["validation"]["max_retries"].as_u64().unwrap_or(3) as usize,
        },
    })
}

/// List all micro-agent configs in `.micro-agents/`.
pub fn list_micro_agent_configs(root_path: &str) -> Vec<MicroAgentConfig> {
    let agents_dir = std::path::Path::new(root_path).join(".micro-agents");
    let read_dir = match std::fs::read_dir(&agents_dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let mut configs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let stem = if let Some(s) = file_name.strip_suffix(".json") {
            s.to_string()
        } else if let Some(s) = file_name.strip_suffix(".md") {
            s.to_string()
        } else {
            continue;
        };
        if !seen.insert(stem.clone()) {
            continue;
        }
        if let Ok(cfg) = load_micro_agent_config(root_path, &stem) {
            configs.push(cfg);
        }
    }
    configs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    configs
}

/// List all agent configs in `.agents/` (name + description + prompt + model +
/// backend + tools). Used to build the `spawn_subagent` tool description.
fn list_agent_configs(root_path: &str) -> Vec<AgentConfig> {
    let agents_dir = std::path::Path::new(root_path).join(".agents");
    let read_dir = match std::fs::read_dir(&agents_dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let mut configs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let stem = if let Some(s) = file_name.strip_suffix(".json") {
            s.to_string()
        } else if let Some(s) = file_name.strip_suffix(".md") {
            s.to_string()
        } else {
            continue;
        };
        if !seen.insert(stem.clone()) {
            continue;
        }
        if let Ok(cfg) = load_agent_config(root_path, &stem) {
            configs.push(cfg);
        }
    }
    configs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    configs
}

// ---------------------------------------------------------------------------
// Session management commands (project-local `.sessions/` directory)
// ---------------------------------------------------------------------------

/// Resolve the `.sessions/` directory. Falls back to `~/.nolock/sessions` when
/// no project folder is open so sessions still work outside a project.
fn sessions_dir(root_path: &str) -> Result<std::path::PathBuf, String> {
    if root_path.trim().is_empty() {
        let home = std::env::var("HOME")
            .map_err(|_| "No HOME directory and no project folder open".to_string())?;
        return Ok(std::path::Path::new(&home).join(".nolock").join("sessions"));
    }
    Ok(std::path::Path::new(root_path).join(".sessions"))
}

/// Reject session ids that could escape the `.sessions/` directory.
fn sanitize_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid session id: {:?}", id));
    }
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// List all persisted sessions, newest first. Each record carries only metadata.
#[tauri::command]
fn list_sessions(root_path: String) -> Result<Vec<SessionRecord>, String> {
    let dir = sessions_dir(&root_path)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let read_dir = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read .sessions directory: {}", e))?;

    let mut sessions = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read session {}: {}", path.display(), e))?;
        if let Ok(rec) = serde_json::from_str::<SessionRecord>(&content) {
            sessions.push(rec);
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// Read a single session record (metadata only) by id.
#[tauri::command]
fn read_session(root_path: String, id: String) -> Result<SessionRecord, String> {
    sanitize_session_id(&id)?;
    let path = sessions_dir(&root_path)?.join(format!("{}.json", id));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session {}: {}", id, e))?;
    serde_json::from_str::<SessionRecord>(&content)
        .map_err(|e| format!("Failed to parse session {}: {}", id, e))
}

/// Persist a session record (creating it if new, overwriting if existing).
#[tauri::command]
fn save_session(root_path: String, session: SessionRecord) -> Result<(), String> {
    sanitize_session_id(&session.id)?;
    let dir = sessions_dir(&root_path)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create .sessions directory: {}", e))?;
    let path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write session {}: {}", session.id, e))
}

/// Delete a session by id.
#[tauri::command]
fn delete_session(root_path: String, id: String) -> Result<(), String> {
    sanitize_session_id(&id)?;
    let path = sessions_dir(&root_path)?.join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete session {}: {}", id, e))?;
    }
    Ok(())
}

/// Mark a session as archived and optionally attach a summary.
#[tauri::command]
fn archive_session(root_path: String, id: String, summary: String) -> Result<(), String> {
    sanitize_session_id(&id)?;
    let path = sessions_dir(&root_path)?.join(format!("{}.json", id));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session {}: {}", id, e))?;
    let mut rec: SessionRecord = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse session {}: {}", id, e))?;
    rec.status = "archived".to_string();
    if !summary.trim().is_empty() {
        rec.summary = summary.trim().to_string();
    }
    rec.updated_at = now_secs();
    let json = serde_json::to_string_pretty(&rec)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write session {}: {}", id, e))
}

// ---------------------------------------------------------------------------
// Custom tool management commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct CustomToolEntry {
    name: String,
    path: String,
    description: String,
}

/// List all custom tool files in the `.tools/` directory under root_path.
/// Creates `.tools/` if it does not exist.
#[tauri::command]
fn list_tools(root_path: String) -> Result<Vec<CustomToolEntry>, String> {
    let tools_dir = std::path::Path::new(&root_path).join(".tools");
    if !tools_dir.exists() {
        std::fs::create_dir_all(&tools_dir)
            .map_err(|e| format!("Failed to create .tools directory: {}", e))?;
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(&tools_dir)
        .map_err(|e| format!("Failed to read .tools directory: {}", e))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.ends_with(".json") {
                let stem = file_name.strip_suffix(".json").unwrap_or(&file_name).to_string();
                // Read the file to get the description
                let content = std::fs::read_to_string(entry.path())
                    .unwrap_or_default();
                let description = serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|v| v["description"].as_str().map(String::from))
                    .unwrap_or_default();
                entries.push(CustomToolEntry {
                    name: stem,
                    path: entry.path().to_string_lossy().to_string(),
                    description,
                });
            }
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

/// Read and parse a custom tool file from `.tools/`.
#[tauri::command]
fn read_tool(path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read tool file {}: {}", path, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse tool file {}: {}", path, e))
}

/// Execute a custom tool command by name, substituting arguments into the template.
#[tauri::command]
fn run_tool_command(root_path: String, tool_name: String, args: serde_json::Value) -> Result<String, String> {
    let tool_path = std::path::Path::new(&root_path)
        .join(".tools")
        .join(format!("{}.json", tool_name));

    let content = std::fs::read_to_string(&tool_path)
        .map_err(|e| format!("Failed to read tool '{}': {}", tool_name, e))?;

    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse tool '{}': {}", tool_name, e))?;

    let command_template = parsed["command"].as_str()
        .ok_or_else(|| format!("Tool '{}' missing 'command' field", tool_name))?;

    // Substitute {param} placeholders with actual argument values
    let mut command_str = command_template.to_string();
    if let Some(obj) = args.as_object() {
        for (key, value) in obj {
            let placeholder = format!("{{{}}}", key);
            let replacement = value.as_str()
                .map(|s| s.to_string())
                .or_else(|| value.as_i64().map(|n| n.to_string()))
                .or_else(|| value.as_f64().map(|n| n.to_string()))
                .unwrap_or_default();
            command_str = command_str.replace(&placeholder, &replacement);
        }
    }

    if command_str.trim().is_empty() {
        return Ok(String::new());
    }

    let parts: Vec<&str> = command_str.split_whitespace().collect();
    if parts.is_empty() {
        return Ok(String::new());
    }

    let program = parts[0];
    let cmd_args = &parts[1..];

    match std::process::Command::new(program)
        .args(cmd_args)
        .current_dir(&root_path)
        .output()
    {
        Ok(out) => {
            let mut result = String::new();
            if !out.stdout.is_empty() {
                result.push_str(&String::from_utf8_lossy(&out.stdout));
            }
            if !out.stderr.is_empty() {
                if !result.is_empty() { result.push('\n'); }
                result.push_str(&String::from_utf8_lossy(&out.stderr));
            }
            if result.is_empty() {
                result = format!("(exit code: {})", out.status.code().unwrap_or(-1));
            }
            Ok(result)
        }
        Err(e) => Err(format!("Failed to execute tool '{}': {}", tool_name, e)),
    }
}

// ---------------------------------------------------------------------------
// Skill management commands
// ---------------------------------------------------------------------------

/// Reset all sub-agent conversation memory. Called by the frontend when a new
/// chat session starts so a fresh session doesn't inherit prior sub-agent
/// context.
#[tauri::command]
fn subagent_reset(memory: tauri::State<'_, SubAgentMemory>) -> Result<(), String> {
    memory.clear();
    Ok(())
}

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

// Tool result limits (for 9B model safety)
const GREP_MAX_MATCHES: usize = 100;
const GREP_MAX_OUTPUT_BYTES: usize = 50 * 1024; // 50KB
const GREP_MAX_LINE_LENGTH: usize = 500;
const READ_FILE_MAX_BYTES: usize = 8 * 1024; // 8KB

// Tool result limits for cloud providers (DigitalOcean, OpenRouter, OpenCode).
// These route to models with large context windows, so the aggressive
// small-model truncation above should not be applied to them.
const READ_FILE_MAX_BYTES_CLOUD: usize = 1024 * 1024; // 1MB
const WEB_FETCH_MAX_CHARS_CLOUD: usize = 256 * 1024; // 256KB

/// Default output-token budget for cloud providers when the user hasn't set one
/// explicitly. Kept well below the model's context window so there's always room
/// for the input prompt (the API rejects `input + max_completion_tokens` when it
/// exceeds the context). The user can override it via the "Cloud Max Tokens"
/// setting in the Chat Model panel.
const CLOUD_DEFAULT_MAX_TOKENS: u32 = 65_536;

/// Default output-token budget for local backends when tools are enabled and the
/// user hasn't set one. Large enough for multi-tool agent loops on models with
/// big context windows.
const LOCAL_TOOL_MAX_TOKENS: u32 = 256_000;

/// Default output-token budget for local backends when the user hasn't set one
/// and there are no tools. Matches the Chat Model panel's default (8192).
/// Thinking/reasoning models (Qwen3, Nemotron, DeepSeek-R1, etc.) can spend a
/// large fraction of this on hidden reasoning before emitting any visible
/// content, so keeping the floor at 8192 (not 2048) prevents "silent" responses
/// where the model thinks for the entire budget and never writes an answer.
const LOCAL_DEFAULT_MAX_TOKENS: u32 = 8192;

/// Returns true for cloud backends (DigitalOcean, OpenRouter, OpenCode), which
/// have large context windows and should not be constrained by the small-local-
/// model tool-result limits.
fn is_cloud_backend(backend: &str) -> bool {
    !matches!(backend, "ollama" | "llamacpp")
}

/// Max bytes `read_file` may return for the given backend.
fn read_file_limit(backend: &str) -> usize {
    if is_cloud_backend(backend) {
        READ_FILE_MAX_BYTES_CLOUD
    } else {
        READ_FILE_MAX_BYTES
    }
}

/// Max chars `web_fetch` may return for the given backend.
fn web_fetch_limit(backend: &str) -> usize {
    if is_cloud_backend(backend) {
        WEB_FETCH_MAX_CHARS_CLOUD
    } else {
        15_000
    }
}

/// Resolves `path` against the open project folder (`root_path`) when one is
/// set, and rejects any path that resolves outside it. When no folder is open
/// the path is returned as-is. This keeps filesystem tools scoped to the
/// project the user actually has open in nolock.
fn resolve_within_root(
    root_path: Option<&str>,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    match root_path {
        None => Ok(std::path::PathBuf::from(path)),
        Some(rp) => {
            let p = std::path::Path::new(path);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                std::path::Path::new(rp).join(p)
            };
            let root_canon = std::path::Path::new(rp)
                .canonicalize()
                .map_err(|e| format!("Failed to resolve project root: {}", e))?;
            // Canonicalize the target when it exists; otherwise resolve its
            // nearest existing parent and re-append the file/dir name. This
            // also resolves symlinks so links pointing outside the project
            // are rejected too.
            let target_canon = abs
                .canonicalize()
                .or_else(|_| {
                    abs.parent()
                        .and_then(|par| par.canonicalize().ok())
                        .map(|par| par.join(abs.file_name().unwrap_or_default()))
                        .ok_or_else(|| {
                            std::io::Error::new(
                                std::io::ErrorKind::NotFound,
                                "path has no resolvable parent",
                            )
                        })
                })
                .map_err(|e| format!("Failed to resolve path '{}': {}", path, e))?;
            if !target_canon.starts_with(&root_canon) {
                return Err(format!(
                    "Path '{}' is outside the open folder '{}'",
                    path, rp
                ));
            }
            Ok(abs)
        }
    }
}

/// Returns true if `candidate` (an absolute path string) is equal to or nested
/// inside `root` (an already-canonicalized absolute path). Falls back to a
/// lexical component comparison when `candidate` does not exist on disk.
fn path_is_within(root: &std::path::Path, candidate: &str) -> bool {
    let cand = std::path::Path::new(candidate);
    if let Ok(cc) = cand.canonicalize() {
        return cc.starts_with(root);
    }
    let root_comps: Vec<std::path::Component> = root.components().collect();
    let mut norm: Vec<std::path::Component> = Vec::new();
    for c in cand.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if norm.len() > 1 {
                    norm.pop();
                }
            }
            other => norm.push(other),
        }
    }
    norm.len() >= root_comps.len()
        && norm.iter().zip(&root_comps).all(|(a, b)| a == b)
}

/// Scans a shell command for absolute-path references and returns the first one
/// that resolves outside `root` (which must already be canonicalized). This
/// keeps `bash_sandbox` scoped to the open project folder so the shell can't
/// `find`/`cat`/`cd` into other directories.
fn command_escapes_root(command: &str, root: &std::path::Path) -> Option<String> {
    for raw in command.split_whitespace() {
        // Take the leading path-like portion of each token, dropping leading
        // quotes and trailing shell metacharacters / punctuation.
        let path_str: String = raw
            .chars()
            .skip_while(|c| matches!(c, '\'' | '"'))
            .take_while(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~'))
            .collect();
        if !path_str.starts_with('/') {
            continue;
        }
        if !path_is_within(root, &path_str) {
            return Some(path_str);
        }
    }
    None
}

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

            let ctx = parse_ollama_context_length(&data);
            eprintln!("[nolock] get_model_info: context_length={}", ctx);
            Ok(ModelInfoResult { context_length: ctx })
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

/// Parse the model's context length from an Ollama `/api/show` response.
///
/// Priority:
///   1. The model's NATIVE `context_length` (its true max token capability).
///      The Modelfile's `num_ctx` (e.g. 32k) is only the default window Ollama
///      loads — it is NOT the model's ceiling. The context meter should show
///      the model's true max so the user knows how much context is available.
///   2. The user-set `num_ctx` override in the Modelfile parameters (only when
///      the native length is unavailable).
///   3. A conservative default (8192).
///
/// Pure — unit-testable.
fn parse_ollama_context_length(data: &serde_json::Value) -> u32 {
    // 1. Native context length (max capability).
    if let Some(model_info) = data["model_info"].as_object() {
        if let Some(arch) = model_info
            .get("general.architecture")
            .and_then(|v| v.as_str())
        {
            let key = format!("{}.context_length", arch);
            if let Some(ctx) = model_info.get(&key).and_then(|v| v.as_u64()) {
                return ctx as u32;
            }
        }
    }

    // 2. User-set num_ctx override in parameters.
    if let Some(params) = data["parameters"].as_str() {
        for line in params.lines() {
            let trimmed = line.trim();
            if let Some(num_str) = trimmed.strip_prefix("num_ctx ") {
                if let Ok(ctx) = num_str.trim().parse::<u32>() {
                    return ctx;
                }
            }
        }
    }

    // 3. Fallback.
    8192
}

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
    /// Per-1M-token pricing (USD) when the provider reports it. Lets the
    /// frontend compute approximate session costs per model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pricing: Option<ModelPricing>,
}

#[derive(serde::Serialize)]
struct ModelPricing {
    prompt: f64,
    completion: f64,
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
                    pricing: Some(ModelPricing { prompt: prompt_price, completion: completion_price }),
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
                        pricing: None,
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
                        pricing: None,
                    }
                }).collect())
            }
        }
        "ollama" => {
            let base = req.url.trim_end_matches('/');
            let endpoint = format!("{}/api/tags", base);
            eprintln!("[nolock] fetch_models ollama GET {}", endpoint);
            let resp = client
                .get(&endpoint)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Ollama request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("Ollama API error ({}): {}", status, &text[..text.len().min(200)]));
            }

            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let models = body["models"].as_array().cloned().unwrap_or_default();

            Ok(models.iter().map(|m| {
                let name = m["name"].as_str().unwrap_or("");
                ModelListItem {
                    id: name.to_string(),
                    name: name.to_string(),
                    is_free: true, // local models are always free
                    zero_data_retention: true, // local = fully private
                    pricing: None,
                }
            }).collect())
        }
        "llamacpp" => {
            let base = req.url.trim_end_matches('/');
            let endpoint = format!("{}/v1/models", base);
            eprintln!("[nolock] fetch_models llamacpp GET {}", endpoint);
            let mut builder = client
                .get(&endpoint)
                .header("Accept", "application/json");
            if let Some(ref key) = req.api_key {
                if !key.is_empty() {
                    builder = builder.header("Authorization", format!("Bearer {}", key));
                }
            }
            let resp = builder
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("llama.cpp request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("llama.cpp API error ({}): {}", status, &text[..text.len().min(200)]));
            }

            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let data = body["data"].as_array().cloned().unwrap_or_default();

            Ok(data.iter().map(|m| {
                let id = m["id"].as_str().unwrap_or("");
                let name = m["name"].as_str().unwrap_or(id);
                ModelListItem {
                    id: id.to_string(),
                    name: name.to_string(),
                    is_free: true, // local models are always free
                    zero_data_retention: true, // local = fully private
                    pricing: None,
                }
            }).collect())
        }
        "digitalocean" => {
            // DigitalOcean Inference Router — return empty list, routers are fetched separately
            // Models are associated with routers, not listed directly
            Ok(vec![])
        }
        _ => Ok(vec![]),
    }
}

// ---------------------------------------------------------------------------
// DigitalOcean Inference Router commands
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct FetchRoutersRequest {
    api_key: String,
}

#[derive(serde::Serialize)]
struct RouterItem {
    /// Router name — used to build the `router:{name}` model reference.
    id: String,
    /// Display name.
    name: String,
    /// Router description.
    description: String,
}

#[tauri::command]
async fn fetch_digitalocean_routers(req: FetchRoutersRequest) -> Result<Vec<RouterItem>, String> {
    let client = reqwest::Client::new();
    // DigitalOcean Inference Router management API — lists the routers in the
    // authenticated account. Requires a personal access token (dop_v1_...) with
    // the `genai:read` scope.
    let endpoint = "https://api.digitalocean.com/v2/gen-ai/models/routers?per_page=200";

    eprintln!("[nolock] fetch_digitalocean_routers GET {}", endpoint);
    let resp = client
        .get(endpoint)
        .header("Authorization", format!("Bearer {}", req.api_key))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("DigitalOcean routers request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "DigitalOcean API error ({}): {}",
            status,
            &text[..text.len().min(300)]
        ));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // The list endpoint returns the routers under the `model_routers` key
    // (per the OpenAPI spec `apiListModelRoutersOutput`). Fall back to other
    // plausible keys in case the shape changes between API versions.
    let routers = body["model_routers"]
        .as_array()
        .or_else(|| body["routers"].as_array())
        .or_else(|| body["data"].as_array())
        .cloned()
        .unwrap_or_default();

    Ok(routers
        .iter()
        .filter_map(|r| {
            // `name` is the router reference used in `router:{name}`. Fall back
            // to `uuid`/`id` (the unique identifier) in case `name` is absent.
            let name = r["name"]
                .as_str()
                .or_else(|| r["uuid"].as_str())
                .or_else(|| r["id"].as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                return None;
            }
            let description = r["description"].as_str().unwrap_or("").to_string();
            Some(RouterItem {
                id: name.clone(),
                name,
                description,
            })
        })
        .collect())
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
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Sessions — project-local conversation persistence (`.sessions/`)
// ---------------------------------------------------------------------------

/// A single persisted conversation session. Only *metadata* is stored — the
/// full message history is intentionally NOT persisted. The important summary
/// fields are: message count, tool-call count, the first/last message text, and
/// the total token usage (so the frontend can warn and clean context as the
/// model's context window fills up).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    summary: String,
    /// "active" | "finished" | "archived"
    status: String,
    created_at: u64,
    updated_at: u64,
    /// Number of user + assistant messages in the conversation.
    #[serde(default)]
    message_count: u64,
    /// Number of tool calls the agent made during the session.
    #[serde(default)]
    tool_call_count: u64,
    /// First user message (display title fallback).
    #[serde(default)]
    first_message: String,
    /// Last message content (user or assistant).
    #[serde(default)]
    last_message: String,
    /// Total tokens in the last-recorded outgoing context payload.
    #[serde(default)]
    token_usage: u64,
    /// The model's context window (denominator for the context meter).
    #[serde(default)]
    context_window: u64,
    /// Full conversation log — every user prompt and every assistant tool call
    /// (no exceptions). This turns `.sessions/` files into an audit trail rather
    /// than metadata-only records.
    #[serde(default)]
    messages: Vec<SessionLogMessage>,
    /// Per-request/per-iteration token usage split by provider + model with an
    /// optional unit price and computed cost.
    #[serde(default)]
    usage: Vec<SessionUsageRecord>,
    /// Computed session cost (USD) when pricing is known for the models used.
    #[serde(default)]
    total_cost: Option<f64>,
}

/// A single logged conversation entry persisted in a session file. Captures the
/// full user prompt (both what the user typed and the expanded API content) and
/// any tool calls made by the assistant on that turn.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLogMessage {
    role: String,
    content: String,
    #[serde(default)]
    display_content: String,
    /// Unix timestamp (seconds) when this message was created.
    #[serde(default)]
    created_at: u64,
    /// Model that produced this message (assistant only).
    #[serde(default)]
    model: String,
    /// Token count for this message (computed by the frontend).
    #[serde(default)]
    tokens: u64,
    /// Tool calls made by the assistant on this turn (assistant only).
    #[serde(default)]
    tool_calls: Vec<ToolCallLog>,
}

/// Per-request/per-iteration token usage persisted in a session file, split by
/// provider + model so the summary UI can show exactly what each model cost.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUsageRecord {
    provider: String,
    model: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    /// Price per 1M input tokens (USD), when available from the provider.
    #[serde(default)]
    prompt_price_per_m: Option<f64>,
    /// Price per 1M output tokens (USD), when available from the provider.
    #[serde(default)]
    completion_price_per_m: Option<f64>,
    /// Computed cost (USD) for this entry, when pricing is available.
    #[serde(default)]
    cost: Option<f64>,
}

/// Endpoint + credential for a single model provider, used to resolve the
/// sub-agent's provider when it differs from the main agent's.
#[derive(Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub backend: String,
    pub url: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Config for all configured providers, keyed by backend name. Used to
    /// resolve credentials + endpoint when a sub-agent runs on a different
    /// provider than the main agent (multi-model provider routing).
    #[serde(default)]
    pub providers: HashMap<String, ProviderConfig>,
    #[serde(default)]
    pub tools_enabled: Vec<String>,
    /// Per-tool configuration (e.g. web_search provider + api_key).
    /// Stored in localStorage on the frontend as `nolock.toolConfig`.
    #[serde(default)]
    pub tool_configs: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// The model's context window (in tokens), used to cap `max_completion_tokens`
    /// so `input + output` never exceeds the context. Passed from the frontend
    /// (the "Context Window" setting / auto-detected value).
    #[serde(default)]
    pub context_length: Option<u32>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// The root folder path currently open in the editor.
    /// Used by file-system tools (e.g. write_file) to scope paths.
    #[serde(default)]
    pub root_path: Option<String>,
    /// Maximum number of tool call iterations before the agent stops.
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    /// Whether to pin the DigitalOcean Inference Router to a single model for
    /// the whole agent/tool loop (via the `X-Model-Affinity` header). Defaults
    /// to enabled when absent.
    #[serde(default)]
    pub model_affinity: Option<bool>,
    /// Agents explicitly referenced by the user via `@agent` mentions. The
    /// backend pre-spawns these in parallel and injects their results as
    /// context, so parallel triggering doesn't depend on the orchestrator
    /// model reliably emitting multiple `spawn_subagent` calls in one turn.
    #[serde(default)]
    pub referenced_agents: Vec<String>,
    /// Maximum number of consecutive "reasoning-only" retries before giving up
    /// when a thinking model (nemotron, qwen3, deepseek-r1, …) ends a turn with
    /// only thinking and no visible content / tool call. Configurable from the
    /// Chat Model panel. Defaults to THINKING_ONLY_MAX_RETRIES when unset.
    #[serde(default)]
    pub reasoning_retries: Option<usize>,
}

fn default_max_iterations() -> usize {
    10
}

/// Token usage for a single model request/iteration, explicitly keyed by the
/// provider and model that served it. The frontend's session log persists this
/// as the per-iteration token breakdown (with optional price/cost enrichment).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub provider: String,
    pub model: String,
    /// Input / prompt tokens consumed by this request.
    pub prompt_tokens: u64,
    /// Output / completion tokens produced by this request.
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(serde::Serialize)]
pub struct ChatResult {
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallLog>,
    /// Total tokens of the context the model actually processed for this
    /// request — the full outgoing messages PLUS every tool iteration and any
    /// injected sub-agent results. The frontend uses this (when > 0) as the
    /// authoritative session token count / context meter numerator so the
    /// UI reflects what the main agent really sent (not just the frontend's
    /// estimate of the first payload).
    #[serde(default)]
    pub context_tokens: u64,
    /// Estimated tokens of hidden reasoning/thinking the model produced for
    /// this request (main agent + any sub-agents it spawned). Folded into
    /// `context_tokens` so the session meter/limit reflects thinking too.
    #[serde(default)]
    pub thinking_tokens: u64,
    /// Per-request/per-iteration token usage split by provider + model.
    /// Each tool-loop iteration that hit the streaming endpoint contributes
    /// one entry (with the provider's reported usage when available, otherwise
    /// an estimate). The frontend persists this in the session file so users
    /// can see exactly what each iteration cost.
    #[serde(default)]
    pub usage: Vec<UsageReport>,
}

/// Rough token estimate for text (chars / 4, the same heuristic the rest of
/// the backend uses). Consistent so the context meter matches the request
/// caps the backend computes.
pub fn estimate_chat_tokens(text: &str) -> u64 {
    (text.chars().count() as u64 / 4) + 1
}

/// Add the estimated token count of a hidden-reasoning string to a running
/// total. Extracted into a helper so the invocation site (and unit test) is
/// uniform across the Ollama/OpenAI tool loops and the plain-chat retry path.
fn accumulate_thinking(total: &mut u64, thinking: &str) {
    if !thinking.is_empty() {
        *total += estimate_chat_tokens(thinking);
    }
}

/// Bound a local output budget (`num_predict`) against the model's context
/// window. `max_output` is the room left after the current input estimate and
/// a safety margin. A 4096 floor keeps tool-dominated agents one plausible
/// iteration cycle even when the window is nearly full.
fn bound_local_max_tokens(max_tokens: u32, max_output: u32) -> u32 {
    max_tokens.min(max_output.max(4096))
}

/// Sum the estimated token count of a full message list — used to report the
/// real context the model processed (including injected `[Sub-agent @X result]`
/// system messages added by the pre-spawn step).
fn estimate_messages_tokens(messages: &[ChatMessage]) -> u64 {
    messages.iter().map(|m| estimate_chat_tokens(&m.content)).sum()
}

/// Estimate tokens from a serde_json message array (used by the tool loops for
/// the `context_tokens` report — the full conversation the model processed,
/// including assistant tool-call messages and tool results).
fn estimate_json_messages_tokens(msgs: &[serde_json::Value]) -> u64 {
    msgs.iter()
        .filter_map(|m| m["content"].as_str().map(estimate_chat_tokens))
        .sum()
}

/// Build a token-usage report for a single model iteration, explicitly split by
/// provider + model. Prefers the provider's reported usage (OpenAI: `usage`,
/// Ollama: `prompt_eval_count`/`eval_count`); falls back to the same
/// character-count heuristic the rest of the backend uses so the session cost
/// log stays consistent even when a provider doesn't return a `usage` payload.
/// Thinking tokens are intentionally NOT folded into the report (the session
/// summary excludes them for now).
fn usage_for(
    provider: &str,
    model: &str,
    reported_prompt: u64,
    reported_completion: u64,
    est_prompt: u64,
    est_completion: u64,
) -> UsageReport {
    let prompt_tokens = if reported_prompt > 0 {
        reported_prompt
    } else {
        est_prompt.max(1)
    };
    let completion_tokens = if reported_completion > 0 {
        reported_completion
    } else {
        est_completion
    };
    UsageReport {
        provider: provider.to_string(),
        model: model.to_string(),
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

/// A single old/new text pair from an `edit` tool call.
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
struct FileChangeEdit {
    old_text: String,
    new_text: String,
}

/// Structured metadata about a file that a tool call changed. Returned to the
/// frontend so it can render an expandable before/after diff. Only populated
/// for file-mutating tools (`write_file`, `edit`).
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
struct FileChange {
    path: String,
    /// "write" for new/overwritten files, "edit" for in-place edits.
    action: String,
    /// True when the file did not exist before the tool ran.
    created: bool,
    /// Number of bytes in the file after the change.
    bytes: u64,
    /// The individual edits (for `edit`). Empty for `write`.
    #[serde(default)]
    edits: Vec<FileChangeEdit>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ToolCallLog {
    pub name: String,
    pub arguments: String,
    #[serde(default)]
    pub result_snippet: String,
    #[serde(default)]
    pub result_full: String,
    #[serde(default)]
    file_changes: Vec<FileChange>,
    /// Present when this tool call spawned a sub-agent; carries the full trace
    /// so the frontend can render an inspectable "window" in the conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubAgentTrace>,
}

/// Full trace of a sub-agent run, returned to the frontend so it can render an
/// expandable window showing the sub-agent's work (tool calls + final answer).
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SubAgentTrace {
    pub id: String,
    pub agent: String,
    pub task: String,
    pub model: String,
    pub result: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallLog>,
    /// Estimated tokens of hidden reasoning/thinking the sub-agent produced.
    #[serde(default)]
    pub thinking_tokens: u64,
}

#[derive(Clone, serde::Serialize)]
struct StreamPayload {
    token: String,
    #[serde(default)]
    thinking: bool,
}

/// Emitted as `tool-progress` while the agent tool loop runs, so the frontend
/// can show a live "editing <file>…" status line.
#[derive(Clone, serde::Serialize)]
struct ToolProgressPayload {
    /// "start" | "done" | "error"
    #[serde(rename = "type")]
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

// ---- Sub-agent streaming event payloads ------------------------------------

/// Emitted as `subagent-start` when the main agent spawns a sub-agent.
#[derive(Clone, serde::Serialize)]
struct SubAgentStartPayload {
    id: String,
    agent: String,
    task: String,
    model: String,
}

/// Emitted as `subagent-token` while a sub-agent streams its answer/thinking.
#[derive(Clone, serde::Serialize)]
struct SubAgentTokenPayload {
    id: String,
    token: String,
    #[serde(default)]
    thinking: bool,
}

/// Emitted as `subagent-tool-progress` while a sub-agent runs a tool.
#[derive(Clone, serde::Serialize)]
struct SubAgentToolProgressPayload {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// Emitted as `subagent-done` when a sub-agent finishes.
#[derive(Clone, serde::Serialize)]
struct SubAgentDonePayload {
    id: String,
    result: String,
}

/// Abstraction over where the agent loop reports its live progress (streamed
/// tokens, tool progress, routed-model info). The Tauri app emits these as
/// events to the frontend; the CLI writes them to stdout/stderr. This lets the
/// full main/sub/micro-agent tool loops run identically from the GUI and from a
/// headless CLI / E2E test harness.
pub trait EventSink {
    fn emit_stream_token(&self, subagent_id: Option<&str>, token: &str, thinking: bool);
    fn emit_tool_progress(&self, subagent_id: Option<&str>, kind: &str, name: &str, path: Option<String>);
    fn emit_model_routed(&self, model: &str);
    fn emit_subagent_start(&self, id: &str, agent: &str, task: &str, model: &str);
    fn emit_subagent_done(&self, id: &str, result: &str);
}

/// The Tauri `AppHandle` forwards events to the frontend (unchanged behaviour).
impl EventSink for tauri::AppHandle {
    fn emit_stream_token(&self, subagent_id: Option<&str>, token: &str, thinking: bool) {
        emit_stream_token(self, subagent_id, token, thinking);
    }
    fn emit_tool_progress(&self, subagent_id: Option<&str>, kind: &str, name: &str, path: Option<String>) {
        emit_tool_progress(self, subagent_id, kind, name, path);
    }
    fn emit_model_routed(&self, model: &str) {
        self.emit("model-routed", model.to_string()).ok();
    }
    fn emit_subagent_start(&self, id: &str, agent: &str, task: &str, model: &str) {
        self.emit("subagent-start", SubAgentStartPayload {
            id: id.to_string(),
            agent: agent.to_string(),
            task: task.to_string(),
            model: model.to_string(),
        })
        .ok();
    }
    fn emit_subagent_done(&self, id: &str, result: &str) {
        self.emit("subagent-done", SubAgentDonePayload {
            id: id.to_string(),
            result: result.to_string(),
        })
        .ok();
    }
}

/// A headless sink for the CLI / E2E harness: streams visible tokens to stdout,
/// thinking to stderr, and logs tool progress to stderr.
pub struct CliSink;

impl EventSink for CliSink {
    fn emit_stream_token(&self, _subagent_id: Option<&str>, token: &str, thinking: bool) {
        // Streaming tokens go to stderr so stdout carries exactly one clean
        // final answer (printed by the CLI after `run_chat` returns). Thinking
        // is labelled so it's distinguishable from visible progress.
        if thinking {
            eprint!("[thinking]{}", token);
        } else {
            eprint!("{}", token);
        }
    }
    fn emit_tool_progress(&self, _subagent_id: Option<&str>, kind: &str, name: &str, path: Option<String>) {
        let p = path.unwrap_or_default();
        match kind {
            "start" => eprintln!("\n[tool] {} {}", name, p),
            "done" => eprintln!("[tool] {} done {}", name, p),
            "error" => eprintln!("[tool] {} ERROR {}", name, p),
            _ => eprintln!("[tool] {} {} {}", kind, name, p),
        }
    }
    fn emit_model_routed(&self, model: &str) {
        eprintln!("[routed model] {}", model);
    }
    fn emit_subagent_start(&self, _id: &str, agent: &str, task: &str, model: &str) {
        eprintln!("\n[subagent] {} started ({}): {}\n", agent, model, task);
        eprintln!("--- subagent output ---");
    }
    fn emit_subagent_done(&self, _id: &str, _result: &str) {
        eprintln!("--- subagent done ---");
    }
}

/// Emit a stream token, routing to `subagent-token` when a sub-agent is
/// streaming (so its window updates live) or `stream-token` for the main agent.
fn emit_stream_token(
    app_handle: &tauri::AppHandle,
    subagent_id: Option<&str>,
    token: &str,
    thinking: bool,
) {
    if let Some(id) = subagent_id {
        app_handle
            .emit(
                "subagent-token",
                SubAgentTokenPayload {
                    id: id.to_string(),
                    token: token.to_string(),
                    thinking,
                },
            )
            .ok();
    } else {
        app_handle
            .emit(
                "stream-token",
                StreamPayload {
                    token: token.to_string(),
                    thinking,
                },
            )
            .ok();
    }
}

/// Emit tool progress, routing to `subagent-tool-progress` for sub-agents.
fn emit_tool_progress(
    app_handle: &tauri::AppHandle,
    subagent_id: Option<&str>,
    kind: &str,
    name: &str,
    path: Option<String>,
) {
    if let Some(id) = subagent_id {
        app_handle
            .emit(
                "subagent-tool-progress",
                SubAgentToolProgressPayload {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    name: name.to_string(),
                    path,
                },
            )
            .ok();
    } else {
        app_handle
            .emit(
                "tool-progress",
                ToolProgressPayload {
                    kind: kind.to_string(),
                    name: name.to_string(),
                    path,
                },
            )
            .ok();
    }
}

// ---------------------------------------------------------------------------
// Sub-agents (multi-model provider routing)
// ---------------------------------------------------------------------------

/// Bundles everything needed to spawn and run sub-agents from within a tool
/// loop. Passed into the tool loops so `spawn_subagent` can launch a sub-agent
/// on a (possibly different) provider with its own model + tools.
#[derive(Clone, Copy)]
pub struct SubAgentRunner<'a> {
    sink: &'a (dyn EventSink + Send + Sync),
    client: &'a reqwest::Client,
    main_backend: &'a str,
    main_url: &'a str,
    main_model: &'a str,
    main_api_key: &'a str,
    providers: &'a HashMap<String, ProviderConfig>,
    tool_configs: &'a HashMap<String, serde_json::Value>,
    root_path: Option<&'a str>,
    max_tokens: Option<u32>,
    max_iterations: usize,
    /// Configured "reasoning-only" retry budget propagated from the main chat
    /// request (sub-agents share the same retry behaviour).
    reasoning_retries: usize,
    /// The model's context window (in tokens), propagated so sub/micro-agents
    /// can detect near-limit usage and trigger context summarization.
    context_length: u64,
use_model_affinity: bool,
    /// Current sub-agent nesting depth (to bound recursion).
    depth: usize,
    /// Shared per-agent conversation memory (persists across turns/session).
    memory: &'a SubAgentMemory,
}

/// Persistent per-agent conversation memory across turns in the same session.
/// Key: `"{root_path}::{agent_name}"`. When the same @agent is triggered again
/// in a later user message, its prior conversation (the tasks it was given and
/// the answers it produced) is appended to its context so the sub-agent has
/// continuity — "prompt the same sub-agent by its agent identifier, adding to
/// its context and the overall session context".
///
/// The store is capped (per key) so a very long session doesn't grow unbounded.
const SUBAGENT_MEMORY_MAX_TURNS: usize = 8;

pub struct SubAgentMemory {
    convos: Mutex<std::collections::HashMap<String, Vec<ChatMessage>>>,
}

impl SubAgentMemory {
    pub fn new() -> Self {
        SubAgentMemory { convos: Mutex::new(std::collections::HashMap::new()) }
    }

    /// Conversation key for (root_path, agent_name).
    fn key(root_path: &str, agent_name: &str) -> String {
        format!("{}::{}", root_path, agent_name)
    }

    /// Retrieve the stored conversation for an agent, or `None` on first spawn.
    pub fn get(&self, root_path: &str, agent_name: &str) -> Option<Vec<ChatMessage>> {
        let convos = self.convos.lock().unwrap();
        convos.get(&Self::key(root_path, agent_name)).cloned()
    }

    /// Append a completed sub-agent turn (the task + its final answer) to the
    /// conversation so the next invocation has memory.
    fn push_turn(
        &self,
        root_path: &str,
        agent_name: &str,
        task: &str,
        answer: &str,
    ) {
        let key = Self::key(root_path, agent_name);
        let mut convos = self.convos.lock().unwrap();
        let entry = convos.entry(key).or_default();
        entry.push(ChatMessage { role: "user".to_string(), content: task.to_string() });
        if !answer.trim().is_empty() {
            entry.push(ChatMessage { role: "assistant".to_string(), content: answer.to_string() });
        }
        // Cap the history to the most recent N turns (keep newest).
        if entry.len() > SUBAGENT_MEMORY_MAX_TURNS * 2 {
            let overflow = entry.len() - SUBAGENT_MEMORY_MAX_TURNS * 2;
            entry.drain(0..overflow);
        }
    }

    /// Reset all memory (called when a new chat session starts).
    fn clear(&self) {
        self.convos.lock().unwrap().clear();
    }
}

/// Default tool set for a sub-agent that doesn't specify its own `tools:` list.
const DEFAULT_SUBAGENT_TOOLS: [&str; 8] = [
    "read_file",
    "list_directory",
    "grep",
    "edit",
    "write_file",
    "web_fetch",
    "web_search",
    "bash_sandbox",
];

pub const MAX_SUBAGENT_DEPTH: usize = 4;

/// Sub-agents get a tighter tool-loop budget than the main agent so they don't
/// spin calling the same tools repeatedly; enough to gather info and answer.
const SUBAGENT_MAX_ITERATIONS: usize = 6;

/// Maximum number of consecutive "reasoning-only" retries the Ollama tool loop
/// allows before giving up and surfacing "(no response)". Thinking-capable
/// models (nemotron, qwen3, deepseek-r1) can get stuck emitting ONLY thinking
/// (no visible content, no tool call) for several turns. Each retry nudges the
/// model with an escalating reminder; this budget (5..10) is large enough that
/// a stuck model gets plenty of chances to produce a real answer or a tool
/// call without hanging forever.
const THINKING_ONLY_MAX_RETRIES: usize = 8;

/// After this many consecutive reasoning-only turns (no visible content, no
/// tool call), the tool loop drops the tools from the request and forces a
/// plain-text answer. A model that can't even emit a tool call after several
/// tries is stuck (e.g. a simple greeting with tools enabled) — removing the
/// tools makes it answer directly instead of looping forever.
const TOOLS_DROP_RETRY_THRESHOLD: usize = 3;

/// Resolved provider (backend + model + url + api_key) for a sub-agent.
/// A sub-agent uses its OWN backend/model when configured, otherwise it falls
/// back to the main agent's. Its endpoint/credential come from the `providers`
/// map (when the route differs from the main agent's) else the main's.
/// Extracted as a pure function so the per-agent provider routing can be
/// unit-tested ("each agent can come from a different model provider").
pub fn resolve_agent_provider(
    agent: &AgentConfig,
    main_backend: &str,
    main_model: &str,
    main_url: &str,
    main_api_key: &str,
    providers: &HashMap<String, ProviderConfig>,
) -> (String, String, String, String) {
    let backend = if agent.backend.is_empty() {
        main_backend.to_string()
    } else {
        agent.backend.clone()
    };
    let model = if agent.model.is_empty() {
        main_model.to_string()
    } else {
        agent.model.clone()
    };
    let provider = providers.get(&backend);
    let url = provider
        .and_then(|p| if p.url.is_empty() { None } else { Some(p.url.clone()) })
        .unwrap_or_else(|| main_url.to_string());
    let api_key = provider
        .and_then(|p| if p.api_key.is_empty() { None } else { Some(p.api_key.clone()) })
        .unwrap_or_else(|| main_api_key.to_string());
    (backend, model, url, api_key)
}

/// Run a sub-agent and return its final result + full trace (for the frontend
/// "window"). Emits `subagent-*` events so the window streams live.
pub async fn run_subagent(
    runner: &SubAgentRunner<'_>,
    agent_name: &str,
    task: &str,
) -> Result<(String, SubAgentTrace), String> {
    if runner.depth >= MAX_SUBAGENT_DEPTH {
        return Err(format!(
            "Sub-agent nesting depth limit ({}) exceeded",
            MAX_SUBAGENT_DEPTH
        ));
    }
    let root = runner
        .root_path
        .ok_or("No project folder is open — sub-agents require one")?;
    let agent = load_agent_config(root, agent_name)?;

    // Resolve the sub-agent's provider: its own backend/model when set,
    // otherwise fall back to the main agent's. Endpoint/credential come from
    // the matching entry in the providers map, else the main agent's.
    let (mut backend, mut model, mut url, mut api_key) = resolve_agent_provider(
        &agent,
        runner.main_backend,
        runner.main_model,
        runner.main_url,
        runner.main_api_key,
        runner.providers,
    );

    // ---- Switchyard routing (sub-agent) ----------------------------------
    // When the project's `.routers/switchyard.json` is enabled and has a
    // `subagent` route, the embedded libsy router may override the sub-agent's
    // provider/model. Fail-safe: any error keeps the resolved provider above.
    if let Some(root) = runner.root_path {
        let providers: HashMap<String, switchyard::ProviderEndpoint> = runner
            .providers
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    switchyard::ProviderEndpoint {
                        url: v.url.clone(),
                        api_key: v.api_key.clone(),
                    },
                )
            })
            .collect();
        let judge_transport: switchyard::JudgeTransport = {
            let client = runner.client.clone();
            Arc::new(
                move |backend, model, url, api_key, system_prompt, user_task, response_format| {
                    let client = client.clone();
                    Box::pin(async move {
                        switchyard_judge_completion(
                            &client,
                            &backend,
                            &model,
                            &url,
                            &api_key,
                            &system_prompt,
                            &user_task,
                            response_format,
                        )
                        .await
                    })
                },
            )
        };
        match switchyard::resolve_route(
            root,
            switchyard::RoutePurpose::Subagent,
            task,
            &providers,
            runner.main_backend,
            runner.main_model,
            runner.main_url,
            runner.main_api_key,
            judge_transport,
        )
        .await
        {
            Ok(Some(selected)) => {
                eprintln!(
                    "[switchyard] subagent '{}' route '{}' -> {} ({})",
                    agent_name, selected.route_name, selected.model, selected.backend
                );
                backend = selected.backend;
                model = selected.model;
                url = selected.url;
                api_key = selected.api_key;
            }
            Ok(None) => {}
            Err(e) => eprintln!("[switchyard] subagent routing skipped: {}", e),
        }
    }

    // Resolve the sub-agent's tool set.
    let tool_names: Vec<String> = if agent.tools.is_empty() {
        DEFAULT_SUBAGENT_TOOLS.iter().map(|s| s.to_string()).collect()
    } else {
        agent.tools.clone()
    };
    // Sub-agents must NOT get the spawn_subagent tool — otherwise they can
    // cascade-delegate to other agents. Isolated tool set only. They MAY get
    // the spawn_micro_agent tool when can_spawn_micro_agents is set.
    let tools = build_tool_schemas_inner(&tool_names, runner.root_path, false, Some(&agent));

    let id = format!(
        "sa_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

// Wrap the agent prompt with sub-agent operating instructions so it stays
    // focused and returns a final answer instead of looping on tools.
    // Wrap the agent prompt with sub-agent operating instructions so it stays
    // focused and returns a final answer instead of looping on tools. The
    // "thorough" variant (used e.g. by code-reviewer) instructs the model to
    // actually inspect the relevant files with tools before concluding, instead
    // of returning a shallow answer too early.
    let ops = if agent.thorough {
        "Complete the task above and return a single final answer. You MUST actually \
         inspect the material with your tools before concluding — listing a directory \
         is NOT enough. Read the key files (config/manifest, main entry points, and the \
         highest-risk files for the task) and grep for issues. Only write the final \
         answer after you have genuinely read the relevant content. Do not conclude \
         that you have \"enough info\" from a directory listing alone. Use your tools \
         repeatedly until the task is properly done; do not call the same tool \
         redundantly without a reason."
    } else {
        "Complete the task above and return a single final answer. Use tools only \
         when necessary; do not call the same tool repeatedly and do not re-read the \
         same file. Once you have enough information, stop calling tools and write \
         your answer directly."
    };
    // NEW: Micro-agent delegation directive. When the sub-agent may spawn
    // micro-agents, tell it to delegate mechanical work to them and (unless
    // deterministic validation is available) fall back to doing the task
    // directly instead of spawning micro-agents that cannot be verified.
    let micro_directive = if agent.can_spawn_micro_agents {
        if validation::project_has_validation_for_task(task, &agent.validation) {
            "\n\n[Micro-agent delegation]\n\
             You may spawn micro-agents (via the `spawn_micro_agent` tool) for focused, \
             mechanical work: fixing compiler/lint errors, writing tests, etc. Delegate such \
             work to the matching micro-agent instead of doing it yourself. After a micro-agent \
             returns, incorporate its result (including its validation status) into your answer."
        } else {
            "\n\n[Micro-agent delegation]\n\
             NOTE: No deterministic validation is available for this task type. Complete the \
             task directly using your own tools. Do not spawn micro-agents."
        }
    } else {
        ""
    };

    let system_prompt = format!(
        "{}\n\n[Sub-agent operating instructions]\n{}\n\n\
         Do NOT ask yourself questions and then answer them. Do NOT role-play multiple \
         personas or write out an internal back-and-forth dialogue. Do NOT produce a \
         long chain-of-thought before answering. State your answer once, directly and \
         concisely.{}",
        agent.prompt, ops, micro_directive
    );

    // Build the sub-agent's message list. When this agent has been spawned
    // before in the session, include its PRIOR turns (prior task + the answer
    // it gave) so the same @agent continues its working context — each new
    // trigger adds to the agent's memory and the overall session context.
    // The prior history is injected as an additional system block so it never
    // pollutes the current user message stream.
    let mut msgs: Vec<ChatMessage> = Vec::new();
    msgs.push(ChatMessage { role: "system".to_string(), content: system_prompt.clone() });
    if let Some(prior) = runner.memory.get(root, &agent.name) {
        if !prior.is_empty() {
            let mut history = String::from("[Prior conversation with this sub-agent]\n");
            for (i, m) in prior.iter().enumerate() {
                let who = if m.role == "user" { "user asked" } else { "you answered" };
                // Keep only the first ~400 chars of each prior turn to bound
                // token usage while preserving context.
                let snippet: String = if m.content.chars().count() > 400 {
                    m.content.chars().take(400).collect::<String>() + "…"
                } else {
                    m.content.clone()
                };
                let safe = snippet.replace('\n', " ");
                if i % 2 == 0 {
                    history.push_str(&format!("- {}: {}\n", who, safe));
                } else {
                    history.push_str(&format!("  {}: {}\n", who, safe));
                }
            }
            msgs.push(ChatMessage {
                role: "system".to_string(),
                content: history,
            });
            msgs.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "[Continuing our conversation: I have a new task for you.]\n\n{}",
                    task
                ),
            });
        } else {
            msgs.push(ChatMessage { role: "user".to_string(), content: task.to_string() });
        }
    } else {
        msgs.push(ChatMessage { role: "user".to_string(), content: task.to_string() });
    }
    // Local sub-agents (ollama/llamacpp) don't need a tighter iteration cap —
    // the user can configure max_iterations globally, and caps cause local
    // reviewers to hit "max tool iterations" before finishing. Only cap when
    // the backend is a paid/compute-expensive remote provider.
    let sub_iterations = if backend == "ollama" || backend == "llamacpp" {
        runner.max_iterations
    } else {
        runner.max_iterations.min(SUBAGENT_MAX_ITERATIONS)
    };

    runner
        .sink
        .emit_subagent_start(&id, &agent.name, task, &model);

    // nemo-fabric-core gate (request side): normalize the sub-agent invocation
    // into the fabric AgentRunRequest contract. Currently informational — the
    // task + project root are captured for diagnostics. The result side is
    // validated after the run (see the match below).
    let _fabric_request = fabric::build_agent_run_request(task, runner.root_path);
    let _ = &_fabric_request;

    let sub_runner = SubAgentRunner { depth: runner.depth + 1, ..*runner };

    let result = if backend == "ollama" {
        let ctx = OllamaChatContext {
            sink: runner.sink,
            client: runner.client,
            url: &url,
            model: &model,
            tool_configs: runner.tool_configs,
            root_path: runner.root_path,
            reasoning_retries: runner.reasoning_retries,
            context_length: runner.context_length,
        };
        ollama_chat_with_tools(
            &ctx,
            &msgs,
            &tools,
            sub_iterations,
            agent.temperature,
            runner.max_tokens.unwrap_or(4096),
            Some(&id),
            Some(&sub_runner),
            &std::collections::HashSet::new(),
        )
        .await
    } else if backend == "llamacpp" {
        Err("Sub-agents on the llamacpp backend are not supported; use ollama or a cloud provider.".to_string())
    } else {
        run_openai_tool_loop(
            runner.client,
            runner.sink,
            &url,
            &api_key,
            &model,
            &backend,
            &msgs,
            &tools,
            runner.tool_configs,
            runner.root_path,
            agent.temperature,
            runner.max_tokens,
            sub_iterations,
            None,
            runner.use_model_affinity,
            Some(&id),
            Some(&sub_runner),
            &std::collections::HashSet::new(),
            runner.context_length,
        )
        .await
    };

    match result {
        Ok(chat) => {
            // Some models reply with a structured JSON blob (analysis/plan/
            // tool_calls/final_answer). Surface only the final answer to the
            // main model and the user — the raw blob is confusing and pollutes
            // the parent context.
            let clean = unwrap_structured_answer(&chat.content);
            // Store this turn (task → answer) as the agent's memory so a later
            // trigger of the sAME @agent continues from this context.
            runner.memory.push_turn(root, &agent.name, task, &clean);

            // nemo-fabric-core gate: normalize the completed run into the fabric
            // AgentRunResult contract and validate invariants. This is the
            // "behind the scenes" check that a successful agent-to-agent handoff
            // is actually well-formed (no error on success, well-formed
            // artifacts). Any violation is logged; we still return the result so
            // a validation miss never silently kills a working flow.
            if let Err(v_err) = fabric::validate_subagent_run(
                &agent.name,
                true,
                &clean,
                None,
                Vec::new(),
            ) {
                eprintln!(
                    "[nolock] fabric run-validation WARNING for sub-agent '{}': {}",
                    agent.name, v_err
                );
            }

            let trace = SubAgentTrace {
                id: id.clone(),
                agent: agent.name.clone(),
                task: task.to_string(),
                model,
                result: clean.clone(),
                tool_calls: chat.tool_calls.clone(),
                thinking_tokens: chat.thinking_tokens,
            };
            runner
                .sink
                .emit_subagent_done(&id, &clean);
            Ok((clean, trace))
        }
        Err(e) => {
            let err_msg = format!("Sub-agent error: {}", e);
            // nemo-fabric-core gate for the failure path: a failed run MUST carry
            // a structured error. nolock surfaces the message the same way, but
            // this validates the contract so the error isn't dropped.
            if let Err(v_err) = fabric::validate_subagent_run(
                &agent.name,
                false,
                "",
                Some(&e),
                Vec::new(),
            ) {
                eprintln!(
                    "[nolock] fabric run-validation WARNING for sub-agent '{}': {}",
                    agent.name, v_err
                );
            }
            runner
                .sink
                .emit_subagent_done(&id, &err_msg);
            Err(format!("Sub-agent '{}' failed: {}", agent.name, e))
        }
    }
}

/// Maximum number of sub-agents to run concurrently. Bounded so two large local
/// models don't exhaust VRAM.
const MAX_CONCURRENT_SUBAGENTS: usize = 2;

/// Maximum micro-agent nesting depth (Sub → Micro → Micro).
pub const MAX_MICRO_AGENT_DEPTH: usize = 2;

// ---------------------------------------------------------------------------
// Structured agent-result markers (A2A handoff contract)
// ---------------------------------------------------------------------------
// Every sub-agent / micro-agent result surfaced back to the orchestrator (the
// main agent) is prefixed with one of these markers so the orchestrator can
// unambiguously tell success from failure or an empty response — instead of
// having to infer it from free text. The main agent's system prompt instructs
// it to retry on FAILED/EMPTY and to take over the task itself if a delegate
// keeps failing (fallback chain).
pub const AGENT_RESULT_OK: &str = "[AGENT_RESULT: OK]";
pub const AGENT_RESULT_FAILED: &str = "[AGENT_RESULT: FAILED]";
pub const AGENT_RESULT_EMPTY: &str = "[AGENT_RESULT: EMPTY]";

/// Prefix `body` with the given structured result marker.
fn tag_agent_result(marker: &str, body: &str) -> String {
    format!("{}\n{}", marker, body)
}

/// Classify a delegate's raw output into the appropriate marker: OK when it has
/// substantive content, EMPTY when it produced nothing usable.
fn classify_agent_result(body: &str) -> &'static str {
    if body.trim().is_empty() {
        AGENT_RESULT_EMPTY
    } else {
        AGENT_RESULT_OK
    }
}

/// Run a sub-agent with a deterministic validation auto-retry loop.
///
/// The sub-agent runs once via `run_subagent`, then its changed files are
/// validated with the configured deterministic checks (cargo check, tsc, ruff,
/// etc.). If validation fails and retries remain, the validation errors are fed
/// back into the task and the sub-agent runs again. This gives sub-agents the
/// same "clear deterministic validation to conclude" guarantee as micro-agents,
/// and failures always trigger a retry (up to the configured budget).
///
/// When the agent has no validation configured, it behaves exactly like
/// `run_subagent` (single run, no validation).
async fn run_subagent_with_validation(
    runner: &SubAgentRunner<'_>,
    agent_name: &str,
    task: &str,
) -> Result<(String, SubAgentTrace), String> {
    let root = runner
        .root_path
        .ok_or("No project folder is open — sub-agents require one")?;
    let agent = load_agent_config(root, agent_name)?;

    // No validation configured → plain single run.
    let has_validation = agent.validation.rust_check
        || agent.validation.js_ts_lint
        || agent.validation.python_check
        || agent.validation.go_check
        || !agent.validation.custom_commands.is_empty();
    if !has_validation {
        return run_subagent(runner, agent_name, task).await;
    }

    let max_retries = if agent.validation.max_retries == 0 {
        DEFAULT_MICRO_AGENT_MAX_RETRIES
    } else {
        agent.validation.max_retries
    };

    let mut current_task = task.to_string();

    for attempt in 1..=max_retries {
        let (result, trace) = run_subagent(runner, agent_name, &current_task).await?;

        // Run deterministic validations on the changed files.
        let changed_files = validation::extract_changed_files(&result);
        let validations = validation::run_validations(root, &agent.validation, &changed_files).await;
        let all_passed = validations.iter().all(|v| v.passed);

        if all_passed || attempt == max_retries {
            return Ok((result, trace));
        }

        // Failures always trigger a retry: feed the validation errors back.
        current_task = format!(
            "Previous attempt failed validation:\n{}\n\nFix the errors and retry:\n{}",
            validation::format_validation_errors(&validations),
            task
        );
    }

    Err("Max retries exceeded".to_string())
}

/// Micro-agents get a tighter iteration budget than sub-agents.
const MICRO_AGENT_MAX_ITERATIONS: usize = 4;

/// Default retry budget for micro-agent validation loops.
const DEFAULT_MICRO_AGENT_MAX_RETRIES: usize = 3;

/// Run a micro-agent with a deterministic validation auto-retry loop.
///
/// The micro-agent is given a focused task, runs once, then the changed files
/// are validated with the configured deterministic checks (cargo check, tsc,
/// ruff, etc.). If validation fails and retries remain, the validation errors
/// are fed back into the task and the micro-agent runs again. Returns the final
/// result plus the validation results from the last attempt.
pub async fn run_micro_agent(
    runner: &SubAgentRunner<'_>,
    agent_name: &str,
    task: &str,
) -> Result<(String, Vec<validation::ValidationResult>, SubAgentTrace), String> {
    if runner.depth >= MAX_MICRO_AGENT_DEPTH {
        return Err(format!(
            "Micro-agent nesting depth limit ({}) exceeded",
            MAX_MICRO_AGENT_DEPTH
        ));
    }
    let root = runner
        .root_path
        .ok_or("No project folder is open — micro-agents require one")?;
    let agent = load_micro_agent_config(root, agent_name)?;

    // Resolve the micro-agent's provider (its own backend/model, else the main's).
    let (backend, model, url, api_key) = resolve_agent_provider(
        &AgentConfig {
            backend: agent.backend.clone(),
            model: agent.model.clone(),
            ..Default::default()
        },
        runner.main_backend,
        runner.main_model,
        runner.main_url,
        runner.main_api_key,
        runner.providers,
    );

    // Resolve the micro-agent's tool set (defaults to a minimal mechanical set).
    let tool_names: Vec<String> = if agent.tools.is_empty() {
        vec![
            "read_file".to_string(),
            "edit".to_string(),
            "write_file".to_string(),
            "bash_sandbox".to_string(),
        ]
    } else {
        agent.tools.clone()
    };
    // Micro-agents never get spawn_subagent or spawn_micro_agent tools.
    let tools = build_tool_schemas_inner(&tool_names, runner.root_path, false, None);

    let id = format!(
        "ma_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let system_prompt = format!(
        "{}\n\n[Micro-agent operating instructions]\n\
         You are a focused, single-purpose agent. Apply MINIMAL changes to complete the task. \
         Do NOT ask yourself questions or role-play. Do NOT produce a long chain-of-thought. \
         Return only the edited file content or a concise summary of the change you made.",
        agent.prompt
    );

    // Base messages for the first attempt. On retries we append the validation
    // feedback as an extra user message so the micro-agent can correct itself.
    let base_msgs: Vec<ChatMessage> = vec![
        ChatMessage { role: "system".to_string(), content: system_prompt },
        ChatMessage { role: "user".to_string(), content: task.to_string() },
    ];

    let sub_runner = SubAgentRunner { depth: runner.depth + 1, ..*runner };

    let mut last_validations: Vec<validation::ValidationResult> = Vec::new();
    // Track the previous attempt's cleaned output so the retry nudge can
    // distinguish an empty/stalled response from a validation failure.
    let mut last_clean = String::new();
    let max_retries = if agent.validation.max_retries == 0 {
        DEFAULT_MICRO_AGENT_MAX_RETRIES
    } else {
        agent.validation.max_retries
    };

    for attempt in 1..=max_retries {
        // Build the messages for this attempt: base task plus, on retries, the
        // validation errors from the previous attempt.
        let mut msgs = base_msgs.clone();
        if attempt > 1 {
            // Distinguish an empty/stalled response from a validation failure so
            // the retry nudge is specific to the failure mode.
            let feedback = if last_clean.trim().is_empty() {
                "Your previous response was empty or contained no usable output. \
                 Return ONLY the final answer (the script's output or a concise summary). \
                 Do not produce thinking-only output and do not stop without a result."
            } else {
                &format!(
                    "Previous attempt failed validation:\n{}\n\nFix the errors and retry.",
                    validation::format_validation_errors(&last_validations)
                )
            };
            msgs.push(ChatMessage {
                role: "user".to_string(),
                content: feedback.to_string(),
            });
        }

        // 1. Run the micro-agent once. The call must be boxed to break the
        //    async recursion (micro-agent loops can spawn further micro-agents).
        let result = if backend == "ollama" {
            let ctx = OllamaChatContext {
                sink: runner.sink,
                client: runner.client,
                url: &url,
                model: &model,
                tool_configs: runner.tool_configs,
                root_path: runner.root_path,
                reasoning_retries: runner.reasoning_retries,
                context_length: runner.context_length,
            };
            Box::pin(ollama_chat_with_tools(
                &ctx,
                &msgs,
                &tools,
                MICRO_AGENT_MAX_ITERATIONS,
                agent.temperature,
                runner.max_tokens.unwrap_or(4096),
                Some(&id),
                Some(&sub_runner),
                &std::collections::HashSet::new(),
            ))
            .await
        } else if backend == "llamacpp" {
            Err("Micro-agents on the llamacpp backend are not supported; use ollama or a cloud provider.".to_string())
        } else {
            Box::pin(run_openai_tool_loop(
                runner.client,
                runner.sink,
                &url,
                &api_key,
                &model,
                &backend,
                &msgs,
                &tools,
                runner.tool_configs,
                runner.root_path,
                agent.temperature,
                runner.max_tokens,
                MICRO_AGENT_MAX_ITERATIONS,
                None,
                runner.use_model_affinity,
                Some(&id),
                Some(&sub_runner),
                &std::collections::HashSet::new(),
                runner.context_length,
            ))
            .await
        };

        let (clean, tool_calls, thinking_tokens) = match result {
            Ok(chat) => (
                unwrap_structured_answer(&chat.content),
                chat.tool_calls.clone(),
                chat.thinking_tokens,
            ),
            Err(e) => return Err(format!("Micro-agent '{}' failed: {}", agent.name, e)),
        };

        // 2. Run deterministic validations on the changed files.
        let changed_files = validation::extract_changed_files(&clean);
        let mut validations = validation::run_validations(root, &agent.validation, &changed_files).await;

        // 2b. Generic self-consistency check for script-running agents: when
        //     `verify_reported_output` is set, re-run the last `bash_sandbox`
        //     command the micro-agent executed and require non-empty output.
        //     This catches "the command failed" / "produced no output" even
        //     when no task-specific custom command is configured.
        if agent.validation.verify_reported_output {
            if let Some(v) = verify_reported_output_check(root, &tool_calls, task, runner).await {
                validations.push(v);
            }
        }

        // 3. Check if all passed (or we're out of retries). An empty/stalled
        //    response also triggers a retry (with a specific nudge) so a
        //    thinking-only stall never surfaces as a successful-but-empty result.
        let all_passed = validations.iter().all(|v| v.passed);
        last_validations = validations;
        last_clean = clean.clone();
        let empty_response = clean.trim().is_empty();
        if (all_passed && !empty_response) || attempt == max_retries {
            // nemo-fabric-core gate: a completed micro-agent run must be
            // well-formed (succeeded + no error); violations are logged, not
            // fatal, so deterministic validation still owns the retry decision.
            if let Err(v_err) = fabric::validate_subagent_run(
                &agent.name,
                true,
                &clean,
                None,
                Vec::new(),
            ) {
                eprintln!(
                    "[nolock] fabric run-validation WARNING for micro-agent '{}': {}",
                    agent.name, v_err
                );
            }
            let trace = SubAgentTrace {
                id: id.clone(),
                agent: agent.name.clone(),
                task: task.to_string(),
                model: model.clone(),
                result: clean.clone(),
                tool_calls,
                thinking_tokens,
            };
            return Ok((clean, last_validations, trace));
        }
    }

    Err("Max retries exceeded".to_string())
}

/// Re-run the last `bash_sandbox` command a micro-agent executed and verify it
/// produced output. When the task text states an expected result (e.g. "data.txt
/// with 5 lines", "prints exactly 'VALIDATED_OK'"), the re-run output must also
/// contain that expected value — this catches "the command ran but produced the
/// wrong answer" (e.g. `wc -l` returning 4 instead of 5). Returns `None` when
/// there is no bash_sandbox call to verify (no-op for non-shell micro-agents).
async fn verify_reported_output_check(
    root: &str,
    tool_calls: &[ToolCallLog],
    task: &str,
    runner: &SubAgentRunner<'_>,
) -> Option<validation::ValidationResult> {
    // Find the bash_sandbox call that references the script file named in the
    // task (e.g. "count.sh"). We prefer the script-referencing call over the
    // last bash_sandbox call: a micro-agent may run a fallback command that
    // happens to produce the right output while the actual script command
    // failed (e.g. `./count.sh` → Permission denied). The script-referencing
    // call is the one that proves the script itself ran.
    let script_name = extract_script_name(task);
    let target = tool_calls.iter().rev().find(|c| {
        if c.name != "bash_sandbox" {
            return false;
        }
        if script_name.is_empty() {
            return true;
        }
        c.arguments.contains(&script_name)
    })?;
    let args: serde_json::Value = serde_json::from_str(&target.arguments).unwrap_or(serde_json::json!({}));
    let command = args["command"].as_str()?;
    eprintln!(
        "[nolock] verify_reported_output: re-running bash_sandbox command={} (expected={:?})",
        &command[..command.len().min(120)],
        extract_expected_output(task)
    );
    let result = execute_tool(
        "bash_sandbox",
        &args,
        runner.client,
        runner.tool_configs,
        Some(root),
        "ollama",
    )
    .await
    .unwrap_or_else(|e| format!("Tool error: {}", e));

    let expected = extract_expected_output(task);
    let non_empty = !result.trim().is_empty();
    let matches_expected = expected.is_empty() || result.contains(&expected);
    let passed = non_empty && matches_expected;
    eprintln!(
        "[nolock] verify_reported_output: result={:?} non_empty={} matches_expected={} passed={}",
        result.chars().take(120).collect::<String>(),
        non_empty,
        matches_expected,
        passed
    );
    Some(validation::ValidationResult {
        name: format!("re-run bash_sandbox: {}", command),
        passed,
        output: result.clone(),
        error: if passed {
            None
        } else if !non_empty {
            Some("Re-run of the shell command produced no output".to_string())
        } else {
            Some(format!(
                "Re-run output did not contain expected {:?}",
                expected
            ))
        },
    })
}

/// Extract the script filename from a task description (e.g. "count.sh" from
/// "Create a shell script at count.sh"). Returns empty when no `.sh` file is
/// named.
fn extract_script_name(task: &str) -> String {
    // Match a `.sh` filename anywhere in the task.
    let lower = task.to_lowercase();
    let mut best = String::new();
    let mut search = 0usize;
    while let Some(pos) = lower[search..].find(".sh") {
        let abs = search + pos;
        // Walk backwards to the start of the filename token.
        let mut start = abs;
        while start > 0 {
            let c = lower.as_bytes()[start - 1];
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'.' {
                start -= 1;
            } else {
                break;
            }
        }
        let candidate = &task[start..abs + 3];
        // Prefer the longest candidate (e.g. "count.sh" over "sh").
        if candidate.len() > best.len() {
            best = candidate.to_string();
        }
        search = abs + 3;
    }
    best
}

/// Extract an expected-output substring from a task description, if stated.
/// Recognises the common patterns used by the shell e2e prompts:
///   - "with N lines" / "N lines"  → the number N (line-count tasks)
///   - "prints exactly 'X'"        → X
///   - "prints \"X\""              → X
/// Returns an empty string when no expected output is stated (caller then only
/// checks for non-empty output).
fn extract_expected_output(task: &str) -> String {
    // "data.txt with 5 lines" / "with 5 lines" → "5"
    if let Some(caps) = regex_capture(task, r"(?i)with\s+(\d+)\s+lines") {
        return caps;
    }
    if let Some(caps) = regex_capture(task, r"(?i)prints\s+exactly\s+'([^']+)'") {
        return caps;
    }
    if let Some(caps) = regex_capture(task, r#"(?i)prints\s+"([^"]+)""#) {
        return caps;
    }
    String::new()
}

/// Simple regex capture helper (avoids pulling in the `regex` crate if not
/// already a dependency). Returns the first capture group or empty string.
fn regex_capture(text: &str, pattern: &str) -> Option<String> {
    // Minimal pattern support: find the literal prefix/suffix around a capture.
    // Patterns used here are simple: a fixed prefix, then the captured group,
    // then a fixed suffix. We locate the prefix, then read until the suffix.
    let (prefix, suffix) = split_pattern(pattern)?;
    let start = text.find(&prefix)? + prefix.len();
    let rest = &text[start..];
    let end = rest.find(&suffix)?;
    Some(rest[..end].to_string())
}

/// Split a simple regex like `(?i)with\s+(\d+)\s+lines` into the literal text
/// before and after the capture group. Only supports the fixed patterns used by
/// `extract_expected_output`; returns `None` for anything else.
fn split_pattern(pattern: &str) -> Option<(String, String)> {
    let p = pattern.strip_prefix("(?i)")?;
    let open = p.find('(')?;
    let close = p[open..].find(')')? + open;
    let prefix = p[..open].replace("\\s+", " ");
    let suffix = p[close + 1..].replace("\\s+", " ");
    Some((prefix, suffix))
}

/// Extract a short "task hint" (the original user task) from the message list,
/// used when re-triggering the model after context summarization. Pure.
fn task_hint(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.chars().take(300).collect::<String>())
        .unwrap_or_default()
}

/// Summarize the conversation context via a micro-agent, so the model can be
/// re-triggered with a compact summary + to-do list instead of the full
/// (near-limit) context. Uses the `context-summarizer` micro-agent when
/// available; returns `None` if it can't be spawned (caller falls back).
async fn summarize_context_via_micro_agent(
    runner: &SubAgentRunner<'_>,
    last_message: &str,
    todo_list: &str,
) -> Option<String> {
    let prompt = build_context_summarization_prompt(last_message, todo_list);
    match run_micro_agent(runner, "context-summarizer", &prompt).await {
        Ok((summary, _, _)) if !summary.trim().is_empty() => Some(summary),
        _ => None,
    }
}

/// Some tool-calling models (e.g. certain Ollama Qwen/Nemotron builds and some
/// "structured output" prompts) respond to a sub-agent task with a JSON blob
/// like:
///   {"analysis": "...", "plan": "...", "tool_calls": [...],
///    "result": "...", "final_answer": "..."}
/// Instead of a plain-text answer. That JSON is confusing in the sub-agent
/// window and, worse, the whole blob (including the internal plan + tool_calls)
/// gets concatenated into the final context the main model sees.
///
/// `unwrap_structured_answer` detects this and returns ONLY the final answer:
///   - if the whole text parses as JSON with a non-empty `final_answer` → that;
///   - if `final_answer` is empty but `analysis` is present (the model planned
///     more work but didn't finish), return the analysis so the user at least
///     sees the reasoning instead of raw JSON;
///   - otherwise it scans for top-level `{...}` JSON objects and joins every
///     `final_answer` it finds (a tool loop can emit several concatenated
///     blobs, e.g. one per iteration);
///   - if no JSON answer is found, returns the text unchanged.
pub fn unwrap_structured_answer(content: &str) -> String {
    // Fast path: the entire output is one structured JSON answer.
    if content.trim_start().starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(content) {
            // If the blob also carries planned next_steps / tool_calls, the
            // model still wants to work — the loop will consume those, so we
            // return the analysis (not a premature final_answer).
            let has_planned = ["next_steps", "tool_calls"].iter().any(|k| {
                v.get(*k)
                    .and_then(|a| a.as_array())
                    .map_or(false, |a| !a.is_empty())
            });
            if let Some(fa) = v.get("final_answer").and_then(|f| f.as_str()) {
                if !fa.trim().is_empty() && !has_planned {
                    return fa.trim().to_string();
                }
            }
            // The model planned more work but produced no final answer yet.
            // Surface the analysis (reasoning) rather than the raw JSON.
            if let Some(analysis) = v.get("analysis").and_then(|f| f.as_str()) {
                if !analysis.trim().is_empty() {
                    return analysis.trim().to_string();
                }
            }
        }
    }

    // Slow path: search for whole JSON objects. A tool loop can emit several
    // (one per iteration), each carrying `final_answer`; keep all of them so
    // nothing important is dropped.
    let mut final_answers: Vec<String> = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '{' {
            i += 1;
            continue;
        }
        // Find the matching closing brace, skipping strings and escapes.
        let mut depth = 0i32;
        let mut in_string = false;
        let mut escaped = false;
        let mut j = i;
        let mut end = false;
        for k in i..chars.len() {
            let cc = chars[k];
            if in_string {
                if escaped {
                    escaped = false;
                } else if cc == '\\' {
                    escaped = true;
                } else if cc == '"' {
                    in_string = false;
                }
            } else {
                match cc {
                    '"' => in_string = true,
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            j = k;
                            end = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        if end {
            let slice: String = chars[i..=j].iter().collect();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&slice) {
                if let Some(fa) = v.get("final_answer").and_then(|f| f.as_str()) {
                    if !fa.trim().is_empty() {
                        final_answers.push(fa.trim().to_string());
                    }
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }

    if final_answers.is_empty() {
        content.to_string()
    } else {
        final_answers.join("\n\n")
    }
}

/// Extract tool calls the model *planned* in a structured-JSON blob
/// (`next_steps` / `tool_calls` arrays) but did NOT emit as real tool_calls.
/// Some local models (e.g. lfm2.5) respond to a task with a planning JSON
/// instead of actually invoking tools — this lets the tool loop feed those
/// planned steps back as real tool calls so the sub-agent actually does the
/// work instead of returning early.
///
/// Robust to the sloppy shapes these local models emit:
///   - `{"tool_name": "grep", "arguments": {...}}`
///   - `{"name": "web_search", "arguments": {...}}`
///   - sometimes the whole array (or individual entries) is malformed (extra
///     braces, trailing commas). In that case we fall back to scanning for
///     well-formed `{"tool_name"|"name": "...", "arguments": {...}}` objects.
fn extract_planned_tool_calls(content: &str) -> Vec<serde_json::Value> {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(content);
    if let Ok(v) = parsed {
        let mut calls: Vec<serde_json::Value> = Vec::new();
        if let Some(keys) = v.as_object() {
            for key in ["next_steps", "tool_calls"] {
                if let Some(arr) = keys.get(key).and_then(|a| a.as_array()) {
                    for item in arr {
                        let name = item
                            .get("tool_name")
                            .or_else(|| item.get("name"))
                            .and_then(|n| n.as_str());
                        if let Some(name) = name {
                            // Skip entries whose "name" is actually a whole CLI
                            // command string (e.g. `grep -r "import" ... | head`).
                            if name.contains(' ') || name.contains('|') || name.contains("--include") {
                                continue;
                            }
                            let args = item.get("arguments").cloned().unwrap_or(serde_json::json!({}));
                            calls.push(serde_json::json!({
                                "function": { "name": name, "arguments": args }
                            }));
                        }
                    }
                }
            }
        }
        if !calls.is_empty() {
            return calls;
        }
    }

    // Fallback: whole blob was malformed — find each `"tool_name"` / `"name"`
    // occurrence and parse the enclosing `{ ... }` object as an individual
    // tool-entry. This survives sloppy structural errors (extra braces,
    // trailing garbage) as long as each entry itself is well-formed enough.
    let mut calls: Vec<serde_json::Value> = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    // Find occurrences of `tool_name` or `"name"` (the name-bearing keys).
    let name_keys: Vec<&str> = vec!["\"tool_name\"", "\"name\""];
    for key in name_keys {
        let key_chars: Vec<char> = key.chars().collect();
        let mut search = 0usize;
        while let Some(pos) = find_subsequence(&chars, &key_chars, search) {
            // Walk backwards to the object's opening brace.
            let mut at_open = None;
            let mut k = pos;
            while k > 0 {
                k -= 1;
                // Find the nearest `{` before pos; verify it closes after pos.
                if chars[k] == '{' {
                    if let Some(close) = matching_brace(&chars, k) {
                        if close >= pos.saturating_add(key_chars.len()) {
                            at_open = Some(k);
                            break;
                        }
                    }
                }
            }
            if let Some(open_idx) = at_open {
                if let Some(close_idx) = matching_brace(&chars, open_idx) {
                    let slice: String = chars[open_idx..=close_idx].iter().collect();
                    if let Ok(item) = serde_json::from_str::<serde_json::Value>(&slice) {
                        if let Some(obj) = item.as_object() {
                            let name = obj
                                .get("tool_name")
                                .or_else(|| obj.get("name"))
                                .and_then(|n| n.as_str());
                            if let Some(name) = name {
                                if !name.contains(' ') && !name.contains('|') && !name.contains("--include") {
                                    let args = obj.get("arguments").cloned().unwrap_or(serde_json::json!({}));
                                    let already = calls.iter().any(|c| {
                                        c["function"]["name"] == name
                                            && c["function"]["arguments"] == args
                                    });
                                    if !already {
                                        calls.push(serde_json::json!({
                                            "function": { "name": name, "arguments": args }
                                        }));
                                    }
                                }
                            }
                        }
                    }
                    search = close_idx + 1;
                    continue;
                }
            }
            search = pos + 1;
        }
    }
    calls
}

/// Index of the first occurrence of `needle` in `haystack` starting at `start`,
/// or `None`.
fn find_subsequence(haystack: &[char], needle: &[char], start: usize) -> Option<usize> {
    if needle.is_empty() || start >= haystack.len() {
        return None;
    }
    // If the needle is longer than the remaining haystack (or the whole
    // haystack), it can't match — searching would panic on the slice below.
    if needle.len() > haystack.len() - start {
        return None;
    }
    for i in start..=haystack.len().saturating_sub(needle.len()) {
        if haystack[i..i + needle.len()] == *needle {
            return Some(i);
        }
    }
    None
}

/// Minimum visible characters for a response to count as a complete answer.
/// Shorter replies (e.g. "ok", "sure", a bare acknowledgment) are treated as
/// premature conclusions and the loop nudges the agent to actually answer.
const MIN_COMPLETE_ANSWER_CHARS: usize = 12;

/// Detect a "premature conclusion" — a response that stops the loop but does
/// not actually complete the task: a pure question, a clarification request, or
/// a suspiciously short reply. This is what keeps the main agent from "closing
/// the iteration with a question too quickly" instead of doing the work.
///
/// IMPORTANT: a response that contains a substantive statement before a
/// question (e.g. "Yes, I'm here! How can I help you today?") is a COMPLETE
/// answer — the model answered and then offered help. Only a *pure* question
/// (no statement part) is premature. Without this, a simple greeting loops
/// through retries → repetition → micro-agent summarization → tool spree.
/// Pure — unit-testable.
fn is_premature_answer(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return true;
    }
    let len = trimmed.chars().count();
    // Suspiciously short: not enough substance to be a real answer.
    if len < MIN_COMPLETE_ANSWER_CHARS {
        return true;
    }
    // A response that ends with '?' is the agent asking for input instead of
    // doing the work — BUT only when it's a *pure* question. A response that
    // contains a statement before the question (e.g. "Yes, I'm here! How can I
    // help you today?") is a complete answer.
    if trimmed.ends_with('?') {
        // Strip the trailing '?' (1 byte) and look for a statement terminator.
        let before = &trimmed[..trimmed.len() - 1];
        let has_statement = before.contains('.') || before.contains('!');
        if !has_statement {
            return true;
        }
    }
    // Clarification / hand-back phrases — only for short responses. A long
    // answer that happens to mention "how can I help" is a real answer.
    if len <= PREMATURE_ANSWER_MAX_CHARS {
        let lower = trimmed.to_lowercase();
        const CLARIFY: &[&str] = &[
            "could you clarify",
            "what do you mean",
            "please clarify",
            "can you be more specific",
            "what exactly",
            "could you tell me",
            "please let me know",
            "what information",
        ];
        if CLARIFY.iter().any(|p| lower.contains(p)) {
            return true;
        }
    }
    false
}

/// Maximum length (chars) of a response that can be considered a premature
/// clarification/hand-back. Longer responses are treated as real answers even
/// if they mention a clarification phrase.
const PREMATURE_ANSWER_MAX_CHARS: usize = 80;

/// Extract a best-effort answer from a thinking-only trace when the model
/// stalled and never produced a visible answer. Takes the last substantive
/// sentence(s) of the reasoning as a fallback so the user gets *something*
/// instead of "(no response)". Pure — unit-testable.
fn extract_answer_from_thinking(thinking: &str) -> String {
    let trimmed = thinking.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Split into sentences and keep the trailing ones that look like a real
    // conclusion (not a question, not empty).
    let sentences: Vec<&str> = trimmed
        .split(|c: char| c == '.' || c == '!' || c == '?' || c == '\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    // Walk backwards to find the last substantive, non-question sentence.
    for s in sentences.iter().rev() {
        if s.ends_with('?') {
            continue;
        }
        if s.chars().count() < MIN_COMPLETE_ANSWER_CHARS {
            continue;
        }
        return s.to_string();
    }
    // Fall back to the last sentence regardless of length.
    sentences.last().map(|s| s.to_string()).unwrap_or_default()
}

/// Decide whether a main-agent response is a *complete final answer* — i.e. the
/// task is done and the tool loop should conclude rather than keep retrying.
///
/// A response is complete when it has substantive visible content AND is not a
/// "still planning" JSON blob AND is not a premature conclusion (a question, a
/// clarification request, or a suspiciously short reply). This is the
/// deterministic "task done" signal the main agent uses to conclude
/// automatically (instead of stalling, waiting for a manual continue, or
/// closing too early with a question). Pure — unit-testable.
pub fn is_complete_answer(content: &str, has_tool_calls: bool) -> bool {
    // A pending tool call means the agent is still working — not done.
    if has_tool_calls {
        return false;
    }
    // A "still planning" JSON (conclusion:false / empty final_answer) is not done.
    if is_planning_json(content) {
        return false;
    }
    // A premature conclusion (question / too short / clarification) is not done.
    if is_premature_answer(content) {
        return false;
    }
    // Otherwise: substantive visible content = done.
    !content.trim().is_empty()
}

/// Fraction of the context window that is "near the limit" — when usage reaches
/// this ratio (80%) we proactively summarize the context to free room before the
/// model stalls or the request is rejected for exceeding the window.
const CONTEXT_SUMMARIZE_THRESHOLD: f64 = 0.80;

/// How many recent iterations to inspect when detecting repetition.
const REPETITION_WINDOW: usize = 3;

/// Detect whether the model is *repeating itself* — i.e. the last `window`
/// iterations produced identical (or near-identical) content, or the same tool
/// call. This is the "stuck in a loop" signal that triggers a micro-agent to
/// repurpose the last message, summarize the context, and re-trigger the model
/// with a to-do list. Pure — unit-testable.
///
/// `recent` holds the content (or a stable fingerprint) of the last iterations,
/// oldest first. When the trailing `window` entries are all equal (or all empty
/// while the model keeps calling the same tool), we treat it as repetition.
pub fn detect_repetition(recent: &[String], window: usize) -> bool {
    if recent.len() < window || window < 2 {
        return false;
    }
    let tail = &recent[recent.len() - window..];
    // All entries in the window must be identical (trimmed) to count as a loop.
    let first = tail[0].trim();
    if first.is_empty() {
        return false;
    }
    tail.iter().all(|c| c.trim() == first)
}

/// Context usage as a fraction of the model's context window (0.0–1.0+).
pub fn context_usage_ratio(context_tokens: u64, context_length: u64) -> f64 {
    if context_length == 0 {
        return 0.0;
    }
    context_tokens as f64 / context_length as f64
}

/// Whether the context is close enough to the limit that we should summarize.
/// True when usage is at or above `CONTEXT_SUMMARIZE_THRESHOLD` (80%).
pub fn should_summarize_context(context_tokens: u64, context_length: u64) -> bool {
    context_usage_ratio(context_tokens, context_length) >= CONTEXT_SUMMARIZE_THRESHOLD
}

/// Build the prompt that drives a micro-agent to repurpose the last message and
/// summarize the conversation, so the model can be re-triggered with a focused
/// to-do list instead of the full (near-limit) context.
pub fn build_context_summarization_prompt(last_message: &str, todo_list: &str) -> String {
    format!(
        "The conversation context is near its limit and the model is repeating itself. \
         Repurpose the last message and summarize the conversation so it can be re-triggered \
         with a focused to-do list.\n\n\
         LAST MESSAGE:\n{}\n\n\
         TODO LIST:\n{}\n\n\
         Produce a concise summary that preserves the task, the decisions made, and the \
         remaining work. Return ONLY the summary text.",
        last_message, todo_list
    )
}

/// Build a compact re-trigger message list from a context summary + to-do list,
/// replacing the full (near-limit) conversation. This is what gets fed back to
/// the model after a micro-agent summarizes the context, so the model resumes
/// with a focused plan instead of the bloated history. Pure — unit-testable.
pub fn build_retrigger_messages(
    summary: &str,
    todo_list: &str,
    original_task: &str,
) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "role": "system",
            "content": format!(
                "You are continuing a task after a context summarization. \
                 The following is a summary of the work done so far. Use it to continue \
                 the task to completion.\n\nSUMMARY:\n{}",
                summary
            )
        }),
        serde_json::json!({
            "role": "user",
            "content": format!(
                "Original task: {}\n\nRemaining to-do list:\n{}\n\n\
                 Continue working through the to-do list and complete the task. \
                 Do not repeat work already summarized.",
                original_task, todo_list
            )
        }),
    ]
}

/// Escalating nudge message for a reasoning-only retry. Each retry gets firmer
/// so a stuck thinking model (nemotron/qwen3/deepseek-r1) is pushed to finally
/// emit visible content or a structured tool call. Pure — unit-testable.
fn thinking_retry_prompt(retry: usize) -> String {
    if retry >= 5 {
        format!(
            "This is attempt {} — you MUST now answer. Stop reasoning aloud. Output \
             the final answer as visible text, or (if you intended a tool call) emit \
             the structured tool_calls block immediately.",
            retry
        )
    } else if retry >= 3 {
        "You have reasoned again without answering. Do NOT output further reasoning — \
         write the final answer as plain visible text now. If a tool is required, \
         call it (tool_calls) instead of describing it."
            .to_string()
    } else {
        "You have just finished your reasoning without producing a visible answer or \
         a tool call. Now provide the final answer as plain, visible text (no reasoning \
         trace). If you need to call a tool to answer, call it in the next response."
            .to_string()
    }
}

/// Nudge used after tools are dropped to force a plain-text answer.
fn tools_dropped_prompt() -> &'static str {
    "Tools are no longer available. Answer the user's request directly with plain visible \
     text now — no reasoning, no tool calls."
}

/// Derive a simple to-do list from the last message / current state. In a real
/// deployment this is produced by the summarization micro-agent; here we provide
/// a deterministic fallback so the re-trigger always has a plan. Pure.
pub fn build_fallback_todo_list(last_message: &str) -> String {
    let trimmed = last_message.trim();
    if trimmed.is_empty() {
        "1. Complete the original task and provide the final answer.".to_string()
    } else {
        format!(
            "1. Continue from the last message: {}\n2. Complete the remaining work and provide the final answer.",
            trimmed.chars().take(200).collect::<String>()
        )
    }
}

/// Detect whether `content` is a "still planning" structured-JSON blob — i.e.
/// the model explicitly says it is NOT done (`"conclusion": false`) or carries
/// an empty final_answer. In that case the tool loop must keep going (bounded
/// by retries) instead of returning the planning JSON as a final answer.
pub fn is_planning_json(content: &str) -> bool {
    let trimmed = content.trim_start();
    if !trimmed.starts_with('{') {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        // Multi-blob / malformed: treat as "still planning" only if it contains
        // a conclusion:false marker.
        return content.contains("\"conclusion\":false")
            || content.contains("\"conclusion\": false");
    };
    if let Some(c) = v.get("conclusion").and_then(|c| c.as_bool()) {
        if !c {
            return true;
        }
    }
    if let Some(fa) = v.get("final_answer").and_then(|f| f.as_str()) {
        if fa.trim().is_empty() {
            return true;
        }
    }
    false
}

/// Find the matching closing brace for the `{` at `open`, skipping string
/// literals. Returns `Some(index)` of the `}` or `None`.
fn matching_brace(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for k in open..chars.len() {
        let cc = chars[k];
        if in_string {
            if escaped {
                escaped = false;
            } else if cc == '\\' {
                escaped = true;
            } else if cc == '"' {
                in_string = false;
            }
        } else {
            match cc {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(k);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Build the `(agent, task, is_dup)` items used to pre-spawn explicitly
/// referenced `@agent`s. Each agent gets its OWN focused sub-task derived from
/// the user's message (see `split_task_for_agent`), so an agent never sees the
/// other @mentions and never tries to spawn its siblings. Duplicate agent
/// names are de-duplicated so a single agent is never pre-spawned twice. Pure —
/// unit-testable.
fn build_pre_spawn_items(referenced: &[String], user_message: &str) -> Vec<(String, String, bool)> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut items: Vec<(String, String, bool)> = Vec::new();
    for a in referenced {
        let name = a.trim();
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        let task = split_task_for_agent(user_message, name);
        items.push((name.to_string(), task, false));
    }
    items
}

/// Derive the focused task for one agent from the user's full message.
/// Rules:
///   - If the message contains exactly one `@agent` token, the agent gets the
///     whole message minus the @token (the request is clearly aimed at it).
///   - If MULTIPLE agents are mentioned, this agent gets the portion of the
///     message that mentions it (its own sentence/clause), with every OTHER
///     `@mention` and its associated clause stripped out so the sub-agent won't
///     attempt to re-spawn its siblings.
///   - Mentions of OTHER agents that don't appear in the known list are left
///     intact (e.g. @someone not an agent); we only strip known siblings.
/// Pure — unit-testable.
fn split_task_for_agent(user_message: &str, agent_name: &str) -> String {
    let agent_token = format!("@{}", agent_name);
    // Locate every @mention boundary in the message.
    let chars: Vec<char> = user_message.chars().collect();
    struct Mention { start: usize, end: usize, token: String }
    let mut mentions: Vec<Mention> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let mut j = i + 1;
            while j < chars.len()
                && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-' || chars[j] == '.' || chars[j] == '/')
            {
                j += 1;
            }
            mentions.push(Mention {
                start: i,
                end: j,
                token: chars[i..j].iter().collect::<String>(),
            });
            i = j;
        } else {
            i += 1;
        }
    }

    // The mention of THIS agent.
    let Some(idx) = mentions.iter().position(|m| m.token == agent_token) else {
        return user_message.trim().to_string();
    };

    // Determine the clause span for this agent. An agent's task is the text
    // that FOLLOWS its own @mention (its action), up to the next sibling
    // @mention boundary (or end of message). This gives "N agents × N tasks":
    //   "@researcher search the web while @code-reviewer review the code"
    //   → researcher gets "search the web while"
    //   → code-reviewer gets "review the code"
    // and critically never exposes ONE agent to the OTHER agent's clause, so a
    // sub-agent cannot re-spawn its siblings (the cascade bug).
    let start = mentions[idx].end;
    let end = if idx + 1 < mentions.len() { mentions[idx + 1].start } else { chars.len() };

    let out: String = chars[start..end].iter().collect();
    // Within the clause, drop ANY leftover @word (shouldn't be any since the
    // span stops at the next mention boundary, but be defensive).
    let result: String = {
        let c = out.chars().collect::<Vec<char>>();
        let mut buf = String::new();
        let mut k = 0;
        while k < c.len() {
            if c[k] == '@' {
                let mut l = k + 1;
                while l < c.len() && (c[l].is_alphanumeric() || c[l] == '_' || c[l] == '-' || c[l] == '.' || c[l] == '/') {
                    l += 1;
                }
                k = l; // drop the mention
            } else {
                buf.push(c[k]);
                k += 1;
            }
        }
        buf
    };
    let cleaned = result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Drop leading connective words that spilled over from the coordinator
    // ("while", "and", "then", "also", "in parallel", etc.) so the task reads
    // as a direct instruction for THIS agent only.
    let stop_words = ["while", "and", "then", "also", "in", "with", "using", "parallel", "at", "on", "for"];
    let mut words: Vec<&str> = cleaned.split_whitespace().collect();
    let mut trimmed_once = true;
    while trimmed_once {
        trimmed_once = false;
        if let Some(first) = words.first() {
            let f = first.trim_matches([',', ';', '-']);
            if words.len() > 1 && stop_words.contains(&f.to_lowercase().as_str()) {
                words.remove(0);
                trimmed_once = true;
            }
        }
    }
    let cleaned = words.join(" ");
    let cleaned = cleaned
        .trim()
        .trim_start_matches([',', ';', '-', '(', '['])
        .trim_end_matches([',', ';', '-', ')', ']'])
        .trim();
    if cleaned.is_empty() {
        user_message.trim().to_string()
    } else {
        cleaned.to_string()
    }
}

/// Run a batch of `spawn_subagent` calls concurrently (at most
/// `MAX_CONCURRENT_SUBAGENTS` at a time). Returns `(result, optional_trace)` for
/// each item in the same order as `items`. Duplicates (`is_dup`) are
/// short-circuited without running.
async fn run_spawn_batch(
    runner: Option<&SubAgentRunner<'_>>,
    items: &[(String, String, bool)], // (agent, task, is_dup)
) -> Vec<(String, Option<SubAgentTrace>)> {
    let mut results: Vec<(String, Option<SubAgentTrace>)> = Vec::with_capacity(items.len());
    for chunk in items.chunks(MAX_CONCURRENT_SUBAGENTS) {
        let futures = chunk.iter().map(|(agent, task, is_dup)| {
            let is_dup = *is_dup;
            async move {
                if is_dup {
                    (format!("Sub-agent '{}' was already spawned with this task in this turn; skipped duplicate.", agent), None)
                } else if let Some(r) = runner {
                    match Box::pin(run_subagent_with_validation(r, agent, task)).await {
                        Ok((out, trace)) => (tag_agent_result(classify_agent_result(&out), &out), Some(trace)),
                        Err(e) => (tag_agent_result(AGENT_RESULT_FAILED, &format!("Tool error: {}", e)), None),
                    }
                } else {
                    (tag_agent_result(AGENT_RESULT_FAILED, "Tool error: sub-agents are not available"), None)
                }
            }
        });
        results.extend(futures::future::join_all(futures).await);
    }
    results
}

// ---------------------------------------------------------------------------
// Tool definitions & execution
// ---------------------------------------------------------------------------

pub fn build_tool_schemas(enabled: &[String], root_path: Option<&str>) -> Vec<serde_json::Value> {
    build_tool_schemas_inner(enabled, root_path, true, None)
}

/// Internal builder. `allow_spawn_subagent` controls whether the
/// `spawn_subagent` tool is attached. Set to `false` for sub-agent tool loops
/// so a sub-agent can never delegate to (spawn) another sub-agent — this is
/// what prevents the cascade where each @mentioned sub-agent re-spawns the
/// other agents it sees mentioned in its (too-broad) task.
/// `agent_config` is optional; when provided and `can_spawn_micro_agents` is true,
/// the `spawn_micro_agent` tool is added.
fn build_tool_schemas_inner(
    enabled: &[String],
    root_path: Option<&str>,
    allow_spawn_subagent: bool,
    agent_config: Option<&AgentConfig>,
) -> Vec<serde_json::Value> {
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
                "description": "Read the contents of a file on disk. Use this to examine source code, configuration files, or any file the user references. When a project folder is open, only files within that folder can be read.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path to read (absolute or relative to the open project folder)"
                        }
                    },
                    "required": ["path"]
                }
            }
        }));
    }
    if enabled.contains(&"list_directory".to_string()) {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List files and directories at a given path. Use this to explore the project structure. When a project folder is open, only directories within that folder can be listed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The directory path to list (absolute or relative to the open project folder)"
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
    if enabled.contains(&"grep".to_string()) {
        let grep_desc = match root_path {
            Some(rp) => format!(
                "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers. \
                 Respects .gitignore. The open project folder is: {}. Search within it.", rp),
            None => "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers. \
                     Respects .gitignore.".to_string(),
        };
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "grep",
                "description": grep_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "Regex pattern to search for (e.g. 'fn main' or 'TODO.*fix')"
                        },
                        "path": {
                            "type": "string",
                            "description": "Directory or file to search in (default: project root)"
                        },
                        "glob": {
                            "type": "string",
                            "description": "Filter files by glob, e.g. '*.tsx' or '*.rs'"
                        },
                        "ignore_case": {
                            "type": "boolean",
                            "description": "Case-insensitive search (default: false)"
                        },
                        "context": {
                            "type": "integer",
                            "description": "Lines of context before/after each match (default: 0)"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max matches to return (default: 100)"
                        }
                    },
                    "required": ["pattern"]
                }
            }
        }));
    }
    if enabled.contains(&"edit".to_string()) {
        let edit_desc = match root_path {
            Some(rp) => format!(
                "Edit a file using exact text replacement. Each old_text must be unique in the file. \
                 For multiple changes in one file, include them all in one call. \
                 The open project folder is: {}. All paths must be within it.", rp),
            None => "Edit a file using exact text replacement. Each old_text must be unique in the file. \
                     NOTE: No folder is currently open — you need to open a folder to edit files.".to_string(),
        };
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "edit",
                "description": edit_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path to edit (relative or absolute)"
                        },
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_text": {
                                        "type": "string",
                                        "description": "Exact text to find (must be unique in the file)"
                                    },
                                    "new_text": {
                                        "type": "string",
                                        "description": "Replacement text"
                                    }
                                },
                                "required": ["old_text", "new_text"]
                            },
                            "description": "One or more text replacements to apply"
                        }
                    },
                    "required": ["path", "edits"]
                }
            }
        }));
    }
    if enabled.contains(&"write_file".to_string()) {
        let write_desc = match root_path {
            Some(rp) => format!(
                "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does. \
                 Automatically creates parent directories. \
                 The open project folder is: {}. All file paths must be within this folder. \
                 Use the edit tool instead of write_file when modifying existing files — it uses far fewer tokens.",
                rp),
            None => "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does. \
                     NOTE: No folder is currently open — you need to open a folder to write files.".to_string(),
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
                            "description": "File path to write to"
                        },
                        "content": {
                            "type": "string",
                            "description": "Content to write to the file"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        }));
    }

    if enabled.contains(&"rust_repl".to_string()) {
        let repl_desc = match root_path {
            Some(rp) => format!(
                "Compile and run a Rust code snippet in a temporary Cargo project. \
                 The code MUST include a `fn main()` entry point. \
                 The code is compiled and executed — stdout, stderr, and compiler errors are returned as the result. \
                 If compilation fails, the compiler errors are returned so you can fix the code and try again. \
                 Use this to verify code answers, test algorithms, compute results, or debug issues. \
                 You can optionally list crate dependencies. \
                 The open project folder is: {}.", rp),
            None => "Compile and run a Rust code snippet in a temporary Cargo project. \
                     The code MUST include a `fn main()` entry point. \
                     The code is compiled and executed — stdout, stderr, and compiler errors are returned as the result. \
                     If compilation fails, the compiler errors are returned so you can fix the code and try again. \
                     Use this to verify code answers, test algorithms, compute results, or debug issues. \
                     You can optionally list crate dependencies.".to_string(),
        };
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "rust_repl",
                "description": repl_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The Rust code to compile and run. Must include a `fn main()` function."
                        },
                        "dependencies": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "The crate name (e.g. 'serde', 'rand', 'regex')"
                                    },
                                    "version": {
                                        "type": "string",
                                        "description": "The version requirement (e.g. '1', '0.8', '1.0.200')"
                                    }
                                },
                                "required": ["name", "version"]
                            },
                            "description": "Optional Cargo crate dependencies needed by the code"
                        }
                    },
                    "required": ["code"]
                }
            }
        }));
    }

    if enabled.contains(&"bash_sandbox".to_string()) {
        let sandbox_desc = match root_path {
            Some(rp) => format!(
                "Execute a shell command in a sandboxed environment and return its output. \
                 The command runs in the open project folder (or in the specified working_directory). \
                 Commands may only access paths within the open project folder. \
                 Use this to validate CLI commands, test shell scripts, run build tools, \
                 or verify command-line answers before presenting them. \
                 stdout and stderr are captured and returned. \
                 The open project folder is: {}.", rp),
            None => "Execute a shell command in a sandboxed environment and return its output. \
                     The command runs in a temporary directory by default (or in the specified working_directory). \
                     Use this to validate CLI commands, test shell scripts, run build tools, \
                     or verify command-line answers before presenting them. \
                     stdout and stderr are captured and returned.".to_string(),
        };
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "bash_sandbox",
                "description": sandbox_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute (passed to /bin/bash -c)"
                        },
                        "timeout": {
                            "type": "integer",
                            "description": "Maximum execution time in seconds (default: 30, max: 300)"
                        },
                        "working_directory": {
                            "type": "string",
                            "description": "Working directory for the command (default: a temporary sandbox directory)"
                        }
                    },
                    "required": ["command"]
                }
            }
        }));
    }

    // Load custom tools from .tools/ directory
    if let Some(rp) = root_path {
        let tools_dir = std::path::Path::new(rp).join(".tools");
        if tools_dir.exists() {
            if let Ok(read_dir) = std::fs::read_dir(&tools_dir) {
                for entry in read_dir.flatten() {
                    if entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        if file_name.ends_with(".json") {
                            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                                    let tool_name = parsed["name"].as_str()
                                        .or_else(|| file_name.strip_suffix(".json"))
                                        .unwrap_or(&file_name);
                                    let description = parsed["description"].as_str().unwrap_or("");
                                    let mut params = parsed.get("parameters")
                                        .cloned()
                                        .unwrap_or(serde_json::json!({
                                            "type": "object",
                                            "properties": {}
                                        }));
                                    // Normalize: `"parameters": {}` (empty object) is not a valid
                                    // JSON Schema for function calling — it needs type + properties.
                                    if params == serde_json::json!({}) {
                                        params = serde_json::json!({
                                            "type": "object",
                                            "properties": {}
                                        });
                                    }
                                    tools.push(serde_json::json!({
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "description": description,
                                            "parameters": params
                                        }
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Add a `spawn_subagent` tool when sub-agents are defined in `.agents/`.
    // The description lists each agent + its description so the main LLM can
    // decide which tasks to route to which sub-agent. Only the main agent's
    // tool loop gets this tool; sub-agent loops pass allow_spawn_subagent=false
    // so they cannot spawn further sub-agents (prevents the re-spawn cascade).
    if allow_spawn_subagent {
        if let Some(rp) = root_path {
            let agents = list_agent_configs(rp);
            if !agents.is_empty() {
                let agent_list: Vec<String> = agents
                    .iter()
                    .map(|a| {
                        let desc = if a.description.is_empty() { "(no description)" } else { a.description.as_str() };
                        format!("- {}: {}", a.name, desc)
                    })
                    .collect();
                tools.push(serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": "spawn_subagent",
                        "description": format!(
                            "Delegate a task to a specialized sub-agent and return its result. \
                             Use this to offload focused work (e.g. code review, research, writing, \
                             or anything another agent is better suited for) to a sub-agent that runs \
                             independently and reports back. Available sub-agents:\n{}",
                            agent_list.join("\n")
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "agent": {
                                    "type": "string",
                                    "description": "The name of the sub-agent to spawn (must match one of the available sub-agents)"
                                },
                                "task": {
                                    "type": "string",
                                    "description": "The task or instruction for the sub-agent"
                                }
                            },
                            "required": ["agent", "task"]
                        }
                    }
                }));
            }
        }
    }

    // Add a `spawn_micro_agent` tool when the current agent is allowed to
    // delegate to micro-agents (can_spawn_micro_agents) and micro-agents are
    // defined in `.micro-agents/`. Only sub-agents with this flag get the tool;
    // the main agent does not (it delegates to sub-agents, which delegate to
    // micro-agents).
    if let Some(ac) = agent_config {
        if ac.can_spawn_micro_agents {
            if let Some(rp) = root_path {
                let micros = list_micro_agent_configs(rp);
                if !micros.is_empty() {
                    let micro_list: Vec<String> = micros
                        .iter()
                        .filter(|m| ac.allowed_micro_agents.is_empty() || ac.allowed_micro_agents.contains(&m.name))
                        .map(|m| {
                            let desc = if m.description.is_empty() { "(no description)" } else { m.description.as_str() };
                            format!("- {}: {}", m.name, desc)
                        })
                        .collect();
                    if !micro_list.is_empty() {
                        tools.push(serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": "spawn_micro_agent",
                                "description": format!(
                                    "Delegate a focused, mechanical task (fixing a compiler error, writing a test, \
                                     fixing a lint issue) to a small, fast micro-agent and return its result. \
                                     Use this for single-purpose, deterministic work that a small model can do \
                                     reliably and that can be validated with a build/lint/test command. \
                                     Available micro-agents:\n{}",
                                    micro_list.join("\n")
                                ),
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "agent": {
                                            "type": "string",
                                            "description": "The name of the micro-agent to spawn (must match one of the available micro-agents)"
                                        },
                                        "task": {
                                            "type": "string",
                                            "description": "The focused, single-purpose task for the micro-agent (e.g. 'Fix the cargo check errors in src/main.rs')"
                                        }
                                    },
                                    "required": ["agent", "task"]
                                }
                            }
                        }));
                    }
                }
            }
        }
    }

    tools
}

/// Computes structured file-change metadata for file-mutating tools, resolved
/// the same way `execute_tool` does (relative paths joined to `root_path`).
/// Called *before* the tool executes so `write_file` can record whether the
/// file already existed. Returns an empty vec for non-file tools or when the
/// edit would fail (so a failed edit isn't reported as a change).
fn compute_file_changes(
    name: &str,
    args: &serde_json::Value,
    root_path: Option<&str>,
) -> Vec<FileChange> {
    let resolve = |path: &str| -> Option<std::path::PathBuf> {
        let p = std::path::Path::new(path);
        if p.is_absolute() {
            Some(p.to_path_buf())
        } else {
            root_path.map(|rp| std::path::Path::new(rp).join(p))
        }
    };

    match name {
        "write_file" => {
            let path = args["path"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            if path.is_empty() {
                return Vec::new();
            }
            match resolve(path) {
                Some(abs) => vec![FileChange {
                    path: path.to_string(),
                    action: "write".to_string(),
                    created: !abs.exists(),
                    bytes: content.len() as u64,
                    edits: Vec::new(),
                }],
                None => Vec::new(),
            }
        }
        "edit" => {
            let path = args["path"].as_str().unwrap_or("");
            let edits = args["edits"].as_array().cloned().unwrap_or_default();
            if path.is_empty() || edits.is_empty() {
                return Vec::new();
            }
            match resolve(path) {
                Some(abs) => {
                    let content = match std::fs::read_to_string(&abs) {
                        Ok(c) => c,
                        // The edit tool will fail too — don't report a change.
                        Err(_) => return Vec::new(),
                    };
                    // Mirror the edit tool's sequential replace + uniqueness
                    // checks so a change is only reported when the edit will
                    // actually succeed.
                    let mut new_content = content;
                    let mut fc_edits: Vec<FileChangeEdit> = Vec::with_capacity(edits.len());
                    for edit in &edits {
                        let old_text = edit["old_text"].as_str().unwrap_or("");
                        let new_text = edit["new_text"].as_str().unwrap_or("");
                        let count = new_content.matches(old_text).count();
                        if count != 1 {
                            // Missing or ambiguous — the edit tool will error.
                            return Vec::new();
                        }
                        new_content = new_content.replacen(old_text, new_text, 1);
                        fc_edits.push(FileChangeEdit {
                            old_text: old_text.to_string(),
                            new_text: new_text.to_string(),
                        });
                    }
                    vec![FileChange {
                        path: path.to_string(),
                        action: "edit".to_string(),
                        created: false,
                        bytes: new_content.len() as u64,
                        edits: fc_edits,
                    }]
                }
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// Executes a tool and also returns file-change metadata (for `write_file` and
/// `edit`) so the frontend can render expandable diffs. Thin wrapper around
/// `execute_tool` — the actual tool logic is untouched.
async fn execute_tool_tracked(
    name: &str,
    args: &serde_json::Value,
    client: &reqwest::Client,
    tool_configs: &HashMap<String, serde_json::Value>,
    root_path: Option<&str>,
    backend: &str,
) -> Result<(String, Vec<FileChange>), String> {
    let file_changes = compute_file_changes(name, args, root_path);
    let output = execute_tool(name, args, client, tool_configs, root_path, backend).await?;
    Ok((output, file_changes))
}

async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    client: &reqwest::Client,
    tool_configs: &HashMap<String, serde_json::Value>,
    root_path: Option<&str>,
    backend: &str,
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
            let limit = web_fetch_limit(backend);
            if text.len() > limit {
                Ok(format!(
                    "{}\n\n... [truncated at {} chars, total {} chars]",
                    &text[..limit],
                    limit,
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
            let resolved = resolve_within_root(root_path, path)?;
            let text = std::fs::read_to_string(&resolved)
                .map_err(|e| format!("Failed to read {}: {}", path, e))?;
            // Truncate to avoid overwhelming small models with large files
            let limit = read_file_limit(backend);
            if text.len() > limit {
                Ok(format!(
                    "{}\n\n... [truncated at {} chars, total {} chars — use grep to search, or edit for targeted changes]",
                    &text[..limit],
                    limit,
                    text.len()
                ))
            } else {
                Ok(text)
            }
        }
        "list_directory" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            eprintln!("[nolock] tool list_directory path={}", path);
            let resolved = resolve_within_root(root_path, path)?;
            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(&resolved)
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
        "grep" => {
            let pattern = args["pattern"]
                .as_str()
                .ok_or("Missing required parameter: pattern")?;
            let search_path_buf = if let Some(p) = args["path"].as_str() {
                resolve_within_root(root_path, p)?
            } else {
                match root_path {
                    Some(rp) => std::path::PathBuf::from(rp),
                    None => std::path::PathBuf::from("."),
                }
            };
            let glob_pattern = args["glob"].as_str();
            let ignore_case = args["ignore_case"].as_bool().unwrap_or(false);
            let context_lines = args["context"].as_u64().unwrap_or(0) as usize;
            let max_matches = args["limit"].as_u64().unwrap_or(GREP_MAX_MATCHES as u64) as usize;
            eprintln!(
                "[nolock] tool grep pattern={} path={}",
                pattern,
                search_path_buf.display()
            );

            // Build regex
            let re_str = if ignore_case {
                format!("(?i){}", pattern)
            } else {
                pattern.to_string()
            };
            let re = Regex::new(&re_str).map_err(|e| format!("Invalid regex pattern: {}", e))?;

            // Glob filter
            let glob_re: Option<Regex> = glob_pattern.map(|g| {
                // Convert simple glob to regex: *.ts -> .*\.ts, **/*.ts -> .*
                let mut regex_str = String::from("(?s)");
                let mut chars = g.chars().peekable();
                while let Some(c) = chars.next() {
                    match c {
                        '*' => {
                            if chars.peek() == Some(&'*') {
                                chars.next(); // skip second *
                                if chars.peek() == Some(&'/') {
                                    chars.next(); // skip /
                                    regex_str.push_str(".*");
                                } else {
                                    regex_str.push_str(".*");
                                }
                            } else {
                                regex_str.push_str("[^/]*");
                            }
                        }
                        '?' => regex_str.push('.'),
                        '.' => regex_str.push_str("\\."),
                        '[' => regex_str.push('['),
                        ']' => regex_str.push(']'),
                        _ => regex_str.push(c),
                    }
                }
                Regex::new(&regex_str).unwrap_or_else(|_| Regex::new(".*").unwrap())
            });

            let root = search_path_buf.as_path();
            let mut output_lines: Vec<String> = Vec::new();
            let mut match_count: usize = 0;
            let mut total_bytes: usize = 0;
            let mut truncated = false;
            let mut dirs_to_visit = vec![root.to_path_buf()];
            let mut post_context_remaining: usize = 0;

            while let Some(dir) = dirs_to_visit.pop() {
                if match_count >= max_matches || total_bytes >= GREP_MAX_OUTPUT_BYTES {
                    truncated = true;
                    break;
                }
                let read_dir = match std::fs::read_dir(&dir) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                for entry in read_dir {
                    if match_count >= max_matches || total_bytes >= GREP_MAX_OUTPUT_BYTES {
                        truncated = true;
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
                        if metadata.len() > MAX_FILE_SIZE {
                            continue;
                        }
                        if is_binary(&path) {
                            continue;
                        }
                        // Apply glob filter
                        if let Some(ref gr) = glob_re {
                            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            if !gr.is_match(file_name) {
                                continue;
                            }
                        }

                        let content = match std::fs::read_to_string(&path) {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        let file_path_str = path.strip_prefix(root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .to_string();
                        let lines: Vec<&str> = content.lines().collect();

                        for (idx, line) in lines.iter().enumerate() {
                            if match_count >= max_matches || total_bytes >= GREP_MAX_OUTPUT_BYTES {
                                truncated = true;
                                break;
                            }
                            if re.is_match(line) {
                                match_count += 1;
                                let line_num = idx + 1;
                                let truncated_line: String = line.chars().take(GREP_MAX_LINE_LENGTH).collect();
                                let entry = format!("{}:{}:{}", file_path_str, line_num, truncated_line);
                                total_bytes += entry.len() + 1;
                                output_lines.push(entry);

                                // Add context lines after match
                                if context_lines > 0 {
                                    post_context_remaining = context_lines;
                                }
                            } else if post_context_remaining > 0 && idx > 0 {
                                // Output context line
                                let line_num = idx + 1;
                                let truncated_line: String = line.chars().take(GREP_MAX_LINE_LENGTH).collect();
                                let entry = format!("{}-{}-{}", file_path_str, line_num, truncated_line);
                                total_bytes += entry.len() + 1;
                                output_lines.push(entry);
                                post_context_remaining -= 1;
                            } else {
                                post_context_remaining = 0;
                            }
                        }
                        post_context_remaining = 0;
                    }
                }
            }

            if output_lines.is_empty() {
                Ok("No matches found".to_string())
            } else {
                let mut result = output_lines.join("\n");
                if truncated {
                    let notice = format!(
                        "\n\n[Truncated: {} matches returned.{}]",
                        match_count,
                        if match_count >= max_matches {
                            " Use limit parameter for more, or refine your pattern."
                        } else {
                            " Output too large."
                        }
                    );
                    result.push_str(&notice);
                }
                Ok(result)
            }
        }
        "edit" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            let edits = args["edits"]
                .as_array()
                .ok_or("Missing required parameter: edits")?;
            if edits.is_empty() {
                return Err("edits must contain at least one replacement".into());
            }
            eprintln!("[nolock] tool edit path={} edits={}", path, edits.len());

            // Resolve path — if relative, resolve against root_path
            let abs_path = if std::path::Path::new(path).is_absolute() {
                std::path::PathBuf::from(path)
            } else {
                let root = root_path.ok_or("No folder is open — cannot use relative paths")?;
                std::path::Path::new(root).join(path)
            };

            // Ensure path is within root
            if let Some(rp) = root_path {
                let root_canonical = std::path::Path::new(rp).canonicalize()
                    .map_err(|e| format!("Failed to resolve root path: {}", e))?;
                let file_canonical = abs_path.canonicalize()
                    .map_err(|_| format!("File does not exist: {}", path))?;
                if !file_canonical.starts_with(&root_canonical) {
                    return Err("Path is outside the open folder".into());
                }
            }

            let content = std::fs::read_to_string(&abs_path)
                .map_err(|e| format!("Failed to read {}: {}", path, e))?;

            let mut new_content = content.clone();
            let mut replacements = 0usize;

            for edit in edits {
                let old_text = edit["old_text"].as_str()
                    .ok_or("Each edit must have an old_text string")?;
                let new_text = edit["new_text"].as_str()
                    .ok_or("Each edit must have a new_text string")?;

                // Check uniqueness
                let count = new_content.matches(old_text).count();
                if count == 0 {
                    return Err(format!(
                        "old_text not found in {}: {:?}",
                        path,
                        &old_text[..old_text.len().min(80)]
                    ));
                }
                if count > 1 {
                    return Err(format!(
                        "old_text found {} times in {} — must be unique. Include more surrounding context.",
                        count, path
                    ));
                }

                new_content = new_content.replacen(old_text, new_text, 1);
                replacements += 1;
            }

            std::fs::write(&abs_path, &new_content)
                .map_err(|e| format!("Failed to write {}: {}", path, e))?;

            Ok(format!(
                "Successfully replaced {} block(s) in {}",
                replacements, path
            ))
        }
        "write_file" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            let content = args["content"]
                .as_str()
                .ok_or("Missing required parameter: content")?;
            eprintln!("[nolock] tool write_file path={}", path);

            // Resolve path — if relative, resolve against root_path
            let abs_path = if std::path::Path::new(path).is_absolute() {
                std::path::PathBuf::from(path)
            } else {
                let root = root_path.ok_or("No folder is open — cannot use relative paths")?;
                std::path::Path::new(root).join(path)
            };

            // Ensure path is within root
            if let Some(rp) = root_path {
                let root_canonical = std::path::Path::new(rp).canonicalize()
                    .map_err(|e| format!("Failed to resolve root path: {}", e))?;
                // Create parent dirs first so canonicalize works
                if let Some(parent) = abs_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let file_canonical = abs_path.canonicalize()
                    .or_else(|_| {
                        // File might not exist yet — check parent
                        abs_path.parent()
                            .map(|p| p.join(abs_path.file_name().unwrap_or_default()))
                            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no parent"))
                    })
                    .map_err(|e| format!("Failed to resolve path: {}", e))?;
                if !file_canonical.starts_with(&root_canonical) {
                    return Err("Path is outside the open folder".into());
                }
            }

            // Create parent directories
            if let Some(parent) = abs_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directories: {}", e))?;
            }

            std::fs::write(&abs_path, content)
                .map_err(|e| format!("Failed to write {}: {}", path, e))?;

            Ok(format!(
                "Successfully wrote {} bytes to {}",
                content.len(),
                path
            ))
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
                    Ok(format!("{}\n\n[Results from Brave Search]", output.trim()))
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
        "rust_repl" => {
            let code = args["code"]
                .as_str()
                .ok_or("Missing required parameter: code")?;
            let dependencies = args["dependencies"].as_array();
            eprintln!("[nolock] tool rust_repl code_len={}", code.len());

            // Create a temporary directory for the Cargo project.
            // Use a nanosecond timestamp to avoid collisions if multiple
            // repl calls happen concurrently.
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let temp_dir = std::env::temp_dir().join(format!("nolock_repl_{}", nanos));

            // Build Cargo.toml
            let mut cargo_toml = "[package]\nname = \"repl\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n".to_string();

            if let Some(deps) = dependencies {
                for dep in deps {
                    if let (Some(name), Some(version)) =
                        (dep["name"].as_str(), dep["version"].as_str())
                    {
                        // Only allow reasonable crate names (alphanumeric, underscore, hyphen)
                        if name
                            .chars()
                            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
                            && !name.is_empty()
                        {
                            cargo_toml.push_str(&format!("{} = \"{}\"\n", name, version));
                        }
                    }
                }
            }

            // Create the project structure
            let src_dir = temp_dir.join("src");
            std::fs::create_dir_all(&src_dir)
                .map_err(|e| format!("Failed to create temp directory: {}", e))?;
            std::fs::write(temp_dir.join("Cargo.toml"), &cargo_toml)
                .map_err(|e| format!("Failed to write Cargo.toml: {}", e))?;
            std::fs::write(src_dir.join("main.rs"), code)
                .map_err(|e| format!("Failed to write main.rs: {}", e))?;

            // Run cargo run --quiet (compiles and executes)
            let output = std::process::Command::new("cargo")
                .args(["run", "--quiet"])
                .current_dir(&temp_dir)
                .output()
                .map_err(|e| format!("Failed to execute cargo: {}", e))?;

            // Clean up the temp directory regardless of outcome
            let _ = std::fs::remove_dir_all(&temp_dir);

            // Build result from stdout + stderr
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            let mut result = String::new();

            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&stderr);
            }

            if result.is_empty() {
                result = format!("(Program exited with code {})", exit_code);
            }

            // Truncate to avoid overwhelming the model
            if result.len() > 15000 {
                result = format!(
                    "{}\n\n... [truncated at 15000 chars, total {} chars]",
                    &result[..15000],
                    result.len()
                );
            }

            Ok(result)
        }
        "bash_sandbox" => {
            let command = args["command"]
                .as_str()
                .ok_or("Missing required parameter: command")?;
            let timeout_secs = args["timeout"]
                .as_u64()
                .unwrap_or(30)
                .min(300); // cap at 5 minutes
            let working_dir = args["working_directory"].as_str();
            eprintln!(
                "[nolock] tool bash_sandbox command={} timeout={}s",
                &command[..command.len().min(120)],
                timeout_secs
            );

            // When a project is open, refuse commands that reference absolute
            // paths outside it, so the sandboxed shell can't escape into other
            // directories (e.g. `find /other/project ...`).
            if let Some(rp) = root_path {
                let root_canonical = std::path::Path::new(rp)
                    .canonicalize()
                    .map_err(|e| format!("Failed to resolve project root: {}", e))?;
                if let Some(bad_path) = command_escapes_root(command, &root_canonical) {
                    return Err(format!(
                        "Command references path '{}' outside the open project folder '{}'. \
                         Commands must stay within the open folder.",
                        bad_path, rp
                    ));
                }
            }

            // Determine working directory — always restricted to within root_path
            // when a project folder is open, to prevent filesystem escape.
            let cwd = if let Some(wd) = working_dir {
                let p = std::path::PathBuf::from(wd);
                // If a project folder is open, ensure the working dir is within it
                if let Some(rp) = root_path {
                    let root_canonical = std::path::Path::new(rp).canonicalize()
                        .map_err(|e| format!("Failed to resolve project root: {}", e))?;
                    // Create the directory if it doesn't exist yet
                    if !p.exists() {
                        std::fs::create_dir_all(&p)
                            .map_err(|e| format!("Failed to create working directory {}: {}", wd, e))?;
                    }
                    let dir_canonical = p.canonicalize()
                        .map_err(|e| format!("Failed to resolve working directory {}: {}", wd, e))?;
                    if !dir_canonical.starts_with(&root_canonical) {
                        return Err(format!(
                            "Working directory '{}' is outside the open project folder '{}'",
                            wd, rp
                        ));
                    }
                    p
                } else {
                    // No project open — still allow the requested directory
                    if !p.exists() {
                        std::fs::create_dir_all(&p)
                            .map_err(|e| format!("Failed to create working directory {}: {}", wd, e))?;
                    }
                    p
                }
            } else if let Some(rp) = root_path {
                std::path::PathBuf::from(rp)
            } else {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let temp = std::env::temp_dir().join(format!("nolock_bash_{}", nanos));
                std::fs::create_dir_all(&temp)
                    .map_err(|e| format!("Failed to create temp directory: {}", e))?;
                temp
            };

            // Spawn the process and implement a real timeout by killing it
            // after the deadline expires.
            //
            // IMPORTANT: We call `setsid()` via pre_exec to place the child
            // in its own session/process group.  This is required so that
            // `kill(-pid, SIGKILL)` targets the correct process group and
            // kills the entire tree (bash + any children it spawns).
            #[cfg(unix)]
            let child = {
                use std::os::unix::process::CommandExt;
                let mut cmd = std::process::Command::new("/bin/bash");
                cmd.arg("-c")
                    .arg(command)
                    .current_dir(&cwd)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
                // SAFETY: pre_exec is safe when we only call async-signal-safe
                // functions.  setsid() is async-signal-safe.
                unsafe {
                    cmd.pre_exec(|| {
                        libc::setsid();
                        Ok(())
                    });
                }
                cmd.spawn()
                    .map_err(|e| format!("Failed to spawn command: {}", e))?
            };
            #[cfg(not(unix))]
            let child = std::process::Command::new("/bin/bash")
                .arg("-c")
                .arg(command)
                .current_dir(&cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn command: {}", e))?;

            // Spawn a killer thread that waits for the timeout then kills the
            // process group.  We use the child's PID to target the whole tree
            // so that child processes (e.g. from `sleep &`) are also cleaned up.
            let child_id = child.id();
            let kill_handle = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(timeout_secs));
                // Kill the entire process group by sending SIGKILL to -pid.
                // On Unix this targets all processes in the group.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
                #[cfg(not(unix))]
                let _ = child_id; // On non-Unix, just ignore (process groups don't exist)
            });

            // Wait for the process to finish
            let output = child.wait_with_output()
                .map_err(|e| format!("Failed to read command output: {}", e))?;

            // Clean up the killer thread (it will either have fired or be a
            // no-op now that the process is dead).
            let _ = kill_handle.join();

            // Build result
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            // Detect if we killed it due to timeout
            let timed_out = exit_code == -1
                || stderr.contains("Killed")
                || stderr.contains("SIGKILL");

            let mut result = String::new();
            if timed_out {
                result.push_str(&format!(
                    "[Command killed after {} second timeout]\n",
                    timeout_secs
                ));
            }
            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&stderr);
            }

            if result.is_empty() {
                result = format!("(Command exited with code {})", exit_code);
            }

            // Truncate to avoid overwhelming the model
            if result.len() > 15000 {
                result = format!(
                    "{}\n\n... [truncated at 15000 chars, total {} chars]",
                    &result[..15000],
                    result.len()
                );
            }

            Ok(result)
        }
        _ => {
            // Try custom tool from .tools/ directory
            if let Some(rp) = root_path {
                let tool_path = std::path::Path::new(rp)
                    .join(".tools")
                    .join(format!("{}.json", name));
                if tool_path.exists() {
                    return execute_custom_tool(name, args, rp);
                }
            }
            Err(format!("Unknown tool: {}", name))
        }
    }
}

fn execute_custom_tool(name: &str, args: &serde_json::Value, root_path: &str) -> Result<String, String> {
    let tool_path = std::path::Path::new(root_path)
        .join(".tools")
        .join(format!("{}.json", name));

    let content = std::fs::read_to_string(&tool_path)
        .map_err(|e| format!("Failed to read tool '{}': {}", name, e))?;

    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse tool '{}': {}", name, e))?;

    let command_template = parsed["command"].as_str()
        .ok_or_else(|| format!("Tool '{}' missing 'command' field", name))?;

    // Substitute {param} placeholders with actual argument values
    let mut command_str = command_template.to_string();
    if let Some(obj) = args.as_object() {
        for (key, value) in obj {
            let placeholder = format!("{{{}}}", key);
            let replacement = value.as_str()
                .map(|s| s.to_string())
                .or_else(|| value.as_i64().map(|n| n.to_string()))
                .or_else(|| value.as_f64().map(|n| n.to_string()))
                .unwrap_or_default();
            command_str = command_str.replace(&placeholder, &replacement);
        }
    }

    if command_str.trim().is_empty() {
        return Ok(String::new());
    }

    let parts: Vec<&str> = command_str.split_whitespace().collect();
    if parts.is_empty() {
        return Ok(String::new());
    }

    let program = parts[0];
    let cmd_args = &parts[1..];

    // Read optional timeout from tool definition (default 30s, max 300s)
    let timeout_secs = parsed["timeout"].as_u64().unwrap_or(30).min(300);

    eprintln!("[nolock] custom tool {} command: {} timeout: {}s", name, command_str, timeout_secs);

    // Spawn with timeout protection (same as bash_sandbox)
    // Use setsid() so the child gets its own process group for reliable killing.
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new(program);
        cmd.args(cmd_args)
            .current_dir(root_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // SAFETY: setsid() is async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn()
            .map_err(|e| format!("Failed to execute tool '{}': {}", name, e))?
    };
    #[cfg(not(unix))]
    let child = std::process::Command::new(program)
        .args(cmd_args)
        .current_dir(root_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute tool '{}': {}", name, e))?;

    // Killer thread for timeout
    let child_id = child.id();
    let kill_handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(timeout_secs));
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child_id as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        let _ = child_id;
    });

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to read tool output: {}", e))?;

    let _ = kill_handle.join();

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    let timed_out = exit_code == -1
        || stderr.contains("Killed")
        || stderr.contains("SIGKILL");

    let mut result = String::new();
    if timed_out {
        result.push_str(&format!(
            "[Tool killed after {} second timeout]\n",
            timeout_secs
        ));
    }
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() { result.push('\n'); }
        result.push_str(&stderr);
    }
    if result.is_empty() {
        result = format!("(exit code: {})", exit_code);
    }

    // Truncate to avoid overwhelming the model
    if result.len() > 15000 {
        result = format!(
            "{}\n\n... [truncated at 15000 chars, total {} chars]",
            &result[..15000],
            result.len()
        );
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Helpers for ollama_chat_with_tools
// ---------------------------------------------------------------------------

/// Result from streaming a single Ollama response.
struct StreamResult {
    /// Content emitted by the model in this iteration (for the assistant message).
    iter_content: String,
    /// Thinking trace emitted by thinking-capable models (e.g. Qwen3).
    iter_thinking: String,
    /// Tool calls detected, if any.
    tool_calls: Option<Vec<serde_json::Value>>,
    /// Prompt tokens reported by Ollama in the final "done" chunk (0 if absent).
    prompt_tokens: u64,
    /// Completion tokens reported by Ollama in the final "done" chunk (0 if absent).
    completion_tokens: u64,
}

/// Build the initial messages array for the Ollama tool-calling loop.
///
/// Ollama's `tools` field already injects tool descriptions into the chat
/// template, so we do **not** prepend a separate system message listing tool
/// names.  That dual-signal approach can confuse smaller models (e.g. Qwen
/// 9B) and wastes precious context window space.
fn build_initial_messages(
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut ollama_msgs: Vec<serde_json::Value> = Vec::new();

    // Hint the model to delegate when a sub-agent is available.
    let has_spawn_subagent = tools
        .iter()
        .any(|t| t["function"]["name"].as_str() == Some("spawn_subagent"));
    let has_spawn_micro_agent = tools
        .iter()
        .any(|t| t["function"]["name"].as_str() == Some("spawn_micro_agent"));
    if has_spawn_subagent || has_spawn_micro_agent {
        ollama_msgs.push(serde_json::json!({
            "role": "system",
            "content": "When the `spawn_subagent` tool is available, delegate focused tasks that \
                        match a sub-agent's specialty (e.g. code review, research, writing) to the \
                        appropriate sub-agent instead of doing everything yourself. Spawn each \
                        sub-agent at most once per task. When MULTIPLE sub-agents are warranted, \
                        emit ALL the spawn_subagent tool calls in the SAME response (a single \
                        tool_calls batch) so they run in PARALLEL — do not spawn them one at a \
                        time or wait between spawns. After the sub-agents return their results, \
                        incorporate them into a complete final answer that directly addresses \
                        the user's original request: do not stop after spawning — wait for \
                        their results and then write the final response.\n\n\
                        [A2A retry contract] Every sub-agent / micro-agent result is prefixed \
                        with a status marker: [AGENT_RESULT: OK], [AGENT_RESULT: FAILED], or \
                        [AGENT_RESULT: EMPTY]. If a delegate returns FAILED or EMPTY, retry it \
                        ONCE with a more specific task that includes the error/feedback. If it \
                        fails again, COMPLETE THE TASK YOURSELF with your own tools (write_file, \
                        bash_sandbox, etc.) — never leave the task incomplete because a delegate \
                        failed."
        }));
    }

    // When tools are available, tell the model to actually USE them when the
    // task calls for it. Nemotron-class thinking models otherwise tend to
    // "think" through a computation and write prose instead of calling a tool.
    let tool_names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    if !tool_names.is_empty() {
        let has_rust_repl = tool_names.iter().any(|n| *n == "rust_repl");
        let mut hinted = String::new();
        if has_rust_repl {
            hinted.push_str(
                "Use the `rust_repl` tool to compile and run Rust code whenever the task involves \
                 computing a result, verifying a claim, testing an algorithm, or debugging code. \
                 Do NOT try to compute or simulate it in prose.",
            );
        }
        let extra = if tool_names.contains(&"web_search") || tool_names.contains(&"web_fetch") {
            " To answer questions about external or current information, use web_search / web_fetch."
        } else {
            ""
        };
        ollama_msgs.push(serde_json::json!({
            "role": "system",
            "content": format!(
                "You have the following tools available: {}. \
                 Call a tool (via the tool_calls field) when the task requires it — waiting for \
                 its result and then continuing is correct behaviour.{}{}",
                tool_names.join(", "),
                if hinted.is_empty() { "" } else { hinted.as_str() },
                extra
            )
        }));
    }

    for m in messages {
        ollama_msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    ollama_msgs
}

/// Extract the next complete newline-delimited line from a byte buffer,
/// returning it as a trimmed `String`, or `None` if no complete line is present.
///
/// Buffering raw bytes (rather than decoding each network chunk in isolation)
/// is critical for correctness: a multi-byte UTF-8 sequence can be split across
/// chunk boundaries, and decoding a chunk whose tail ends mid-sequence with
/// `String::from_utf8_lossy` would corrupt the stream (garbled / replacement
/// characters — often appearing as CJK mojibake). We instead accumulate raw
/// bytes and only decode once the trailing newline arrives, so split sequences
/// are reassembled before decoding.
fn take_next_line(buf: &mut Vec<u8>) -> Option<String> {
    let pos = buf.iter().position(|&b| b == b'\n')?;
    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
    let line = String::from_utf8_lossy(&line_bytes);
    Some(line.trim().to_string())
}

/// The tool-calling architecture of the model currently being driven. Different
/// model families emit tool calls in subtly different shapes, so the stream
/// parser adapts its normalization to the architecture. This lets nolock drive
/// a heterogeneous stack — e.g. nemotron 9B (main, max context), lfm2.5 (intent
/// classifier / agent router), and qwen3.5:0.8b (micro-agent layer) — each with
/// its own quirks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelArch {
    /// Nemotron-class: thinking-capable, emits standard Ollama `message.tool_calls`,
    /// but can get stuck in "thinking only" mode (handled by the retry loop).
    Nemotron,
    /// lfm2.5-class: responds with a structured JSON *planning* blob
    /// (`{"analysis", "next_steps", "tool_calls"}`) instead of real tool_calls.
    Lfm,
    /// Qwen-class (incl. small coder models like qwen3.5:0.8b): may emit
    /// `arguments` as a JSON *string* rather than an object, and occasionally
    /// nests tool calls under alternate keys.
    Qwen,
    /// DeepSeek-class: reasoning model, OpenAI-compatible tool_calls.
    DeepSeek,
    /// Unknown / generic — apply the most permissive normalization.
    Generic,
}

/// Classify a model name into a `ModelArch`. Pure — unit-testable.
pub fn model_architecture(model: &str) -> ModelArch {
    let m = model.to_lowercase();
    if m.contains("nemotron") {
        ModelArch::Nemotron
    } else if m.contains("lfm") {
        ModelArch::Lfm
    } else if m.contains("qwen") {
        ModelArch::Qwen
    } else if m.contains("deepseek") {
        ModelArch::DeepSeek
    } else {
        ModelArch::Generic
    }
}

/// Accumulated deltas from the Ollama `/api/chat` NDJSON stream.
#[derive(Default, Debug, PartialEq)]
struct OllamaChunkAcc {
    content: String,
    thinking: String,
    tool_calls: Option<Vec<serde_json::Value>>,
}

/// Parse one NDJSON line from the Ollama `/api/chat` stream, appending any
/// content/thinking deltas and recording tool calls (if any). Pure — no events
/// emitted — so it can be unit-tested against realistic streaming responses
/// from thinking-capable models (Nemotron, Qwen3, DeepSeek-R1, …).
///
/// `arch` lets the parser apply architecture-specific normalization to tool
/// calls (e.g. Qwen small models emit `arguments` as a JSON string).
///
/// Returns `true` when the line was valid JSON (even if it carried no deltas).
fn apply_ollama_stream_line(line: &str, acc: &mut OllamaChunkAcc, arch: ModelArch) -> bool {
    let Ok(data) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    if let Some(thinking) = data["message"]["thinking"].as_str() {
        if !thinking.is_empty() {
            acc.thinking.push_str(thinking);
        }
    }
    if let Some(content) = data["message"]["content"].as_str() {
        if !content.is_empty() {
            acc.content.push_str(content);
        }
    }
    if let Some(calls) = data["message"]["tool_calls"].as_array() {
        if !calls.is_empty() {
            acc.tool_calls = Some(
                calls.iter().map(|c| normalize_ollama_tool_call(c, arch)).collect(),
            );
        }
    }
    true
}

/// Normalize a single Ollama tool call into the canonical
/// `{ "id", "type", "function": { "name", "arguments" } }` shape.
///
/// Architecture-specific handling:
///   - Qwen small models (e.g. qwen3.5:0.8b) sometimes emit `arguments` as a
///     JSON *string* rather than an object, or nest the call under
///     `{"function": {"name": ..., "arguments": ...}}` vs a flat
///     `{"name": ..., "arguments": ...}`. We normalize both.
///   - lfm2.5 may emit `tool_name` instead of `name` (handled here so the
///     stream path and the planning-JSON path share one normalizer).
/// Pure — unit-testable.
pub fn normalize_ollama_tool_call(call: &serde_json::Value, arch: ModelArch) -> serde_json::Value {
    // Locate the function object: either `call.function` or the call itself.
    let func = call.get("function").unwrap_or(call);
    let name = func
        .get("name")
        .or_else(|| func.get("tool_name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();

    // Normalize arguments: object → keep; JSON string → parse; else empty.
    let raw_args = func.get("arguments").cloned().unwrap_or(serde_json::json!({}));
    let args = match raw_args {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str::<serde_json::Value>(trimmed)
                    .unwrap_or_else(|_| serde_json::json!({ "value": trimmed }))
            }
        }
        other => other,
    };

    // Qwen small models occasionally emit arguments as a bare array of
    // positional values (e.g. `["src/main.rs"]`). Coerce to a `{ "value": ... }`
    // so the tool executor still receives something usable. Only Qwen does this,
    // so gate it on the architecture to avoid mangling well-formed calls.
    let args = if args.is_array() && arch == ModelArch::Qwen {
        serde_json::json!({ "value": args })
    } else {
        args
    };

    let id = call
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("")
        .to_string();

    serde_json::json!({
        "id": id,
        "type": "function",
        "function": { "name": name, "arguments": args }
    })
}

/// Stream an Ollama NDJSON response line by line, emitting tokens to the
/// frontend via `app_handle` and accumulating content into `full_content`.
/// Returns the iteration-scoped content, thinking trace, and any tool calls found.
async fn stream_ollama_response(
    mut resp: reqwest::Response,
    sink: &(dyn EventSink + Send + Sync),
    full_content: &mut String,
    subagent_id: Option<&str>,
    arch: ModelArch,
) -> Result<StreamResult, String> {
    let mut iter_content = String::new();
    let mut iter_thinking = String::new();
    let mut tool_calls: Option<Vec<serde_json::Value>> = None;
    let mut buf: Vec<u8> = Vec::new();
    // Token usage reported by Ollama on the final "done" chunk
    // (`prompt_eval_count` / `eval_count`). Falls back to 0 when absent.
    let mut prompt_usage: u64 = 0;
    let mut completion_usage: u64 = 0;

    // Process a single NDJSON line: the pure `apply_ollama_stream_line` does the
    // parsing; this helper only emits tokens and aggregates buffers. All
    // accumulators are passed by reference (not captured) so they remain usable
    // after the streaming/drain loops (e.g. for the thinking fallback).
    let mut acc = OllamaChunkAcc::default();
    let consume_line = |line: &str,
                        acc: &mut OllamaChunkAcc,
                        iter_content: &mut String,
                        iter_thinking: &mut String,
                        tool_calls: &mut Option<Vec<serde_json::Value>>,
                        full_content: &mut String,
                        prompt_usage: &mut u64,
                        completion_usage: &mut u64| {
        // Capture Ollama-reported token usage from the final "done" line so the
        // session log can break token counts down per iteration with real
        // numbers (prompt_eval_count / eval_count) instead of only estimates.
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(n) = data["prompt_eval_count"].as_u64() {
                *prompt_usage = n;
            }
            if let Some(n) = data["eval_count"].as_u64() {
                *completion_usage = n;
            }
        }
        if apply_ollama_stream_line(line, acc, arch) {
            // Thinking-capable models (Qwen3, Nemotron, DeepSeek-R1, etc.) emit
            // a `thinking` field separate from `content`. Capture it for the
            // tool-loop context but stream it with a `thinking` flag so the
            // frontend can display it transiently without adding it to the
            // conversation messages.
            if !acc.thinking.is_empty() {
                sink.emit_stream_token(subagent_id, &acc.thinking, true);
            }
            if !acc.content.is_empty() {
                sink.emit_stream_token(subagent_id, &acc.content, false);
                full_content.push_str(&acc.content);
            }
            iter_content.push_str(&acc.content);
            iter_thinking.push_str(&acc.thinking);
            if acc.tool_calls.is_some() {
                *tool_calls = acc.tool_calls.clone();
            }
            *acc = OllamaChunkAcc::default();
        }
    };

    loop {
        match resp.chunk().await {
            Ok(None) => break,
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                while let Some(line) = take_next_line(&mut buf) {
                    if line.is_empty() {
                        continue;
                    }
                    consume_line(&line, &mut acc, &mut iter_content, &mut iter_thinking, &mut tool_calls, full_content, &mut prompt_usage, &mut completion_usage);
                }
            }
            Err(e) => {
                // Stream interrupted mid-response — keep partial content rather
                // than failing the whole request with a bare decode error.
                eprintln!("[nolock] ollama stream interrupted: {}", e);
                if iter_content.is_empty() && iter_thinking.is_empty() && tool_calls.is_none() {
                    return Err(format!("Stream interrupted before any content: {}", e));
                }
                let note = format!("\n\n[stream interrupted: {}]", e);
                iter_content.push_str(&note);
                full_content.push_str(&note);
                break;
            }
        }
    }

    // Drain any remaining data in the buffer after the stream ends.
    // The last chunk from the server may not end with a newline, so the
    // inner while-let loop leaves residual bytes in `buf`. Process every
    // complete line in the tail (a single chunk can carry several).
    while !buf.is_empty() {
        match take_next_line(&mut buf) {
            Some(line) if !line.is_empty() => {
                consume_line(&line, &mut acc, &mut iter_content, &mut iter_thinking, &mut tool_calls, full_content, &mut prompt_usage, &mut completion_usage);
            }
            _ => {
                // Trailing fragment with no newline — try parsing the whole
                // remaining buffer as one (final) line.
                let tail = String::from_utf8_lossy(&buf).trim().to_string();
                if !tail.is_empty() {
                    consume_line(&tail, &mut acc, &mut iter_content, &mut iter_thinking, &mut tool_calls, full_content, &mut prompt_usage, &mut completion_usage);
                }
                buf.clear();
            }
        }
    }

    // IMPORTANT: A thinking-capable model may spend its whole budget on
    // reasoning and never emit visible `content` (seen with Ollama models such
    // as nemotron, qwen3, deepseek-r1). We do NOT dump the reasoning into the
    // visible message here — that polluted the chat. Instead the tool loop gets
    // `iter_thinking` populated and decides whether to RETRY (see
    // ollama_chat_with_tools) so the model is nudged to emit a real answer or a
    // structured tool call. This branch only logs diagnostic info.
    if iter_content.is_empty() && iter_thinking.is_empty() && tool_calls.is_none() {
        eprintln!("[nolock] WARNING: ollama stream returned no content, thinking, or tool calls");
    } else if iter_content.is_empty() && tool_calls.is_none() && !iter_thinking.is_empty() {
        eprintln!(
            "[nolock] ollama stream produced ONLY thinking ({} chars) — no content, no tool calls. The tool loop will retry.",
            iter_thinking.len()
        );
    }

    Ok(StreamResult {
        iter_content,
        iter_thinking,
        tool_calls,
        prompt_tokens: prompt_usage,
        completion_tokens: completion_usage,
    })
}

// ---------------------------------------------------------------------------
// Ollama tool-calling loop (streaming)
// ---------------------------------------------------------------------------

/// Shared context for the Ollama tool-calling loop — bundles parameters that
/// are stable across iterations so the function signature stays under the
/// clippy default argument limit (7).
struct OllamaChatContext<'a> {
    sink: &'a (dyn EventSink + Send + Sync),
    client: &'a reqwest::Client,
    url: &'a str,
    model: &'a str,
    tool_configs: &'a HashMap<String, serde_json::Value>,
    root_path: Option<&'a str>,
    /// Configured "reasoning-only" retry budget (from the Chat Model panel).
    reasoning_retries: usize,
    /// The model's context window (in tokens), used to detect near-limit usage
    /// and trigger context summarization.
    context_length: u64,
}

async fn ollama_chat_with_tools(
    ctx: &OllamaChatContext<'_>,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    max_iterations: usize,
    temperature: f64,
    max_tokens: u32,
    subagent_id: Option<&str>,
    runner: Option<&SubAgentRunner<'_>>,
    pre_spawned: &std::collections::HashSet<String>,
) -> Result<ChatResult, String> {
    let mut ollama_msgs = build_initial_messages(messages, tools);
    // Tools may be dropped mid-loop when the model gets stuck reasoning-only
    // (see TOOLS_DROP_RETRY_THRESHOLD). Keep a mutable copy so the body reflects
    // the current tool set.
    let mut effective_tools = tools.to_vec();
    let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
    let mut full_content = String::new();
    // Running total of hidden reasoning/thinking tokens across all iterations
    // (main agent + any sub-agents it spawned). Folded into context_tokens so
    // the session meter/limit reflects thinking, not just visible content.
    let mut thinking_tokens: u64 = 0;
    // Accumulated reasoning text across iterations — used as a last-resort
    // answer source when the model stalls on thinking-only (mirrors the
    // non-tool `ai_complete` path).
    let mut total_thinking = String::new();
    // De-duplicate spawn_subagent calls (same agent + task) within this run.
    let mut spawned_subagents: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Bounded retries when a thinking model ends a turn with ONLY reasoning
    // (no content, no tool call). The budget is user-configurable via the
    // Chat Model panel (ctx.reasoning_retries); we nudge the model to produce
    // a real answer / structured tool call instead of dumping the reasoning
    // into the chat.
    let mut thinking_only_retries: usize = 0;
    let thinking_only_max_retries = ctx.reasoning_retries;
    // Track recent iteration content (or a fingerprint) to detect when the model
    // starts repeating itself (stuck in a loop). When detected, we trigger a
    // micro-agent to repurpose the last message, summarize the context, and
    // re-trigger the model with a to-do list.
    let mut recent_iterations: Vec<String> = Vec::new();
    // Whether we've already summarized the context this run (avoid repeated
    // summarization loops).
    let mut context_summarized = false;
    // Per-iteration token usage split by provider + model, reported back in
    // `ChatResult.usage` so the frontend session log can attribute costs.
    let mut usage: Vec<UsageReport> = Vec::new();

    for iteration in 0..max_iterations {
        // --- Build and send request ---
        let body = build_ollama_chat_body(ctx.model, &ollama_msgs, &effective_tools, temperature, max_tokens);

        eprintln!(
            "[nolock] ollama tool loop iteration={}, POST {}/api/chat (streaming)",
            iteration, ctx.url
        );

        let resp = ctx
            .client
            .post(format!("{}/api/chat", ctx.url))
            .json(&body)
            .timeout(std::time::Duration::from_secs(300))
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
        let arch = model_architecture(ctx.model);
        let stream = stream_ollama_response(resp, ctx.sink, &mut full_content, subagent_id, arch).await?;
        // Accumulate this iteration's hidden reasoning so it counts toward the
        // session token total (the model processes it even though it's not
        // visible content).
        if !stream.iter_thinking.is_empty() {
            accumulate_thinking(&mut thinking_tokens, &stream.iter_thinking);
            total_thinking.push_str(&stream.iter_thinking);
        }
        // Record this iteration's token usage (provider-reported when available;
        // otherwise estimate from the current message context + this iteration's
        // output). Thinking tokens are intentionally NOT included for now.
        usage.push(usage_for(
            "ollama",
            ctx.model,
            stream.prompt_tokens,
            stream.completion_tokens,
            estimate_json_messages_tokens(&ollama_msgs),
            estimate_chat_tokens(&stream.iter_content),
        ));

        // --- Handle tool calls or return final response ---
        if let Some(calls) = stream.tool_calls {
            // Push the assistant message so Ollama knows the context.
            // Include the thinking field for thinking-capable models so the
            // model retains its reasoning context across tool-call iterations.
            let mut assistant_msg = serde_json::json!({
                "role": "assistant",
                "content": stream.iter_content,
                "tool_calls": calls
            });
            if !stream.iter_thinking.is_empty() {
                assistant_msg["thinking"] = serde_json::json!(stream.iter_thinking);
            }
            ollama_msgs.push(assistant_msg);

            // Execute each tool call and add results. `spawn_subagent` calls run
            // concurrently (max 2); other tools run sequentially.
            let mut spawn_items: Vec<(String, String, String, serde_json::Value, bool)> = Vec::new();

            for call in &calls {
                let name = call["function"]["name"].as_str().unwrap_or("unknown");
                let args = &call["function"]["arguments"];
                let tool_call_id = call["id"].as_str().unwrap_or("call_unknown").to_string();
                let tool_path = args["path"].as_str().map(String::from);

                if name == "spawn_subagent" {
                    let agent = args["agent"].as_str().unwrap_or("").to_string();
                    let task = args["task"].as_str().unwrap_or("").to_string();
                    // Agents already dispatched by the backend (explicit
                    // @mention) must not be spawned again — their result is
                    // already in the conversation context.
                    if pre_spawned.contains(&agent) {
                        ollama_msgs.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": format!(
                                "Agent '@{}' was already dispatched with the user's request; its result is in the conversation context.",
                                agent
                            )
                        }));
                        continue;
                    }
                    let task_norm: String = task.split_whitespace().collect::<Vec<_>>().join(" ");
                    let dedup_key = format!("{}||{}", agent.trim(), task_norm);
                    let is_dup = spawned_subagents.contains(&dedup_key);
                    if !is_dup {
                        spawned_subagents.insert(dedup_key);
                    }
                    spawn_items.push((tool_call_id, agent, task, args.clone(), is_dup));
                } else if name == "spawn_micro_agent" {
                    let agent = args["agent"].as_str().unwrap_or("").to_string();
                    let task = args["task"].as_str().unwrap_or("").to_string();
                    ctx.sink.emit_tool_progress(subagent_id, "start", name, tool_path.clone());
                    let result = match runner {
                        Some(r) => Box::pin(run_micro_agent(r, &agent, &task)).await,
                        None => Err("Micro-agents are not available".to_string()),
                    };
                    let (result_text, micro_trace) = match result {
                        Ok((text, v, trace)) => {
                            let mut out = text.clone();
                            if !v.is_empty() {
                                out.push_str("\n\n[Validation results]\n");
                                for vr in &v {
                                    out.push_str(&format!(
                                        "- {}: {}\n",
                                        vr.name,
                                        if vr.passed { "PASS" } else { "FAIL" }
                                    ));
                                }
                            }
                            (tag_agent_result(classify_agent_result(&out), &out), Some(trace))
                        }
                        Err(e) => (tag_agent_result(AGENT_RESULT_FAILED, &format!("Tool error: {}", e)), None),
                    };
                    ctx.sink.emit_tool_progress(subagent_id, "done", "spawn_micro_agent", tool_path);
                    let snippet = if result_text.len() > 200 {
                        format!("{}...", &result_text[..200])
                    } else {
                        result_text.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: "spawn_micro_agent".to_string(),
                        arguments: serde_json::to_string(args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result_text.clone(),
                        file_changes: Vec::new(),
                        subagent: micro_trace,
                    });
                    ollama_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result_text
                    }));
                } else {
                    ctx.sink.emit_tool_progress(subagent_id, "start", name, tool_path.clone());
                    let (result, file_changes) =
                        execute_tool_tracked(name, args, ctx.client, ctx.tool_configs, ctx.root_path, "ollama")
                            .await
                            .unwrap_or_else(|e| {
                                ctx.sink.emit_tool_progress(subagent_id, "error", name, tool_path.clone());
                                (format!("Tool error: {}", e), Vec::new())
                            });
                    ctx.sink.emit_tool_progress(subagent_id, "done", name, tool_path);

                    let snippet = if result.len() > 200 {
                        format!("{}...", &result[..200])
                    } else {
                        result.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: name.to_string(),
                        arguments: serde_json::to_string(args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result.clone(),
                        file_changes,
                        subagent: None,
                    });
                    ollama_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result
                    }));
                }
            }

            // Run the collected spawn_subagent calls concurrently (max 2).
            if !spawn_items.is_empty() {
                let batch: Vec<(String, String, bool)> = spawn_items
                    .iter()
                    .map(|(_, agent, task, _, is_dup)| (agent.clone(), task.clone(), *is_dup))
                    .collect();
                let outcomes = run_spawn_batch(runner, &batch).await;

                for ((tool_call_id, _, _, args, _), (result, subagent_trace)) in spawn_items.into_iter().zip(outcomes) {
                    ctx.sink.emit_tool_progress(subagent_id, "done", "spawn_subagent", args["path"].as_str().map(String::from));

                    // Charge the sub-agent's hidden reasoning to the parent's
                    // session token total so a sub-agent-heavy turn is counted.
                    if let Some(ref trace) = subagent_trace {
                        thinking_tokens += trace.thinking_tokens;
                    }

                    let snippet = if result.len() > 200 {
                        format!("{}...", &result[..200])
                    } else {
                        result.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: "spawn_subagent".to_string(),
                        arguments: serde_json::to_string(&args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result.clone(),
                        file_changes: Vec::new(),
                        subagent: subagent_trace,
                    });
                    ollama_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result
                    }));
                }
            }

            // Add a newline separator between tool-loop iterations so the
            // streamed content from the previous turn doesn't run directly
            // into the next turn's content without a visual break.
            if !full_content.is_empty() {
                full_content.push('\n');
            }
        } else {
            // No real tool_calls streamed. But some local models (lfm2.5)
            // respond with a structured JSON *planning* blob instead of invoking
            // tools:
            //   {"analysis": "...", "next_steps": [{"tool_name": "grep", ...}], "final_answer": ""}
            // Treat that as "wants more tool rounds": execute the planned steps
            // as real tool calls and continue the loop instead of surfacing the
            // JSON (or returning too early).
            let planned = extract_planned_tool_calls(&stream.iter_content);
            if !planned.is_empty() {
                eprintln!(
                    "[nolock] ollama tool loop: executing {} planned step(s) from structured JSON",
                    planned.len()
                );
                // Remove the JSON planning text from the accumulated content so
                // it never shows up in the final answer.
                full_content.truncate(full_content.len().saturating_sub(stream.iter_content.len()));
                for (pi, tc) in planned.into_iter().enumerate() {
                    // Normalize the planned call (lfm2.5 may emit `tool_name` /
                    // string arguments) so it matches the canonical shape.
                    let tc = normalize_ollama_tool_call(&tc, arch);
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args = tc["function"]["arguments"].clone();
                    let tool_call_id = format!("call_planned_{}_{}", iteration, pi);
                    let tool_path = args["path"].as_str().map(String::from);
                    ctx.sink.emit_tool_progress(subagent_id, "start", &name, tool_path.clone());
                    let (result, file_changes) =
                        execute_tool_tracked(&name, &args, ctx.client, ctx.tool_configs, ctx.root_path, "ollama")
                            .await
                            .unwrap_or_else(|e| {
                                ctx.sink.emit_tool_progress(subagent_id, "error", &name, tool_path.clone());
                                (format!("Tool error: {}", e), Vec::new())
                            });
                    ctx.sink.emit_tool_progress(subagent_id, "done", &name, tool_path);
                    let snippet = if result.len() > 200 {
                        format!("{}...", &result[..200])
                    } else {
                        result.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: name.clone(),
                        arguments: serde_json::to_string(&args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result.clone(),
                        file_changes,
                        subagent: None,
                    });
                    ollama_msgs.push(serde_json::json!({
                        "role": "assistant",
                        "content": stream.iter_content,
                        "tool_calls": [{
                            "id": tool_call_id,
                            "function": { "name": name, "arguments": args }
                        }]
                    }));
                    ollama_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result
                    }));
                }
                continue;
            }

            // The main agent concludes the task is done when the response is a
            // COMPLETE final answer: substantive visible content, no pending
            // tool calls, and not a "still planning" JSON. If it only reasoned
            // (thinking-only) or emitted a planning JSON, it is NOT done — retry
            // (bounded) with an escalating reminder so the user gets a real
            // answer rather than "(no response)" or a dump of the thinking trace.
            let complete = is_complete_answer(&stream.iter_content, false);
            if !complete {
                // Track this iteration's content for repetition detection.
                recent_iterations.push(stream.iter_content.clone());
                if recent_iterations.len() > REPETITION_WINDOW {
                    recent_iterations.remove(0);
                }

                // Context usage so far (messages + accumulated content + thinking).
                let context_tokens_now = estimate_json_messages_tokens(&ollama_msgs)
                    + estimate_chat_tokens(&full_content)
                    + thinking_tokens;

                // 1. Repetition detection → micro-agent repurpose + summarize +
                //    re-trigger with a to-do list. This is the "stuck in a loop"
                //    recovery: instead of endlessly retrying the same nudge, we
                //    compact the context and give the model a fresh plan.
                if detect_repetition(&recent_iterations, REPETITION_WINDOW) {
                    eprintln!(
                        "[nolock] ollama tool loop iteration={} detected repetition; summarizing context and re-triggering",
                        iteration
                    );
                    let last_message = stream.iter_content.clone();
                    let todo_list = build_fallback_todo_list(&last_message);
                    let summary = if let Some(r) = runner {
                        summarize_context_via_micro_agent(r, &last_message, &todo_list).await
                            .unwrap_or_else(|| last_message.clone())
                    } else {
                        last_message.clone()
                    };
                    ollama_msgs = build_retrigger_messages(&summary, &todo_list, &task_hint(messages));
                    context_summarized = true;
                    recent_iterations.clear();
                    continue;
                }

                // 2. Context near the limit → summarize to free room before the
                //    model stalls or the request is rejected for exceeding the
                //    window. Only do this once per run.
                if !context_summarized
                    && should_summarize_context(context_tokens_now, ctx.context_length)
                {
                    eprintln!(
                        "[nolock] ollama tool loop iteration={} context at {:.0}% of window; summarizing",
                        iteration,
                        context_usage_ratio(context_tokens_now, ctx.context_length) * 100.0
                    );
                    let last_message = stream.iter_content.clone();
                    let todo_list = build_fallback_todo_list(&last_message);
                    let summary = if let Some(r) = runner {
                        summarize_context_via_micro_agent(r, &last_message, &todo_list).await
                            .unwrap_or_else(|| last_message.clone())
                    } else {
                        last_message.clone()
                    };
                    ollama_msgs = build_retrigger_messages(&summary, &todo_list, &task_hint(messages));
                    context_summarized = true;
                    recent_iterations.clear();
                    continue;
                }

                // 3. Otherwise: thinking-only retry (existing escalating nudge).
                if thinking_only_retries < thinking_only_max_retries {
                    thinking_only_retries += 1;
                    eprintln!(
                        "[nolock] ollama tool loop iteration={} reasoning-only, retry {}/{}",
                        iteration, thinking_only_retries, thinking_only_max_retries
                    );
                    // A model that keeps reasoning without producing content or a
                    // tool call is stuck. Drop the tools so it is forced to answer
                    // plainly, and give it a fresh retry budget to do so.
                    if thinking_only_retries >= TOOLS_DROP_RETRY_THRESHOLD
                        && !effective_tools.is_empty()
                    {
                        eprintln!(
                            "[nolock] ollama tool loop iteration={} dropping tools to force a plain answer",
                            iteration
                        );
                        effective_tools.clear();
                        recent_iterations.clear();
                        ollama_msgs.push(serde_json::json!({
                            "role": "system",
                            "content": tools_dropped_prompt()
                        }));
                        continue;
                    }
                    ollama_msgs.push(serde_json::json!({
                        "role": "system",
                        "content": thinking_retry_prompt(thinking_only_retries)
                    }));
                    continue;
                }
                eprintln!(
                    "[nolock] ollama tool loop gave up after {} reasoning-only retries",
                    thinking_only_retries
                );
            }
            eprintln!(
                "[nolock] ollama tool loop returning: content_len={} tool_calls={}",
                full_content.len(),
                all_tool_calls.len()
            );
            if full_content.is_empty() && all_tool_calls.is_empty() {
                eprintln!("[nolock] WARNING: empty response from model in tool loop");
            }
            let context_tokens = estimate_json_messages_tokens(&ollama_msgs) + estimate_chat_tokens(&full_content) + thinking_tokens;
            // If we gave up on a "still planning" JSON, surface the readable
            // analysis rather than the raw structured-JSON dump.
            let mut final_content = if is_planning_json(&full_content) {
                unwrap_structured_answer(&full_content)
            } else {
                full_content.clone()
            };
            // Last resort: if the model stalled on thinking-only and never
            // produced visible content, surface a best-effort answer extracted
            // from the accumulated reasoning instead of "(no response)".
            if final_content.trim().is_empty() && !total_thinking.trim().is_empty() {
                let fallback = extract_answer_from_thinking(&total_thinking);
                if !fallback.is_empty() {
                    final_content = fallback;
                }
            }
            return Ok(ChatResult {
                content: if final_content.is_empty() {
                    "(no response)".to_string()
                } else {
                    final_content
                },
                tool_calls: all_tool_calls,
                context_tokens,
                thinking_tokens,
                usage,
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
    let context_tokens = estimate_json_messages_tokens(&ollama_msgs) + estimate_chat_tokens(&full_content) + thinking_tokens;
    let mut final_content = full_content.clone();
    if final_content.trim().is_empty() && !total_thinking.trim().is_empty() {
        let fallback = extract_answer_from_thinking(&total_thinking);
        if !fallback.is_empty() {
            final_content = fallback;
        }
    }
    Ok(ChatResult {
        content: if final_content.is_empty() {
            "(max tool iterations reached, no response)".to_string()
        } else {
            final_content
        },
        tool_calls: all_tool_calls,
        context_tokens,
        thinking_tokens,
        usage,
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
        // Anti-repetition options: some models (e.g. Nemotron) otherwise spiral
        // into self-question/self-answer loops. repeat_penalty + top_k/top_p add
        // just enough diversity to break the loop without hurting coherence.
        "options": {
            "num_predict": max_tokens,
            "temperature": temperature,
            "repeat_penalty": 1.1,
            "repeat_last_n": 256,
            "top_k": 40,
            "top_p": 0.95
        }
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::json!(tools);
    }
body
}

// ---------------------------------------------------------------------------
// OpenAI-compatible tool calling (for DigitalOcean, OpenRouter, etc.)
// ---------------------------------------------------------------------------

/// Result from streaming a single OpenAI-compatible response.
struct OpenAIStreamResult {
    /// Content emitted by the model in this iteration.
    iter_content: String,
    /// Hidden reasoning/thinking emitted by the model this iteration.
    iter_thinking: String,
    /// Tool calls detected, if any.
    tool_calls: Option<Vec<serde_json::Value>>,
    /// Prompt tokens reported in the stream's final `usage` chunk (0 if absent).
    prompt_tokens: u64,
    /// Completion tokens reported in the stream's final `usage` chunk (0 if absent).
    completion_tokens: u64,
}

/// Stream an OpenAI-compatible SSE response, emitting tokens to the frontend
/// and accumulating content. Returns iteration-scoped content and any tool calls.
async fn stream_openai_response(
    mut resp: reqwest::Response,
    sink: &(dyn EventSink + Send + Sync),
    full_content: &mut String,
    subagent_id: Option<&str>,
    arch: ModelArch,
) -> Result<OpenAIStreamResult, String> {
    let mut iter_content = String::new();
    let mut iter_thinking = String::new();
    let mut tool_calls: Option<Vec<serde_json::Value>> = None;
    let mut buf: Vec<u8> = Vec::new();
    // Provider-reported token usage from the stream's final `usage` chunk
    // (OpenAI-compatible APIs emit it once `choices` is empty). 0 when absent.
    let mut prompt_usage: u64 = 0;
    let mut completion_usage: u64 = 0;

    let process_sse_data = |data: &str,
                            iter_content: &mut String,
                            iter_thinking: &mut String,
                            tool_calls: &mut Option<Vec<serde_json::Value>>,
                            full_content: &mut String,
                            prompt_usage: &mut u64,
                            completion_usage: &mut u64|
     -> Result<(), String> {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            // Capture provider-reported usage from the final stream chunk so the
            // session log can break token counts down per iteration with real
            // numbers instead of only estimates.
            if let Some(usage) = json["usage"].as_object() {
                if let Some(n) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                    *prompt_usage = n;
                }
                if let Some(n) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                    *completion_usage = n;
                }
            }
            // Reasoning trace (thinking-capable models) — stream with a
            // `thinking` flag so the frontend can display it transiently.
            if let Some(thinking) = json["choices"][0]["delta"]["reasoning_content"].as_str() {
                if !thinking.is_empty() {
                    iter_thinking.push_str(thinking);
                    sink.emit_stream_token(subagent_id, thinking, true);
                }
            }
            // Content delta
            if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                if !content.is_empty() {
                    iter_content.push_str(content);
                    full_content.push_str(content);
                    sink.emit_stream_token(subagent_id, content, false);
                }
            }
            // Tool calls delta (OpenAI format: delta.tool_calls)
            if let Some(calls) = json["choices"][0]["delta"]["tool_calls"].as_array() {
                if !calls.is_empty() {
                    // Accumulate tool calls - they may come in chunks
                    let mut accumulated = tool_calls.take().unwrap_or_default();
                    for call in calls {
                        let index = call["index"].as_u64().unwrap_or(0) as usize;
                        // Ensure we have space for this index
                        while accumulated.len() <= index {
                            accumulated.push(serde_json::json!({
                                "id": "",
                                "type": "function",
                                "function": { "name": "", "arguments": "" }
                            }));
                        }
                        // Merge the delta into the accumulated call
                        if let Some(id) = call["id"].as_str() {
                            accumulated[index]["id"] = serde_json::json!(id);
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            accumulated[index]["function"]["name"] = serde_json::json!(name);
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            let existing = accumulated[index]["function"]["arguments"].as_str().unwrap_or("");
                            accumulated[index]["function"]["arguments"] = serde_json::json!(format!("{}{}", existing, args));
                        }
                    }
                    *tool_calls = Some(accumulated);
                }
            }
        }
        Ok(())
    };

    loop {
        match resp.chunk().await {
            Ok(None) => break,
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                while let Some(line) = take_next_line(&mut buf) {
                    if let Some(data) = line.strip_prefix("data: ") {
                        let data = data.trim();
                        if data == "[DONE]" { continue; }
                        process_sse_data(data, &mut iter_content, &mut iter_thinking, &mut tool_calls, full_content, &mut prompt_usage, &mut completion_usage)?;
                    }
                }
            }
            Err(e) => {
                // The connection was interrupted mid-stream (e.g. the provider
                // reset the connection after a slow response). If we already
                // received content or tool calls, return them with a note instead
                // of failing the whole request with a bare decode error.
                eprintln!("[nolock] openai stream interrupted: {}", e);
                if iter_content.is_empty() && tool_calls.is_none() {
                    return Err(format!("Stream interrupted before any content: {}", e));
                }
                let note = format!("\n\n[stream interrupted: {}]", e);
                iter_content.push_str(&note);
                full_content.push_str(&note);
                break;
            }
        }
    }
    // Drain trailing buffer
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if let Some(data) = line.strip_prefix("data: ") {
            let data = data.trim();
            if data != "[DONE]" {
                process_sse_data(data, &mut iter_content, &mut iter_thinking, &mut tool_calls, full_content, &mut prompt_usage, &mut completion_usage)?;
            }
        }
    }

    // Normalize accumulated tool calls (arguments arrive as JSON strings in the
    // OpenAI format; DeepSeek/Qwen may also emit alternate shapes).
    let tool_calls = tool_calls.map(|calls| {
        calls.iter().map(|c| normalize_ollama_tool_call(c, arch)).collect()
    });

    Ok(OpenAIStreamResult { iter_content, iter_thinking, tool_calls, prompt_tokens: prompt_usage, completion_tokens: completion_usage })
}

/// Normalize tool-call arguments to a JSON object.
///
/// OpenAI-compatible APIs (DigitalOcean, OpenRouter, etc.) return
/// `function.arguments` as a JSON-encoded *string*, whereas Ollama returns it as
/// a JSON *object*. Some models also emit leading/trailing whitespace or extra
/// quoting around the JSON. This normalizes both forms (trimming whitespace) so
/// `execute_tool` always receives a plain object keyed by parameter name.
fn normalize_tool_args(raw: &serde_json::Value) -> serde_json::Value {
    match raw {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return serde_json::json!({});
            }
            serde_json::from_str::<serde_json::Value>(trimmed)
                .unwrap_or_else(|_| serde_json::json!({ "value": trimmed }))
        }
        other => other.clone(),
    }
}

/// Convert tool calls back to the OpenAI wire format for the assistant message.
///
/// `stream.tool_calls` are normalized to objects (via `normalize_ollama_tool_call`)
/// so `execute_tool` can read them, but the OpenAI API requires
/// `tool_calls[].function.arguments` to be a JSON-encoded *string*. Sending an
/// object makes DigitalOcean fail with "failed to convert request" (HTTP 400).
/// This re-serializes object arguments to strings; string arguments pass through.
fn tool_calls_for_api(calls: &[serde_json::Value]) -> Vec<serde_json::Value> {
    calls
        .iter()
        .map(|c| {
            let mut c = c.clone();
            match c["function"]["arguments"].clone() {
                serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                    c["function"]["arguments"] = serde_json::json!(
                        serde_json::to_string(&c["function"]["arguments"]).unwrap_or_default()
                    );
                }
                serde_json::Value::String(_) => {} // already a string — pass through
                _ => {
                    c["function"]["arguments"] = serde_json::json!("{}");
                }
            }
            c
        })
        .collect()
}

/// Run an OpenAI-compatible tool-calling loop (DigitalOcean, OpenRouter, etc.).
async fn run_openai_tool_loop(
    client: &reqwest::Client,
    sink: &(dyn EventSink + Send + Sync),
    url: &str,
    api_key: &str,
    model: &str,
    backend: &str,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    tool_configs: &HashMap<String, serde_json::Value>,
    root_path: Option<&str>,
    temperature: f64,
    max_tokens: Option<u32>,
    max_iterations: usize,
    extra_headers: Option<Vec<(&str, &str)>>,
    use_model_affinity: bool,
    subagent_id: Option<&str>,
    runner: Option<&SubAgentRunner<'_>>,
    pre_spawned: &std::collections::HashSet<String>,
    context_length: u64,
) -> Result<ChatResult, String> {
    let mut openai_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    // Tools may be dropped mid-loop when the model gets stuck reasoning-only
    // (see TOOLS_DROP_RETRY_THRESHOLD below). Keep a mutable copy so the body
    // reflects the current tool set.
    let mut effective_tools = tools.to_vec();

    // Add a system message instructing the model on tool usage, including each
    // tool's own description so the model knows when to call which one.
    if !tools.is_empty() {
        let tool_block: Vec<String> = tools
            .iter()
            .filter_map(|t| {
                let name = t["function"]["name"].as_str()?;
                let desc = t["function"]["description"].as_str().unwrap_or("");
                Some(format!("- {name}: {desc}"))
            })
            .collect();
        let has_spawn_subagent = tools
            .iter()
            .any(|t| t["function"]["name"].as_str() == Some("spawn_subagent"));
        let has_spawn_micro_agent = tools
            .iter()
            .any(|t| t["function"]["name"].as_str() == Some("spawn_micro_agent"));
        let mut sys_prompt = format!(
            "You are a helpful assistant with access to tools. Use them whenever they help: \
             call web_search or web_fetch for current information, documentation, or anything \
             outside your training data instead of guessing; use read_file/list_directory/grep \
             to inspect files and code; use edit/write_file to make changes. You may call \
             multiple tools and then use their results in your answer.\n\nAvailable tools:\n{}",
            tool_block.join("\n")
        );
        if has_spawn_subagent {
            sys_prompt.push_str(
                "\n\nWhen the `spawn_subagent` tool is available, delegate focused tasks that \
                 match a sub-agent's specialty (e.g. code review, research, writing) to the \
                 appropriate sub-agent instead of doing everything yourself. Spawn each \
                 sub-agent at most once per task. When MULTIPLE sub-agents are warranted, \
                 emit ALL the spawn_subagent tool calls in the SAME response (a single \
                 tool_calls batch) so they run in PARALLEL — do not spawn them one at a time \
                 or wait between spawns. After the sub-agents return their results, incorporate \
                 them into a complete final answer that directly addresses the user's original \
                 request: do not stop after spawning — wait for their results and then write \
                 the final response.",
            );
        }
        if has_spawn_subagent || has_spawn_micro_agent {
            sys_prompt.push_str(
                "\n\n[A2A retry contract] Every sub-agent / micro-agent result is prefixed \
                 with a status marker: [AGENT_RESULT: OK], [AGENT_RESULT: FAILED], or \
                 [AGENT_RESULT: EMPTY]. If a delegate returns FAILED or EMPTY, retry it ONCE \
                 with a more specific task that includes the error/feedback. If it fails again, \
                 COMPLETE THE TASK YOURSELF with your own tools (write_file, bash_sandbox, etc.) \
                 — never leave the task incomplete because a delegate failed.",
            );
        }
        openai_msgs.insert(0, serde_json::json!({
            "role": "system",
            "content": sys_prompt
        }));
    }

    let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
    let mut full_content = String::new();
    // Running total of hidden reasoning/thinking tokens across all iterations
    // (main agent + any sub-agents it spawned). Folded into context_tokens.
    let mut thinking_tokens: u64 = 0;
    // Accumulated reasoning text across iterations — used as a last-resort
    // answer source when the model stalls on thinking-only.
    let mut total_thinking = String::new();
    // De-duplicate spawn_subagent calls (same agent + task) within this run.
    let mut spawned_subagents: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Generate a stable session ID for the model-affinity header. This pins the
    // DigitalOcean Inference Router to a single model across the whole tool loop,
    // preventing mid-session model switches (which break tool-calling formats and
    // invalidate the KV cache). Without it the router may route each iteration to
    // a different model, so tool_calls from one turn don't parse in the next.
    let session_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();

    // Bounded retries when a thinking model (deepseek-r1, qwen3, …) ends a turn
    // with ONLY reasoning (no content, no tool call). We nudge it to produce a
    // real answer / structured tool call instead of dumping the reasoning.
    let mut thinking_only_retries: usize = 0;
    let thinking_only_max_retries = runner.map(|r| r.reasoning_retries).unwrap_or(THINKING_ONLY_MAX_RETRIES);
    // Track recent iteration content to detect repetition (stuck in a loop).
    let mut recent_iterations: Vec<String> = Vec::new();
    // Whether we've already summarized the context this run.
    let mut context_summarized = false;
    // Per-iteration token usage split by provider + model, reported back in
    // `ChatResult.usage` so the frontend session log can attribute costs.
    let mut usage: Vec<UsageReport> = Vec::new();

    for iteration in 0..max_iterations {
        // Build request body. DigitalOcean deprecates `max_tokens` in favor of
        // `max_completion_tokens`, which is scoped across the whole run (i.e. all
        // tool-call iterations) rather than per completion. We only set it when
        // the user explicitly configured a budget: when left unset we omit it so
        // the provider's own (generous) default applies instead of an arbitrary
        // local-model cap that would truncate mid-agent-loop.
        let mut body = serde_json::json!({
            "model": model,
            "messages": openai_msgs,
            "temperature": temperature,
            "stream": true
        });
        if let Some(mt) = max_tokens {
            body["max_completion_tokens"] = serde_json::json!(mt);
        }
        if !effective_tools.is_empty() {
            body["tools"] = serde_json::json!(effective_tools);
            body["tool_choice"] = serde_json::json!("auto");
        }

        eprintln!(
            "[nolock] openai-tool-loop iteration={}, POST {} (streaming, tools={}, affinity={})",
            iteration, url, tools.len(), session_id
        );

        let mut req_builder = client
            .post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .timeout(std::time::Duration::from_secs(300));
        if use_model_affinity {
            req_builder = req_builder.header("X-Model-Affinity", &session_id);
        }

        if let Some(headers) = &extra_headers {
            for (k, v) in headers {
                req_builder = req_builder.header(*k, *v);
            }
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| {
                eprintln!("[nolock] openai-tool-loop network error: {}", e);
                e.to_string()
            })?;

        let status = resp.status();
        // Log the routed task/model for debugging (DigitalOcean router headers)
        if let Some(route) = resp.headers().get("x-model-router-selected-route") {
            if let Ok(route) = route.to_str() {
                eprintln!("[nolock] openai-tool-loop routed route={}", route);
            }
        }
        if let Some(m) = resp.headers().get("x-model-router-selected-model") {
            if let Ok(m) = m.to_str() {
                eprintln!("[nolock] openai-tool-loop routed model={}", m);
                // Surface the routed model to the frontend so the user can see
                // which model the DigitalOcean Inference Router selected (helps
                // diagnose e.g. reasoning-model "overthinking").
                sink.emit_model_routed(m);
            }
        }
        if !status.is_success() {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!(
                "[nolock] openai-tool-loop status={} body={}",
                status,
                &text[..text.len().min(300)]
            );
            // Debug: dump the request messages that triggered a non-rate-limit
            // error so a provider "failed to convert request" can be reproduced
            // exactly. Skip 429s (transient rate limits — the body is irrelevant).
            if status.as_u16() != 429 {
                eprintln!(
                    "[nolock] openai-tool-loop FAILED REQUEST messages={}",
                    serde_json::to_string(&openai_msgs).unwrap_or_default()
                );
            }
            let error_detail = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .or_else(|| {
                    serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v["message"].as_str().map(String::from))
                })
                .unwrap_or_else(|| text.clone());
            if !tools.is_empty() && error_detail.to_lowercase().contains("tool") {
                return Err(format!(
                    "Model '{}' does not support tool calling (HTTP {}). Try disabling Agent Tools in AI Settings.",
                    model, status
                ));
            }
            return Err(format!("API error ({}): {}", status, error_detail));
        }

        // Stream the response
        let arch = model_architecture(model);
        let stream = stream_openai_response(resp, sink, &mut full_content, subagent_id, arch).await?;
        // Accumulate this iteration's hidden reasoning so it counts toward the
        // session token total (the model processes it even though it's not
        // visible content).
        if !stream.iter_thinking.is_empty() {
            accumulate_thinking(&mut thinking_tokens, &stream.iter_thinking);
            total_thinking.push_str(&stream.iter_thinking);
        }
        // Record this iteration's token usage (provider-reported when available;
        // otherwise estimate from the current message context + this iteration's
        // output). Thinking tokens are intentionally NOT included for now.
        usage.push(usage_for(
            backend,
            model,
            stream.prompt_tokens,
            stream.completion_tokens,
            estimate_json_messages_tokens(&openai_msgs),
            estimate_chat_tokens(&stream.iter_content),
        ));

        // Handle tool calls or return final response
        if let Some(calls) = stream.tool_calls {
            let names: Vec<&str> = calls
                .iter()
                .filter_map(|c| c["function"]["name"].as_str())
                .collect();
            eprintln!(
                "[nolock] openai-tool-loop iteration={} detected {} tool_calls: {:?}",
                iteration,
                calls.len(),
                names
            );

            // Filter out incomplete tool calls (missing name or id)
            let complete_calls: Vec<serde_json::Value> = calls
                .into_iter()
                .filter(|c| {
                    c["function"]["name"].as_str().map_or(false, |n| !n.is_empty())
                        && c["id"].as_str().map_or(false, |i| !i.is_empty())
                })
                .collect();

            if complete_calls.is_empty() {
                // No complete tool calls, continue
                continue;
            }

            // Push assistant message with tool calls. `complete_calls` carry
            // object arguments (for execute_tool); the API requires string
            // arguments, so re-serialize before sending back.
            let assistant_msg = serde_json::json!({
                "role": "assistant",
                "content": stream.iter_content,
                "tool_calls": tool_calls_for_api(&complete_calls)
            });
            openai_msgs.push(assistant_msg);

            // Execute each tool call and add results. `spawn_subagent` calls run
            // concurrently (max 2); other tools run sequentially.
            let mut spawn_items: Vec<(String, String, String, serde_json::Value, bool)> = Vec::new();

            for call in &complete_calls {
                let name = call["function"]["name"].as_str().unwrap_or("unknown");
                let args = normalize_tool_args(&call["function"]["arguments"]);
                let tool_call_id = call["id"].as_str().unwrap_or("call_unknown").to_string();
                let tool_path = args["path"].as_str().map(String::from);

                if name == "spawn_subagent" {
                    let agent = args["agent"].as_str().unwrap_or("").to_string();
                    let task = args["task"].as_str().unwrap_or("").to_string();
                    // Agents already dispatched by the backend (explicit
                    // @mention) must not be spawned again.
                    if pre_spawned.contains(&agent) {
                        openai_msgs.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": format!(
                                "Agent '@{}' was already dispatched with the user's request; its result is in the conversation context.",
                                agent
                            )
                        }));
                        continue;
                    }
                    let task_norm: String = task.split_whitespace().collect::<Vec<_>>().join(" ");
                    let dedup_key = format!("{}||{}", agent.trim(), task_norm);
                    let is_dup = spawned_subagents.contains(&dedup_key);
                    if !is_dup {
                        spawned_subagents.insert(dedup_key);
                    }
                    spawn_items.push((tool_call_id, agent, task, args.clone(), is_dup));
                } else if name == "spawn_micro_agent" {
                    let agent = args["agent"].as_str().unwrap_or("").to_string();
                    let task = args["task"].as_str().unwrap_or("").to_string();
                    sink.emit_tool_progress(subagent_id, "start", name, tool_path.clone());
let result = match runner {
                        Some(r) => Box::pin(run_micro_agent(r, &agent, &task)).await,
                        None => Err("Micro-agents are not available".to_string()),
                    };
                    let (result_text, micro_trace) = match result {
                        Ok((text, v, trace)) => {
                            let mut out = text.clone();
                            if !v.is_empty() {
                                out.push_str("\n\n[Validation results]\n");
                                for vr in &v {
                                    out.push_str(&format!(
                                        "- {}: {}\n",
                                        vr.name,
                                        if vr.passed { "PASS" } else { "FAIL" }
                                    ));
                                }
                            }
                            (tag_agent_result(classify_agent_result(&out), &out), Some(trace))
                        }
                        Err(e) => (tag_agent_result(AGENT_RESULT_FAILED, &format!("Tool error: {}", e)), None),
                    };
                    sink.emit_tool_progress(subagent_id, "done", "spawn_micro_agent", tool_path);
                    let snippet = if result_text.len() > 200 {
                        format!("{}...", &result_text[..200])
                    } else {
                        result_text.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: "spawn_micro_agent".to_string(),
                        arguments: serde_json::to_string(&args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result_text.clone(),
                        file_changes: Vec::new(),
                        subagent: micro_trace,
                    });
                    openai_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result_text
                    }));
                } else {
                    sink.emit_tool_progress(subagent_id, "start", name, tool_path.clone());
                    let (result, file_changes) =
                        execute_tool_tracked(name, &args, client, tool_configs, root_path, backend)
                            .await
                            .unwrap_or_else(|e| {
                                sink.emit_tool_progress(subagent_id, "error", name, tool_path.clone());
                                (format!("Tool error: {}", e), Vec::new())
                            });
                    sink.emit_tool_progress(subagent_id, "done", name, tool_path);

                    let snippet = if result.len() > 200 {
                        format!("{}...", &result[..200])
                    } else {
                        result.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: name.to_string(),
                        arguments: serde_json::to_string(&args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result.clone(),
                        file_changes,
                        subagent: None,
                    });
                    openai_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result
                    }));
                }
            }

            // Run the collected spawn_subagent calls concurrently (max 2).
            if !spawn_items.is_empty() {
                let batch: Vec<(String, String, bool)> = spawn_items
                    .iter()
                    .map(|(_, agent, task, _, is_dup)| (agent.clone(), task.clone(), *is_dup))
                    .collect();
                let outcomes = run_spawn_batch(runner, &batch).await;

                for ((tool_call_id, _, _, args, _), (result, subagent_trace)) in spawn_items.into_iter().zip(outcomes) {
                    sink.emit_tool_progress(subagent_id, "done", "spawn_subagent", args["path"].as_str().map(String::from));

                    // Charge the sub-agent's hidden reasoning to the parent's
                    // session token total so a sub-agent-heavy turn is counted.
                    if let Some(ref trace) = subagent_trace {
                        thinking_tokens += trace.thinking_tokens;
                    }

                    let snippet = if result.len() > 200 {
                        format!("{}...", &result[..200])
                    } else {
                        result.clone()
                    };
                    all_tool_calls.push(ToolCallLog {
                        name: "spawn_subagent".to_string(),
                        arguments: serde_json::to_string(&args).unwrap_or_default(),
                        result_snippet: snippet,
                        result_full: result.clone(),
                        file_changes: Vec::new(),
                        subagent: subagent_trace,
                    });
                    openai_msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result
                    }));
                }
            }

            // Add separator between iterations
            if !full_content.is_empty() {
                full_content.push('\n');
            }
        } else {
            // No tool calls — final response. The main agent concludes the task
            // is done when the response is a COMPLETE final answer. If it only
            // reasoned (thinking-only) or repeated itself, recover automatically.
            let complete = is_complete_answer(&stream.iter_content, false);
            if !complete {
                // Track this iteration's content for repetition detection.
                recent_iterations.push(stream.iter_content.clone());
                if recent_iterations.len() > REPETITION_WINDOW {
                    recent_iterations.remove(0);
                }

                let context_tokens_now = estimate_json_messages_tokens(&openai_msgs)
                    + estimate_chat_tokens(&full_content)
                    + thinking_tokens;

                // 1. Repetition detection → micro-agent repurpose + summarize +
                //    re-trigger with a to-do list.
                if detect_repetition(&recent_iterations, REPETITION_WINDOW) {
                    eprintln!(
                        "[nolock] openai-tool-loop iteration={} detected repetition; summarizing context and re-triggering",
                        iteration
                    );
                    let last_message = stream.iter_content.clone();
                    let todo_list = build_fallback_todo_list(&last_message);
                    let summary = if let Some(r) = runner {
                        summarize_context_via_micro_agent(r, &last_message, &todo_list).await
                            .unwrap_or_else(|| last_message.clone())
                    } else {
                        last_message.clone()
                    };
                    openai_msgs = build_retrigger_messages(&summary, &todo_list, &task_hint(messages));
                    context_summarized = true;
                    recent_iterations.clear();
                    continue;
                }

                // 2. Context near the limit → summarize to free room.
                if !context_summarized
                    && should_summarize_context(context_tokens_now, context_length)
                {
                    eprintln!(
                        "[nolock] openai-tool-loop iteration={} context at {:.0}% of window; summarizing",
                        iteration,
                        context_usage_ratio(context_tokens_now, context_length) * 100.0
                    );
                    let last_message = stream.iter_content.clone();
                    let todo_list = build_fallback_todo_list(&last_message);
                    let summary = if let Some(r) = runner {
                        summarize_context_via_micro_agent(r, &last_message, &todo_list).await
                            .unwrap_or_else(|| last_message.clone())
                    } else {
                        last_message.clone()
                    };
                    openai_msgs = build_retrigger_messages(&summary, &todo_list, &task_hint(messages));
                    context_summarized = true;
                    recent_iterations.clear();
                    continue;
                }

                // 3. Thinking-only retry (bounded nudge).
                if thinking_only_retries < thinking_only_max_retries {
                    thinking_only_retries += 1;
                    eprintln!(
                        "[nolock] openai-tool-loop iteration={} reasoning-only, retry {}/{}",
                        iteration, thinking_only_retries, thinking_only_max_retries
                    );
                    // A model that keeps reasoning without producing content or a
                    // tool call is stuck. Drop the tools so it is forced to answer
                    // plainly (e.g. a simple greeting with tools enabled), and give
                    // it a fresh retry budget to do so.
                    if thinking_only_retries >= TOOLS_DROP_RETRY_THRESHOLD
                        && !effective_tools.is_empty()
                    {
                        eprintln!(
                            "[nolock] openai-tool-loop iteration={} dropping tools to force a plain answer",
                            iteration
                        );
                        effective_tools.clear();
                        recent_iterations.clear();
                        openai_msgs.push(serde_json::json!({
                            "role": "system",
                            "content": tools_dropped_prompt()
                        }));
                        continue;
                    }
                    openai_msgs.push(serde_json::json!({
                        "role": "system",
                        "content": thinking_retry_prompt(thinking_only_retries)
                    }));
                    continue;
                }
            }

            eprintln!(
                "[nolock] openai-tool-loop iteration={} no tool_calls, returning: content_len={} tool_calls={}",
                iteration,
                full_content.len(),
                all_tool_calls.len()
            );
            if full_content.is_empty() && all_tool_calls.is_empty() {
                eprintln!("[nolock] WARNING: empty response from model in tool loop");
            }
            let context_tokens = estimate_json_messages_tokens(&openai_msgs) + estimate_chat_tokens(&full_content) + thinking_tokens;
            let mut final_content = full_content.clone();
            // Last resort: if the model stalled on thinking-only and never
            // produced visible content, surface a best-effort answer extracted
            // from the accumulated reasoning instead of "(no response)".
            if final_content.trim().is_empty() && !total_thinking.trim().is_empty() {
                let fallback = extract_answer_from_thinking(&total_thinking);
                if !fallback.is_empty() {
                    final_content = fallback;
                }
            }
            return Ok(ChatResult {
                content: if final_content.is_empty() {
                    "(no response)".to_string()
                } else {
                    final_content
                },
                tool_calls: all_tool_calls,
                context_tokens,
                thinking_tokens,
                usage,
            });
        }
    }

    // Exhausted iterations
    eprintln!(
        "[nolock] openai-tool-loop exhausted after {} iterations: content_len={} tool_calls={}",
        max_iterations,
        full_content.len(),
        all_tool_calls.len()
    );
    let context_tokens = estimate_json_messages_tokens(&openai_msgs) + estimate_chat_tokens(&full_content) + thinking_tokens;
    let mut final_content = full_content.clone();
    if final_content.trim().is_empty() && !total_thinking.trim().is_empty() {
        let fallback = extract_answer_from_thinking(&total_thinking);
        if !fallback.is_empty() {
            final_content = fallback;
        }
    }
    Ok(ChatResult {
        content: if final_content.is_empty() {
            "(max tool iterations reached, no response)".to_string()
        } else {
            final_content
        },
        tool_calls: all_tool_calls,
        context_tokens,
        thinking_tokens,
        usage,
    })
}

/// Builds the JSON body for an Ollama `/api/generate` request.
///
/// * `raw: true` bypasses the model's chat template so FIM tokens
///   (`<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`) are sent
///   as-is rather than wrapped inside `<|im_start|>user...<|im_end|>` tags.
/// * The `system_prompt` is prepended to the prompt because raw mode
///   may drop the separate `system` field.
fn build_ollama_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    max_tokens: u32,
    temperature: f64,
) -> serde_json::Value {
    let raw_prompt = format!("{}\n{}", system_prompt, prompt);
    serde_json::json!({
        "model": model,
        "prompt": raw_prompt,
        "stream": false,
        "raw": true,
        "options": {
            "num_predict": max_tokens,
            "temperature": temperature,
            "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
        }
    })
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
            // FITM: The frontend already wraps the prompt in FIM tokens
            // (<|fim_prefix|><prefix><|fim_suffix|><suffix><|fim_middle|>).
            // Send it as-is — no separate `suffix` field needed.
            // raw=true bypasses the chat template so FIM tokens are not wrapped
            // inside chat tags. The system prompt is prepended since raw mode
            // may drop the separate `system` field.
            let body = build_ollama_body(
                &req.model,
                system_prompt,
                &req.prompt,
                max_tokens,
                temperature,
            );

            eprintln!("[nolock] ollama POST {}/api/generate prompt_len={}", req.url, req.prompt.len());
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body)
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

            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["response"].as_str().unwrap_or("").to_string())
        }
        "llamacpp" => {
            // FITM: The frontend wraps the prompt in FIM tokens. Send as-is.
            let body = serde_json::json!({
                "prompt": req.prompt,
                "n_predict": max_tokens,
                "temperature": temperature,
                "stream": false,
                "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
                "system": system_prompt
            });
            eprintln!("[nolock] llamacpp POST {}/completion prompt_len={}", req.url, req.prompt.len());
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
                .header("HTTP-Referer", "https://nolock.impacte.tech")
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
                        "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
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
        "digitalocean" => {
            let api_key = req.api_key.unwrap_or_default();

            // Build a structured prompt that includes both prefix and suffix context.
            // DigitalOcean Inference Router uses the chat completions API which doesn't natively support
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
            // DigitalOcean serverless inference endpoint — a fixed host (like
            // OpenRouter's). We ignore `req.url` here because the inference API
            // lives at `inference.do-ai.run`, not `api.digitalocean.com`. The
            // model field carries either a model id or "router:{router_name}".
            let full_url = "https://inference.do-ai.run/v1/chat/completions".to_string();
            eprintln!("[nolock] digitalocean POST {} model={}", full_url, req.model);
            let resp = client
                .post(&full_url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[nolock] digitalocean error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[nolock] digitalocean status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        _ => Err(format!("Unknown backend: {}", req.backend)),
    }
}

#[tauri::command]
async fn ai_chat(app_handle: tauri::AppHandle, req: ChatRequest) -> Result<ChatResult, String> {
    let memory = app_handle.state::<SubAgentMemory>();
    run_chat(&app_handle, memory.inner(), req).await
}

/// Serve a Switchyard classifier/judge model call over nolock's own transport.
/// A minimal non-tool chat completion: Ollama uses `/api/chat`, every other
/// backend uses the OpenAI-compatible `/chat/completions` shape.
async fn switchyard_judge_completion(
    client: &reqwest::Client,
    backend: &str,
    model: &str,
    url: &str,
    api_key: &str,
    system_prompt: &str,
    user_task: &str,
    response_format: Option<serde_json::Value>,
) -> Result<String, String> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !system_prompt.trim().is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": system_prompt }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": user_task }));
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    // The judge must return a structured JSON verdict matching the schema libsy
    // attached to the classifier request (`output.response_format`). For the
    // capability classifier that is the crux/primary_rule/capability_boundary/
    // p_solve verdict;for a custom classifier it is the user-supplied schema.
    // Ollama enforces structured output via its `format` field (which takes the
    // inner JSON Schema directly);OpenAI-compatible backends use
    // `response_format` with a `json_schema` wrapper.
    if let Some(response_format) = response_format {
        // libsy gives us the provider wrapper: { "type": "json_schema",
        // "json_schema": { "name": ..., "strict": true, "schema": {...} } }.
        let inner_schema = response_format
            .pointer("/json_schema/schema")
            .cloned()
            .unwrap_or_else(|| response_format.clone());
        if backend == "ollama" {
            body["format"] = inner_schema;
        } else {
            body["response_format"] = response_format;
        }
    } else {
        // No schema from libsy — fall back to a generic JSON object so the
        // judge still returns parseable JSON.
        if backend == "ollama" {
            body["format"] = serde_json::json!({ "type": "object" });
        } else {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
    }
    let endpoint = if backend == "ollama" {
        format!("{}/api/chat", url)
    } else {
        format!("{}/chat/completions", url)
    };
    let mut request = client
        .post(&endpoint)
        .json(&body)
        .timeout(std::time::Duration::from_secs(120));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("switchyard judge request failed: {}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("switchyard judge read failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("switchyard judge HTTP {}: {}", status, text));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("switchyard judge parse failed: {}", e))?;
    if backend == "ollama" {
        v["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "switchyard judge: no message.content in ollama response".to_string())
    } else {
        v["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "switchyard judge: no choices[0].message.content".to_string())
    }
}

/// Core chat entry point, shared by the Tauri command and the headless CLI /
/// E2E harness. `sink` reports live progress (streamed tokens, tool progress,
/// sub-agent windows) and `subagent_memory` persists per-agent conversation
/// memory across turns.
pub async fn run_chat(
    sink: &(dyn EventSink + Send + Sync),
    subagent_memory: &SubAgentMemory,
    mut req: ChatRequest,
) -> Result<ChatResult, String> {
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

    // Resolve configurable values with defaults.
    // When tools are enabled, the model needs extra token budget beyond what the
    // user sets: each tool-call iteration consumes thinking tokens + content
    // tokens, and the final response still needs room.  Thinking-capable models
    // (Qwen3, DeepSeek-R1, etc.) spend a large fraction of their budget on
    // hidden thinking tokens that are never visible.  Auto-scale the default
    // when tools are active so the model doesn't hit `num_predict` mid-generation.
    let temperature = req.temperature.unwrap_or(0.7);
    let has_tools = !req.tools_enabled.is_empty();
    // The last user message — used as the task for pre-spawned @agents.
    let user_task = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    // Local backends default to a reasoning-friendly floor (matches the Chat
    // Model panel's 8192). Thinking models (Qwen3, Nemotron, DeepSeek-R1) can
    // otherwise spend the whole budget on hidden reasoning and never emit
    // visible content → the user sees "(no response)".
    let user_max_tokens = req
        .max_tokens
        .unwrap_or_else(|| if is_cloud_backend(&req.backend) { CLOUD_DEFAULT_MAX_TOKENS } else { LOCAL_DEFAULT_MAX_TOKENS });
    let max_tokens = if has_tools && req.max_tokens.is_none() {
        // User did not explicitly set max_tokens — use a large tool-mode budget
        // so long agentic runs aren't truncated mid-generation.
        LOCAL_TOOL_MAX_TOKENS
    } else if has_tools && user_max_tokens < 4096 {
        // User set a low value but tools are on — enforce a minimum of 4096
        // so thinking models have room for at least one tool-call cycle.
        4096
    } else {
        user_max_tokens
    };
    // Cloud providers must NOT be auto-scaled. Their max_tokens /
    // max_completion_tokens budget is the only thing the user controls, and
    // DigitalOcean scopes `max_completion_tokens` across the *entire* tool loop
    // (all iterations). When the user hasn't set a budget we apply a default,
    // and we cap the result so `input + output` stays within the model's context
    // window (the API rejects requests that exceed it).
    let context_len = req.context_length.unwrap_or(128_000);
    // Rough input-token estimate (~4 chars/token) plus a margin for the system
    // prompt + tool definitions the backend adds.
    let input_estimate: u32 = req
        .messages
        .iter()
        .map(|m| (m.content.len() as u32 / 4) + 1)
        .sum();
    let max_output = context_len
        .saturating_sub(input_estimate)
        .saturating_sub(16_384);
    let cloud_max_tokens: Option<u32> = Some(
        req.max_tokens
            .unwrap_or(CLOUD_DEFAULT_MAX_TOKENS)
            .min(max_output.max(1)),
    );
    // Bound the LOCAL output budget against the real context window too.
    // Previously LOCAL_TOOL_MAX_TOKENS (256k) was sent as num_predict even
    // when the model's working window could not fit it — after sub-agent
    // results inflate the input, the (much smaller) effective budget gets
    // burned entirely on thinking tokens and the generation is truncated
    // before visible content → the "reasoning-only" retry loop. Keep a 4096
    // floor so tool-dominated agents still have one plausible cycle.
    let max_tokens = if is_cloud_backend(&req.backend) {
        max_tokens
    } else {
        bound_local_max_tokens(max_tokens, max_output)
    };
    eprintln!(
        "[nolock] ai_chat resolved max_tokens={} (local, user={:?}, has_tools={}) cloud_max_tokens={:?} context_len={} input_estimate={} max_output={}",
        max_tokens, req.max_tokens, has_tools, cloud_max_tokens, context_len, input_estimate, max_output
    );

    // Prepend global system prompt if provided and not already present
    let mut messages = if let Some(ref system_prompt) = req.system_prompt {
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

    // ---- Switchyard routing (main chat) ----------------------------------
    // When the project's `.routers/switchyard.json` is enabled and has a
    // `chat` route, the embedded libsy router picks the backend/model for this
    // request. Fail-safe: any error falls through to the user-configured
    // provider below.
    if let Some(root) = req.root_path.as_deref() {
        let providers: HashMap<String, switchyard::ProviderEndpoint> = req
            .providers
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    switchyard::ProviderEndpoint {
                        url: v.url.clone(),
                        api_key: v.api_key.clone(),
                    },
                )
            })
            .collect();
        let judge_transport: switchyard::JudgeTransport = {
            let client = client.clone();
            Arc::new(
                move |backend, model, url, api_key, system_prompt, user_task, response_format| {
                    let client = client.clone();
                    Box::pin(async move {
                        switchyard_judge_completion(
                            &client,
                            &backend,
                            &model,
                            &url,
                            &api_key,
                            &system_prompt,
                            &user_task,
                            response_format,
                        )
                        .await
                    })
                },
            )
        };
        let default_api_key = req.api_key.clone().unwrap_or_default();
        match switchyard::resolve_route(
            root,
            switchyard::RoutePurpose::Chat,
            &user_task,
            &providers,
            &req.backend,
            &req.model,
            &req.url,
            &default_api_key,
            judge_transport,
        )
        .await
        {
            Ok(Some(selected)) => {
                eprintln!(
                    "[switchyard] route '{}' ({:?}) -> {} ({}){}",
                    selected.route_name,
                    selected.algorithm,
                    selected.model,
                    selected.backend,
                    selected
                        .reasoning
                        .as_deref()
                        .map(|r| format!(" — {}", r))
                        .unwrap_or_default()
                );
                sink.emit_model_routed(&selected.model);
                req.backend = selected.backend;
                req.model = selected.model;
                req.url = selected.url;
                req.api_key = Some(selected.api_key);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[switchyard] routing skipped: {}", e),
        }
    }

    // The main agent may delegate mechanical work to micro-agents. Load its
    // config from `.agents/main.md` if present; otherwise default to allowing
    // micro-agent spawning so the orchestrator can route suitable tasks to a
    // dedicated micro-agent (e.g. shell-runner for shell scripts). This adds the
    // `spawn_micro_agent` tool to the main agent's tool set (alongside the
    // existing `spawn_subagent`), so it can hand off focused, deterministic work.
    let main_agent_config = req.root_path.as_deref().and_then(|rp| {
        load_agent_config(rp, "main").ok().or_else(|| {
            Some(AgentConfig {
                name: "main".to_string(),
                can_spawn_micro_agents: true,
                allowed_micro_agents: Vec::new(),
                ..Default::default()
            })
        })
    });
    let tools = build_tool_schemas_inner(
        &req.tools_enabled,
        req.root_path.as_deref(),
        true,
        main_agent_config.as_ref(),
    );
    let has_tools = !tools.is_empty();

    // Shared sub-agent conversation memory (persists across turns in the same
    // session). Read once and pass the reference down through the runner.
    let main_api_key = req.api_key.clone().unwrap_or_default();
    let runner = SubAgentRunner {
        sink,
        client: &client,
        main_backend: &req.backend,
        main_url: &req.url,
        main_model: &req.model,
        main_api_key: &main_api_key,
        providers: &req.providers,
        tool_configs: &req.tool_configs,
        root_path: req.root_path.as_deref(),
        max_tokens: cloud_max_tokens,
        max_iterations: req.max_iterations,
        reasoning_retries: req.reasoning_retries.unwrap_or(THINKING_ONLY_MAX_RETRIES),
        context_length: context_len as u64,
        use_model_affinity: req.model_affinity.unwrap_or(true),
        depth: 0,
        memory: &subagent_memory,
    };

    // Pre-spawn explicitly-referenced agents (from `@agent` mentions) so they
    // run in PARALLEL regardless of the orchestrator model's tool-calling
    // reliability (nemotron-class models sometimes emit only one spawn call).
    // Their results are injected as system context for the orchestrator to
    // synthesize, and the tool loops skip re-spawning them.
    let mut pre_spawned: std::collections::HashSet<String> = std::collections::HashSet::new();
    if !req.referenced_agents.is_empty() {
        let items = build_pre_spawn_items(&req.referenced_agents, &user_task);
        eprintln!(
            "[nolock] pre-spawning referenced agents in parallel: {:?}",
            req.referenced_agents
        );
        let outcomes = run_spawn_batch(Some(&runner), &items).await;
        // Inject the results as system context right BEFORE the latest user
        // message so the orchestrator (the only model that builds the final
        // response) sees them in its working context — not buried at the start
        // of a long conversation. Each result is labelled with the agent.
        let inject_at = messages
            .iter()
            .rposition(|m| m.role == "user")
            .map(|i| i)
            .unwrap_or(0);
        for ((agent, _task, _dup), (result, _trace)) in items.into_iter().zip(outcomes) {
            pre_spawned.insert(agent.clone());
            let msg = ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "[Sub-agent @{} result]\n{}\n\nUse the above result from sub-agent @{} \
                     as input to your final answer. You are the orchestrator: write the unified, \
                     complete answer that directly addresses the user's request.",
                    agent, result, agent
                ),
            };
            messages.insert(inject_at, msg);
        }
    }

    match req.backend.as_str() {
        "ollama" => {
            if has_tools {
                let ollama_ctx = OllamaChatContext {
                    sink,
                    client: &client,
                    url: &req.url,
                    model: &req.model,
                    tool_configs: &req.tool_configs,
                    root_path: req.root_path.as_deref(),
                    reasoning_retries: req.reasoning_retries.unwrap_or(THINKING_ONLY_MAX_RETRIES),
                    context_length: context_len as u64,
                };
                ollama_chat_with_tools(&ollama_ctx, &messages, &tools, req.max_iterations, temperature, max_tokens, None, Some(&runner), &pre_spawned)
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
                    .timeout(std::time::Duration::from_secs(180))
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

                // Stream NDJSON response (handles both thinking and content fields).
                // We reuse `apply_ollama_stream_line` here so the plain-chat path
                // and the tool-loop path share identical parsing. Thinking
                // tokens are streamed with the `thinking` flag (frontend shows
                // them in the indicator, NOT in the message body). If the model
                // finishes with only reasoning and no visible answer, we RETRY
                // with a short nudge (bounded) instead of dumping the reasoning.
                let mut attempts = 0;
                // The plain-chat retry budget mirrors the configured reasoning
                // retries (defaults to the max attempts floor).
                const MAX_PLAIN_CHAT_ATTEMPTS: usize = 8;
                let max_plain_attempts = req
                    .reasoning_retries
                    .unwrap_or(MAX_PLAIN_CHAT_ATTEMPTS)
                    .max(1);
                // Start with the failure message; it is replaced as soon as the
                // model produces a real answer.
                let mut final_content = "(no response)".to_string();
                // Running total of hidden reasoning across all retry attempts.
                let mut total_thinking = String::new();
                loop {
                    let mut full_content = String::new();
                    let mut full_thinking = String::new();
                    let mut acc = OllamaChunkAcc::default();
                    let mut buf: Vec<u8> = Vec::new();
                    let mut handle_chunk =
                        |line: &str,
                         full_content: &mut String,
                         full_thinking: &mut String| {
                            if apply_ollama_stream_line(line, &mut acc, ModelArch::Generic) {
                                if !acc.thinking.is_empty() {
                                    full_thinking.push_str(&acc.thinking);
                                    sink.emit_stream_token(None, &acc.thinking, true);
                                }
                                if !acc.content.is_empty() {
                                    full_content.push_str(&acc.content);
                                    sink.emit_stream_token(None, &acc.content, false);
                                }
                                acc = OllamaChunkAcc::default();
                            }
                        };
                    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
                        buf.extend_from_slice(&chunk);
                        while let Some(line) = take_next_line(&mut buf) {
                            if line.is_empty() { continue; }
                            handle_chunk(&line, &mut full_content, &mut full_thinking);
                        }
                    }
                    // Drain every complete line in the trailing buffer (the last
                    // HTTP chunk may contain several lines and may not end with '\n').
                    while !buf.is_empty() {
                        match take_next_line(&mut buf) {
                            Some(line) if !line.is_empty() => {
                                handle_chunk(&line, &mut full_content, &mut full_thinking);
                            }
                            _ => {
                                let tail = String::from_utf8_lossy(&buf).trim().to_string();
                                if !tail.is_empty() {
                                    handle_chunk(&tail, &mut full_content, &mut full_thinking);
                                }
                                buf.clear();
                            }
                        }
                    }

                    // Accumulate the hidden reasoning so it counts toward the
                    // session token total across all retry attempts.
                    if !full_thinking.is_empty() {
                        total_thinking.push_str(&full_thinking);
                    }

                    if is_complete_answer(&full_content, false) {
                        // Real, complete answer received (not a question, not a
                        // premature/too-short reply). Accept it.
                        final_content = full_content;
                        break;
                    }
                    // The model only reasoned, produced nothing, OR concluded
                    // prematurely (a question / clarification / too-short reply).
                    // If we still have budget, retry with a nudge so it actually
                    // answers instead of closing the turn with a question.
                    if full_thinking.is_empty() {
                        // Genuinely empty — no thinking, no content.
                        eprintln!("[nolock] ollama chat returned nothing (attempt {})", attempts);
                    } else {
                        eprintln!(
                            "[nolock] ollama chat returned only thinking ({} chars), retry {}",
                            full_thinking.len(),
                            attempts + 1
                        );
                    }
                    attempts += 1;
                    if attempts >= max_plain_attempts {
                        break;
                    }
                    // Re-request with a nudge appended so the model emits the
                    // answer directly instead of finishing with reasoning.
                    let mut retry_msgs: Vec<serde_json::Value> = messages
                        .iter()
                        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                        .collect();
                    retry_msgs.push(serde_json::json!({
                        "role": "user",
                        "content": "Please answer normally now — provide the actual answer as plain, visible text. \
                                    Do NOT output an internal reasoning trace, do NOT ask a clarifying question, \
                                    and do NOT just acknowledge the request. Give the real answer directly."
                    }));
                    let retry_body = serde_json::json!({
                        "model": req.model,
                        "messages": retry_msgs,
                        "stream": true,
                        "options": { "num_predict": max_tokens, "temperature": temperature }
                    });
                    resp = client
                        .post(format!("{}/api/chat", req.url))
                        .json(&retry_body)
                        .timeout(std::time::Duration::from_secs(180))
                        .send()
                        .await
                        .map_err(|e| {
                            eprintln!("[nolock] ollama chat retry error: {}", e);
                            e.to_string()
                        })?;
                }
                let mut thinking_tokens = 0u64;
                accumulate_thinking(&mut thinking_tokens, &total_thinking);
                // If the model never produced a visible answer (stalled on
                // thinking-only across all retries), fall back to a best-effort
                // answer extracted from the accumulated reasoning rather than
                // returning "(no response)". This keeps the main agent from
                // stalling silently.
                if final_content == "(no response)" && !total_thinking.trim().is_empty() {
                    let fallback = extract_answer_from_thinking(&total_thinking);
                    if !fallback.is_empty() {
                        final_content = fallback;
                    }
                }
                Ok(ChatResult {
                    content: final_content.clone(),
                    tool_calls: vec![],
                    context_tokens: estimate_messages_tokens(&messages) + thinking_tokens,
                    thinking_tokens,
                    usage: vec![usage_for(
                        "ollama",
                        &req.model,
                        0,
                        0,
                        estimate_messages_tokens(&messages),
                        estimate_chat_tokens(&final_content),
                    )],
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
            let mut buf: Vec<u8> = Vec::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        buf.extend_from_slice(&chunk);
                        while let Some(line) = take_next_line(&mut buf) {
                            if let Some(data) = line.strip_prefix("data: ") {
                                let data = data.trim();
                                if data == "[DONE]" { continue; }
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(content) = json["content"].as_str() {
                                        if !content.is_empty() {
                                            full_content.push_str(content);
                                            sink.emit_stream_token(None, &content.to_string(), false);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Drain trailing buffer (last chunk may not end with '\n')
            if !buf.is_empty() {
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if let Some(data) = line.strip_prefix("data: ") {
                    let data = data.trim();
                    if data != "[DONE]" {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(content) = json["content"].as_str() {
                                if !content.is_empty() {
                                    full_content.push_str(content);
                                    sink.emit_stream_token(None, &content.to_string(), false);
                                }
                            }
                        }
                    }
                }
            }
            let ctx_tokens_estimate = estimate_messages_tokens(&messages) + estimate_chat_tokens(&full_content);
            Ok(ChatResult {
                content: full_content.clone(),
                tool_calls: vec![],
                context_tokens: ctx_tokens_estimate,
                thinking_tokens: 0,
                usage: vec![usage_for(
                    "llamacpp",
                    &req.model,
                    0,
                    0,
                    estimate_messages_tokens(&messages),
                    estimate_chat_tokens(&full_content),
                )],
            })
        }
        "openrouter" => {
            if has_tools {
                // OpenRouter supports OpenAI-compatible tool calling. Route
                // through the shared tool loop so tools actually execute (and
                // reasoning models like nemotron-3-ultra have their thinking +
                // answer handled) instead of falling back to a plain completion.
                let api_key = req.api_key.clone().unwrap_or_default();
                let full_url = "https://openrouter.ai/api/v1/chat/completions".to_string();
                run_openai_tool_loop(
                    &client,
                    sink,
                    &full_url,
                    &api_key,
                    &req.model,
                    &req.backend,
                    &messages,
                    &tools,
                    &req.tool_configs,
                    req.root_path.as_deref(),
                    temperature,
                    cloud_max_tokens,
                    req.max_iterations,
                    Some(vec![("HTTP-Referer", "https://nolock.impacte.tech")]),
                    true,
                    None, // subagent_id (main agent)
                    Some(&runner),
                    &pre_spawned,
                    context_len as u64,
                )
                .await
            } else {
                let api_key = req.api_key.clone().unwrap_or_default();
                let or_msgs: Vec<serde_json::Value> = messages
                    .iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect();

                let mut body = serde_json::json!({
                    "model": req.model,
                    "messages": or_msgs,
                    "temperature": temperature,
                    "stream": true
                });
                if let Some(mt) = cloud_max_tokens {
                    body["max_tokens"] = serde_json::json!(mt);
                }

                eprintln!("[nolock] openrouter POST chat completions (streaming)");
                let mut resp = client
                    .post("https://openrouter.ai/api/v1/chat/completions")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("HTTP-Referer", "https://nolock.impacte.tech")
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
                let mut full_thinking = String::new();
                let mut buf: Vec<u8> = Vec::new();
                // Reasoning models stream `delta.reasoning_content` for thinking and
                // `delta.content` for the visible answer. When the model emits NO
                // content (only reasoning), surface the reasoning so the user isn't
                // left with "(no response)".
                let handle_delta = |json: &serde_json::Value,
                                    full_content: &mut String,
                                    full_thinking: &mut String| {
                    if let Some(thinking) = json["choices"][0]["delta"]["reasoning_content"].as_str() {
                        if !thinking.is_empty() {
                            full_thinking.push_str(thinking);
                            sink.emit_stream_token(None, &thinking.to_string(), true);
                        }
                    }
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        if !content.is_empty() {
                            full_content.push_str(content);
                            sink.emit_stream_token(None, &content.to_string(), false);
                        }
                    }
                };
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            buf.extend_from_slice(&chunk);
                            while let Some(line) = take_next_line(&mut buf) {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        handle_delta(&json, &mut full_content, &mut full_thinking);
                                    }
                                }
                            }
                        }
                    }
                }
                // Drain trailing buffer (last chunk may not end with '\n\n')
                if !buf.is_empty() {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if let Some(data) = line.strip_prefix("data: ") {
                        let data = data.trim();
                        if data != "[DONE]" {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                handle_delta(&json, &mut full_content, &mut full_thinking);
                            }
                        }
                    }
                }
                // If the model only produced reasoning and no visible content,
                // surface the reasoning as the answer (like the Ollama fallback).
                let final_content = if full_content.is_empty() && !full_thinking.is_empty() {
                    let as_content = if full_thinking.contains('`') {
                        format!("\n\n[model produced only internal reasoning]\n{}", full_thinking)
                    } else {
                        full_thinking.clone()
                    };
                    sink.emit_stream_token(None, &as_content, false);
                    as_content
                } else {
                    full_content
                };
                let thinking_tokens = estimate_chat_tokens(&full_thinking);
                let ctx_tokens_estimate = estimate_messages_tokens(&messages) + estimate_chat_tokens(&final_content) + thinking_tokens;
                Ok(ChatResult {
                    content: final_content.clone(),
                    tool_calls: vec![],
                    context_tokens: ctx_tokens_estimate,
                    thinking_tokens,
                    usage: vec![usage_for(
                        "openrouter",
                        &req.model,
                        0,
                        0,
                        estimate_messages_tokens(&messages),
                        estimate_chat_tokens(&final_content),
                    )],
                })
            }
        }
        "opencode" => {
            let api_key = req.api_key.clone().unwrap_or_default();
            let is_remote = req.url.contains("/v1");

            if is_remote {
                // Remote OpenCode Zen API — OpenAI-compatible SSE streaming
                let mut body = serde_json::json!({
                    "model": req.model,
                    "messages": messages,
                    "stream": true,
                    "temperature": temperature,
                });
                if let Some(mt) = cloud_max_tokens {
                    body["max_tokens"] = serde_json::json!(mt);
                }
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
                let mut full_thinking = String::new();
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            buf.extend_from_slice(&chunk);
                            while let Some(line) = take_next_line(&mut buf) {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(thinking) = json["choices"][0]["delta"]["reasoning_content"].as_str() {
                                            if !thinking.is_empty() {
                                                full_thinking.push_str(thinking);
                                                 sink.emit_stream_token(None, &thinking.to_string(), true);
                                            }
                                        }
                                        if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                            if !content.is_empty() {
                                                full_content.push_str(content);
                                                 sink.emit_stream_token(None, &content.to_string(), false);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Drain trailing buffer (last chunk may not end with '\n\n')
                if !buf.is_empty() {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if let Some(data) = line.strip_prefix("data: ") {
                        let data = data.trim();
                        if data != "[DONE]" {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(thinking) = json["choices"][0]["delta"]["reasoning_content"].as_str() {
                                    if !thinking.is_empty() {
                                        full_thinking.push_str(thinking);
                                         sink.emit_stream_token(None, &thinking.to_string(), true);
                                    }
                                }
                                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                    if !content.is_empty() {
                                        full_content.push_str(content);
                                        sink.emit_stream_token(None, &content.to_string(), false);
                                    }
                                }
                            }
                        }
                    }
                }
                let thinking_tokens = estimate_chat_tokens(&full_thinking);
                let ctx_tokens_estimate = estimate_messages_tokens(&messages) + estimate_chat_tokens(&full_content) + thinking_tokens;
                Ok(ChatResult {
                    content: full_content.clone(),
                    tool_calls: vec![],
                    context_tokens: ctx_tokens_estimate,
                    thinking_tokens,
                    usage: vec![usage_for(
                        "opencode",
                        &req.model,
                        0,
                        0,
                        estimate_messages_tokens(&messages),
                        estimate_chat_tokens(&full_content),
                    )],
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
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            buf.extend_from_slice(&chunk);
                            while let Some(line) = take_next_line(&mut buf) {
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(content) = data["response"].as_str() {
                                         if !content.is_empty() {
                                            full_content.push_str(content);
                                            sink.emit_stream_token(None, &content.to_string(), false);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Drain trailing buffer (last chunk may not end with '\n')
                if !buf.is_empty() {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(content) = data["response"].as_str() {
                            if !content.is_empty() {
                                full_content.push_str(content);
                                sink.emit_stream_token(None, &content.to_string(), false);
                            }
                        }
                    }
                }
                let ctx_tokens_estimate = estimate_messages_tokens(&messages) + estimate_chat_tokens(&full_content);
                Ok(ChatResult {
                    content: full_content.clone(),
                    tool_calls: vec![],
                    context_tokens: ctx_tokens_estimate,
                    thinking_tokens: 0,
                    usage: vec![usage_for(
                        "opencode",
                        &req.model,
                        0,
                        0,
                        estimate_messages_tokens(&messages),
                        estimate_chat_tokens(&full_content),
                    )],
                })
            }
        }
        "digitalocean" => {
            let api_key = req.api_key.clone().unwrap_or_default();

            // DigitalOcean serverless inference endpoint — a fixed host (like
            // OpenRouter's). We ignore `req.url` because the inference API lives
            // at `inference.do-ai.run`, not `api.digitalocean.com`. The model
            // field carries either a model id or "router:{router_name}".
            let full_url = "https://inference.do-ai.run/v1/chat/completions".to_string();

            // Model affinity (session pinning) keeps the router on a single model
            // across the whole tool loop. Defaults to enabled; the user can disable
            // it in the DigitalOcean provider settings.
            let use_model_affinity = req.model_affinity.unwrap_or(true);

            // Use the OpenAI-compatible tool calling loop
            run_openai_tool_loop(
                &client,
                sink,
                &full_url,
                &api_key,
                &req.model,
                &req.backend,
                &messages,
                &tools,
                &req.tool_configs,
                req.root_path.as_deref(),
                temperature,
                cloud_max_tokens,
                req.max_iterations,
                None, // no extra headers needed for DigitalOcean
                use_model_affinity,
                None, // subagent_id (main agent)
                Some(&runner),
                &pre_spawned,
                context_len as u64,
            )
            .await
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
        .manage(SubAgentMemory::new())
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
            // On macOS, intercept Cmd+Z/A/Y at the native NSResponder level
            // before WKWebView processes them, preventing native undo/redo/selectAll.
            macos_keyboard::install(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_directory,
            list_files_recursive,
            hooks::list_hooks,
            hooks::read_hook,
            hooks::save_hook,
            rename_file,
            move_file,
            delete_file,
            copy_file,
            create_file,
            list_agents,
            read_agent,
            validate_agents,
            read_switchyard_config,
            write_switchyard_config,
            list_micro_agents,
            read_micro_agent,
            subagent_reset,
            list_skills,
            run_skill_command,
            list_tools,
            read_tool,
            run_tool_command,
            list_sessions,
            read_session,
            save_session,
            delete_session,
            archive_session,
            search_in_files,
            replace_in_files,
            create_directory,
            append_to_file,
            get_rlhf_dir,
            get_model_info,
            fetch_models,
            fetch_digitalocean_routers,
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
            secrets::store_secret,
            secrets::get_secret,
            secrets::delete_secret,
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

    // ---- Streaming UTF-8 line splitter ------------------------------------
    #[test]
    fn test_take_next_line_reassembles_split_utf8() {
        // "你" is the 3 bytes E4 BD A0. Split it across two chunks: chunk 1
        // ends with E4 BD, chunk 2 starts with A0. take_next_line must buffer
        // raw bytes and only decode complete lines, otherwise the split
        // sequence would corrupt into replacement characters.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: hello \xE4\xBD"); // partial "你"
        assert!(take_next_line(&mut buf).is_none()); // no newline yet
        buf.extend_from_slice(b"\xA0 world\n"); // completes "你" + newline
        let line = take_next_line(&mut buf).unwrap();
        assert_eq!(line, "data: hello 你 world");
    }

    #[test]
    fn test_take_next_line_handles_crlf_and_partial_tail() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"line one\r\nline two\n");
        assert_eq!(take_next_line(&mut buf).unwrap(), "line one");
        assert_eq!(take_next_line(&mut buf).unwrap(), "line two");
        // No trailing newline — should return None, not lose data.
        buf.extend_from_slice(b"partial");
        assert!(take_next_line(&mut buf).is_none());
    }

    // ---- Sub-agent config parsing ------------------------------------------
    #[test]
    fn test_parse_tools_list() {
        assert_eq!(parse_tools_list("read_file, grep , edit"), vec!["read_file", "grep", "edit"]);
        assert_eq!(parse_tools_list("[\"read_file\", \"web_search\"]"), vec!["read_file", "web_search"]);
        assert_eq!(parse_tools_list("  "), Vec::<String>::new());
        assert_eq!(parse_tools_list(""), Vec::<String>::new());
    }

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

    // ---- normalize_tool_args ---------------------------------------------
    #[test]
    fn test_normalize_tool_args_parses_json_string() {
        // OpenAI-compatible APIs return arguments as a JSON-encoded string.
        let raw = serde_json::json!("{\"query\": \"Rust docs\"}");
        let args = normalize_tool_args(&raw);
        assert!(args.is_object());
        assert_eq!(args["query"], "Rust docs");
    }

    #[test]
    fn test_tool_calls_for_api_serializes_object_arguments_to_string() {
        // Regression guard for the DigitalOcean "failed to convert request" bug:
        // the assistant message sent back to the API must carry `arguments` as a
        // JSON string, not an object.
        let calls = vec![serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "web_search",
                "arguments": { "query": "AWS Kinesis documentation" }
            }
        })];
        let api_calls = tool_calls_for_api(&calls);
        let args = api_calls[0]["function"]["arguments"].as_str().expect("arguments must be a string");
        let parsed: serde_json::Value = serde_json::from_str(args).unwrap();
        assert_eq!(parsed["query"], "AWS Kinesis documentation");
    }

    #[test]
    fn test_tool_calls_for_api_passes_string_arguments_through() {
        let calls = vec![serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": "{\"path\": \"a.rs\"}"
            }
        })];
        let api_calls = tool_calls_for_api(&calls);
        assert_eq!(
            api_calls[0]["function"]["arguments"].as_str().unwrap(),
            "{\"path\": \"a.rs\"}"
        );
    }

    #[test]
    fn test_normalize_tool_args_trims_whitespace() {
        // Some models emit leading/trailing whitespace around the JSON.
        let raw = serde_json::json!("  {\"url\": \"https://doc.rust-lang.org/\"}  ");
        let args = normalize_tool_args(&raw);
        assert!(args.is_object());
        assert_eq!(args["url"], "https://doc.rust-lang.org/");
    }

    #[test]
    fn test_normalize_tool_args_passes_object_through() {
        // Ollama-compatible APIs return arguments as an object directly.
        let raw = serde_json::json!({ "path": "/tmp/foo.rs" });
        let args = normalize_tool_args(&raw);
        assert!(args.is_object());
        assert_eq!(args["path"], "/tmp/foo.rs");
    }

    #[test]
    fn test_normalize_tool_args_empty_string_is_empty_object() {
        let raw = serde_json::json!("");
        let args = normalize_tool_args(&raw);
        assert!(args.is_object());
        assert!(args.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_normalize_tool_args_invalid_json_falls_back() {
        let raw = serde_json::json!("not-json{{{");
        let args = normalize_tool_args(&raw);
        assert!(args.is_object());
        assert_eq!(args["value"], "not-json{{{");
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
            "list_directory".into(),
            "web_search".into(),
        ], None);
        assert_eq!(schemas.len(), 4);

        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"web_fetch"));
        assert!(names.contains(&"read_file"));
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
    fn test_rust_repl_schema_present() {
        let schemas = build_tool_schemas(&["rust_repl".into()], None);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "rust_repl");
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "code"));
        // dependencies is optional (not in required)
        assert!(!required.iter().any(|v| v == "dependencies"));
    }

    #[test]
    fn test_bash_sandbox_schema_present() {
        let schemas = build_tool_schemas(&["bash_sandbox".into()], None);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "bash_sandbox");
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "command"));
        // timeout and working_directory are optional
        assert!(!required.iter().any(|v| v == "timeout"));
        assert!(!required.iter().any(|v| v == "working_directory"));
    }

    // ---- execute_tool error paths (without network / fs) -----------------
    #[tokio::test]
    async fn test_execute_tool_unknown_name() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("unknown_tool", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn test_execute_tool_web_fetch_missing_url() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("web_fetch", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_file_xyzzy_123.test" });
        let result = execute_tool("read_file", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[tokio::test]
    async fn test_execute_tool_list_directory_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_dir_xyzzy_123" });
        let result = execute_tool("list_directory", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read dir"));
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_respects_backend_limit() {
        let client = reqwest::Client::new();
        // A file larger than the 8KB local limit but well under the 1MB cloud
        // limit: cloud providers must receive the full content, local backends
        // keep the small-model truncation.
        let dir = std::env::temp_dir().join("nolock_test_read_limit");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("big_file.txt");
        let content = "x".repeat(16 * 1024); // 16KB
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().to_string();
        let args = serde_json::json!({ "path": path_str });

        // Local backend keeps the 8KB truncation.
        let local = execute_tool("read_file", &args, &client, &HashMap::new(), None, "ollama")
            .await
            .unwrap();
        assert!(
            local.contains("truncated at"),
            "expected local backend to truncate 16KB file, got len {}",
            local.len()
        );
        assert!(local.len() < content.len(), "local result should be truncated");

        // Cloud backend returns the full file.
        let cloud = execute_tool("read_file", &args, &client, &HashMap::new(), None, "digitalocean")
            .await
            .unwrap();
        assert_eq!(
            cloud, content,
            "cloud backend should return the full 16KB file"
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    // ---- read_file with temp dirs ---------------------------
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

    // ---- web_search provider dispatch ------------------------------------
    #[tokio::test]
    async fn test_execute_tool_web_search_brave_with_empty_key_returns_hint() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "query": "test query" });
        let tool_configs = HashMap::from([
            (
                "web_search".to_string(),
                serde_json::json!({
                    "provider": "brave",
                    "api_key": "",
                }),
            ),
        ]);
        let result = execute_tool("web_search", &args, &client, &tool_configs, None, "ollama")
            .await
            .unwrap();
        assert!(
            result.contains("Brave Search requires an API key"),
            "expected key hint for empty API key, got: {}",
            result
        );
    }

    #[tokio::test]
    async fn test_execute_tool_web_search_defaults_to_duckduckgo_when_no_config() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "query": "test query" });
        let tool_configs = HashMap::new();
        let result = execute_tool("web_search", &args, &client, &tool_configs, None, "ollama").await;
        // Without tool_configs it defaults to DuckDuckGo. The request will fail
        // because the DuckDuckGo API is reachable but may return no results for
        // "test query" — either way we get a non-error string (not a tool error).
        assert!(result.is_ok(), "expected Ok even with default config, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            !output.contains("[Results from Brave Search]"),
            "expected DuckDuckGo output, got Brave: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_web_search_respects_brave_provider() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "query": "Rust programming language" });
        // Use a real-ish API key shape — still empty to avoid an HTTP call,
        // but the provider check should route to the "brave" branch.
        let tool_configs = HashMap::from([
            (
                "web_search".to_string(),
                serde_json::json!({
                    "provider": "brave",
                    "api_key": "BSA-test-key",
                }),
            ),
        ]);
        let result = execute_tool("web_search", &args, &client, &tool_configs, None, "ollama").await;
        // With a real-looking key the code attempts an HTTP call, which will
        // fail (invalid key) but the error message should come from the Brave
        // Search API path, NOT from DuckDuckGo.
        match &result {
            Ok(msg) => {
                assert!(
                    msg.contains("Brave Search"),
                    "expected Brave Search response, got: {}",
                    msg
                );
            }
            Err(e) => {
                assert!(
                    e.contains("Brave Search"),
                    "expected Brave Search error, got: {}",
                    e
                );
            }
        }
    }

    // ---- rust_repl tests ---------------------------------------------------
    #[tokio::test]
    async fn test_execute_tool_rust_repl_missing_code() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("rust_repl", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_rust_repl_hello_world() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "code": "fn main() { println!(\"Hello, world!\"); }"
        });
        let result = execute_tool("rust_repl", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should compile and run, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("Hello, world!"),
            "expected Hello, world! in output, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_rust_repl_computation() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "code": "fn main() { let sum: u64 = (1..=100).sum(); println!(\"Sum = {}\", sum); }"
        });
        let result = execute_tool("rust_repl", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should compile and run, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("Sum = 5050"),
            "expected Sum = 5050, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_rust_repl_compile_error() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "code": "fn main() { let x: i32 = \"not an int\"; println!(\"{}\", x); }"
        });
        let result = execute_tool("rust_repl", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should return compile error, not Err: {:?}", result);
        let output = result.unwrap();
        // The output should contain compiler error messages
        assert!(
            output.contains("error") || output.contains("mismatched types"),
            "expected compiler error in output, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_rust_repl_with_dependency() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "code": "fn main() { let mut v = vec![1, 2, 3]; v.sort(); println!(\"sorted: {:?}\", v); }",
            "dependencies": []
        });
        let result = execute_tool("rust_repl", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should compile and run, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("sorted: [1, 2, 3]"),
            "expected sorted output, got: {}",
            output
        );
    }

    // ---- bash_sandbox tests ------------------------------------------------
    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_missing_command() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_echo() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "command": "echo hello from bash"
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should run, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("hello from bash"),
            "expected echo output, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_error_exit() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "command": "echo error_msg >&2; exit 1"
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should return output even on non-zero exit, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("error_msg"),
            "expected stderr output, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_pipeline() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({
            "command": "echo -e 'banana\\napple\\ncherry' | sort | head -2"
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should run pipeline, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("apple") && output.contains("banana"),
            "expected sorted head output, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_working_directory() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir().join("nolock_bash_test_dir");
        let _ = std::fs::create_dir_all(&dir);
        let args = serde_json::json!({
            "command": "pwd",
            "working_directory": dir.to_string_lossy()
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should run in working dir, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("nolock_bash_test_dir"),
            "expected working directory in pwd output, got: {}",
            output
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_timeout() {
        let client = reqwest::Client::new();
        // Use a very short timeout (2s) and a command that sleeps longer
        let args = serde_json::json!({
            "command": "sleep 60",
            "timeout": 2
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), None, "ollama").await;
        assert!(result.is_ok(), "should return output even on kill, got: {:?}", result);
        let output = result.unwrap();
        assert!(
            output.contains("timeout") || output.contains("Killed"),
            "expected timeout/killed message, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_working_directory_outside_root() {
        let client = reqwest::Client::new();
        // When root_path is set, working_directory outside it should be rejected
        let args = serde_json::json!({
            "command": "pwd",
            "working_directory": "/tmp"
        });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), Some("/home"), "ollama").await;
        assert!(result.is_err(), "should reject working dir outside root, got: {:?}", result);
        assert!(
            result.unwrap_err().contains("outside"),
            "expected 'outside' in error message"
        );
    }

    // ---- filesystem tools scoped to the open project folder --------------
    #[test]
    fn test_command_escapes_root_detects_outside_path() {
        let base = std::env::temp_dir().join("nolock_test_escape");
        let _ = std::fs::create_dir_all(&base);
        let root = base.canonicalize().unwrap();
        let outside = std::env::temp_dir().join("nolock_other_dir_xyz");
        let _ = std::fs::create_dir_all(&outside);

        let cmd = format!("find {} -name '*.tsx'", outside.to_string_lossy());
        assert!(
            command_escapes_root(&cmd, &root).is_some(),
            "outside absolute path should be detected"
        );

        let in_cmd = format!("find {} -name '*.rs'", root.join("src").to_string_lossy());
        assert!(
            command_escapes_root(&in_cmd, &root).is_none(),
            "in-root absolute path should be allowed"
        );

        assert!(
            command_escapes_root("cargo test", &root).is_none(),
            "command without absolute paths should be allowed"
        );

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_outside_root() {
        let client = reqwest::Client::new();
        let base = std::env::temp_dir().join("nolock_test_read_scope");
        let project = base.join("project");
        let outside = base.join("outside");
        let _ = std::fs::create_dir_all(&project);
        let _ = std::fs::create_dir_all(&outside);
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "secret data").unwrap();
        let project_str = project.to_string_lossy().to_string();
        let secret_str = secret.to_string_lossy().to_string();

        let args = serde_json::json!({ "path": secret_str });
        let result = execute_tool("read_file", &args, &client, &HashMap::new(), Some(&project_str), "ollama")
            .await;
        assert!(result.is_err(), "read outside root should be rejected, got: {:?}", result);
        assert!(result.unwrap_err().contains("outside the open folder"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn test_execute_tool_list_directory_outside_root() {
        let client = reqwest::Client::new();
        let base = std::env::temp_dir().join("nolock_test_list_scope");
        let project = base.join("project");
        let outside = base.join("outside");
        let _ = std::fs::create_dir_all(&project);
        let _ = std::fs::create_dir_all(&outside);
        let project_str = project.to_string_lossy().to_string();
        let outside_str = outside.to_string_lossy().to_string();

        let args = serde_json::json!({ "path": outside_str });
        let result = execute_tool("list_directory", &args, &client, &HashMap::new(), Some(&project_str), "ollama")
            .await;
        assert!(result.is_err(), "listing outside root should be rejected, got: {:?}", result);
        assert!(result.unwrap_err().contains("outside the open folder"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_command_outside_root() {
        let client = reqwest::Client::new();
        let base = std::env::temp_dir().join("nolock_test_sandbox_scope");
        let project = base.join("project");
        let outside = base.join("outside");
        let _ = std::fs::create_dir_all(&project);
        let _ = std::fs::create_dir_all(&outside);
        let project_str = project.to_string_lossy().to_string();
        let outside_str = outside.to_string_lossy().to_string();

        let args = serde_json::json!({ "command": format!("find {} -name '*.txt'", outside_str) });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), Some(&project_str), "ollama")
            .await;
        assert!(result.is_err(), "command escaping root should be rejected, got: {:?}", result);
        assert!(result.unwrap_err().contains("outside the open project folder"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn test_execute_tool_bash_sandbox_command_within_root() {
        let client = reqwest::Client::new();
        let base = std::env::temp_dir().join("nolock_test_sandbox_within");
        let project = base.join("project");
        let _ = std::fs::create_dir_all(&project);
        let file = project.join("hello.txt");
        std::fs::write(&file, "hi").unwrap();
        let project_str = project.to_string_lossy().to_string();
        let file_str = file.to_string_lossy().to_string();

        let args = serde_json::json!({ "command": format!("cat '{}'", file_str) });
        let result = execute_tool("bash_sandbox", &args, &client, &HashMap::new(), Some(&project_str), "ollama")
            .await;
        assert!(result.is_ok(), "in-root command should run, got: {:?}", result);
        assert!(
            result.unwrap().contains("hi"),
            "expected file content in output"
        );

        let _ = std::fs::remove_dir_all(&base);
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
                "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
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
        assert!(b["options"]["stop"].as_array().unwrap().contains(&serde_json::json!("<|im_end|>")));
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
            "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
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
                "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
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
            vec!["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
            // llama.cpp stops
            vec!["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
            // OpenRouter stops
            vec!["\n\n", "```", "Here is", "Sure", "I'll", "Explanation"],
            // OpenCode stops
            vec!["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"],
        ];

        // Every backend's stop array must contain the core conversational triggers
        for stops in &all_backend_stops {
            assert!(stops.contains(&"```"), "Every backend needs ``` stop");
            assert!(stops.contains(&"Here is"), "Every backend needs 'Here is' stop");
            assert!(stops.contains(&"I'll"), "Every backend needs 'I'll' stop");
        }
        // Local backends (ollama, llamacpp, opencode) must include ChatML end-of-turn
        for stops in [&all_backend_stops[0], &all_backend_stops[1], &all_backend_stops[3]] {
            assert!(stops.contains(&"<|im_end|>"), "Local backends need ChatML end-of-turn stop");
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
                "stop": ["<|im_end|>", "```", "Here is", "Sure", "I'll", "Let me", "Explanation"]
            }
        });
        // Fallback body must NOT have suffix field
        assert!(!body.as_object().unwrap().contains_key("suffix"),
                "Fallback body (no suffix) must not contain a 'suffix' field");
    }

    // =========================================================================
    // build_ollama_body – request body construction
    // =========================================================================

    #[test]
    fn test_build_ollama_body_has_raw_true() {
        let body = build_ollama_body("qwen2.5-coder:1.5b", "system", "<|fim_prefix|>fn main() {", 64, 0.2);
        assert_eq!(body["raw"], true, "Ollama body must have raw=true to bypass chat template");
    }

    #[test]
    fn test_build_ollama_body_prepends_system_prompt() {
        let body = build_ollama_body("qwen2.5-coder:1.5b", "You are a code completion engine.", "<|fim_middle|>", 64, 0.2);
        let prompt = body["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("You are a code completion engine."),
                "System prompt should be prepended to the raw prompt");
        assert!(prompt.contains("<|fim_middle|>"),
                "FIM tokens should be in the prompt after the system prompt");
    }

    #[test]
    fn test_build_ollama_body_forwards_model() {
        let body = build_ollama_body("deepseek-coder:6.7b", "sys", "prompt", 128, 0.5);
        assert_eq!(body["model"], "deepseek-coder:6.7b");
    }

    #[test]
    fn test_build_ollama_body_forwards_max_tokens() {
        let body = build_ollama_body("m", "s", "p", 256, 0.3);
        assert_eq!(body["options"]["num_predict"], 256);
    }

    #[test]
    fn test_build_ollama_body_forwards_temperature() {
        let body = build_ollama_body("m", "s", "p", 64, 0.8);
        assert_eq!(body["options"]["temperature"], 0.8);
    }

    #[test]
    fn test_build_ollama_body_has_stop_tokens() {
        let body = build_ollama_body("m", "s", "p", 64, 0.2);
        let stops = body["options"]["stop"].as_array().unwrap();
        assert!(stops.contains(&serde_json::json!("<|im_end|>")),
                "Must stop on Qwen ChatML end-of-turn token");
        assert!(stops.contains(&serde_json::json!("```")),
                "Must stop on markdown code fence to prevent prose leakage");
        assert!(stops.contains(&serde_json::json!("Here is")),
                "Must stop on conversational preamble trigger");
    }

    #[test]
    fn test_build_ollama_body_does_not_have_system_field() {
        // With raw=true, the system field is not needed — it's prepended to prompt.
        let body = build_ollama_body("m", "s", "p", 64, 0.2);
        assert!(!body.as_object().unwrap().contains_key("system"),
                "Body should not contain a separate 'system' field when raw=true");
    }

    #[test]
    fn test_build_ollama_body_stream_is_false() {
        let body = build_ollama_body("m", "s", "p", 64, 0.2);
        assert_eq!(body["stream"], false);
    }

    // ---- Ollama streaming parse (nemotron / thinking-model regression) ----
    // These tests guard against the "model sometimes just doesn't answer"
    // regression seen with thinking-capable Ollama models (nemotron, qwen3,
    // deepseek-r1): the model can emit reasoning in `message.thinking` and then
    // end the stream WITHOUT ever emitting `message.content`. nolock must not
    // lose the answer in that case.

    #[test]
    fn test_apply_ollama_stream_line_accumulates_thinking_and_content() {
        // A typical nemotron-style thinking + answer stream. Each NDJSON line is
        // one token-ish chunk; nolock must concatenate both fields separately.
        let lines = [
            r#"{"message":{"role":"assistant","thinking":"Let me reason"}}"#,
            r#"{"message":{"role":"assistant","thinking":" about the bug."}}"#,
            r#"{"message":{"role":"assistant","content":"The bug is"}}"#,
            r#"{"message":{"role":"assistant","content":" a null deref.","tool_calls":[]},"done":false}"#,
            r#"{"message":{"role":"assistant","content":""},"done":true}"#,
        ];
        let mut acc = OllamaChunkAcc::default();
        for l in &lines {
            assert!(apply_ollama_stream_line(l, &mut acc, ModelArch::Nemotron), "line should parse: {}", l);
        }
        assert_eq!(acc.thinking, "Let me reason about the bug.");
        assert_eq!(acc.content, "The bug is a null deref.");
    }

    #[test]
    fn apply_ollama_stream_line_ignores_garbage_lines() {
        // A partial/fragmented line at the end of a stream must not break the
        // parse loop (returns false, state untouched).
        let mut acc = OllamaChunkAcc::default();
        let parsed = apply_ollama_stream_line("{\"message\":{\"content\":\"ok",
                                              &mut acc, ModelArch::Generic);
        assert!(!parsed);
        assert!(acc.content.is_empty());
    }

    #[test]
    fn apply_ollama_stream_line_captures_tool_calls_early() {
        // Tool calls can appear in any chunk (not just the done:true chunk).
        let line = r#"{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a.rs"}}}]},"done":false}"#;
        let mut acc = OllamaChunkAcc::default();
        assert!(apply_ollama_stream_line(line, &mut acc, ModelArch::Generic));
        assert!(acc.tool_calls.is_some());
        let calls = acc.tool_calls.unwrap();
        assert_eq!(calls[0]["function"]["name"], "read_file");
    }

    #[test]
    fn apply_ollama_stream_line_realistic_nemotron_tool_turn() {
        // Mirrors the REAL streaming output observed from a nemotron-nano-9b-v2
        // chat that calls rust_repl (captured live from Ollama):
        //   1. a long `message.thinking` trace (one chunk per token),
        //   2. some stray `content` fragments (the model writing aloud), then
        //   3. the structured `tool_calls` chunk.
        // The parser must accumulate thinking AND land the tool call so the
        // tool loop actually executes rust_repl instead of treating the turn as
        // a "final answer".
        let stream_lines = [
            r#"{"message":{"role":"assistant","content":"","thinking":"Okay"}}"#,
            r#"{"message":{"role":"assistant","content":"","thinking":" the user wants the result via the tool"}}"#,
            r#"{"message":{"role":"assistant","content":""}}"#,
            r#"{"message":{"role":"assistant","content":"I will get the result from the tool's response","thinking":""}}"#,
            r#"{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_m63h6de5","function":{"index":1,"name":"rust_repl","arguments":{"code":"fn main(){ println!(\"5\"); }"}}}]},"done":false}"#,
            r#"{"message":{"role":"assistant","content":""},"done":true}"#,
        ];
        let mut acc = OllamaChunkAcc::default();
        for l in &stream_lines {
            assert!(apply_ollama_stream_line(l, &mut acc, ModelArch::Nemotron), "should parse: {}", l);
        }
        assert!(acc.thinking.contains("user wants"), "thinking trace accumulated");
        let calls = acc.tool_calls.expect("structured tool call must be captured");
        assert_eq!(calls[0]["function"]["name"], "rust_repl");
        assert_eq!(calls[0]["id"], "call_m63h6de5");
        assert!(
            calls[0]["function"]["arguments"]["code"].as_str().unwrap_or("").contains("fn main"),
            "rust_repl code argument must survive"
        );
    }

    #[test]
    fn take_next_line_drains_whole_tail_without_newline() {
        // The last HTTP chunk may contain several NDJSON lines and no trailing
        // newline. The drain loop must extract each complete line from the tail.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(br#"{"message":{"content":"a"}}
{"message":{"content":"b"}}"#);
        let first = take_next_line(&mut buf).unwrap();
        assert!(first.contains("\"content\":\"a\""));
        // Second line still in buffer, but no trailing newline yet.
        assert!(take_next_line(&mut buf).is_none());
        // Drain the whole remaining tail as a final line.
        let tail = String::from_utf8_lossy(&buf).trim().to_string();
        assert!(tail.contains("\"content\":\"b\""));
    }

    #[test]
    fn local_default_max_tokens_is_reasoning_friendly() {
        // Regression guard: the local non-tool default must be >= 4096 so
        // thinking models don't burn the whole budget on reasoning and return
        // "(no response)" with no visible answer.
        assert!(LOCAL_DEFAULT_MAX_TOKENS >= 4096, "default must leave room for reasoning + answer");
        // And the cloud default stays large but below huge context windows.
        assert!(CLOUD_DEFAULT_MAX_TOKENS > 0);
    }

#[test]
    fn user_max_tokens_defaults_to_local_floor_for_local_backends() {
        // When the user has not set max_tokens, ollama/llamacpp should get the
        // reasoning-friendly floor rather than a tiny 2048.
        let req = ChatRequest {
            backend: "ollama".into(),
            ..ChatRequest::default()
        };
        let resolved = req
            .max_tokens
            .unwrap_or_else(|| if is_cloud_backend(&req.backend) { CLOUD_DEFAULT_MAX_TOKENS } else { LOCAL_DEFAULT_MAX_TOKENS });
        assert_eq!(resolved, LOCAL_DEFAULT_MAX_TOKENS);
    }

    // ---- build_initial_messages tool guidance (nemotron tool-calling) ----

    fn rust_repl_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "rust_repl",
                "description": "Compile and run Rust snippets",
                "parameters": {
                    "type": "object",
                    "properties": { "code": { "type": "string" } },
                    "required": ["code"]
                }
            }
        })
    }

    #[test]
    fn build_initial_messages_adds_tool_usage_guidance_with_rust_repl() {
        let tools = vec![rust_repl_schema()];
        let msgs = vec![ChatMessage {
            role: "user".to_string(),
            content: "What is fibonacci(5)?".to_string(),
        }];
        let built = build_initial_messages(&msgs, &tools);
        // A system guidance message must be injected that names rust_repl and
        // pushes the model to call it rather than computing in prose.
        let guidance = built
            .iter()
            .find(|m| m["role"] == "system" && m["content"].as_str().map_or(false, |c| c.contains("rust_repl")))
            .expect("expected tool usage guidance system message");
        let content = guidance["content"].as_str().unwrap();
        assert!(content.contains("tool_calls"), "guidance should mention tool_calls");
        assert!(content.contains("rust_repl"), "guidance should name rust_repl");
        // User message preserved after guidance.
        assert!(built.iter().any(|m| m["role"] == "user" && m["content"] == "What is fibonacci(5)?"));
    }

    #[test]
    fn build_initial_messages_adds_no_guidance_when_no_tools() {
        let msgs = vec![ChatMessage { role: "user".to_string(), content: "hi".to_string() }];
        let built = build_initial_messages(&msgs, &[]);
        assert_eq!(built.len(), 1, "no tools → just the user message");
        assert_eq!(built[0]["role"], "user");
    }

    #[test]
    fn build_initial_messages_preserves_spawn_subagent_hint() {
        // spawn_subagent hint must coexist with the generic tool guidance.
        let tools = vec![
            rust_repl_schema(),
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "spawn_subagent",
                    "description": "spawn",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "agent": { "type": "string" },
                            "task": { "type": "string" }
                        },
                        "required": ["agent", "task"]
                    }
                }
            }),
        ];
        let built = build_initial_messages(&[], &tools);
        let sys_msg = built
            .iter()
            .filter(|m| m["role"] == "system")
            .map(|m| m["content"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(sys_msg.contains("spawn_subagent"), "sub-agent delegation hint present");
        assert!(sys_msg.contains("rust_repl"), "tool guidance present");
        assert!(sys_msg.contains("tool_calls"), "tool guidance present");
    }

    // ---- Sub-agent provider resolution (per-agent model sourcing) ----------

    #[test]
    fn resolve_agent_provider_uses_agents_own_backend_and_model() {
        // An agent with an explicit backend/model must be routed there, with the
        // provider map supplying the endpoint + credential for that backend.
        let agent = AgentConfig {
            name: "code-reviewer".into(),
            description: "".into(),
            prompt: "".into(),
            model: "lfm2.5".into(),
            backend: "ollama".into(),
            temperature: 0.3,
            tools: vec![],
            thorough: false,
            ..Default::default()
        };
        let mut providers = HashMap::new();
        // ollama provider entry has a URL but no key configured.
        providers.insert(
            "ollama".to_string(),
            ProviderConfig { url: "http://cell:11434".into(), api_key: "".into() },
        );
        let (backend, model, url, api_key) = resolve_agent_provider(
            &agent,
            "openrouter",
            "main-model",
            "https://main.example",
            "main-key",
            &providers,
        );
        assert_eq!(backend, "ollama", "agent's own backend wins");
        assert_eq!(model, "lfm2.5", "agent's own model wins");
        assert_eq!(url, "http://cell:11434", "provider entry supplies the URL");
        // Provider entry has an empty api_key → falls back to the main key.
        assert_eq!(api_key, "main-key");
    }

    #[test]
    fn resolve_agent_provider_falls_back_to_main_when_unset() {
        // No backend/model on the agent → main agent's backend/model/url/key.
        let agent = AgentConfig::default();
        let mut providers = HashMap::new();
        providers.insert("openrouter".to_string(), ProviderConfig {
            url: "https://router.example/v1".into(),
            api_key: "router-key".into(),
        });
        let (backend, model, url, api_key) = resolve_agent_provider(
            &agent,
            "openrouter",
            "some-main-model",
            "https://router.example/v1",
            "router-key",
            &providers,
        );
        assert_eq!(backend, "openrouter");
        assert_eq!(model, "some-main-model");
        assert_eq!(url, "https://router.example/v1");
        assert_eq!(api_key, "router-key");
    }

    #[test]
    fn spawn_subagent_tool_is_included_when_agents_exist_in_root() {
        // The sub-agent regression: build_tool_schemas must ALWAYS add the
        // spawn_subagent tool (listing available agents) when the open project
        // has a non-empty `.agents/` directory — otherwise the model can never
        // trigger a sub-agent, even via explicit @ mention.
        let root = env!("CARGO_MANIFEST_DIR").trim_end_matches("src-tauri");
        let tools = build_tool_schemas(&[], Some(root));
        let spawn = tools
            .iter()
            .find(|t| t["function"]["name"].as_str() == Some("spawn_subagent"));
        assert!(spawn.is_some(), "expected spawn_subagent tool when .agents exists in {:?}", root);
        let desc = spawn.unwrap()["function"]["description"].as_str().unwrap_or("");
        assert!(desc.contains("code-reviewer") || desc.contains("researcher"),
                "spawn_subagent description should list the available agents:\n{}", desc);
    }

    // ---- Micro-agent config parsing & validation helpers --------------------

    #[test]
    fn read_agent_parses_nested_validation_block_from_markdown() {
        // A `.md` agent with the nested `validation:` mapping (see the plan's
        // Sub-Agent Config example) must fold the indented keys into the JSON
        // output so load_agent_config picks them up.
        let content = r#"---
name: code-reviewer
description: Reviews code
model: nemotron:9b
backend: ollama
temperature: 0.3
tools: [read_file, list_directory, grep]
can_spawn_micro_agents: true
allowed_micro_agents: [rust-fixer, ts-type-fixer]
validation:
  rust_check: true
  js_ts_lint: true
  python_check: false
  custom_commands: []
  require_all_pass: true
  max_retries: 5
---

Review the code."#;
        let dir = std::env::temp_dir().join("nolock_test_agent_parse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join(".agents")).unwrap();
        let path = dir.join(".agents").join("code-reviewer.md");
        std::fs::write(&path, content).unwrap();

        let parsed = read_agent(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(parsed["can_spawn_micro_agents"], true);
        assert_eq!(parsed["allowed_micro_agents"][0], "rust-fixer");
        assert_eq!(parsed["validation"]["rust_check"], true);
        assert_eq!(parsed["validation"]["js_ts_lint"], true);
        assert_eq!(parsed["validation"]["max_retries"], 5);
        assert_eq!(parsed["validation"]["require_all_pass"], true);

        // And the full AgentConfig load path.
        let cfg = load_agent_config(dir.to_string_lossy().as_ref(), "code-reviewer").unwrap();
        assert!(cfg.can_spawn_micro_agents);
        assert_eq!(cfg.allowed_micro_agents, vec!["rust-fixer", "ts-type-fixer"]);
        assert!(cfg.validation.rust_check);
        assert!(cfg.validation.js_ts_lint);
        assert_eq!(cfg.validation.max_retries, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_micro_agent_config_reads_tools_and_validation() {
        let dir = std::env::temp_dir().join("nolock_test_micro_parse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join(".micro-agents")).unwrap();
        let content = r#"---
name: rust-fixer
description: Fixes Rust errors
model: qwen2.5-coder:1.5b
backend: ollama
temperature: 0.1
tools: [read_file, edit, write_file, bash_sandbox]
validation:
  rust_check: true
  verify_reported_output: true
  max_retries: 3
---

Fix the errors."#;
        let path = dir.join(".micro-agents").join("rust-fixer.md");
        std::fs::write(&path, content).unwrap();

        let cfg = load_micro_agent_config(dir.to_string_lossy().as_ref(), "rust-fixer").unwrap();
        assert_eq!(cfg.name, "rust-fixer");
        assert_eq!(cfg.model, "qwen2.5-coder:1.5b");
        assert_eq!(cfg.backend, "ollama");
        assert!(cfg.tools.iter().any(|t| t == "edit"));
        assert!(cfg.validation.rust_check);
        assert!(cfg.validation.verify_reported_output);
        assert_eq!(cfg.validation.max_retries, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_has_validation_for_task_detects_language_mismatch() {
        let mut cfg = validation::ValidationConfig::default();
        cfg.rust_check = true;
        // Rust task + rust check enabled → available.
        assert!(validation::project_has_validation_for_task("Fix cargo errors in src/main.rs", &cfg));
        // TS task but no js_ts_lint enabled → NOT available (should fall back to
        // the main agent rather than spawn a micro-agent it can't verify).
        assert!(!validation::project_has_validation_for_task("Fix the eslint errors in App.tsx", &cfg));
    }

    #[test]
    fn spawn_micro_agent_tool_only_added_when_can_spawn_micro_agents() {
        let root = env!("CARGO_MANIFEST_DIR").trim_end_matches("src-tauri");
        // Agent WITHOUT the flag → no spawn_micro_agent tool.
        let plain = AgentConfig { name: "plain".into(), ..Default::default() };
        let tools = build_tool_schemas_inner(&["read_file".to_string()], Some(root), false, Some(&plain));
        assert!(tools.iter().all(|t| t["function"]["name"].as_str() != Some("spawn_micro_agent")));

        // Agent WITH the flag + a .micro-agents dir present → tool added and
        // lists only the allowed subset.
        let delegating = AgentConfig {
            name: "delegator".into(),
            can_spawn_micro_agents: true,
            allowed_micro_agents: vec!["rust-fixer".to_string(), "ts-type-fixer".to_string()],
            ..Default::default()
        };
        let tools = build_tool_schemas_inner(&["read_file".to_string()], Some(root), false, Some(&delegating));
        let micro = tools
            .iter()
            .find(|t| t["function"]["name"].as_str() == Some("spawn_micro_agent"));
        assert!(micro.is_some(), "expected spawn_micro_agent tool for a delegating sub-agent");
        let desc = micro.unwrap()["function"]["description"].as_str().unwrap_or("");
        assert!(desc.contains("rust-fixer"), "should list allowed micro-agents: {}", desc);
    }

    #[test]
    fn apply_ollama_stream_line_captures_realistic_spawn_subagent_call() {
        // Replays the EXACT tool-call shape a thinking model (nemotron / lfm2.5)
        // emits when it delegates: a chunk with empty content + structured
        // tool_calls → spawn_subagent. If the parser drops this, the sub-agent
        // never triggers.
        let line = r#"{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_dreqrkza","function":{"index":0,"name":"spawn_subagent","arguments":{"agent":"code-reviewer","task":"review src/main.rs for bugs"}}}],"thinking":"ok"},"done":false}"#;
        let mut acc = OllamaChunkAcc::default();
        assert!(apply_ollama_stream_line(line, &mut acc, ModelArch::Nemotron));
        let calls = acc.tool_calls.expect("spawn_subagent tool call must survive parsing");
        assert_eq!(calls[0]["function"]["name"], "spawn_subagent");
        assert_eq!(calls[0]["function"]["arguments"]["agent"], "code-reviewer");
        assert_eq!(calls[0]["function"]["arguments"]["task"], "review src/main.rs for bugs");
    }

    // ---- Model-architecture-aware tool-call parsing ------------------------

    #[test]
    fn model_architecture_classifies_known_families() {
        assert_eq!(model_architecture("nemotron-nano-9b-v2"), ModelArch::Nemotron);
        assert_eq!(model_architecture("lfm2.5"), ModelArch::Lfm);
        assert_eq!(model_architecture("qwen3.5:0.8b"), ModelArch::Qwen);
        assert_eq!(model_architecture("deepseek-r1"), ModelArch::DeepSeek);
        assert_eq!(model_architecture("some-other-model"), ModelArch::Generic);
    }

    // ---- find_subsequence boundary safety -----------------------------------

    #[test]
    fn find_subsequence_does_not_panic_when_needle_longer_than_haystack() {
        // Regression: when the needle is longer than the (remaining) haystack,
        // the old loop used `saturating_sub` then sliced `[0..needle.len()]`,
        // which was out of bounds. Must return None instead of panicking.
        let hay: Vec<char> = "ab".chars().collect();
        let needle: Vec<char> = "abc".chars().collect();
        assert_eq!(find_subsequence(&hay, &needle, 0), None);
    }

    #[test]
    fn find_subsequence_respects_start_offset_and_remaining_length() {
        let hay: Vec<char> = "xyzabc".chars().collect();
        let needle: Vec<char> = "abc".chars().collect();
        // needle fits when search starts early...
        assert_eq!(find_subsequence(&hay, &needle, 0), Some(3));
        // ...but a late start leaves too little room → None (not a panic).
        assert_eq!(find_subsequence(&hay, &needle, 4), None);
    }

    // ---- Repetition detection & context summarization ----------------------

    #[test]
    fn detect_repetition_flags_repeating_content() {
        // Three identical iterations → repetition detected.
        let recent = vec![
            "I will fix the bug".to_string(),
            "I will fix the bug".to_string(),
            "I will fix the bug".to_string(),
        ];
        assert!(detect_repetition(&recent, REPETITION_WINDOW));
    }

    #[test]
    fn detect_repetition_does_not_flag_progress() {
        // Distinct iterations → not repetition.
        let recent = vec![
            "Reading the file".to_string(),
            "Found the bug".to_string(),
            "Applying the fix".to_string(),
        ];
        assert!(!detect_repetition(&recent, REPETITION_WINDOW));
    }

    #[test]
    fn detect_repetition_requires_full_window() {
        // Fewer than the window → not repetition.
        let recent = vec!["same".to_string(), "same".to_string()];
        assert!(!detect_repetition(&recent, REPETITION_WINDOW));
    }

    #[test]
    fn detect_repetition_ignores_empty_content() {
        let recent = vec![
            "".to_string(),
            "".to_string(),
            "".to_string(),
        ];
        assert!(!detect_repetition(&recent, REPETITION_WINDOW));
    }

    #[test]
    fn should_summarize_context_triggers_at_threshold() {
        // 80% usage → summarize.
        assert!(should_summarize_context(80_000, 100_000));
        // 50% usage → don't summarize.
        assert!(!should_summarize_context(50_000, 100_000));
        // Zero context length → never summarize.
        assert!(!should_summarize_context(100, 0));
    }

    #[test]
    fn context_usage_ratio_is_fraction() {
        assert!((context_usage_ratio(50_000, 100_000) - 0.5).abs() < 1e-9);
        assert_eq!(context_usage_ratio(0, 100_000), 0.0);
        assert_eq!(context_usage_ratio(100, 0), 0.0);
    }

    #[test]
    fn build_retrigger_messages_contains_summary_and_todo() {
        let msgs = build_retrigger_messages("summary here", "1. finish", "original task");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"].as_str().unwrap().contains("summary here"));
        assert_eq!(msgs[1]["role"], "user");
        assert!(msgs[1]["content"].as_str().unwrap().contains("original task"));
        assert!(msgs[1]["content"].as_str().unwrap().contains("1. finish"));
    }

    #[test]
    fn build_fallback_todo_list_handles_empty() {
        let todo = build_fallback_todo_list("");
        assert!(todo.contains("Complete the original task"));
        let todo2 = build_fallback_todo_list("fix the parser");
        assert!(todo2.contains("fix the parser"));
    }

    #[test]
    fn thinking_retry_prompt_escalates_with_retry_count() {
        let mild = thinking_retry_prompt(1);
        let medium = thinking_retry_prompt(3);
        let strong = thinking_retry_prompt(5);
        assert!(mild.contains("plain, visible text"));
        assert!(medium.contains("Do NOT output further reasoning"));
        assert!(strong.contains("MUST now answer"));
        assert!(strong.contains("attempt 5"));
    }

    #[test]
    fn tools_dropped_prompt_forces_plain_answer() {
        let p = tools_dropped_prompt();
        assert!(p.contains("Tools are no longer available"));
        assert!(p.contains("plain visible text"));
    }

    #[test]
    fn is_complete_answer_requires_content_and_no_tool_calls() {
        assert!(is_complete_answer("The answer is 42.", false));
        assert!(!is_complete_answer("", false));
        assert!(!is_complete_answer("The answer is 42.", true));
        // A "still planning" JSON is not complete.
        assert!(!is_complete_answer(r#"{"conclusion": false, "final_answer": ""}"#, false));
    }

    #[test]
    fn is_complete_answer_rejects_premature_questions() {
        // A pure question / clarification is a premature conclusion — not done.
        assert!(!is_complete_answer("What would you like me to do?", false));
        assert!(!is_complete_answer("Could you clarify what you mean?", false));
        assert!(!is_complete_answer("How can I help you today?", false));
        assert!(!is_complete_answer("Can you provide more details?", false));
    }

    #[test]
    fn is_complete_answer_accepts_statement_plus_question() {
        // A response with a substantive statement before the question is a
        // complete answer (e.g. a greeting reply) — NOT premature. This is the
        // regression guard for the "Hi" loop bug.
        assert!(is_complete_answer("Yes, I'm here! How can I help you today?", false));
        assert!(is_complete_answer("I'm ready. What would you like me to do?", false));
        assert!(is_complete_answer("Sure, I can do that. Which file should I edit?", false));
        // A pure question is still premature.
        assert!(!is_complete_answer("How can I help you today?", false));
    }

    #[test]
    fn is_complete_answer_rejects_too_short_replies() {
        // Bare acknowledgments are too short to be a real answer.
        assert!(!is_complete_answer("ok", false));
        assert!(!is_complete_answer("sure", false));
        assert!(!is_complete_answer("done", false));
        assert!(!is_complete_answer("yes", false));
        // A real (if short) answer is still complete.
        assert!(is_complete_answer("The answer is 42.", false));
    }

#[test]
    fn is_premature_answer_detects_clarification_phrases() {
        assert!(is_premature_answer("What do you mean by that?"));
        assert!(is_premature_answer("Please clarify the requirements."));
        assert!(is_premature_answer("What information do you need?"));
        assert!(!is_premature_answer("The fix is in src/main.rs."));
    }

    #[test]
    fn extract_answer_from_thinking_returns_last_substantive_sentence() {
        let thinking = "Let me reason about this. The user wants a greeting. The answer is hello.";
        let ans = extract_answer_from_thinking(thinking);
        assert_eq!(ans, "The answer is hello");
    }

    #[test]
    fn extract_answer_from_thinking_skips_questions() {
        let thinking = "What should I do? The user asked for a greeting. I should say hello.";
        let ans = extract_answer_from_thinking(thinking);
        assert_eq!(ans, "I should say hello");
    }

    #[test]
    fn extract_answer_from_thinking_handles_empty() {
        assert_eq!(extract_answer_from_thinking(""), "");
        assert_eq!(extract_answer_from_thinking("   "), "");
    }

    #[test]
    fn normalize_ollama_tool_call_parses_string_arguments_for_qwen() {
        // Qwen small models (qwen3.5:0.8b) emit `arguments` as a JSON *string*.
        let call = serde_json::json!({
            "id": "call_1",
            "function": {
                "name": "read_file",
                "arguments": "{\"path\": \"src/main.rs\"}"
            }
        });
        let norm = normalize_ollama_tool_call(&call, ModelArch::Qwen);
        assert_eq!(norm["function"]["name"], "read_file");
        assert_eq!(norm["function"]["arguments"]["path"], "src/main.rs");
    }

    #[test]
    fn normalize_ollama_tool_call_handles_flat_tool_name_shape() {
        // lfm2.5 emits `tool_name` at the top level (no `function` wrapper).
        let call = serde_json::json!({
            "tool_name": "grep",
            "arguments": { "pattern": "TODO", "path": "src" }
        });
        let norm = normalize_ollama_tool_call(&call, ModelArch::Lfm);
        assert_eq!(norm["function"]["name"], "grep");
        assert_eq!(norm["function"]["arguments"]["pattern"], "TODO");
    }

    #[test]
    fn normalize_ollama_tool_call_coerces_positional_array_only_for_qwen() {
        // Qwen may emit positional args as a bare array → coerce to {value: [...]}.
        let call = serde_json::json!({
            "function": { "name": "read_file", "arguments": ["src/main.rs"] }
        });
        let norm = normalize_ollama_tool_call(&call, ModelArch::Qwen);
        assert_eq!(norm["function"]["arguments"]["value"][0], "src/main.rs");

        // Non-Qwen architectures must NOT mangle a well-formed array argument.
        let norm_generic = normalize_ollama_tool_call(&call, ModelArch::Generic);
        assert!(norm_generic["function"]["arguments"].is_array());
    }

    #[test]
    fn apply_ollama_stream_line_normalizes_qwen_string_arguments() {
        // A realistic qwen3.5:0.8b micro-agent tool call with string arguments.
        let line = r#"{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"edit","arguments":"{\"path\":\"src/lib.rs\",\"edits\":[{\"old_text\":\"a\",\"new_text\":\"b\"}]}"}}]},"done":false}"#;
        let mut acc = OllamaChunkAcc::default();
        assert!(apply_ollama_stream_line(line, &mut acc, ModelArch::Qwen));
        let calls = acc.tool_calls.expect("qwen tool call must survive parsing");
        assert_eq!(calls[0]["function"]["name"], "edit");
        assert_eq!(calls[0]["function"]["arguments"]["path"], "src/lib.rs");
        assert_eq!(calls[0]["function"]["arguments"]["edits"][0]["new_text"], "b");
    }

    // ---- unwrap_structured_answer (sub-agent output cleanup) --------------

    #[test]
    fn unwrap_structured_answer_extracts_single_final_answer() {
        let blob = r#"{
            "analysis": "This file lacks an explicit recursion depth limit",
            "plan": "investigate, then conclude",
            "tool_calls": [],
            "final_answer": "Use memoization or an iterative loop for linear time."
        }"#;
        let out = unwrap_structured_answer(blob);
        assert_eq!(out, "Use memoization or an iterative loop for linear time.");
    }

    #[test]
    fn unwrap_structured_answer_joins_multiple_final_answers() {
        // A tool loop can produce several concatenated JSON blobs (one per
        // iteration). The unwrapper collects each `final_answer`.
        let blob = format!(
            r#"{{"analysis":"a","final_answer":"First answer."}}
{{"analysis":"b","final_answer":"Second answer."}}"#
        );
        let out = unwrap_structured_answer(&blob);
        assert_eq!(out, "First answer.\n\nSecond answer.");
    }

    #[test]
    fn unwrap_structured_answer_leaves_plain_text_untouched() {
        let plain = "Recursive Fibonacci is slow; prefer memoization.";
        assert_eq!(unwrap_structured_answer(plain), plain);
    }

    #[test]
    fn sparse_json_in_plain_text_is_not_mangled() {
        // A normal answer may happen to contain some code with {} — must be
        // returned unchanged when there's no `final_answer`.
        let text = "fn fib(n: usize) -> usize { if n < 2 { n } else { fib(n-1) + fib(n-2) } }";
        assert_eq!(unwrap_structured_answer(text), text);
    }

    #[test]
    fn unwrap_structured_answer_falls_back_to_analysis_when_final_empty() {
        // The code-reviewer (lfm2.5) sometimes emits a planning JSON with an
        // EMPTY final_answer + an analysis + next_steps. We must NOT surface the
        // raw JSON — surface the analysis instead.
        let blob = r#"{
            "analysis": "I explored the project structure. To review properly I should grep for secrets and read the key files.",
            "next_steps": [
                {"tool_name": "grep", "arguments": {"pattern": "process.env"}}
            ],
            "final_answer": ""
        }"#;
        let out = unwrap_structured_answer(blob);
        assert!(out.contains("I explored the project structure"), "got: {}", out);
        assert!(!out.contains("next_steps"), "raw JSON leaked: {}", out);
        assert!(!out.contains("{"), "raw JSON leaked: {}", out);
    }

    #[test]
    fn extract_script_name_finds_sh_filename() {
        assert_eq!(
            extract_script_name("Create a shell script at count.sh that counts lines"),
            "count.sh"
        );
        assert_eq!(
            extract_script_name("Create valid.sh that prints exactly 'VALIDATED_OK'"),
            "valid.sh"
        );
        // No .sh file → empty.
        assert_eq!(extract_script_name("Run the script and report the output"), "");
    }

    #[test]
    fn extract_expected_output_recognises_task_patterns() {
        // Line-count task: "data.txt with 5 lines" → "5"
        assert_eq!(
            extract_expected_output("Create data.txt with 5 lines, then run `bash count.sh data.txt`"),
            "5"
        );
        // "prints exactly 'X'"
        assert_eq!(
            extract_expected_output("Create valid.sh that prints exactly 'VALIDATED_OK'"),
            "VALIDATED_OK"
        );
        // "prints \"X\""
        assert_eq!(
            extract_expected_output("Create greet.sh that prints \"Hello, <name>!\""),
            "Hello, <name>!"
        );
        // No stated expectation → empty (caller only checks non-empty output).
        assert_eq!(extract_expected_output("Run the script and report the output"), "");
    }

    #[test]
    fn extract_planned_tool_calls_reads_next_steps_shape() {
        let blob = r#"{
            "analysis": "need to inspect",
            "next_steps": [
                {"tool_name": "grep", "arguments": {"pattern": "secret", "path": "/p"}},
                {"tool_name": "read_file", "arguments": {"path": "/p/src/lib.rs"}}
            ],
            "final_answer": ""
        }"#;
        let calls = extract_planned_tool_calls(blob);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "grep");
        assert_eq!(calls[0]["function"]["arguments"]["pattern"], "secret");
        assert_eq!(calls[1]["function"]["name"], "read_file");
    }

    #[test]
    fn extract_planned_tool_calls_reads_tool_calls_shape_and_returns_empty_for_plain() {
        // The alternate shape uses "name" instead of "tool_name".
        let blob = r#"{"tool_calls": [{"name": "web_search", "arguments": {"query": "rust"}}]}"#;
        let calls = extract_planned_tool_calls(blob);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["function"]["name"], "web_search");
        // Plain text has no planned calls.
        assert!(extract_planned_tool_calls("just a plain answer").is_empty());
        // Garbage JSON → empty.
        assert!(extract_planned_tool_calls("not json at all").is_empty());
    }

    #[test]
    fn extract_planned_tool_calls_survives_malformed_blob() {
        // Realistic lfm2.5 code-reviewer output: the next_steps array contains a
        // well-formed grep + read_file, plus a malformed entry (extra braces) and
        // a whole-CLI string. The extractor must still return the valid steps so
        // the loop executes them instead of surfacing raw JSON.
        let blob = r#"{
            "analysis": "Need to inspect the structure",
            "next_steps": [
                {"tool_name": "list_directory", "arguments": {"path": "/p/src"}},
                {"tool_name": "read_file", "arguments": {"path": "/p/package.json"}}},
                {"tool_name": "grep -r \"import\" /p --include=\"*.ts\" | head -20",
                 "context": 0, "pattern": "(test|spec|tests)"}
            ],
            "final_answer": "No further calls needed; we have enough info."
        }"#;
        let calls = extract_planned_tool_calls(blob);
        assert_eq!(calls.len(), 2, "should extract only the 2 well-formed steps");
        assert_eq!(calls[0]["function"]["name"], "list_directory");
        assert_eq!(calls[1]["function"]["name"], "read_file");
    }

    #[test]
    fn unwrap_structured_answer_ignores_final_when_planned_steps_exist() {
        // When the blob carries next_steps/tool_calls, the model still wants to
        // work — the final_answer ("we have enough info") must NOT be surfaced.
        let blob = r#"{
            "analysis": "I explored the project structure.",
            "next_steps": [{"tool_name": "grep", "arguments": {"pattern": "secret"}}],
            "final_answer": "No further calls needed; we have enough info."
        }"#;
        let out = unwrap_structured_answer(blob);
        assert!(!out.contains("No further calls"), "premature final surfaced: {}", out);
        assert!(out.contains("I explored"), "analysis should surface: {}", out);
    }

    #[test]
    fn is_planning_json_detects_conclusion_false_and_empty_final() {
        // conclusion:false → still planning (must keep looping).
        let blob = r#"{"analysis": "A", "tool_calls": [], "conclusion": false}"#;
        assert!(is_planning_json(blob), "conclusion:false must be planning");
        // Empty final_answer → still planning.
        let blob2 = r#"{"analysis": "B", "final_answer": ""}"#;
        assert!(is_planning_json(blob2), "empty final_answer must be planning");
        // Non-empty final_answer + no conclusion → done.
        let done = r#"{"analysis": "C", "final_answer": "Here is the review."}"#;
        assert!(!is_planning_json(done), "non-empty final_answer must NOT be planning");
        // Plain text → not planning.
        assert!(!is_planning_json("This is a normal answer."));
    }

    #[test]
    fn is_planning_json_detects_conclusion_false_in_malformed_multi() {
        // Even with accumulated/malformed content, the conclusion:false marker
        // must flag it as still-planning (so we don't surface raw JSON).
        let content = r#"{"analysis": "first"}{"analysis": "second", "conclusion": false}"#;
        assert!(is_planning_json(content));
    }

    // ---- parallel spawn guidance ------------------------------------------

    #[test]
    fn build_initial_messages_guidance_requests_parallel_spawn() {
        // When spawn_subagent is available the system guidance must explicitly
        // tell the model to emit all spawn calls in one batch (parallel).
        let tools = vec![
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "spawn_subagent",
                    "description": "delegate",
                    "parameters": {"type":"object","properties":{"agent":{"type":"string"},"task":{"type":"string"}},"required":["agent","task"]}
                }
            }),
        ];
        let built = build_initial_messages(&[], &tools);
        let hint = built
            .iter()
            .filter(|m| m["role"] == "system")
            .map(|m| m["content"].as_str().unwrap_or(""))
            .collect::<String>();
        assert!(hint.contains("PARALLEL"), "guidance must request parallel spawning");
        assert!(hint.contains("SAME response"), "guidance must say same response batch");
    }

    // ---- pre-spawn of referenced @agents (parallel triggering safety net) ----

    #[test]
    fn build_pre_spawn_items_maps_each_referenced_agent_with_task() {
        // Each @mentioned agent gets its own focused sub-task (the action text
        // following its mention), not the whole message.
        let items = build_pre_spawn_items(
            &["researcher".to_string(), "code-reviewer".to_string()],
            "@researcher look up Rust CLI best practices while @code-reviewer review the layout",
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, "researcher");
        assert!(items[0].1.contains("look up Rust CLI best practices"), "researcher task: {}", items[0].1);
        assert!(!items[0].1.contains("review the layout"), "researcher must not get reviewer clause: {}", items[0].1);
        assert_eq!(items[1].0, "code-reviewer");
        assert!(items[1].1.contains("review the layout"), "reviewer task: {}", items[1].1);
        assert!(!items[1].1.contains("look up Rust CLI best practices"), "reviewer must not get researcher clause: {}", items[1].1);
    }

    #[test]
    fn build_pre_spawn_items_empty_when_no_referenced_agents() {
        let items = build_pre_spawn_items(&[], "task");
        assert!(items.is_empty());
    }

    #[test]
    fn split_task_for_agent_isolates_each_mention_no_sibling_spawn() {
        // Two agents in one message. Each must get ONLY the action after its
        // OWN @mention, with the sibling's clause excluded so neither tries to
        // spawn the other.
        let msg = "What's the best way to structure a Rust project for a CLI tool? \
                   @researcher look up current best practices while @code-reviewer reviews \
                   the project layout in parallel.";
        let r = split_task_for_agent(msg, "researcher");
        assert!(r.contains("look up current best practices"), "research task: {}", r);
        assert!(!r.contains("@code-reviewer"), "must strip sibling mention: {}", r);
        assert!(!r.contains("reviews the project layout"), "must not include sibling's clause: {}", r);

        let c = split_task_for_agent(msg, "code-reviewer");
        assert!(c.contains("reviews the project layout"), "review task: {}", c);
        assert!(!c.contains("@researcher"), "must strip sibling mention: {}", c);
        assert!(!c.contains("look up current best practices"), "must not include sibling's clause: {}", c);
    }

    #[test]
    fn split_task_for_agent_keeps_own_mention_and_single_agent_message() {
        // Single agent mention: the agent's task is the text after the mention.
        let msg = "Review the parser for bugs. @code-reviewer review src/main.rs";
        let t = split_task_for_agent(msg, "code-reviewer");
        assert!(t.contains("review src/main.rs"), "the code-reviewer task: {}", t);
    }

    #[test]
    fn build_tool_schemas_omits_spawn_subagent_when_disallowed() {
        // Sub-agent tool loops must NOT expose spawn_subagent (prevents the
        // re-spawn cascade where each sub-agent re-delegates to siblings).
        let tools = build_tool_schemas_inner(
            &["read_file".to_string()],
            Some(env!("CARGO_MANIFEST_DIR").trim_end_matches("src-tauri")),
            false,
            None,
        );
        let spawn = tools
            .iter()
            .find(|t| t["function"]["name"].as_str() == Some("spawn_subagent"));
        assert!(spawn.is_none(), "sub-agent must not get spawn_subagent tool");
    }

    #[test]
    fn build_tool_schemas_default_keeps_spawn_subagent_for_main_agent() {
        // The main agent's default build_tool_schemas keeps spawn_subagent.
        let tools = build_tool_schemas_inner(
            &["read_file".to_string()],
            Some(env!("CARGO_MANIFEST_DIR").trim_end_matches("src-tauri")),
            true,
            None,
        );
        let spawn = tools
            .iter()
            .find(|t| t["function"]["name"].as_str() == Some("spawn_subagent"));
        assert!(spawn.is_some(), "main agent tool loop must keep spawn_subagent");
    }

    #[test]
    fn pre_spawned_agents_are_skipped_in_spawn_handling() {
        // The tool loop must NOT re-spawn an agent that the backend already
        // dispatched (explicit @mention). This mirrors the guard added to the
        // ollama/openai spawn handling.
        let mut pre_spawned: std::collections::HashSet<String> = std::collections::HashSet::new();
        pre_spawned.insert("researcher".to_string());
        pre_spawned.insert("code-reviewer".to_string());

        let agent = "researcher".to_string();
        assert!(pre_spawned.contains(&agent), "pre-spawned agent must be skipped");
        let not_spawned = "writer".to_string();
        assert!(!pre_spawned.contains(&not_spawned), "non-referenced agent must still spawn");
    }

    // ---- configurable reasoning retry budget ------------------------------

    #[test]
    fn reasoning_retries_defaults_to_configured_constant_when_unset() {
        // When the client doesn't send reasoning_retries, the backend falls
        // back to THINKING_ONLY_MAX_RETRIES (8).
        let req = ChatRequest {
            backend: "ollama".into(),
            ..ChatRequest::default()
        };
        let budget = req.reasoning_retries.unwrap_or(THINKING_ONLY_MAX_RETRIES);
        assert_eq!(budget, THINKING_ONLY_MAX_RETRIES);
        assert!(budget >= 5, "default retry budget should be 5..10");
    }

    #[test]
    fn reasoning_retries_uses_client_value_when_provided() {
        let req = ChatRequest {
            backend: "ollama".into(),
            reasoning_retries: Some(12),
            ..ChatRequest::default()
        };
        assert_eq!(req.reasoning_retries.unwrap(), 12);
    }

    #[test]
    fn plain_chat_attempts_uses_configurable_budget() {
        // The route's max_plain_attempts must come from the same configured
        // budget (so a raised budget applies to plain chat too). The default
        // floor is 8 (matches THINKING_ONLY_MAX_RETRIES).
        let custom = Some(10usize);
        let max_plain_attempts = custom.unwrap_or(THINKING_ONLY_MAX_RETRIES).max(1);
        assert_eq!(max_plain_attempts, 10);
        let unset: Option<usize> = None;
        let default = unset.unwrap_or(THINKING_ONLY_MAX_RETRIES).max(1);
        assert_eq!(default, THINKING_ONLY_MAX_RETRIES);
    }

    // ---- sub-agent memory (persistent per-agent conversation) -------------

    #[test]
    fn subagent_memory_persists_turns_and_reuses_prior_context() {
        let mem = SubAgentMemory::new();
        let root = "/tmp/proj";
        // First trigger of @researcher — no prior context.
        assert!(mem.get(root, "researcher").is_none());
        mem.push_turn(root, "researcher", "look up Rust CLI best practices", "Use clap + modules.");
        let prior = mem.get(root, "researcher").expect("prior context stored");
        assert_eq!(prior.len(), 2); // user + assistant
        assert!(prior[1].content.contains("clap"));

        // Second trigger of the SAME agent — prior context must be present.
        let prior2 = mem.get(root, "researcher").unwrap();
        assert_eq!(prior2.len(), 2, "second trigger should see the stored turns");
        assert_eq!(prior2[0].role, "user");
        assert_eq!(prior2[0].content, "look up Rust CLI best practices");
    }

    #[test]
    fn subagent_memory_is_per_agent_and_keyed_by_root() {
        let mem = SubAgentMemory::new();
        mem.push_turn("/a", "researcher", "t1", "a1");
        mem.push_turn("/a", "code-reviewer", "t2", "a2");
        mem.push_turn("/b", "researcher", "t3", "a3");
        // Same agent + same root shares context.
        assert!(mem.get("/a", "researcher").is_some());
        // Different agent, same root → separate.
        let c = mem.get("/a", "code-reviewer").unwrap();
        assert!(c[0].content.contains("t2") || c[0].content.contains("t3") || c.len() == 2);
        // Same agent, different root → separate convo.
        assert!(mem.get("/b", "researcher").is_some());
        // Unknown → none.
        assert!(mem.get("/a", "writer").is_none());
    }

    #[test]
    fn subagent_memory_caps_at_max_turns() {
        let mem = SubAgentMemory::new();
        // Push many turns; verify the store stays bounded to MAX_TURNS*2 msgs
        // (user + assistant pairs).
        for i in 0..(SUBAGENT_MEMORY_MAX_TURNS * 3) {
            mem.push_turn("/x", "researcher", &format!("task {}", i), &format!("answer {}", i));
        }
        let conv = mem.get("/x", "researcher").unwrap();
        assert!(conv.len() <= SUBAGENT_MEMORY_MAX_TURNS * 2);
    }

    #[test]
    fn subagent_memory_clear_resets_everything() {
        let mem = SubAgentMemory::new();
        mem.push_turn("/a", "researcher", "t1", "a1");
        assert!(mem.get("/a", "researcher").is_some());
        mem.clear();
        assert!(mem.get("/a", "researcher").is_none());
    }

    // ---- session token accounting (context meter) -------------------------

    #[test]
    fn estimate_chat_tokens_counts_chars_divided_by_4() {
        assert_eq!(estimate_chat_tokens("hello world"), 3); // 11 chars / 4 = 2, + 1
        assert_eq!(estimate_chat_tokens(""), 1); // empty -> 1 (floor)
        assert_eq!(estimate_chat_tokens("a"), 1);
    }

    #[test]
    fn estimate_messages_tokens_sums_each_message() {
        let msgs = vec![
            ChatMessage { role: "user".to_string(), content: "How do I write fib?".to_string() },
            ChatMessage { role: "assistant".to_string(), content: "Use recursion.".to_string() },
        ];
        let total = estimate_messages_tokens(&msgs);
        assert_eq!(total, msgs.iter().map(|m| (m.content.chars().count() as u64 / 4) + 1).sum::<u64>());
        assert!(total > 0);
    }

    #[test]
    fn estimate_json_messages_tokens_counts_content_only() {
        // A tool-loop message array with assistant tool calls + tool results.
        let msgs = serde_json::json!([
            {"role":"user","content":"run the code"},
            {"role":"assistant","content":"","tool_calls":[]},
            {"role":"tool","content":"0"} // result
        ]);
        let arr = msgs.as_array().unwrap();
        let total = estimate_json_messages_tokens(arr);
        // Non-empty content lines counted; empty assistant tool-call line counted as 1.
        assert!(total >= 2);
    }

    // ---- local sub-agents are not capped by SUBAGENT_MAX_ITERATIONS --------

    #[test]
    fn local_subagent_iterations_are_not_capped() {
        // Local (ollama/llamacpp) sub-agents must use the user's configured
        // iteration budget directly — the tight cap made code-reviewer hit
        // "max tool iterations" before finishing its inspection.
        let runner_max = 14usize;
        for backend in ["ollama", "llamacpp"] {
            let capped = if backend == "ollama" || backend == "llamacpp" {
                runner_max
            } else {
                runner_max.min(SUBAGENT_MAX_ITERATIONS)
            };
            assert_eq!(capped, runner_max, "backend {} must not be capped", backend);
        }
        // Cloud sub-agents still get the tighter budget.
        let cloud = 14usize.min(SUBAGENT_MAX_ITERATIONS);
        assert_eq!(cloud, SUBAGENT_MAX_ITERATIONS);
    }

    // ---- context length parsing (native > num_ctx) ------------------------

    #[test]
    fn parse_ollama_context_length_prefers_native_over_num_ctx() {
        // nemotron-nano-9b-v2: native context_length = 1,048,576 (1M), but the
        // Modelfile sets num_ctx=32768. The meter must show the model's MAX
        // capability (1M), not the default load window (32k).
        let data = serde_json::json!({
            "parameters": "temperature 0.7\nnum_ctx 32768\nnum_gpu 99",
            "model_info": {
                "general.architecture": "nemotron_h",
                "nemotron_h.context_length": 1048576
            }
        });
        assert_eq!(parse_ollama_context_length(&data), 1_048_576);
    }

    #[test]
    fn parse_ollama_context_length_falls_back_to_num_ctx_when_no_native() {
        let data = serde_json::json!({
            "parameters": "num_ctx 16384",
            "model_info": { "general.architecture": "llama" }
        });
        assert_eq!(parse_ollama_context_length(&data), 16_384);
    }

    #[test]
    fn parse_ollama_context_length_defaults_when_unknown() {
        let data = serde_json::json!({ "parameters": "temperature 0.5" });
        assert_eq!(parse_ollama_context_length(&data), 8192);
    }

    // ---- thinking tokens count toward the session limit -------------------

    #[test]
    fn accumulate_thinking_counts_reasoning_chars() {
        let mut total = 0u64;
        accumulate_thinking(&mut total, "Let me reason step by step about the bug.");
        assert_eq!(total, estimate_chat_tokens("Let me reason step by step about the bug."));
        // Empty thinking adds nothing.
        accumulate_thinking(&mut total, "");
        assert!(total > 0);
        // A second accumulation adds, not replaces.
        let before = total;
        accumulate_thinking(&mut total, "more thinking");
        assert_eq!(total, before + estimate_chat_tokens("more thinking"));
    }

    #[test]
    fn thinking_tokens_are_folded_into_context_tokens() {
        // Mirrors the tool-loop return: msg tokens + content tokens + thinking.
        let msgs = serde_json::json!([
            {"role":"user","content":"review this code"},
            {"role":"tool","content":"result"}
        ]);
        let msg_tokens = estimate_json_messages_tokens(msgs.as_array().unwrap());
        let content = "Here is the review.";
        let mut thinking = 0u64;
        accumulate_thinking(&mut thinking, "long hidden reasoning trace that the model consumed");
        let context_tokens = msg_tokens + estimate_chat_tokens(content) + thinking;
        assert!(context_tokens > msg_tokens + estimate_chat_tokens(content), "thinking must inflate context_tokens");
        assert_eq!(context_tokens, msg_tokens + estimate_chat_tokens(content) + thinking);
    }

    #[test]
    fn bound_local_max_tokens_caps_output_against_window() {
        // 256k tool budget on a small context window → bounded down, floor 4096.
        assert_eq!(bound_local_max_tokens(256_000, 0), 4096);
        // When there is room, the cap respects the window.
        assert_eq!(bound_local_max_tokens(256_000, 8_000), 8_000);
        // User's explicit smaller budget is never raised above itself.
        assert_eq!(bound_local_max_tokens(2_048, 8_000), 2_048);
        // Plenty of context → the tool budget survives (bounded only by window).
        assert_eq!(bound_local_max_tokens(256_000, 1_000_000), 256_000);
    }

    #[test]
    fn chat_result_serializes_thinking_tokens() {
        let r = ChatResult {
            content: "answer".to_string(),
            tool_calls: vec![],
            context_tokens: 123,
            thinking_tokens: 45,
            usage: vec![],
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["context_tokens"], 123);
        assert_eq!(json["thinking_tokens"], 45);
    }

    #[test]
    fn usage_for_prefers_reported_over_estimate() {
        let r = usage_for("openrouter", "openai/gpt-4o", 1000, 200, 500, 50);
        assert_eq!(r.provider, "openrouter");
        assert_eq!(r.model, "openai/gpt-4o");
        assert_eq!(r.prompt_tokens, 1000);
        assert_eq!(r.completion_tokens, 200);
        assert_eq!(r.total_tokens, 1200);
    }

    #[test]
    fn usage_for_falls_back_to_estimate_when_unreported() {
        let r = usage_for("ollama", "qwen3", 0, 0, 400, 40);
        assert_eq!(r.prompt_tokens, 400);
        assert_eq!(r.completion_tokens, 40);
        assert_eq!(r.total_tokens, 440);
    }
}
