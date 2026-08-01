// ---------------------------------------------------------------------------
// Hooks — project-local automation rules stored as YAML files in `.hooks/`.
//
// A hook defines a trigger (a CLI command prefix, a cron schedule, or a manual
// signal) and an agent run to execute when the trigger fires. Hook agents may
// reference an existing `.agents/` file, an inline system prompt, skills from
// `.skills/`, and an explicit set of tools.
//
// File format (`.hooks/<name>.yaml`):
// ```yaml
// name: commit-review
// description: Review staged changes and suggest a commit message.
// trigger:
//   type: command        # command | cron
//   command: git commit
//   # type: cron
//   # schedule: "0 9 * * 1-5"
// agent:
//   name: code-reviewer  # optional: reuse an existing agent prompt
//   prompt: |            # optional: inline system prompt
//     You are a commit-review hook...
//   skills: [code-review]
//   tools: [read_file, grep]
// ```
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum HookTrigger {
    /// Fire on a repeating schedule. `schedule` is a 5-field cron expression:
    /// `minute hour day-of-month month day-of-week`.
    Cron { schedule: String },
    /// Fire after a CLI command whose leading words match `command`.
    Command { command: String },
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HookAgent {
    /// Name of an existing agent in `.agents/`. When set, its system prompt is used.
    pub name: String,
    /// Inline system prompt for the hook run. Takes precedence over `name`.
    pub prompt: String,
    /// Skill names from `.skills/` to inject into the run context.
    pub skills: Vec<String>,
    /// Explicit tool ids to enable for the run. Empty = use the user's enabled tools.
    pub tools: Vec<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct HookConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub trigger: HookTrigger,
    #[serde(default)]
    pub agent: HookAgent,
}

#[derive(serde::Serialize)]
pub struct HookEntry {
    pub name: String, // file stem (e.g. "commit-review" from "commit-review.yaml")
    pub path: String, // full path to the file
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn hooks_dir(root_path: &str) -> PathBuf {
    Path::new(root_path).join(".hooks")
}

/// List all hook files in the `.hooks/` directory under root_path.
/// Creates `.hooks/` if it does not exist. Supports `.yaml` and `.yml`.
#[tauri::command]
pub fn list_hooks(root_path: String) -> Result<Vec<HookEntry>, String> {
    let dir = hooks_dir(&root_path);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create .hooks directory: {}", e))?;
        return Ok(Vec::new());
    }

    let read_dir =
        std::fs::read_dir(&dir).map_err(|e| format!("Failed to read .hooks directory: {}", e))?;

    let mut entries: Vec<HookEntry> = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if metadata.is_file() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let stem = if file_name.ends_with(".yaml") {
                file_name
                    .strip_suffix(".yaml")
                    .unwrap_or(&file_name)
                    .to_string()
            } else if file_name.ends_with(".yml") {
                file_name
                    .strip_suffix(".yml")
                    .unwrap_or(&file_name)
                    .to_string()
            } else {
                continue;
            };
            entries.push(HookEntry {
                name: stem,
                path: entry.path().to_string_lossy().to_string(),
            });
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

/// Read and parse a hook file by its full path.
#[tauri::command]
pub fn read_hook(path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read hook file {}: {}", path, e))?;
    let config: HookConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse hook file {}: {}", path, e))?;
    serde_json::to_value(&config).map_err(|e| format!("Failed to serialize hook {}: {}", path, e))
}

/// Validate a hook name — must be a non-empty filename-safe identifier.
fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Hook name is required.".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Hook name may only contain letters, numbers, '-', '_' and '.'".to_string());
    }
    Ok(())
}

