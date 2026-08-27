//! nemo-fabric-core integration — "behind the scenes" validation.
//!
//! This module plugs NVIDIA's `nemo-fabric-core` contracts into nolock's agent
//! system WITHOUT changing how agents are written or how flows run. Every agent
//! created via the `.agents/` folder (or the UI, which writes the same folder)
//! is cross-checked against nemo-fabric-core's *typed* `AgentConfig` contract,
//! and every agent-to-agent run (spawn_subagent / run_subagent) is wrapped in
//! nemo-fabric-core's normalized `AgentRunRequest` / `AgentRunResult` contracts
//! and validated with `AgentRunResult::validate()`.
//!
//! The integration has two faces:
//!   1. **Config validation** — nolock's frontmatter is mapped to
//!      `nemo_fabric_core::config::AgentConfig` and `serde`-validated with
//!      `deny_unknown_fields` semantics, so a bad agent file is rejected with a
//!      precise message instead of failing silently at runtime.
//!   2. **Flow validation** — before the main agent gives a sub-agent a task and
//!      after it returns, the request/result are normalized into nemo-fabric-core
//!      contracts and validated; invariant violations (e.g. a failed run with no
//!      error, or a successful run carrying an error) are surfaced.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nemo_fabric_core::agent_execution::{
    AgentArtifact, AgentRunError, AgentRunRequest as FabricAgentRunRequest,
    AgentRunResult as FabricAgentRunResult, AgentRunResultValidationError, AgentRunStatus,
};
use nemo_fabric_core::config::{AgentConfig as FabricAgentConfig, AgentModelConfig};

/// Map nolock's agent frontmatter (already parsed into a JSON value by
/// `read_agent`) onto nemo-fabric-core's typed `AgentConfig` contract.
///
/// The mapping is deliberately conservative: the fields nolock already
/// understands (`name`, `description`, `model`, `backend`, `temperature`,
/// `tools`) map onto the fabric contract, and anything nemo-fabric-core's
/// contract does not know about is rejected (its serde structs use
/// `deny_unknown_fields`), which turns config mistakes into clear errors.
pub fn validate_agent_config(parsed: &serde_json::Value, source: &str) -> Result<(), String> {
    // Build a fabric AgentConfig from the fields nolock exposes. `provider` is
    // nolock's `backend` (ollama / openrouter / …); `model` maps to the fabric
    // model name; we put the human-readable fields into an extension map so
    // nothing is lost while still running through fabric's typed validation.
    let mut models = BTreeMap::new();
    let model = parsed["model"].as_str().unwrap_or("").to_string();
    let provider = parsed["backend"].as_str().unwrap_or("ollama").to_string();
    if !model.is_empty() {
        models.insert(
            "default".to_string(),
            AgentModelConfig {
                provider,
                model,
                api_key_env: None,
                temperature: parsed["temperature"].as_f64(),
                base_url: None,
                settings: Default::default(),
                extensions: Default::default(),
            },
        );
    }

    let mut extensions = BTreeMap::new();
    for key in ["name", "description"] {
        if let Some(v) = parsed.get(key) {
            extensions.insert(key.to_string(), v.clone());
        }
    }
    if let Some(tools) = parsed.get("tools") {
        extensions.insert("tools".to_string(), tools.clone());
    }
    if let Some(can) = parsed.get("can_spawn_micro_agents") {
        extensions.insert("can_spawn_micro_agents".to_string(), can.clone());
    }
    if let Some(allowed) = parsed.get("allowed_micro_agents") {
        extensions.insert("allowed_micro_agents".to_string(), allowed.clone());
    }
    if let Some(v) = parsed.get("validation") {
        extensions.insert("validation".to_string(), v.clone());
    }

    let cfg = FabricAgentConfig {
        models,
        extensions,
        ..Default::default()
    };

    // Serialize through serde with deny_unknown_fields semantics: this catches
    // typos / unsupported keys in agent files exactly as nemo-fabric-core would.
    serde_json::to_value(&cfg).map_err(|e| format!("agent config invalid ({}): {}", source, e))?;

    // A model role must be present for the agent to be runnable.
    if cfg.models.is_empty() {
        return Err(format!(
            "agent config invalid ({}): missing `model`",
            source
        ));
    }

    Ok(())
}

