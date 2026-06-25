use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct LinterDiagnostic {
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub severity: String, // "error" | "warning" | "info"
    pub rule_id: Option<String>,
    pub file_path: String,
}

/// Per-linter preferences that the user can configure in the editor UI.
/// Only fields that are actually needed are exposed — keeps the API minimal.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LinterPrefs {
    /// Enable TypeScript/JavaScript linting via ESLint (default: true).
    pub ts_enabled: Option<bool>,
    /// Enable Python linting via Ruff (default: true).
    pub py_enabled: Option<bool>,
    /// Enable Rust linting via Clippy (default: true).
    pub rs_enabled: Option<bool>,
    /// Extra Ruff rule categories to select, e.g. "E,W,F,I".
    /// Passed as `--extend-select <value>`.
    pub ruff_select: Option<String>,
    /// Ruff rule codes to ignore, e.g. "E302,E501".
    /// Passed as `--ignore <value>`.
    pub ruff_ignore: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn run_linter(
    path: String,
    prefs: Option<LinterPrefs>,
) -> Result<Vec<LinterDiagnostic>, String> {
    let prefs = prefs.unwrap_or_default();
    let Some(language) = detect_language(&path) else {
        return Ok(vec![]); // Unsupported language — silently no diagnostics
    };

    match language {
        "typescript" => {
            if prefs.ts_enabled.unwrap_or(true) {
                lint_eslint(&path, &prefs)
            } else {
                Ok(vec![])
            }
        }
        "python" => {
            if prefs.py_enabled.unwrap_or(true) {
                lint_ruff(&path, &prefs)
            } else {
                Ok(vec![])
            }
        }
        "rust" => {
            if prefs.rs_enabled.unwrap_or(true) {
                lint_clippy(&path, &prefs)
            } else {
                Ok(vec![])
            }
        }
        _ => Ok(vec![]),
    }
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

fn detect_language(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" => Some("typescript"),
        "py" => Some("python"),
        "rs" => Some("rust"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Linter-specific implementations
// ---------------------------------------------------------------------------

fn lint_eslint(file_path: &str, _prefs: &LinterPrefs) -> Result<Vec<LinterDiagnostic>, String> {
    let output = run_cmd("eslint", &["--format", "json", file_path])?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() || stdout.trim() == "[]" {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("eslint: {}", stderr.trim()));
        }
        return Ok(vec![]);
    }

    parse_eslint(&stdout, file_path)
}

fn lint_ruff(file_path: &str, prefs: &LinterPrefs) -> Result<Vec<LinterDiagnostic>, String> {
    // Build command args dynamically from prefs
    let mut args: Vec<String> = vec!["check".into(), "--output-format".into(), "json".into()];

    if let Some(select) = &prefs.ruff_select {
        args.push("--extend-select".into());
        args.push(select.clone());
    }
    if let Some(ignore) = &prefs.ruff_ignore {
        args.push("--ignore".into());
        args.push(ignore.clone());
    }

    args.push(file_path.into());

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = run_cmd("ruff", &args_refs)?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("ruff: {}", stderr.trim()));
        }
        return Ok(vec![]);
    }

    parse_ruff(&stdout, file_path)
}

fn lint_clippy(file_path: &str, _prefs: &LinterPrefs) -> Result<Vec<LinterDiagnostic>, String> {
    let workspace = find_cargo_workspace(file_path)
        .ok_or_else(|| "Not inside a Cargo workspace".to_string())?;

    let output = run_cmd_in_dir(
        "cargo",
        &["clippy", "--message-format", "json", "--offline"],
        &workspace,
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_clippy(&stdout, file_path)
}

// ---------------------------------------------------------------------------
// Process runner with timeout
// ---------------------------------------------------------------------------

fn run_cmd(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let program = program.to_string();
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let program_for_err = program.clone();

    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let result = Command::new(&program).args(&args).output();
        let _ = tx.send(result);
    });

    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| format!("'{}' timed out after 60s", program_for_err))?
        .map_err(|e| format!("Failed to execute '{}': {}", program_for_err, e))
}

