//! nolock-server — headless web deployment of the nolock app.
//!
//! Reuses the EXACT same Rust codebase as the Tauri desktop app by including
//! `../main.rs` as a module (the same pattern `bin/nolock-cli.rs` uses). The
//! desktop command surface (`invoke_handler`) is mirrored as:
//!
//!   POST /api/invoke/<command>   → one-shot command results (JSON)
//!   GET  /api/events             → Server-Sent Events stream carrying every
//!                                  Tauri `emit` as `{ event, payload }` JSON
//!   GET  /*                      → the built web frontend (SPA fallback)
//!   GET  /health                 → Railway healthcheck
//!
//! Commands that don't touch Tauri state (the vast majority: fs, sessions,
//! git, agents, tools, skills, hooks, linter, switchyard, model discovery,
//! ai_complete) are called DIRECTLY — same functions, zero duplication.
//! Commands that need an `AppHandle`/`State` (ai_chat streaming, PTY, python
//! kernels, terminal memory, secrets, subagent memory) get thin web variants
//! that reuse the same core logic and route events over the SSE hub instead.

#![allow(dead_code)]

#[path = "../main.rs"]
mod main_impl;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, Uri},
    response::sse::{KeepAlive, Sse},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::io::Read;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

// ---------------------------------------------------------------------------
// Event hub — every Tauri `emit` equivalent flows through here to all SSE clients
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Hub {
    tx: broadcast::Sender<String>,
}

impl Hub {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(4096);
        Hub { tx }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let msg = serde_json::json!({ "event": event, "payload": payload });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.tx.send(json);
        }
    }
}

/// Implements the same `EventSink` trait the Tauri `AppHandle` and the CLI's
/// `CliSink` implement, so `run_chat` (the whole main/sub/micro-agent tool
/// loop) streams identically over SSE.
struct WebSink {
    hub: Hub,
}

impl main_impl::EventSink for WebSink {
    fn emit_stream_token(&self, subagent_id: Option<&str>, token: &str, thinking: bool) {
        if let Some(id) = subagent_id {
            self.hub.emit(
                "subagent-token",
                serde_json::json!({ "id": id, "token": token, "thinking": thinking }),
            );
        } else {
            self.hub.emit(
                "stream-token",
                serde_json::json!({ "token": token, "thinking": thinking }),
            );
        }
    }

    fn emit_tool_progress(
        &self,
        subagent_id: Option<&str>,
        kind: &str,
        name: &str,
        path: Option<String>,
        arguments: Option<String>,
        result: Option<String>,
    ) {
        if let Some(id) = subagent_id {
            self.hub.emit(
                "subagent-tool-progress",
                serde_json::json!({
                    "id": id, "type": kind, "name": name,
                    "path": path, "arguments": arguments, "result": result,
                }),
            );
        } else {
            self.hub.emit(
                "tool-progress",
                serde_json::json!({
                    "type": kind, "name": name,
                    "path": path, "arguments": arguments, "result": result,
                }),
            );
        }
    }

    fn emit_model_routed(&self, model: &str) {
        self.hub.emit("model-routed", serde_json::Value::String(model.to_string()));
    }

    fn emit_subagent_start(&self, id: &str, agent: &str, task: &str, model: &str) {
        self.hub.emit(
            "subagent-start",
            serde_json::json!({ "id": id, "agent": agent, "task": task, "model": model }),
        );
    }

    fn emit_subagent_done(&self, id: &str, result: &str) {
        self.hub.emit(
            "subagent-done",
            serde_json::json!({ "id": id, "result": result }),
        );
    }

