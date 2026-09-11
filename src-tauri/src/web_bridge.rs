//! Web bridge — public entry points for the headless web server
//! (`bin/nolock-server.rs`).
//!
//! The Tauri command functions in the crate root stay private: a `pub` command
//! at the crate root collides with the `#[macro_export]` macro that the
//! `#[tauri::command]` attribute generates (E0255). This child module can
//! access those private functions and re-expose the exact same logic — no
//! duplication, the web server simply runs the same code paths as the desktop
//! app's IPC layer.

// ----- File system ---------------------------------------------------------

pub fn read_file(path: String) -> Result<String, String> {
    super::read_file(path)
}

pub fn write_file(path: String, content: String) -> Result<(), String> {
    super::write_file(path, content)
}

pub fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<super::DirEntry>, String> {
    super::list_directory(path, show_hidden)
}

pub fn list_files_recursive(path: String) -> Result<Vec<String>, String> {
    super::list_files_recursive(path)
}

pub fn rename_file(path: String, new_name: String) -> Result<(), String> {
    super::rename_file(path, new_name)
}

pub fn move_file(source: String, dest_dir: String) -> Result<(), String> {
    super::move_file(source, dest_dir)
}

pub fn delete_file(path: String) -> Result<(), String> {
    super::delete_file(path)
}

pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    super::copy_file(source, destination)
}

pub fn create_file(path: String) -> Result<(), String> {
    super::create_file(path)
}

pub fn create_directory(path: String) -> Result<(), String> {
    super::create_directory(path)
}

pub fn append_to_file(path: String, content: String) -> Result<(), String> {
    super::append_to_file(path, content)
}

pub fn search_in_files(
    root_path: String,
    query: String,
    match_case: bool,
    use_regex: bool,
) -> Result<Vec<super::SearchMatch>, String> {
    super::search_in_files(root_path, query, match_case, use_regex)
}

pub fn replace_in_files(
    root_path: String,
    query: String,
    replacement: String,
    match_case: bool,
    use_regex: bool,
    target_files: Option<Vec<String>>,
) -> Result<super::ReplaceResult, String> {
    super::replace_in_files(root_path, query, replacement, match_case, use_regex, target_files)
}

// ----- Agents / micro-agents / skills / tools ------------------------------

pub fn list_agents(root_path: String) -> Result<Vec<super::AgentEntry>, String> {
    super::list_agents(root_path)
}

pub fn read_agent(path: String) -> Result<serde_json::Value, String> {
    super::read_agent(path)
}

pub fn validate_agents(root_path: String) -> Vec<String> {
    super::validate_agents(root_path)
}

pub fn list_micro_agents(root_path: String) -> Result<Vec<super::AgentEntry>, String> {
    super::list_micro_agents(root_path)
}

pub fn read_micro_agent(path: String) -> Result<serde_json::Value, String> {
    super::read_micro_agent(path)
}

pub fn list_skills(root_path: String) -> Result<Vec<super::SkillEntry>, String> {
    super::list_skills(root_path)
}

pub fn run_skill_command(root_path: String, skill_name: String) -> Result<super::SkillCommandResult, String> {
    super::run_skill_command(root_path, skill_name)
}

pub fn list_tools(root_path: String) -> Result<Vec<super::CustomToolEntry>, String> {
    super::list_tools(root_path)
}

pub fn read_tool(path: String) -> Result<serde_json::Value, String> {
    super::read_tool(path)
}

pub fn run_tool_command(
    root_path: String,
    tool_name: String,
    args: serde_json::Value,
) -> Result<String, String> {
    super::run_tool_command(root_path, tool_name, args)
}

// ----- Switchyard ----------------------------------------------------------

pub fn read_switchyard_config(root_path: String) -> Result<super::switchyard::SwitchyardConfig, String> {
    super::read_switchyard_config(root_path)
}

pub fn write_switchyard_config(
    root_path: String,
    config: super::switchyard::SwitchyardConfig,
) -> Result<(), String> {
    super::write_switchyard_config(root_path, config)
}

// ----- Sessions ------------------------------------------------------------

pub fn list_sessions(root_path: String) -> Result<Vec<super::SessionRecord>, String> {
    super::list_sessions(root_path)
}

pub fn read_session(root_path: String, id: String) -> Result<super::SessionRecord, String> {
    super::read_session(root_path, id)
}

pub fn save_session(root_path: String, session: super::SessionRecord) -> Result<(), String> {
    super::save_session(root_path, session)
}

pub fn delete_session(root_path: String, id: String) -> Result<(), String> {
    super::delete_session(root_path, id)
}

pub fn archive_session(root_path: String, id: String, summary: String) -> Result<(), String> {
    super::archive_session(root_path, id, summary)
}

// ----- Git session diffs ---------------------------------------------------

pub fn git_session_files(
    root_path: String,
    since_ts: u64,
) -> Result<Vec<super::GitChangedFile>, String> {
    super::git_session_files(root_path, since_ts)
}

pub fn git_session_file_diff(
    root_path: String,
    path: String,
    since_ts: u64,
) -> Result<super::GitFileDiff, String> {
    super::git_session_file_diff(root_path, path, since_ts)
}

// ----- Model discovery + one-shot completion (async) -----------------------

pub async fn get_model_info(
    req: super::ModelInfoRequest,
) -> Result<super::ModelInfoResult, String> {
    super::get_model_info(req).await
}

pub async fn fetch_models(
    req: super::FetchModelsRequest,
) -> Result<Vec<super::ModelListItem>, String> {
    super::fetch_models(req).await
}

pub async fn fetch_digitalocean_routers(
    req: super::FetchRoutersRequest,
) -> Result<Vec<super::RouterItem>, String> {
    super::fetch_digitalocean_routers(req).await
}

pub async fn ai_complete(req: super::CompletionRequest) -> Result<String, String> {
    super::ai_complete(req).await
}

pub fn upload_file(directory: String, name: String, content: Vec<u8>) -> Result<String, String> {
    super::upload_file(directory, name, content)
}