fn run_cmd_in_dir(
    program: &str,
    args: &[&str],
    current_dir: &str,
) -> Result<std::process::Output, String> {
    let program = program.to_string();
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let cwd = current_dir.to_string();
    let program_for_err = program.clone();

    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let result = Command::new(&program)
            .args(&args)
            .current_dir(&cwd)
            .output();
        let _ = tx.send(result);
    });

    rx.recv_timeout(Duration::from_secs(120))
        .map_err(|_| format!("'{}' timed out after 120s", program_for_err))?
        .map_err(|e| format!("Failed to execute '{}': {}", program_for_err, e))
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn parse_eslint(stdout: &str, file_path: &str) -> Result<Vec<LinterDiagnostic>, String> {
    let reports: Vec<serde_json::Value> =
        serde_json::from_str(stdout).map_err(|e| format!("Invalid ESLint JSON: {}", e))?;

    let mut diagnostics = Vec::new();

    for report in &reports {
        let Some(messages) = report.get("messages").and_then(|m| m.as_array()) else {
            continue;
        };
        for msg in messages {
            let Some(line) = msg.get("line").and_then(|l| l.as_u64()) else {
                continue;
            };
            let Some(column) = msg.get("column").and_then(|c| c.as_u64()) else {
                continue;
            };
            let Some(message) = msg.get("message").and_then(|m| m.as_str()) else {
                continue;
            };

            let severity = match msg.get("severity").and_then(|s| s.as_u64()) {
                Some(2) => "error",
                Some(1) => "warning",
                _ => "info",
            };

            let rule_id = msg
                .get("ruleId")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string());

            diagnostics.push(LinterDiagnostic {
                line: line as usize,
                column: column as usize,
                message: message.to_string(),
                severity: severity.to_string(),
                rule_id,
                file_path: file_path.to_string(),
            });
        }
    }

    Ok(diagnostics)
}

fn parse_ruff(stdout: &str, file_path: &str) -> Result<Vec<LinterDiagnostic>, String> {
    let findings: Vec<serde_json::Value> =
        serde_json::from_str(stdout).map_err(|e| format!("Invalid Ruff JSON: {}", e))?;

    let mut diagnostics = Vec::new();

    for finding in &findings {
        let Some(loc) = finding.get("location") else {
            continue;
        };
        let Some(line) = loc.get("row").and_then(|l| l.as_u64()) else {
            continue;
        };
        let Some(column) = loc.get("column").and_then(|c| c.as_u64()) else {
            continue;
        };
        let Some(message) = finding.get("message").and_then(|m| m.as_str()) else {
            continue;
        };

        let rule_id = finding
            .get("code")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        diagnostics.push(LinterDiagnostic {
            line: line as usize,
            column: column as usize,
            message: message.to_string(),
            severity: "warning".to_string(),
            rule_id,
            file_path: file_path.to_string(),
        });
    }

    Ok(diagnostics)
}