    fn emit_iteration_usage(
        &self,
        subagent_id: Option<&str>,
        payload: &main_impl::IterationUsagePayload,
    ) {
        // IterationUsagePayload serializes camelCase (matches the frontend).
        let event = if subagent_id.is_some() {
            "subagent-iteration-usage"
        } else {
            "iteration-usage"
        };
        let value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        self.hub.emit(event, value);
    }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct WebPty {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

struct AppState {
    hub: Hub,
    memory: Arc<main_impl::SubAgentMemory>,
    term_memory: Arc<main_impl::terminal_memory::TermMemory>,
    ptys: Mutex<HashMap<String, WebPty>>,
    kernels: Mutex<HashMap<String, main_impl::pykernel::KernelInstance>>,
    secrets_path: PathBuf,
    dist_dir: PathBuf,
    auth_token: Option<String>,
    /// Optional llama.cpp service URL (from `LLAMACPP_URL` env var, set by
    /// Railway's reference-variable syntax to the private-network URL of the
    /// llama.cpp service). Exposed to the frontend via `GET /api/config` so the
    /// web app auto-wires the llama.cpp provider without manual setup.
    llamacpp_url: Option<String>,
}

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("NOLOCK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".nolock-web")
}

// ---------------------------------------------------------------------------
// Auth (optional): set NOLOCK_WEB_TOKEN to lock the API down
// ---------------------------------------------------------------------------

fn authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let Some(expected) = &state.auth_token else {
        return true;
    };
    if let Some(Ok(bearer)) = headers.get("authorization").map(|v| v.to_str()) {
        if bearer == format!("Bearer {expected}") {
            return true;
        }
    }
    if let Some(q) = query_token {
        if q == expected {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// File-backed secret store (headless replacement for the OS keychain — the
// desktop keyring needs a secret service/dbus which doesn't exist on a server)
// ---------------------------------------------------------------------------

fn secrets_load(path: &PathBuf) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn secrets_save(path: &PathBuf, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create data directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Failed to serialize secrets: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write secrets: {}", e))
}

#[cfg(unix)]
fn secrets_harden(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn secrets_harden(_path: &PathBuf) {}

// ---------------------------------------------------------------------------
// Dispatch plumbing
// ---------------------------------------------------------------------------

/// Deserialize one command's camelCase args into a typed struct.
fn parse<T: serde::de::DeserializeOwned>(command: &str, args: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(args)
        .map_err(|e| format!("Invalid arguments for {command}: {e}"))
}

/// Convert a command result into the JSON envelope value.
fn ok<T: serde::Serialize>(result: Result<T, String>) -> Result<serde_json::Value, String> {
    match result {
        Ok(v) => serde_json::to_value(v)
            .map_err(|e| format!("Failed to serialize result: {e}")),
        Err(e) => Err(e),
    }
}

/// Declares a camelCase args struct in one line.
macro_rules! args {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct $name { $($field : $ty),* }
    };
}


// ---------------------------------------------------------------------------
// Command argument structs (frontend sends camelCase keys, Tauri-style)
// ---------------------------------------------------------------------------

args!(ReadFileArgs { path: String });
args!(WriteFileArgs { path: String, content: String });
args!(ListDirArgs { path: String, show_hidden: Option<bool> });
args!(ListRecArgs { path: String });
args!(RenameArgs { path: String, new_name: String });
args!(MoveArgs { source: String, dest_dir: String });
args!(DeleteArgs { path: String });
args!(CopyArgs { source: String, destination: String });
args!(CreateFileArgs { path: String });
args!(CreateDirArgs { path: String });
args!(AppendArgs { path: String, content: String });
args!(RootArgs { root_path: String });
args!(PathArgs { path: String });
args!(SearchArgs { root_path: String, query: String, match_case: bool, use_regex: bool });
args!(ReplaceArgs {
    root_path: String, query: String, replacement: String,
    match_case: bool, use_regex: bool, target_files: Option<Vec<String>>,
});
args!(SkillArgs { root_path: String, skill_name: String });
args!(RunToolArgs { root_path: String, tool_name: String, args: serde_json::Value });
args!(SaveHookArgs { root_path: String, name: String, config: serde_json::Value });
args!(WriteSwitchyardArgs { root_path: String, config: main_impl::switchyard::SwitchyardConfig });
args!(SessionIdArgs { root_path: String, id: String });
args!(SaveSessionArgs { root_path: String, session: main_impl::SessionRecord });
args!(ArchiveArgs { root_path: String, id: String, summary: String });
args!(GitFilesArgs { root_path: String, since_ts: u64 });
args!(GitDiffArgs { root_path: String, path: String, since_ts: u64 });
args!(LintArgs { path: String, prefs: Option<main_impl::linter::LinterPrefs> });
args!(ModelInfoArgs { req: main_impl::ModelInfoRequest });
args!(FetchModelsArgs { req: main_impl::FetchModelsRequest });
args!(FetchRoutersArgs { req: main_impl::FetchRoutersRequest });
args!(CompletionArgs { req: main_impl::CompletionRequest });
args!(ChatArgs { req: main_impl::ChatRequest });
args!(TermCmdArgs { command: String });
args!(TermCatArgs { command: String, category: String });
args!(SecretSetArgs { service: String, key: String, value: String });
args!(SecretGetArgs { service: String, key: String });
args!(PtySpawnArgs { id: String, shell: Option<String>, cwd: Option<String>, cols: u16, rows: u16 });
args!(PtyWriteArgs { id: String, data: String });
args!(PtyResizeArgs { id: String, cols: u16, rows: u16 });
args!(PtyIdArgs { id: String });
args!(KernelStartArgs { kernel_id: String, python_path: String, cwd: String });
args!(KernelRunArgs {
    kernel_id: String, run_id: String, code: String, timeout_secs: Option<u64>,
});
args!(UploadFileArgs { directory: String, name: String, content: Vec<u8> });
args!(KernelIdArgs { kernel_id: String });
args!(CreateEnvArgs { root_path: String, name: String });

// ---------------------------------------------------------------------------
// The dispatcher — mirrors `tauri::generate_handler!` one-to-one
// ---------------------------------------------------------------------------


async fn dispatch(state: &Arc<AppState>, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    match command {
        // ----- File system (direct reuse — same functions as the desktop app)
        "upload_file" => {
            let a: UploadFileArgs = parse(command, args)?;
            ok(main_impl::web_bridge::upload_file(a.directory, a.name, a.content))
        }
        "read_file" => {
            let a: ReadFileArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_file(a.path))
        }
        "write_file" => {
            let a: WriteFileArgs = parse(command, args)?;
            ok(main_impl::web_bridge::write_file(a.path, a.content))
        }
        "list_directory" => {
            let a: ListDirArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_directory(a.path, a.show_hidden))
        }
        "list_files_recursive" => {
            let a: ListRecArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_files_recursive(a.path))
        }
        "rename_file" => {
            let a: RenameArgs = parse(command, args)?;
            ok(main_impl::web_bridge::rename_file(a.path, a.new_name))
        }
        "move_file" => {
            let a: MoveArgs = parse(command, args)?;
            ok(main_impl::web_bridge::move_file(a.source, a.dest_dir))
        }
        "delete_file" => {
            let a: DeleteArgs = parse(command, args)?;
            ok(main_impl::web_bridge::delete_file(a.path))
        }
        "copy_file" => {
            let a: CopyArgs = parse(command, args)?;
            ok(main_impl::web_bridge::copy_file(a.source, a.destination))
        }
        "create_file" => {
            let a: CreateFileArgs = parse(command, args)?;
            ok(main_impl::web_bridge::create_file(a.path))
        }
        "create_directory" => {
            let a: CreateDirArgs = parse(command, args)?;
            ok(main_impl::web_bridge::create_directory(a.path))
        }
        "append_to_file" => {
            let a: AppendArgs = parse(command, args)?;
            ok(main_impl::web_bridge::append_to_file(a.path, a.content))
        }
        "open_path" => Err("open_path is only available in the desktop app".to_string()),
        "search_in_files" => {
            let a: SearchArgs = parse(command, args)?;
            ok(main_impl::web_bridge::search_in_files(a.root_path, a.query, a.match_case, a.use_regex))
        }
        "replace_in_files" => {
            let a: ReplaceArgs = parse(command, args)?;
            ok(main_impl::web_bridge::replace_in_files(a.root_path, a.query, a.replacement, a.match_case, a.use_regex, a.target_files))
        }

        // ----- Agents / micro-agents / skills / tools (direct reuse)
        "list_agents" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_agents(a.root_path))
        }
        "read_agent" => {
            let a: PathArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_agent(a.path))
        }
        "validate_agents" => {
            let a: RootArgs = parse(command, args)?;
            Ok(serde_json::to_value(main_impl::web_bridge::validate_agents(a.root_path)).unwrap_or_default())
        }
        "list_micro_agents" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_micro_agents(a.root_path))
        }
        "read_micro_agent" => {
            let a: PathArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_micro_agent(a.path))
        }
        "list_skills" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_skills(a.root_path))
        }
        "run_skill_command" => {
            let a: SkillArgs = parse(command, args)?;
            ok(main_impl::web_bridge::run_skill_command(a.root_path, a.skill_name))
        }
        "list_tools" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_tools(a.root_path))
        }
        "read_tool" => {
            let a: PathArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_tool(a.path))
        }
        "run_tool_command" => {
            let a: RunToolArgs = parse(command, args)?;
            ok(main_impl::web_bridge::run_tool_command(a.root_path, a.tool_name, a.args))
        }

        // ----- Hooks (direct reuse)
        "list_hooks" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::hooks::list_hooks(a.root_path))
        }
        "read_hook" => {
            let a: PathArgs = parse(command, args)?;
            ok(main_impl::hooks::read_hook(a.path))
        }
        "save_hook" => {
            let a: SaveHookArgs = parse(command, args)?;
            ok(main_impl::hooks::save_hook(a.root_path, a.name, a.config))
        }

        // ----- Switchyard (direct reuse)
        "read_switchyard_config" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_switchyard_config(a.root_path))
        }
        "write_switchyard_config" => {
            let a: WriteSwitchyardArgs = parse(command, args)?;
            main_impl::switchyard::validate_switchyard_config(&a.config)?;
            ok(main_impl::web_bridge::write_switchyard_config(a.root_path, a.config))
        }

        // ----- Sessions (direct reuse)
        "list_sessions" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::web_bridge::list_sessions(a.root_path))
        }
        "read_session" => {
            let a: SessionIdArgs = parse(command, args)?;
            ok(main_impl::web_bridge::read_session(a.root_path, a.id))
        }
        "save_session" => {
            let a: SaveSessionArgs = parse(command, args)?;
            ok(main_impl::web_bridge::save_session(a.root_path, a.session))
        }
        "delete_session" => {
            let a: SessionIdArgs = parse(command, args)?;
            ok(main_impl::web_bridge::delete_session(a.root_path, a.id))
        }
        "archive_session" => {
            let a: ArchiveArgs = parse(command, args)?;
            ok(main_impl::web_bridge::archive_session(a.root_path, a.id, a.summary))
        }

        // ----- Git session diffs (direct reuse)
        "git_session_files" => {
            let a: GitFilesArgs = parse(command, args)?;
            ok(main_impl::web_bridge::git_session_files(a.root_path, a.since_ts))
        }
        "git_session_file_diff" => {
            let a: GitDiffArgs = parse(command, args)?;
            ok(main_impl::web_bridge::git_session_file_diff(a.root_path, a.path, a.since_ts))
        }

        // ----- Linter (direct reuse)
        "run_linter" => {
            let a: LintArgs = parse(command, args)?;
            ok(main_impl::linter::run_linter(a.path, a.prefs))
        }

        // ----- Model discovery + one-shot completion (direct reuse)
        "get_model_info" => {
            let a: ModelInfoArgs = parse(command, args)?;
            ok(main_impl::web_bridge::get_model_info(a.req).await)
        }
        "fetch_models" => {
            let a: FetchModelsArgs = parse(command, args)?;
            ok(main_impl::web_bridge::fetch_models(a.req).await)
        }
        "fetch_digitalocean_routers" => {
            let a: FetchRoutersArgs = parse(command, args)?;
            ok(main_impl::web_bridge::fetch_digitalocean_routers(a.req).await)
        }
        "ai_complete" => {
            let a: CompletionArgs = parse(command, args)?;
            ok(main_impl::web_bridge::ai_complete(a.req).await)
        }

        // ----- ai_chat: same `run_chat` core the desktop app uses, with the
        // SSE-backed WebSink instead of the Tauri AppHandle. The frontend wraps
        // the request in `{ req: ... }` (matching the Tauri command signature
        // `ai_chat(req: ChatRequest)`), so unwrap it like the other req-commands.

        "ai_chat" => {
            let a: ChatArgs = parse(command, args)?;
            let sink = WebSink { hub: state.hub.clone() };
            ok(main_impl::run_chat(&sink, &state.memory, a.req).await)
        }
        "subagent_reset" => {
            state.memory.clear();
            Ok(serde_json::Value::Null)
        }

        // ----- Terminal memory (same TermMemory state, web entry points)
        "record_command" => {
            let a: TermCmdArgs = parse(command, args)?;
            ok(state.term_memory.record(a.command))
        }
        "get_top_commands" => ok(state.term_memory.top_commands()),
        "get_command_categories" => ok(state.term_memory.categories()),
        "save_command_category" => {
            let a: TermCatArgs = parse(command, args)?;
            ok(state.term_memory.save_category(a.command, a.category))
        }

        // ----- Secrets: file-backed store (no OS keychain on a server)
        "store_secret" => {
            let a: SecretSetArgs = parse(command, args)?;
            let mut map = secrets_load(&state.secrets_path);
            map.insert(format!("{}::{}", a.service, a.key), a.value);
            secrets_save(&state.secrets_path, &map)?;
            secrets_harden(&state.secrets_path);
            Ok(serde_json::Value::Null)
        }
        "get_secret" => {
            let a: SecretGetArgs = parse(command, args)?;
            let map = secrets_load(&state.secrets_path);
            Ok(serde_json::to_value(map.get(&format!("{}::{}", a.service, a.key)).cloned()).unwrap_or(serde_json::Value::Null))
        }
        "delete_secret" => {
            let a: SecretGetArgs = parse(command, args)?;
            let mut map = secrets_load(&state.secrets_path);
            map.remove(&format!("{}::{}", a.service, a.key));
            secrets_save(&state.secrets_path, &map)?;
            Ok(serde_json::Value::Null)
        }

        // ----- RLHF dir (web data dir instead of Tauri app data dir)
        "get_rlhf_dir" => {
            let dir = data_dir().join(".rlhf");
            std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create RLHF directory: {e}"))?;
            Ok(serde_json::Value::String(dir.to_string_lossy().to_string()))
        }

        // ----- PTY terminal (web variant of the same portable-pty logic)
        "pty_spawn" => {
            let a: PtySpawnArgs = parse(command, args)?;
            web_pty_spawn(state, a.id, a.shell, a.cwd, a.cols, a.rows)
        }
        "pty_write" => {
            let a: PtyWriteArgs = parse(command, args)?;
            let mut ptys = state.ptys.lock().map_err(|_| "PTY state poisoned")?;
            let instance = ptys.get_mut(&a.id).ok_or_else(|| format!("PTY {} not found", a.id))?;
            ok(instance
                .writer
                .write_all(a.data.as_bytes())
                .and_then(|_| instance.writer.flush())
                .map_err(|e| format!("Failed to write to PTY: {e}")))
        }
        "pty_resize" => {
            let a: PtyResizeArgs = parse(command, args)?;
            let ptys = state.ptys.lock().map_err(|_| "PTY state poisoned")?;
            let instance = ptys.get(&a.id).ok_or_else(|| format!("PTY {} not found", a.id))?;
            ok(instance
                .master
                .resize(portable_pty::PtySize { rows: a.rows, cols: a.cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("Failed to resize PTY: {e}")))
        }
        "pty_kill" => {
            let a: PtyIdArgs = parse(command, args)?;
            if let Some(mut pty) = state.ptys.lock().map_err(|_| "PTY state poisoned")?.remove(&a.id) {
                let _ = pty.writer.write_all(b"exit\n");
                let _ = pty.child.kill();
            }
            Ok(serde_json::Value::Null)
        }

        // ----- Python kernels (reuse pykernel's spawn/handshake/protocol core)
        "kernel_start" => {
            let a: KernelStartArgs = parse(command, args)?;
            web_kernel_start(state, a.kernel_id, a.python_path, a.cwd)
        }
        "kernel_run" => {
            let a: KernelRunArgs = parse(command, args)?;
            let conn = {
                let kernels = state.kernels.lock().map_err(|_| "Kernel state poisoned")?;
                kernels
                    .get(&a.kernel_id)
                    .ok_or_else(|| "Kernel is not running — connect first".to_string())?
                    .conn
                    .clone()
            };
            let hub = state.hub.clone();
            let kid = a.kernel_id.clone();
            let rid = a.run_id.clone();
            let code = a.code;
            let timeout = a.timeout_secs;
            let result = tokio::task::spawn_blocking(move || -> Result<main_impl::pykernel::RunResult, String> {
                let mut guard = conn.lock().map_err(|_| "Kernel connection poisoned")?;
                main_impl::pykernel::run_on_conn(
                    &mut *guard,
                    &rid,
                    &code,
                    timeout,
                    |kind, text| {
                        hub.emit(
                            "kernel-output",
                            serde_json::json!({ "kernelId": kid, "runId": rid, "kind": kind, "text": text }),
                        );
                    },
                )
            })
            .await
            .map_err(|e| format!("kernel task failed: {e}"))?;
            ok(result)
        }
        "kernel_interrupt" => {
            let a: KernelIdArgs = parse(command, args)?;
            let pid = {
                let kernels = state.kernels.lock().map_err(|_| "Kernel state poisoned")?;
                kernels.get(&a.kernel_id).map(|i| i.child.id())
            };
            match pid {
                Some(pid) => {
                    // SAFETY: sending SIGINT by pid — same as pykernel's send_sigint.
                    let rc = unsafe { libc::kill(pid as i32, libc::SIGINT) };
                    if rc == 0 {
                        Ok(serde_json::Value::Null)
                    } else {
                        Err("Failed to interrupt kernel".to_string())
                    }
                }
                None => Err("Kernel is not running".to_string()),
            }
        }
        "kernel_stop" => {
            let a: KernelIdArgs = parse(command, args)?;
            if let Some(mut inst) = state.kernels.lock().map_err(|_| "Kernel state poisoned")?.remove(&a.kernel_id) {
                let _ = inst.child.kill();
                let _ = inst.child.wait();
            }
            Ok(serde_json::Value::Null)
        }
        "kernel_status" => {
            let a: KernelIdArgs = parse(command, args)?;
            let kernels = state.kernels.lock().map_err(|_| "Kernel state poisoned")?;
            let status = match kernels.get(&a.kernel_id) {
                Some(inst) => main_impl::pykernel::KernelStatus {
                    running: true,
                    pid: Some(inst.child.id()),
                    python_path: Some(inst.python_path.clone()),
                },
                None => main_impl::pykernel::KernelStatus {
                    running: false,
                    pid: None,
                    python_path: None,
                },
            };
            ok(Ok(status))
        }

        // ----- Python environments (list = direct reuse; create = web variant)
        "python_list_envs" => {
            let a: RootArgs = parse(command, args)?;
            ok(main_impl::notebook::python_list_envs(a.root_path))
        }
        "python_create_env" => {
            let a: CreateEnvArgs = parse(command, args)?;
            web_python_create_env(&state.hub, a.root_path, a.name)
        }

        // ----- Browser panel: needs a native webview, desktop only
        "create_browser_webview" | "close_browser_webview" | "update_browser_webview" => Err(
            "The browser panel requires the nolock desktop app (native webview)".to_string(),
        ),

        _ => Err(format!("Unknown command: {command}")),
    }
}

