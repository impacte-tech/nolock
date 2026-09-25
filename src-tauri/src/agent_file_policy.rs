//! File/context boundary for agents. The user's editor and terminal are separate.
use std::{io::Read, path::Path};

pub const BLOCKED: &str = "This file is excluded from AI access because it may contain credentials. Open it in your editor or terminal instead.";

pub fn protected_path(path: &Path) -> bool {
    if ["/proc", "/dev", "/sys"].iter().any(|root| path.starts_with(root)) { return true; }
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_lowercase();
        name.contains(".env") || name.contains("credential-actions") || matches!(name.as_str(), ".bash_history" | ".zsh_history" | "fish_history" | ".aws" | ".ssh" | ".gnupg" | ".op" | "1password" | "bitwarden cli" | ".bitwarden" | "credential-actions.json" | "secrets.json" | "auth.json")
    })
}

pub fn check_path(path: &Path) -> Result<(), String> {
    if protected_path(path) { return Err(BLOCKED.into()); }
    if path.is_symlink() && !path.exists() { return Err(BLOCKED.into()); }
    if path.exists() {
        let real = path.canonicalize().map_err(|_| "Cannot validate file access.")?;
        if protected_path(&real) { return Err(BLOCKED.into()); }
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(path).map_err(|_| "Cannot validate file access.")?;
            if meta.is_file() && meta.nlink() > 1 { return Err("Hard-linked files are excluded from AI access to prevent secret-file aliases.".into()); }
        }
    } else if let Some(parent) = path.parent() {
        if parent != path && !parent.as_os_str().is_empty() { check_path(parent)?; }
    }
    Ok(())
}

pub fn read_to_string(path: impl AsRef<Path>) -> Result<String, String> {
    let path = path.as_ref();
    check_path(path)?;
    let mut file = std::fs::File::open(path).map_err(|e| format!("Cannot read file: {e}"))?;
    // Validate the opened file too, so a symlink replacement between checking
    // the path and opening it cannot make Linux read a protected target.
    #[cfg(target_os = "linux")] {
        use std::os::fd::AsRawFd;
        let actual = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|_| "Cannot validate opened file.")?;
        if protected_path(&actual) { return Err(BLOCKED.into()); }
    }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|_| "Cannot validate opened file.")?.nlink() > 1 { return Err(BLOCKED.into()); }
    }
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| format!("Cannot read file: {e}"))?;
    Ok(content)
}

#[tauri::command]
pub fn agent_read_file(path: String) -> Result<String, String> { read_to_string(path) }

#[tauri::command]
pub fn agent_check_file_access(path: String) -> Result<(), String> { check_path(Path::new(&path)) }

// Until automatic execution has a real OS sandbox, arbitrary code could bypass
// file/context exclusions or query an unlocked password-manager session.
pub fn restricted(_root: Option<&str>) -> bool { true }
pub fn automatic_tool_allowed(name: &str) -> bool {
    matches!(name, "read_file" | "write_file" | "edit" | "grep" | "list_directory" | "web_search" | "web_fetch" | "knowledge_base")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn blocks_env_variants_and_credential_paths() {
        for path in [".env", ".env.local", ".env.example", "production.env", ".env.bak", ".ENV", "folder/.envrc", ".config/nolock/credential-actions.json", ".nolock-web/secrets.json", ".local/share/opencode/auth.json", ".aws/credentials", "/proc/self/environ", "/dev/fd/1", ".config/1Password/data"] {
            assert!(protected_path(Path::new(path)), "{path}");
        }
        assert!(!protected_path(Path::new("src/environment.ts")));
        assert!(!protected_path(Path::new("secrets.refs")));
    }
    #[test] fn blocks_arbitrary_execution_bypasses() {
        for name in ["bash_sandbox", "rust_repl", "custom_script", "spawn_subagent", "terminal_cli_aws"] {
            assert!(!automatic_tool_allowed(name));
        }
    }
    #[cfg(unix)]
    #[test] fn blocks_symlink_and_hardlink_aliases_without_reading_values() {
        let root = std::env::temp_dir().join(format!("nolock-file-policy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let secret = root.join(".env.test");
        std::fs::write(&secret, "TEST_SECRET=fixture").unwrap();
        let alias = root.join("alias.txt");
        let _ = std::fs::remove_file(&alias);
        std::os::unix::fs::symlink(&secret, &alias).unwrap();
        assert!(read_to_string(&alias).is_err());
        std::fs::remove_file(&alias).unwrap();
        std::fs::hard_link(&secret, &alias).unwrap();
        assert!(read_to_string(&alias).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
