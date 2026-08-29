//! Deterministic validation pipeline for micro-agents
//!
//! This module provides validation commands that can be run against
//! code changes to ensure they pass compiler checks, linters, etc.

use std::process::Command;
use std::path::Path;

/// Result of a single validation check
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidationResult {
    pub name: String,
    pub passed: bool,
    pub output: String,
    pub error: Option<String>,
}

/// Configuration for validation checks
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidationConfig {
    pub rust_check: bool,
    pub js_ts_lint: bool,
    pub python_check: bool,
    pub go_check: bool,
    pub custom_commands: Vec<String>,
    /// Optional expected-output substrings, parallel to `custom_commands`.
    /// When an entry is non-empty, the corresponding custom command only
    /// PASSES if its stdout contains that substring (in addition to a zero
    /// exit code). This catches "the command ran but produced the wrong
    /// answer" (e.g. `wc -l` returning 4 instead of 5).
    pub custom_commands_expected: Vec<String>,
    /// When true, the micro-agent runner re-runs the last `bash_sandbox`
    /// command the micro-agent executed and requires it to produce non-empty
    /// output. This is a generic self-consistency check for script-running
    /// agents (e.g. shell-runner): it catches "the command failed" and
    /// "the command produced no output" even when the agent's own validation
    /// config has no task-specific command to assert.
    pub verify_reported_output: bool,
    pub require_all_pass: bool,
    pub max_retries: usize,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            rust_check: false,
            js_ts_lint: false,
            python_check: false,
            go_check: false,
            custom_commands: Vec::new(),
            custom_commands_expected: Vec::new(),
            verify_reported_output: false,
            require_all_pass: true,
            max_retries: 3,
        }
    }
}

/// Run all validations for the given configuration and changed files
pub async fn run_validations(
    root_path: &str,
    config: &ValidationConfig,
    _changed_files: &[String],
) -> Vec<ValidationResult> {
    let mut results = Vec::new();

    if config.rust_check {
        results.push(run_cargo_check(root_path).await);
    }

    if config.js_ts_lint {
        results.push(run_js_ts_lint(root_path).await);
    }

    if config.python_check {
        results.push(run_python_check(root_path).await);
    }

    if config.go_check {
        results.push(run_go_check(root_path).await);
    }

    for (i, cmd) in config.custom_commands.iter().enumerate() {
        let expected = config
            .custom_commands_expected
            .get(i)
            .map(|s| s.as_str())
            .unwrap_or("");
        results.push(run_custom_command(root_path, cmd, expected).await);
    }

    results
}

/// Run `cargo check --workspace` for Rust validation
async fn run_cargo_check(root_path: &str) -> ValidationResult {
    let output = Command::new("cargo")
        .args(["check", "--workspace"])
        .current_dir(root_path)
        .output();

    match output {
        Ok(out) => ValidationResult {
            name: "cargo check".to_string(),
            passed: out.status.success(),
            output: String::from_utf8_lossy(&out.stdout).to_string(),
            error: if out.status.success() {
                None
            } else {
                Some(String::from_utf8_lossy(&out.stderr).to_string())
            },
        },
        Err(e) => ValidationResult {
            name: "cargo check".to_string(),
            passed: false,
            output: String::new(),
            error: Some(format!("Failed to execute cargo check: {}", e)),
        },
    }
}

/// Run `npm run lint && tsc --noEmit` for TypeScript/JavaScript validation
async fn run_js_ts_lint(root_path: &str) -> ValidationResult {
    // First run npm run lint
    let lint_output = Command::new("npm")
        .args(["run", "lint"])
        .current_dir(root_path)
        .output();

    let lint_passed = lint_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let lint_stdout = lint_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let lint_stderr = lint_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    // Then run tsc --noEmit
    let tsc_output = Command::new("npx")
        .args(["tsc", "--noEmit"])
        .current_dir(root_path)
        .output();

    let tsc_passed = tsc_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let tsc_stdout = tsc_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let tsc_stderr = tsc_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    let passed = lint_passed && tsc_passed;
    let mut output = String::new();
    let mut error = None;

    if !lint_passed {
        output.push_str(&lint_stdout);
        output.push_str(&lint_stderr);
        error = Some("npm run lint failed".to_string());
    }
    if !tsc_passed {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&tsc_stdout);
        output.push_str(&tsc_stderr);
        error = Some("tsc --noEmit failed".to_string());
    }

    ValidationResult {
        name: "js/ts lint + typecheck".to_string(),
        passed,
        output,
        error,
    }
}