// ---------------------------------------------------------------------------
// Web PTY (same portable-pty flow as the desktop pty_spawn, events → SSE hub)
// ---------------------------------------------------------------------------

fn web_pty_spawn(
    state: &Arc<AppState>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<serde_json::Value, String> {
    let pty_system = portable_pty::native_pty_system();
    let shell_path = shell.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    });

    let pair = pty_system
        .openpty(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = portable_pty::CommandBuilder::new(&shell_path);
    if let Some(ref c) = cwd {
        cmd.cwd(c);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    // Reader thread: forward PTY output to every SSE client.
    let hub = state.hub.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    hub.emit("pty-output", serde_json::json!({ "id": id_clone, "data": data }));
                }
            }
        }
        hub.emit("pty-exit", serde_json::Value::String(id_clone));
    });

    // Replace any previous instance with the same id (restart semantics).
    let mut ptys = state.ptys.lock().map_err(|_| "PTY state poisoned")?;
    if let Some(mut old) = ptys.remove(&id) {
        let _ = old.writer.write_all(b"exit\n");
        let _ = old.child.kill();
    }
    ptys.insert(id, WebPty { writer, master: pair.master, child });

    Ok(serde_json::Value::Null)
}

// ---------------------------------------------------------------------------
// Web python kernels (reuse pykernel's spawn/handshake/run core)
// ---------------------------------------------------------------------------

