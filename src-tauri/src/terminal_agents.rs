//! Full-access terminals with shell-local agent launchers. No broker or sandbox.
use std::path::{Path, PathBuf};

fn quote(path: &Path) -> String { format!("'{}'", path.to_string_lossy().replace('\'', "'\\''")) }
fn runtime_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Home directory unavailable.")?;
    Ok(PathBuf::from(home).join(".config/nolock/terminal-runtime"))
}
fn write(path: &Path, content: &str, executable: bool) -> Result<(), String> {
    // Replace atomically so an agent launching in another terminal sees a whole script.
    use std::io::Write;
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp = path.with_extension(format!("{}-{unique}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(if executable { 0o700 } else { 0o600 }); }
    let result = (|| {
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}
#[tauri::command]
pub fn terminal_agent_capabilities() -> serde_json::Value {
    serde_json::json!({"supported":cfg!(unix), "agents":["codex", "claude", "opencode"], "genericCommand":"nolock-agent run COMMAND [args...]"})
}
pub fn prepare(shell: &str, cwd: Option<&str>, command: Option<&str>, terminal_id: &str) -> Result<portable_pty::CommandBuilder, String> {
    let mut cmd = portable_pty::CommandBuilder::new(shell);
    if let Some(cwd) = cwd { if !cwd.is_empty() { cmd.cwd(cwd); } }
    cmd.env("TERM", "xterm-256color");
    let root = cwd.filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let runtime = runtime_dir()?;
    let bin = runtime.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    for name in ["nolock-agent", "codex", "claude", "opencode"] {
        write(&bin.join(name), include_str!("../resources/nolock-agent.py"), true)?;
    }
    // Loading settings can migrate earlier MCP connections. Failure must never
    // prevent a normal terminal from opening; the MCP panel reports the error.
    let _ = super::mcp_servers::load(&root.to_string_lossy());
    let config = super::mcp_servers::config_path(&root.to_string_lossy())?;
    cmd.env("NOLOCK_MCP_CONFIG", &config);
    cmd.env("NOLOCK_PROJECT_ROOT", &root);
    cmd.env("NOLOCK_TERMINAL_ID", terminal_id);
    cmd.env("NOLOCK_AGENT_BIN", &bin);
    let host_path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{host_path}", bin.display()));
    // Keep the real HOME, all inherited provider settings and native agent auth.
    match Path::new(shell).file_name().and_then(|s| s.to_str()).unwrap_or("") {
        "zsh" => {
            let startup = runtime.join("zsh");
            std::fs::create_dir_all(&startup).map_err(|e| e.to_string())?;
            let original = std::env::var_os("ZDOTDIR").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).ok_or("Home unavailable.")?;
            cmd.env("NOLOCK_ORIGINAL_ZDOTDIR", &original);
            cmd.env("ZDOTDIR", &startup);
            for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
                let restore = if file == ".zlogin" { "\"$NOLOCK_ORIGINAL_ZDOTDIR\"".to_string() } else { quote(&startup) };
                let content = format!("ZDOTDIR=\"$NOLOCK_ORIGINAL_ZDOTDIR\"\n[[ -f \"$ZDOTDIR/{file}\" ]] && source \"$ZDOTDIR/{file}\"\nZDOTDIR={}\nexport PATH=\"$NOLOCK_AGENT_BIN:$PATH\"\n", restore);
                write(&startup.join(file), &content, false)?;
            }
            if let Some(command) = command { cmd.args(["-lic", command]); } else { cmd.arg("-il"); }
        },
        "bash" => {
            let rc = runtime.join("bashrc");
            write(&rc, "if [ -f /etc/profile ]; then . /etc/profile; fi\nif [ -f ~/.bash_profile ]; then . ~/.bash_profile; elif [ -f ~/.bash_login ]; then . ~/.bash_login; elif [ -f ~/.profile ]; then . ~/.profile; fi\nif [ -f ~/.bashrc ]; then . ~/.bashrc; fi\nexport PATH=\"$NOLOCK_AGENT_BIN:$PATH\"\n", false)?;
            cmd.args(["--rcfile", rc.to_str().ok_or("Invalid shell path")?, "-i"]);
            if let Some(command) = command { cmd.args(["-c", command]); }
        },
        "fish" => {
            cmd.args(["-i", "--init-command", "set -gx PATH $NOLOCK_AGENT_BIN $PATH"]);
            if let Some(command) = command { cmd.args(["-c", command]); }
        },
        _ => { if let Some(command) = command { cmd.args(["-lic", command]); } else { cmd.arg("-l"); } },
    }
    Ok(cmd)
}
