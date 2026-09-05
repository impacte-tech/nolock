// ---------------------------------------------------------------------------
// notebook — Python virtual environment discovery & creation for .ipynb files
//
// Environments are discovered from (in priority order):
//   1. Workspace venvs:  <root>/.venv, <root>/venv, <root>/.venvs/<name>
//   2. User venvs:       ~/.virtualenvs/<name>
//   3. System pythons:   python3, python (resolved via PATH)
//
// New environments are created with `python3 -m venv <root>/.venvs/<name>`
// so each workspace can own several isolated environments (Colab-style
// runtime picker). Progress is streamed to the frontend via `pyenv-progress`
// events.
// ---------------------------------------------------------------------------

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnv {
    /// Display name (e.g. ".venv", "my-env", "python3")
    pub name: String,
    /// Absolute path to the interpreter (or bare name for system pythons)
    pub python_path: String,
    /// "venv" (workspace) | "virtualenv" (home) | "system"
    pub kind: String,
    /// e.g. "Python 3.11.4"
    pub version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyEnvProgress {
    name: String,
    stage: String, // "starting" | "done" | "error"
    message: String,
}

/// Sanitize a user-provided environment name: keep [A-Za-z0-9_-] only.
fn sanitize_env_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Path of the python interpreter inside a venv directory.
fn python_binary(venv_dir: &Path) -> std::path::PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}

/// Probe an interpreter for its version string ("Python 3.11.4").
fn probe_version(python: &Path) -> Option<String> {
    let output = Command::new(python).arg("--version").output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stderr).to_string();
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Build a PythonEnv from a venv directory, if it contains a real interpreter.
fn venv_entry(dir: &Path, name: String, kind: &str) -> Option<PythonEnv> {
    let python = python_binary(dir);
    if !python.is_file() {
        return None;
    }
    let version = probe_version(&python).unwrap_or_else(|| "Python".to_string());
    Some(PythonEnv {
        name,
        python_path: python.to_string_lossy().to_string(),
        kind: kind.to_string(),
        version,
    })
}

/// Resolve a system python (python3/python) to its absolute executable path.
fn resolve_system_python(candidate: &str) -> Option<String> {
    let output = Command::new(candidate)
        .arg("-c")
        .arg("import sys; print(sys.executable)")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn push_unique(envs: &mut Vec<PythonEnv>, seen: &mut HashSet<String>, env: PythonEnv) {
    if seen.insert(env.python_path.clone()) {
        envs.push(env);
    }
}

#[tauri::command]
pub fn python_list_envs(root_path: String) -> Result<Vec<PythonEnv>, String> {
    let mut envs: Vec<PythonEnv> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. Workspace venvs
    let root = PathBuf::from(&root_path);
    if root.is_dir() {
        for dir_name in [".venv", "venv"] {
            if let Some(env) = venv_entry(&root.join(dir_name), dir_name.to_string(), "venv") {
                push_unique(&mut envs, &mut seen, env);
            }
        }
        // Multiple managed envs: <root>/.venvs/<name>
        let multi = root.join(".venvs");
        if multi.is_dir() {
            let mut names: Vec<String> = std::fs::read_dir(&multi)
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .filter_map(|e| e.file_name().to_string_lossy().to_string().into())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            for name in names {
                if let Some(env) = venv_entry(&multi.join(&name), name, "venv") {
                    push_unique(&mut envs, &mut seen, env);
                }
            }
        }
    }

    // 2. User venvs (~/.virtualenvs)
    if let Some(home) = std::env::var_os("HOME") {
        let venvs_dir = Path::new(&home).join(".virtualenvs");
        if venvs_dir.is_dir() {
            let mut names: Vec<String> = std::fs::read_dir(&venvs_dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .filter_map(|e| e.file_name().to_string_lossy().to_string().into())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            for name in names {
                if let Some(env) = venv_entry(&venvs_dir.join(&name), name, "virtualenv") {
                    push_unique(&mut envs, &mut seen, env);
                }
            }
        }
    }

    // 3. System pythons
    for candidate in ["python3", "python"] {
        if let Some(path) = resolve_system_python(candidate) {
            let version = probe_version(Path::new(&path)).unwrap_or_else(|| "Python".to_string());
            push_unique(
                &mut envs,
                &mut seen,
                PythonEnv {
                    name: candidate.to_string(),
                    python_path: path,
                    kind: "system".to_string(),
                    version,
                },
            );
        }
    }

    println!("[pyenv] discovered {} python environment(s):", envs.len());
    for env in &envs {
        println!(
            "  [pyenv] {} ({}) {} — {}",
            env.name, env.kind, env.version, env.python_path
        );
    }

    Ok(envs)
}

#[tauri::command]
pub fn python_create_env(
    app: AppHandle,
    root_path: String,
    name: String,
) -> Result<PythonEnv, String> {
    let name = sanitize_env_name(&name);
    if name.is_empty() {
        return Err("Environment name must contain letters, digits, '-' or '_'".to_string());
    }
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("Open a workspace folder first".to_string());
    }

    let venvs_dir = root.join(".venvs");
    std::fs::create_dir_all(&venvs_dir)
        .map_err(|e| format!("Failed to create .venvs directory: {}", e))?;
    let target = venvs_dir.join(&name);
    if target.exists() {
        return Err(format!("Environment '{}' already exists", name));
    }

    // Base interpreter: prefer python3, fall back to python.
    let base = ["python3", "python"]
        .iter()
        .find_map(|c| resolve_system_python(c))
        .ok_or_else(|| "No system python3 found — install Python 3 first".to_string())?;

    let emit = |stage: &str, message: String| {
        let _ = app.emit(
            "pyenv-progress",
            PyEnvProgress {
                name: name.clone(),
                stage: stage.to_string(),
                message,
            },
        );
    };

    emit(
        "starting",
        format!("Creating virtual environment '{}'…", name),
    );
    let output = Command::new(&base)
        .args(["-m", "venv"])
        .arg(&target)
        .output()
        .map_err(|e| format!("Failed to run venv creation: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        emit("error", stderr.clone());
        return Err(format!("venv creation failed: {}", stderr));
    }
    emit("done", format!("Environment '{}' created", name));

    venv_entry(&target, name, "venv")
        .ok_or_else(|| "Environment created but interpreter not found".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_env_name() {
        assert_eq!(sanitize_env_name("my-env_1"), "my-env_1");
        assert_eq!(sanitize_env_name("  data science! "), "datascience");
        assert_eq!(sanitize_env_name("../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_env_name("###"), "");
    }

    #[test]
    fn test_python_binary_layout() {
        let dir = Path::new("/tmp/fake-venv");
        if cfg!(windows) {
            assert!(python_binary(dir).to_string_lossy().contains("Scripts"));
        } else {
            assert_eq!(python_binary(dir), Path::new("/tmp/fake-venv/bin/python"));
        }
    }
}