fn web_kernel_start(
    state: &Arc<AppState>,
    kernel_id: String,
    python_path: String,
    cwd: String,
) -> Result<serde_json::Value, String> {
    // Restart semantics: kill any previous instance with the same id.
    {
        let mut kernels = state.kernels.lock().map_err(|_| "Kernel state poisoned")?;
        if let Some(mut old) = kernels.remove(&kernel_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    let proc = main_impl::pykernel::spawn_kernel(&python_path, &cwd)?;
    let main_impl::pykernel::KernelProc { mut child, stream, python_version } = proc;
    let pid = child.id();

    // Drain stderr so the pipe never blocks; detect death → kernel-died event.
    let hub = state.hub.clone();
    let kid = kernel_id.clone();
    if let Some(mut stderr_pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match stderr_pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            hub.emit(
                "kernel-died",
                serde_json::json!({ "kernelId": kid, "pid": pid }),
            );
        });
    }

    let info = main_impl::pykernel::KernelInfo { pid, python_version };
    state.kernels.lock().map_err(|_| "Kernel state poisoned")?.insert(
        kernel_id,
        main_impl::pykernel::KernelInstance {
            child,
            conn: Arc::new(Mutex::new(stream)),
            python_path,
            cwd,
        },
    );

    serde_json::to_value(info).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Web python_create_env (same steps as notebook::python_create_env, events → SSE)
// ---------------------------------------------------------------------------

fn web_python_create_env(
    hub: &Hub,
    root_path: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let emit = |stage: &str, message: String| {
        hub.emit("pyenv-progress", serde_json::json!({ "name": name, "stage": stage, "message": message }));
    };

    let name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if name.is_empty() {
        return Err("Environment name must contain letters, digits, '-' or '_'".to_string());
    }
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("Open a workspace folder first".to_string());
    }

    let venvs_dir = root.join(".venvs");
    std::fs::create_dir_all(&venvs_dir).map_err(|e| format!("Failed to create .venvs directory: {e}"))?;
    let target = venvs_dir.join(&name);
    if target.exists() {
        return Err(format!("Environment '{name}' already exists"));
    }

    // Base interpreter: prefer python3, fall back to python.
    let base = ["python3", "python"]
        .iter()
        .find_map(|c| which_python(c))
        .ok_or_else(|| "No system python3 found — install Python 3 first".to_string())?;

    emit("starting", format!("Creating virtual environment '{name}'…"));
    let output = std::process::Command::new(&base)
        .args(["-m", "venv"])
        .arg(&target)
        .output()
        .map_err(|e| format!("Failed to run venv creation: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        emit("error", stderr.clone());
        return Err(format!("venv creation failed: {stderr}"));
    }
    emit("done", format!("Environment '{name}' created"));

    let python_path = target.join("bin/python");
    let version = std::process::Command::new(&python_path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().trim_start_matches("Python ").to_string())
        .map(|v| format!("Python {v}"))
        .unwrap_or_else(|| "Python".to_string());

    ok::<main_impl::notebook::PythonEnv>(Ok(main_impl::notebook::PythonEnv {
        name,
        python_path: python_path.to_string_lossy().to_string(),
        kind: "venv".to_string(),
        version,
    }))
}

fn which_python(candidate: &str) -> Option<String> {
    let out = std::process::Command::new(candidate).arg("--version").output().ok()?;
    out.status.success().then(|| candidate.to_string())
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async fn health_handler() -> &'static str {
    "ok"
}

/// Lightweight auth check used by the web login page. Returns 200 when the
/// request carries a valid token (Bearer header), 401 otherwise. Marked
/// no-store so proxies never cache an auth decision.

async fn auth_check_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

/// Server-provided config for the web frontend. Currently exposes the optional
/// llama.cpp service URL (from `LLAMACPP_URL`) so the web app auto-wires the
/// llama.cpp provider without manual setup. Auth via Bearer header or `?token=`.
async fn config_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, params.get("token").map(|s| s.as_str())) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "ok": true,
            "llamacppUrl": state.llamacpp_url,
        })),
    )
        .into_response()
}