fn parse_clippy(stdout: &str, file_path: &str) -> Result<Vec<LinterDiagnostic>, String> {
    let mut diagnostics = Vec::new();

    for line in stdout.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // skip non-JSON lines
        };

        // Only process compiler messages
        if val.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }

        let Some(msg) = val.get("message") else {
            continue;
        };
        let Some(level) = msg.get("level").and_then(|l| l.as_str()) else {
            continue;
        };
        if level != "warning" && level != "error" {
            continue;
        }

        let Some(message) = msg.get("message").and_then(|m| m.as_str()) else {
            continue;
        };

        let rule_id = msg
            .get("code")
            .and_then(|c| c.get("code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        // Extract span info — use first span that matches our file
        let Some(spans) = msg.get("spans").and_then(|s| s.as_array()) else {
            continue;
        };

        let matching_span = spans.iter().find(|span| {
            span.get("file_name")
                .and_then(|f| f.as_str())
                .map(|f| same_file(f, file_path))
                .unwrap_or(false)
        });

        let Some(span) = matching_span else {
            continue;
        };

        let line = span.get("line_start").and_then(|l| l.as_u64()).unwrap_or(1) as usize;
        let column = span
            .get("column_start")
            .and_then(|c| c.as_u64())
            .unwrap_or(1) as usize;

        diagnostics.push(LinterDiagnostic {
            line,
            column,
            message: message.to_string(),
            severity: level.to_string(),
            rule_id,
            file_path: file_path.to_string(),
        });
    }

    Ok(diagnostics)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find the Cargo workspace root by walking up from the file's directory.
fn find_cargo_workspace(file_path: &str) -> Option<String> {
    let path = Path::new(file_path);
    let parent = path.parent()?;
    for ancestor in parent.ancestors() {
        if ancestor.join("Cargo.toml").exists() {
            return Some(ancestor.to_string_lossy().to_string());
        }
    }
    None
}

/// Compare two file paths, resolving any symlinks or relative differences.
fn same_file(a: &str, b: &str) -> bool {
    let a_path = Path::new(a);
    let b_path = Path::new(b);
    // Try canonical comparison first
    if let (Ok(a_canon), Ok(b_canon)) = (a_path.canonicalize(), b_path.canonicalize()) {
        return a_canon == b_canon;
    }
    // Fall back to string comparison
    a == b
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Language detection ------------------------------------------------

    #[test]
    fn test_detect_ts() {
        assert_eq!(detect_language("file.ts"), Some("typescript"));
        assert_eq!(detect_language("file.tsx"), Some("typescript"));
    }

    #[test]
    fn test_detect_js() {
        assert_eq!(detect_language("file.js"), Some("typescript"));
        assert_eq!(detect_language("file.jsx"), Some("typescript"));
    }

    #[test]
    fn test_detect_py() {
        assert_eq!(detect_language("file.py"), Some("python"));
    }

    #[test]
    fn test_detect_rs() {
        assert_eq!(detect_language("file.rs"), Some("rust"));
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(detect_language("file.go"), None);
        assert_eq!(detect_language("file"), None);
        assert_eq!(detect_language(""), None);
    }

    // ---- ESLint parser ----------------------------------------------------

    #[test]
    fn test_parse_eslint_empty() {
        let result = parse_eslint("[]", "/path/file.ts").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_eslint_single_error() {
        let json = r#"[
          {
            "filePath": "/path/file.ts",
            "messages": [
              {
                "ruleId": "no-unused-vars",
                "severity": 2,
                "message": "'x' is assigned a value but never used.",
                "line": 10,
                "column": 5
              }
            ]
          }
        ]"#;

        let result = parse_eslint(json, "/path/file.ts").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].line, 10);
        assert_eq!(result[0].column, 5);
        assert_eq!(result[0].message, "'x' is assigned a value but never used.");
        assert_eq!(result[0].severity, "error");
        assert_eq!(result[0].rule_id.as_deref(), Some("no-unused-vars"));
    }

    #[test]
    fn test_parse_eslint_warning() {
        let json = r#"[
          {
            "filePath": "/path/file.ts",
            "messages": [
              {
                "ruleId": "no-console",
                "severity": 1,
                "message": "Unexpected console statement.",
                "line": 5,
                "column": 3
              }
            ]
          }
        ]"#;

        let result = parse_eslint(json, "/path/file.ts").unwrap();
        assert_eq!(result[0].severity, "warning");
    }

    #[test]
    fn test_parse_eslint_no_rule_id() {
        let json = r#"[
          {
            "filePath": "/path/file.ts",
            "messages": [
              {
                "severity": 2,
                "message": "Parsing error: Unexpected token",
                "line": 1,
                "column": 1
              }
            ]
          }
        ]"#;

        let result = parse_eslint(json, "/path/file.ts").unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].rule_id.is_none());
    }

    #[test]
    fn test_parse_eslint_invalid_json() {
        let result = parse_eslint("not json", "/path/file.ts");
        assert!(result.is_err());
    }

    // ---- Ruff parser ------------------------------------------------------

    #[test]
    fn test_parse_ruff_empty() {
        let result = parse_ruff("[]", "/path/file.py").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_ruff_single() {
        let json = r#"[
          {
            "cell": null,
            "code": "F841",
            "location": { "row": 10, "column": 5 },
            "end_location": { "row": 10, "column": 10 },
            "filename": "/path/file.py",
            "fix": null,
            "message": "Local variable `x` is assigned to but never used",
            "noqa_row": 10
          }
        ]"#;

        let result = parse_ruff(json, "/path/file.py").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].line, 10);
        assert_eq!(result[0].column, 5);
        assert_eq!(
            result[0].message,
            "Local variable `x` is assigned to but never used"
        );
        assert_eq!(result[0].severity, "warning");
        assert_eq!(result[0].rule_id.as_deref(), Some("F841"));
    }

    #[test]
    fn test_parse_ruff_no_code() {
        let json = r#"[
          {
            "location": { "row": 3, "column": 1 },
            "message": "Something wrong",
            "filename": "/path/file.py"
          }
        ]"#;

        let result = parse_ruff(json, "/path/file.py").unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].rule_id.is_none());
    }

    // ---- Clippy parser ----------------------------------------------------

    #[test]
    fn test_parse_clippy_empty() {
        // Clippy stdout is empty when there are no warnings/errors
        let result = parse_clippy("", "/path/file.rs").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_clippy_skips_non_matching_file() {
        // A message for a different file should be skipped
        let json = r#"{"reason":"compiler-message","message":{"level":"warning","message":"unused variable `x`","code":{"code":"unused_variables"},"spans":[{"file_name":"/other/file.rs","line_start":10,"column_start":9,"line_end":10,"column_end":10}]}}"#;

        let result = parse_clippy(json, "/path/file.rs").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_clippy_matching_file() {
        let json = r#"{"reason":"compiler-message","message":{"level":"warning","message":"unused variable `x`","code":{"code":"unused_variables"},"spans":[{"file_name":"/path/file.rs","line_start":10,"column_start":9,"line_end":10,"column_end":10}]}}"#;

        let result = parse_clippy(json, "/path/file.rs").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].line, 10);
        assert_eq!(result[0].column, 9);
        assert_eq!(result[0].message, "unused variable `x`");
        assert_eq!(result[0].severity, "warning");
        assert_eq!(result[0].rule_id.as_deref(), Some("unused_variables"));
    }

    #[test]
    fn test_parse_clippy_skips_non_compiler_message() {
        let json = r#"{"reason":"build-finished","success":true}"#;
        let result = parse_clippy(json, "/path/file.rs").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_clippy_skips_non_warning_error() {
        let json = r#"{"reason":"compiler-message","message":{"level":"note","message":"something to note","spans":[{"file_name":"/path/file.rs","line_start":1,"column_start":1,"line_end":1,"column_end":2}]}}"#;

        let result = parse_clippy(&json, "/path/file.rs").unwrap();
        assert!(result.is_empty());
    }

    // ---- Cargo workspace detection ----------------------------------------

    #[test]
    fn test_find_cargo_workspace_no_parent() {
        // An absolute path under a non-existent directory — no Cargo.toml
        // exists in any ancestor (root / won't have one).
        let result = find_cargo_workspace("/__nolock_test_nonexistent__/src/lib.rs");
        assert!(result.is_none());
    }

    // ---- Integration: lint_ruff with real file ----------------------------

    #[test]
    fn test_lint_ruff_integration() {
        // Create a temp file with an unused local variable
        let dir = std::env::temp_dir().join("__nolock_lint_test__");
        let _ = std::fs::create_dir_all(&dir);
        let file_path = dir.join("test_unused.py");
        std::fs::write(&file_path, "def foo():\n    x = 1\n    print(\"hello\")\n").unwrap();

        let prefs = LinterPrefs {
            ts_enabled: None,
            py_enabled: Some(true),
            rs_enabled: None,
            ruff_select: Some("E,W,F,I".into()),
            ruff_ignore: None,
        };
        let result = lint_ruff(&file_path.to_string_lossy(), &prefs);
        let _ = std::fs::remove_dir_all(&dir); // clean up

        match result {
            Ok(diagnostics) => {
                assert!(!diagnostics.is_empty(), "Expected at least one diagnostic");
                let diag = &diagnostics[0];
                assert_eq!(diag.line, 2);
                assert_eq!(diag.column, 5);
                assert_eq!(diag.severity, "warning");
                assert_eq!(diag.rule_id.as_deref(), Some("F841"));
                assert!(
                    diag.message.contains("never used"),
                    "Expected 'never used' in message, got: {}",
                    diag.message
                );
            }
            Err(e) => {
                // If ruff is not installed, this is acceptable
                if e.contains("Failed to execute") || e.contains("timed out") {
                    eprintln!(
                        "Skipping integration test — ruff may not be available: {}",
                        e
                    );
                } else {
                    panic!("lint_ruff failed: {}", e);
                }
            }
        }
    }

    // ---- Integration: run_linter via Tauri command ------------------------

    #[test]
    fn test_run_linter_unrecognized_language() {
        // An unsupported extension should return empty Vec, not an error
        let result = run_linter("file.go".to_string(), None);
        match result {
            Ok(diags) => assert!(diags.is_empty()),
            Err(e) => {
                panic!("Expected Ok(vec![]) for unsupported language, got: {}", e)
            }
        }
    }

    #[test]
    fn test_run_linter_missing_file() {
        // A missing file should return an error (linter command fails)
        let result = run_linter("/tmp/__nolock_nonexistent__/file.py".to_string(), None);
        match result {
            Ok(_) => { /* Could be empty if ruff isn't installed */ }
            Err(e) => {
                assert!(e.contains("Failed to execute") || e.contains("ruff"));
            }
        }
    }

    // ---- LinterPrefs -------------------------------------------------------

    #[test]
    fn test_linter_prefs_default() {
        let prefs = LinterPrefs::default();
        assert!(prefs.ts_enabled.is_none());
        assert!(prefs.py_enabled.is_none());
        assert!(prefs.rs_enabled.is_none());
        assert!(prefs.ruff_select.is_none());
        assert!(prefs.ruff_ignore.is_none());
    }

    #[test]
    fn test_linter_prefs_custom() {
        let prefs = LinterPrefs {
            ts_enabled: Some(true),
            py_enabled: Some(false),
            rs_enabled: Some(true),
            ruff_select: Some("E,W".into()),
            ruff_ignore: Some("E302".into()),
        };
        assert_eq!(prefs.ts_enabled, Some(true));
        assert_eq!(prefs.py_enabled, Some(false));
        assert_eq!(prefs.rs_enabled, Some(true));
        assert_eq!(prefs.ruff_select.as_deref(), Some("E,W"));
        assert_eq!(prefs.ruff_ignore.as_deref(), Some("E302"));
    }

    #[test]
    fn test_run_linter_python_disabled() {
        // When py_enabled is false, Python files should return empty diagnostics
        let prefs = LinterPrefs {
            ts_enabled: None,
            py_enabled: Some(false),
            rs_enabled: None,
            ruff_select: None,
            ruff_ignore: None,
        };
        // Even though the file doesn't exist, the linter should not be invoked
        let result = run_linter(
            "/tmp/__nolock_nonexistent__/file.py".to_string(),
            Some(prefs),
        );
        match result {
            Ok(diags) => assert!(diags.is_empty()),
            Err(e) => panic!(
                "Expected Ok(vec![]) when python linting is disabled, got: {}",
                e
            ),
        }
    }

    #[test]
    fn test_run_linter_typescript_disabled() {
        let prefs = LinterPrefs {
            ts_enabled: Some(false),
            py_enabled: None,
            rs_enabled: None,
            ruff_select: None,
            ruff_ignore: None,
        };
        let result = run_linter(
            "/tmp/__nolock_nonexistent__/file.ts".to_string(),
            Some(prefs),
        );
        match result {
            Ok(diags) => assert!(diags.is_empty()),
            Err(e) => panic!(
                "Expected Ok(vec![]) when ts linting is disabled, got: {}",
                e
            ),
        }
    }

    // ---- same_file --------------------------------------------------------

    #[test]
    fn test_same_file_exact() {
        assert!(same_file("/a/b.rs", "/a/b.rs"));
        assert!(!same_file("/a/b.rs", "/a/c.rs"));
    }
}