/// Run `ruff check . && python -m py_compile` for Python validation
async fn run_python_check(root_path: &str) -> ValidationResult {
    // First run ruff check
    let ruff_output = Command::new("ruff")
        .args(["check", "."])
        .current_dir(root_path)
        .output();

    let ruff_passed = ruff_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let ruff_stdout = ruff_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let ruff_stderr = ruff_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    // Then run python -m py_compile on all .py files
    let py_compile_output = Command::new("python")
        .args(["-m", "py_compile"])
        .current_dir(root_path)
        .output();

    let py_passed = py_compile_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let py_stdout = py_compile_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let py_stderr = py_compile_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    let passed = ruff_passed && py_passed;
    let mut output = String::new();
    let mut error = None;

    if !ruff_passed {
        output.push_str(&ruff_stdout);
        output.push_str(&ruff_stderr);
        error = Some("ruff check failed".to_string());
    }
    if !py_passed {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&py_stdout);
        output.push_str(&py_stderr);
        error = Some("python -m py_compile failed".to_string());
    }

    ValidationResult {
        name: "python check".to_string(),
        passed,
        output,
        error,
    }
}

/// Run `go build ./... && go vet ./...` for Go validation
async fn run_go_check(root_path: &str) -> ValidationResult {
    // First run go build
    let build_output = Command::new("go")
        .args(["build", "./..."])
        .current_dir(root_path)
        .output();

    let build_passed = build_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let build_stdout = build_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let build_stderr = build_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    // Then run go vet
    let vet_output = Command::new("go")
        .args(["vet", "./..."])
        .current_dir(root_path)
        .output();

    let vet_passed = vet_output.as_ref().map(|o| o.status.success()).unwrap_or(false);
    let vet_stdout = vet_output.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let vet_stderr = vet_output.as_ref().map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();

    let passed = build_passed && vet_passed;
    let mut output = String::new();
    let mut error = None;

    if !build_passed {
        output.push_str(&build_stdout);
        output.push_str(&build_stderr);
        error = Some("go build failed".to_string());
    }
    if !vet_passed {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&vet_stdout);
        output.push_str(&vet_stderr);
        error = Some("go vet failed".to_string());
    }

    ValidationResult {
        name: "go check".to_string(),
        passed,
        output,
        error,
    }
}

/// Run a custom validation command. When `expected_output` is non-empty, the
/// check additionally requires the command's stdout to contain that substring —
/// a zero exit code alone is not enough (the command may have run but produced
/// the wrong answer, e.g. `wc -l` returning 4 instead of 5).
async fn run_custom_command(root_path: &str, command: &str, expected_output: &str) -> ValidationResult {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return ValidationResult {
            name: format!("custom: {}", command),
            passed: false,
            output: String::new(),
            error: Some("Empty command".to_string()),
        };
    }

    let output = Command::new(parts[0])
        .args(&parts[1..])
        .current_dir(root_path)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let exit_ok = out.status.success();
            let expected_ok = expected_output.is_empty() || stdout.contains(expected_output);
            let passed = exit_ok && expected_ok;
            ValidationResult {
                name: format!("custom: {}", command),
                passed,
                output: stdout,
                error: if passed {
                    None
                } else if !exit_ok {
                    Some(String::from_utf8_lossy(&out.stderr).to_string())
                } else {
                    Some(format!(
                        "command succeeded but output did not contain expected {:?}",
                        expected_output
                    ))
                },
            }
        }
        Err(e) => ValidationResult {
            name: format!("custom: {}", command),
            passed: false,
            output: String::new(),
            error: Some(format!("Failed to execute command: {}", e)),
        },
    }
}