async fn invoke_upload_handler(
    state: axum::extract::State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> impl axum::response::IntoResponse {
    invoke_handler(state, axum::extract::Path("upload_file".to_string()), headers, body).await
}

async fn invoke_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(command): AxumPath<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authorized(&state, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let args: serde_json::Value =
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    match dispatch(&state, &command, args).await {
        Ok(value) => Json(serde_json::json!({ "ok": true, "data": value })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

/// Server-Sent Events stream carrying every event the desktop app emits via
/// `app.emit(...)` as a `data: {"event": ..., "payload": ...}` JSON line.
async fn events_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, params.get("token").map(|s| s.as_str())) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let rx = state.hub.tx.subscribe();
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    return Some((
                        Ok::<_, Infallible>(
                            axum::response::sse::Event::default().data(msg),
                        ),
                        rx,
                    ))
                }
                // Slow client fell behind — skip missed messages, keep streaming.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// Static frontend serving with SPA fallback (hand-rolled — no extra deps).
async fn static_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Reject traversal attempts.
    if path.split('/').any(|seg| seg == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    serve_static_file(&state.dist_dir, path)
}

fn serve_static_file(dist_dir: &PathBuf, path: &str) -> Response {
    let candidates: Vec<String> = if path.is_empty() {
        vec!["index.html".to_string()]
    } else {
        vec![path.to_string(), "index.html".to_string()] // SPA fallback
    };

    for candidate in candidates {
        let full = dist_dir.join(&candidate);
        if full.is_file() {
            let mime = mime_for(&candidate);
            if let Ok(bytes) = std::fs::read(&full) {
                return (
                    [(axum::http::header::CONTENT_TYPE, mime)],
                    bytes,
                )
                    .into_response();
            }
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "ipynb" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Serve a file from the server filesystem. Used by the web export feature to
/// open an exported HTML notebook in a new browser tab (the browser cannot open
/// server-side paths directly, so the server streams the file back over HTTP).
/// Auth via Bearer header or `?token=` (the latter so a plain `window.open`
/// link works — EventSource-style query tokens are already supported).
async fn file_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, params.get("token").map(|s| s.as_str())) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let Some(path) = params.get("path") else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    let full = PathBuf::from(&path);
    if !full.is_file() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }
    let mime = mime_for(&path);
    if let Ok(bytes) = std::fs::read(&full) {
        return (
            [(axum::http::header::CONTENT_TYPE, mime)],
            bytes,
        )
            .into_response();
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let dist_dir: PathBuf = std::env::var("NOLOCK_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./public"));
    let auth_token = std::env::var("NOLOCK_WEB_TOKEN").ok().filter(|t| !t.is_empty());
    let llamacpp_url = std::env::var("LLAMACPP_URL").ok().filter(|u| !u.is_empty());

    let state = Arc::new(AppState {
        hub: Hub::new(),
        memory: Arc::new(main_impl::SubAgentMemory::new()),
        term_memory: Arc::new(main_impl::terminal_memory::TermMemory::new()),
        ptys: Mutex::new(HashMap::new()),
        kernels: Mutex::new(HashMap::new()),
        secrets_path: data_dir().join("secrets.json"),
        dist_dir: dist_dir.clone(),
        auth_token: auth_token.clone(),
        llamacpp_url,
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/auth/check", get(auth_check_handler))
        .route("/api/config", get(config_handler))
        .route("/api/events", get(events_handler))
        .route("/api/file", get(file_handler))
        // JSON byte arrays need up to four wire bytes per file byte.
        .route("/api/invoke/upload_file", post(invoke_upload_handler)
            .layer(axum::extract::DefaultBodyLimit::max(40_000_000 + 65_536)))
        .route("/api/invoke/{command}", post(invoke_handler))
        .fallback(get(static_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));

    eprintln!(
        "nolock-server listening on http://{addr} (dist: {}, auth: {})",
        dist_dir.display(),
        if auth_token.is_some() { "token required" } else { "open" }
    );

    axum::serve(listener, app)
        .await
        .expect("server error");
}