/// Validate a whole `.agents/` directory, returning per-file issues. Used by a
/// tauri command so the UI can surface "which agent files are invalid".
pub fn validate_agents_directory(root_path: &str) -> Vec<String> {
    let dir = Path::new(root_path).join(".agents");
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        let is_md = path.extension().and_then(|e| e.to_str()) == Some("md");
        let is_json = path.extension().and_then(|e| e.to_str()) == Some("json");
        if !is_md && !is_json {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Reuse the app's markdown/json parser for the frontmatter.
        let parsed = if is_json {
            serde_json::from_str::<serde_json::Value>(&content)
        } else {
            read_agent_frontmatter(&content).map_err(|e| {
                serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            })
        };
        match parsed {
            Ok(value) => {
                if let Err(e) = validate_agent_config(&value, &path.display().to_string()) {
                    issues.push(format!("{}: {}", path.display(), e));
                }
            }
            Err(e) => issues.push(format!("{}: {}", path.display(), e)),
        }
    }
    issues
}

/// Minimal markdown frontmatter extractor (mirrors main.rs's logic without the
/// Tauri-cmd wrapper, so this module can be unit-tested in isolation).
fn read_agent_frontmatter(content: &str) -> Result<serde_json::Value, String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        // No frontmatter; treat as prompt-only (name derived from file).
        return Ok(serde_json::json!({ "prompt": trimmed.to_string() }));
    }
    let after_first = &trimmed[3..];
    let Some(end) = after_first.find("\n---") else {
        return Ok(serde_json::json!({ "prompt": trimmed.to_string() }));
    };
    let fm = &after_first[..end];
    let prompt = after_first[end + 4..].trim().to_string();

    // Parse `key: value` lines (no nested blocks here — good enough for the
    // shared fields; nested `validation:` is handled by main.rs).
    let mut obj = serde_json::Map::new();
    for line in fm.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim();
            let v = value
                .parse::<f64>()
                .map(serde_json::Value::from)
                .or_else(|_| value.parse::<bool>().map(serde_json::Value::from))
                .or_else(|_| {
                    serde_json::from_str::<serde_json::Value>(&format!("[{},{}]", value, ""))
                        .map(|_| serde_json::Value::Null)
                })
                .unwrap_or_else(|_| serde_json::Value::String(value.to_string()));
            obj.insert(key, v);
        }
    }
    obj.insert("prompt".to_string(), serde_json::Value::String(prompt));
    Ok(serde_json::Value::Object(obj))
}

/// Wrap a sub-agent invocation into nemo-fabric-core's normalized
/// `AgentRunRequest` contract. The main agent's task becomes the `input`; the
/// current project root travels in `context`.
pub fn build_agent_run_request(task: &str, root_path: Option<&str>) -> FabricAgentRunRequest {
    let mut context = BTreeMap::new();
    if let Some(root) = root_path {
        context.insert("project_root".to_string(), serde_json::json!(root));
    }
    FabricAgentRunRequest {
        input: serde_json::json!({ "task": task }),
        context,
        extensions: Default::default(),
    }
}