/// Check if project has validation config for a given task type.
///
/// The task text is only used as a hint (e.g. "rust", "cargo", ".rs" suggest
/// cargo check); the authoritative signal is whether any deterministic check is
/// enabled in the config.
pub fn project_has_validation_for_task(task: &str, config: &ValidationConfig) -> bool {
    let lower = task.to_lowercase();

    // Task hints: a task mentioning a language whose check is NOT enabled means
    // we can't validate it deterministically for that task.
    let mentions_rust = lower.contains("rust") || lower.contains("cargo") || lower.contains(".rs");
    let mentions_ts = lower.contains("typescript") || lower.contains("tsx") || lower.contains("eslint") || lower.contains(".ts");
    let mentions_py = lower.contains("python") || lower.contains("ruff") || lower.contains(".py");
    let mentions_go = lower.contains("golang") || lower.contains("go vet") || lower.contains(".go");

    if mentions_rust && !config.rust_check {
        return false;
    }
    if mentions_ts && !config.js_ts_lint {
        return false;
    }
    if mentions_py && !config.python_check {
        return false;
    }
    if mentions_go && !config.go_check {
        return false;
    }

    // A mentioned language whose check IS enabled → validation available.
    if (mentions_rust && config.rust_check)
        || (mentions_ts && config.js_ts_lint)
        || (mentions_py && config.python_check)
        || (mentions_go && config.go_check)
    {
        return true;
    }

    // No language-specific signal: default to "validation available" only if at
    // least one check is configured on the agent.
    config.rust_check
        || config.js_ts_lint
        || config.python_check
        || config.go_check
        || !config.custom_commands.is_empty()
}

/// Format validation errors for retry prompt
pub fn format_validation_errors(results: &[ValidationResult]) -> String {
    let mut output = String::new();
    for result in results {
        if !result.passed {
            output.push_str(&format!("=== {} ===\n", result.name));
            if let Some(err) = &result.error {
                output.push_str(err);
            }
            if !result.output.is_empty() {
                output.push_str(&result.output);
            }
            output.push('\n');
        }
    }
    output
}

/// Extract changed files from micro-agent result
pub fn extract_changed_files(result: &str) -> Vec<String> {
    // Simple extraction: look for file paths in the result
    // This is a basic implementation - could be enhanced
    let mut files = Vec::new();
    for line in result.lines() {
        // Look for patterns like "file.rs", "src/file.ts", etc.
        if line.contains('.') && (line.contains('/') || line.contains('\\')) {
            // Try to extract a file path
            let parts: Vec<&str> = line.split_whitespace().collect();
            for part in parts {
                if part.contains('.') && (part.contains('/') || part.contains('\\')) {
                    // Clean up the path
                    let cleaned = part.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '\\' && c != '.');
                    if !cleaned.is_empty() && Path::new(cleaned).exists() {
                        files.push(cleaned.to_string());
                    }
                }
            }
        }
    }
    files.dedup();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_no_expected_outputs() {
        let cfg = ValidationConfig::default();
        assert!(cfg.custom_commands.is_empty());
        assert!(cfg.custom_commands_expected.is_empty());
        assert!(!cfg.verify_reported_output);
    }

    #[test]
    fn expected_output_assertion_passes_when_output_contains_substring() {
        // A command that exits 0 but whose output does NOT contain the expected
        // substring must FAIL — this is the "ran but wrong answer" case.
        let result = run_custom_command_with_output("echo 4", "5");
        assert!(!result.passed, "expected-output mismatch must fail");
        assert!(result.error.unwrap().contains("did not contain expected"));

        let ok = run_custom_command_with_output("echo 5", "5");
        assert!(ok.passed, "matching output must pass");
    }

    /// Helper that runs `run_custom_command` against a fixed stdout so the test
    /// doesn't depend on the shell environment.
    fn run_custom_command_with_output(stdout: &str, expected: &str) -> ValidationResult {
        // Build a tiny shell script that prints `stdout` and exits 0.
        let dir = std::env::temp_dir().join(format!("nolock_val_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cmd.sh");
        std::fs::write(&script, format!("#!/bin/sh\necho '{}'\n", stdout)).unwrap();
        let command = format!("sh {}", script.display());
        // run_custom_command is async; block on it via a tiny runtime.
        let result = futures::executor::block_on(run_custom_command(
            dir.to_str().unwrap(),
            &command,
            expected,
        ));
        let _ = std::fs::remove_dir_all(&dir);
        result
    }
}