/// Serialize a hook config to a `.hooks/<name>.yaml` file (creating/overwriting).
#[tauri::command]
pub fn save_hook(
    root_path: String,
    name: String,
    config: serde_json::Value,
) -> Result<String, String> {
    validate_name(&name)?;
    let trimmed = name.trim().to_string();

    let mut hook: HookConfig =
        serde_json::from_value(config).map_err(|e| format!("Invalid hook config: {}", e))?;
    hook.name = trimmed.clone();

    let dir = hooks_dir(&root_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create .hooks directory: {}", e))?;

    let yaml =
        serde_yaml::to_string(&hook).map_err(|e| format!("Failed to serialize hook: {}", e))?;
    let path = dir.join(format!("{}.yaml", trimmed));
    std::fs::write(&path, yaml)
        .map_err(|e| format!("Failed to write hook {}: {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push("nolock_hooks_test");
        path.push(name);
        let _ = std::fs::remove_dir_all(&path);
        let _ = std::fs::create_dir_all(&path);
        path
    }

    #[test]
    fn test_parse_command_hook() {
        let yaml = r#"
name: commit-review
description: Review staged changes.
trigger:
  type: command
  command: git commit
agent:
  name: code-reviewer
  skills:
    - code-review
  tools:
    - read_file
    - grep
"#;
        let config: HookConfig = serde_yaml::from_str(yaml).expect("parse");
        assert_eq!(config.name, "commit-review");
        assert_eq!(config.description, "Review staged changes.");
        match config.trigger {
            HookTrigger::Command { command } => assert_eq!(command, "git commit"),
            _ => panic!("expected command trigger"),
        }
        assert_eq!(config.agent.name, "code-reviewer");
        assert_eq!(config.agent.skills, vec!["code-review"]);
        assert_eq!(config.agent.tools, vec!["read_file", "grep"]);
    }

    #[test]
    fn test_parse_cron_hook() {
        let yaml = r#"
name: daily-report
trigger:
  type: cron
  schedule: "0 9 * * 1-5"
agent:
  prompt: "Generate the daily standup summary."
"#;
        let config: HookConfig = serde_yaml::from_str(yaml).expect("parse");
        match config.trigger {
            HookTrigger::Cron { schedule } => assert_eq!(schedule, "0 9 * * 1-5"),
            _ => panic!("expected cron trigger"),
        }
        assert_eq!(config.agent.prompt, "Generate the daily standup summary.");
        assert!(config.agent.skills.is_empty());
    }

    #[test]
    fn test_save_and_read_roundtrip() {
        let dir = test_dir("roundtrip");
        let root = dir.to_string_lossy().to_string();
        let config = serde_json::json!({
            "name": "commit-review",
            "description": "Review staged changes.",
            "trigger": { "type": "command", "command": "git commit" },
            "agent": {
                "name": "code-reviewer",
                "prompt": "",
                "skills": ["code-review"],
                "tools": ["read_file", "grep"]
            }
        });

        let path = save_hook(root.clone(), "commit-review".to_string(), config).expect("save");
        assert!(std::path::Path::new(&path).exists());

        let value = read_hook(path.clone()).expect("read");
        assert_eq!(value["name"], "commit-review");
        assert_eq!(value["description"], "Review staged changes.");
        assert_eq!(value["trigger"]["type"], "command");
        assert_eq!(value["trigger"]["command"], "git commit");
        assert_eq!(value["agent"]["name"], "code-reviewer");
        assert_eq!(value["agent"]["skills"][0], "code-review");

        // The saved file should be valid YAML matching our format
        let raw = std::fs::read_to_string(&path).expect("read raw");
        assert!(raw.contains("type: command"));
        assert!(raw.contains("command: git commit"));

        // list_hooks should return the entry
        let entries = list_hooks(root.clone()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "commit-review");
    }

    #[test]
    fn test_save_multiline_prompt_roundtrip() {
        let dir = test_dir("multiline");
        let root = dir.to_string_lossy().to_string();
        let prompt = "Line one\nLine two\n\nParagraph two.";
        let config = serde_json::json!({
            "name": "doc-writer",
            "description": "",
            "trigger": { "type": "cron", "schedule": "0 8 * * *" },
            "agent": { "prompt": prompt, "skills": [], "tools": [] }
        });
        let path = save_hook(root.clone(), "doc-writer".to_string(), config).expect("save");
        let value = read_hook(path).expect("read");
        assert_eq!(value["agent"]["prompt"], prompt);
    }

    #[test]
    fn test_save_rejects_empty_name() {
        let dir = test_dir("empty_name");
        let root = dir.to_string_lossy().to_string();
        let config = serde_json::json!({
            "name": "",
            "description": "",
            "trigger": { "type": "command", "command": "git commit" },
            "agent": { "prompt": "", "skills": [], "tools": [] }
        });
        let result = save_hook(root.clone(), "  ".to_string(), config);
        assert!(result.is_err());
    }

    #[test]
    fn test_save_rejects_invalid_name() {
        let dir = test_dir("invalid_name");
        let root = dir.to_string_lossy().to_string();
        let config = serde_json::json!({
            "name": "bad/name",
            "description": "",
            "trigger": { "type": "command", "command": "git commit" },
            "agent": { "prompt": "", "skills": [], "tools": [] }
        });
        let result = save_hook(root.clone(), "bad/name".to_string(), config);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_creates_dir() {
        let dir = test_dir("creates_dir");
        let root = dir.to_string_lossy().to_string();
        // .hooks does not exist yet
        assert!(!hooks_dir(&root).exists());
        let entries = list_hooks(root.clone()).expect("list");
        assert!(entries.is_empty());
        assert!(hooks_dir(&root).exists());
    }
}