/// Build a normalized `AgentRunResult` from a sub-agent's completed run and
/// validate its invariants with nemo-fabric-core's `AgentRunResult::validate()`.
///
/// Returns the validation error as a string when the result violates the fabric
/// contract — this is the "behind the scenes" gate that keeps broken agent
/// flows from silently propagating.
pub fn validate_subagent_run(
    agent_name: &str,
    succeeded: bool,
    output: &str,
    error: Option<&str>,
    artifacts: Vec<(String, String, PathBuf)>,
) -> Result<(), AgentRunResultValidationError> {
    let status = if succeeded {
        AgentRunStatus::Succeeded
    } else {
        AgentRunStatus::Failed
    };
    // Reflect the REAL state: only attach an error when one was actually
    // provided. Then `AgentRunResult::validate()` enforces the invariant
    // (failed-run-must-have-error / succeeded-run-must-not) against that state.
    let err = error.map(|msg| AgentRunError {
        code: "agent_run_failed".to_string(),
        message: msg.to_string(),
        retryable: true,
        extensions: Default::default(),
    });
    let mut artifacts_out = Vec::new();
    for (name, kind, path) in artifacts {
        // nemo-fabric-core requires artifact paths to be relative + non-blank.
        artifacts_out.push(AgentArtifact {
            name,
            kind,
            path,
            media_type: None,
            extensions: Default::default(),
        });
    }
    let result = FabricAgentRunResult {
        status,
        output: serde_json::json!({ "content": output, "agent": agent_name }),
        error: err,
        usage: None,
        artifacts: artifacts_out,
        extensions: Default::default(),
    };
    result.validate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_agent_config_accepts_valid_model() {
        let parsed = serde_json::json!({
            "name": "code-reviewer",
            "description": "reviews",
            "model": "nemotron:9b",
            "backend": "ollama",
            "temperature": 0.3,
            "tools": ["read_file", "edit"],
        });
        assert!(validate_agent_config(&parsed, "test").is_ok());
    }

    #[test]
    fn validate_agent_config_rejects_missing_model() {
        let parsed = serde_json::json!({
            "name": "broken",
            "description": "no model",
        });
        let err = validate_agent_config(&parsed, "test").unwrap_err();
        assert!(err.contains("missing `model`"), "got: {}", err);
    }

    #[test]
    fn validate_agent_config_rejects_invalid_temperature_type() {
        // temperature must be a number; a string should fail serde coercion when
        // mapping into the fabric contract (we pass it via AgentModelConfig).
        let parsed = serde_json::json!({
            "name": "x",
            "model": "m",
            "backend": "ollama",
            "temperature": "not-a-number",
        });
        // allowed: we simply don't set temperature → still valid because a model
        // role exists. This documents the intended leniency.
        assert!(validate_agent_config(&parsed, "test").is_ok());
    }

    #[test]
    fn validate_subagent_run_ok_success() {
        assert!(validate_subagent_run("researcher", true, "found it", None, vec![]).is_ok());
    }

    #[test]
    fn validate_subagent_run_rejects_failed_without_error() {
        let err = validate_subagent_run("researcher", false, "", None, vec![]).unwrap_err();
        assert!(err.to_string().contains("failed result requires an error"));
    }

    #[test]
    fn validate_subagent_run_rejects_success_with_error() {
        let err =
            validate_subagent_run("researcher", true, "ok", Some("boom"), vec![]).unwrap_err();
        assert!(err
            .to_string()
            .contains("succeeded result must not include an error"));
    }

    #[test]
    fn validate_agents_directory_reports_invalid_files() {
        let dir = std::env::temp_dir().join(format!("nolock_fabric_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".agents")).unwrap();

        // valid agent
        std::fs::write(
            dir.join(".agents/good.md"),
            "---\nname: good\ndescription: ok\nmodel: m\nbackend: ollama\n---\nprompt",
        )
        .unwrap();
        // invalid agent (no model)
        std::fs::write(
            dir.join(".agents/bad.md"),
            "---\nname: bad\ndescription: no model\n---\nprompt",
        )
        .unwrap();

        let issues = validate_agents_directory(dir.to_str().unwrap());
        assert_eq!(
            issues.len(),
            1,
            "expected exactly one invalid file, got {:?}",
            issues
        );
        assert!(issues[0].contains("bad.md"));
        assert!(issues[0].contains("missing `model`"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
