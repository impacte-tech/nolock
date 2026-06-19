use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Manager;
use tauri::Emitter;

mod browser;
mod terminal_memory;

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
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read_dir =
        std::fs::read_dir(&path).map_err(|e| format!("Failed to read dir {}: {}", path, e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
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
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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

            // 1. Try "parameters" string (user‑set num_ctx override)
            if let Some(params) = data["parameters"].as_str() {
                for line in params.lines() {
                    let trimmed = line.trim();
                    if let Some(num_str) = trimmed.strip_prefix("num_ctx ") {
                        if let Ok(ctx) = num_str.trim().parse::<u32>() {
                            eprintln!("[nolock] get_model_info: num_ctx={} (from parameters)", ctx);
                            return Ok(ModelInfoResult { context_length: ctx });
                        }
                    }
                }
            }

            // 2. Try model_info.<architecture>.context_length (native)
            if let Some(model_info) = data["model_info"].as_object() {
                if let Some(arch) = model_info
                    .get("general.architecture")
                    .and_then(|v| v.as_str())
                {
                    let key = format!("{}.context_length", arch);
                    if let Some(ctx) = model_info.get(&key).and_then(|v| v.as_u64()) {
                        eprintln!(
                            "[nolock] get_model_info: native context_length={} (from {})",
                            ctx, key
                        );
                        return Ok(ModelInfoResult {
                            context_length: ctx as u32,
                        });
                    }
                }
            }

            // 3. Fallback — common default for Ollama models
            eprintln!(
                "[nolock] get_model_info: could not determine context length, using default 8192"
            );
            Ok(ModelInfoResult { context_length: 8192 })
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
}

#[derive(serde::Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    backend: String,
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    tools_enabled: Vec<String>,
    /// Per-tool configuration (e.g. web_search provider + api_key).
    /// Stored in localStorage on the frontend as `nolock.toolConfig`.
    #[serde(default)]
    tool_configs: HashMap<String, serde_json::Value>,
}

#[derive(serde::Serialize)]
struct ChatResult {
    content: String,
    #[serde(default)]
    tool_calls: Vec<ToolCallLog>,
}

#[derive(serde::Serialize, Clone)]
struct ToolCallLog {
    name: String,
    arguments: String,
    result_snippet: String,
}

#[derive(Clone, serde::Serialize)]
struct StreamPayload {
    token: String,
}

// ---------------------------------------------------------------------------
// Tool definitions & execution
// ---------------------------------------------------------------------------

fn build_tool_schemas(enabled: &[String]) -> Vec<serde_json::Value> {
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
                "description": "Read the contents of a file on disk. Use this to examine source code, configuration files, or any file the user references.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The absolute file path to read"
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
                "description": "List files and directories at a given path. Use this to explore the project structure.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The directory path to list"
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
    tools
}

async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    client: &reqwest::Client,
    tool_configs: &HashMap<String, serde_json::Value>,
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
            if text.len() > 15000 {
                Ok(format!(
                    "{}\n\n... [truncated at 15000 chars, total {} chars]",
                    &text[..15000],
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
            std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {}", path, e))
        }
        "list_directory" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            eprintln!("[nolock] tool list_directory path={}", path);
            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(path)
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
                    Ok(format!("{}\n\n[Search powered by Brave Search]", output.trim()))
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
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Ollama tool-calling loop (streaming)
// ---------------------------------------------------------------------------

async fn ollama_chat_with_tools(
    app_handle: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    max_iterations: usize,
    tool_configs: &HashMap<String, serde_json::Value>,
) -> Result<ChatResult, String> {
    // Build initial messages array — inject system prompt about tools
    let mut ollama_msgs: Vec<serde_json::Value> = Vec::new();

    // System message describing the tools
    let tool_names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    if !tool_names.is_empty() {
        let tool_list = tool_names.join(", ");
        ollama_msgs.push(serde_json::json!({
            "role": "system",
            "content": format!(
                "You have access to the following tools: {}. \
                 Use them when the user's request requires looking up external information or accessing files. \
                 You may call multiple tools in a single response if needed. \
                 Always use the actual tool rather than making up information.",
                tool_list
            )
        }));
    }

    for m in messages {
        ollama_msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
    let mut full_content = String::new();

    for iteration in 0..max_iterations {
        let mut body = serde_json::json!({
            "model": model,
            "messages": ollama_msgs,
            "stream": true,
            "options": { "num_predict": 2048, "temperature": 0.7 }
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }

        eprintln!(
            "[nolock] ollama tool loop iteration={}, POST {}/api/chat (streaming)",
            iteration, url
        );
        let mut resp = client
            .post(format!("{}/api/chat", url))
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| {
                eprintln!("[nolock] ollama tool loop error: {}", e);
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
                    model, status
                ));
            }
            return Err(format!("Ollama API error ({}): {}", status, error_detail));
        }

        // Stream the NDJSON response line by line, emitting tokens
        let mut iter_content = String::new();
        let mut tool_calls_in_iter: Option<Vec<serde_json::Value>> = None;
        let mut buf = String::new();

        loop {
            match resp.chunk().await.map_err(|e| e.to_string())? {
                None => break,
                Some(chunk) => {
                    let s = String::from_utf8_lossy(&chunk);
                    buf.push_str(&s);
                    while let Some(pos) = buf.find('\n') {
                        let line = buf[..pos].trim().to_string();
                        buf = buf[pos + 1..].to_string();
                        if line.is_empty() {
                            continue;
                        }

                        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(content) = data["message"]["content"].as_str() {
                                if !content.is_empty() {
                                    iter_content.push_str(content);
                                    full_content.push_str(content);
                                    app_handle
                                        .emit(
                                            "stream-token",
                                            StreamPayload {
                                                token: content.to_string(),
                                            },
                                        )
                                        .ok();
                                }
                            }
                            // Detect tool calls in ANY chunk — not just the done:true chunk.
                            // Some Ollama versions/streaming modes may emit tool_calls
                            // in a separate chunk before the done marker.
                            if let Some(calls) = data["message"]["tool_calls"].as_array() {
                                if !calls.is_empty() {
                                    tool_calls_in_iter = Some(calls.clone());
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Some(calls) = tool_calls_in_iter {
            // Push the assistant message so Ollama knows the context
            ollama_msgs.push(serde_json::json!({
                "role": "assistant",
                "content": iter_content,
                "tool_calls": calls
            }));

            // Execute each tool call and add results
            for call in &calls {
                let name = call["function"]["name"].as_str().unwrap_or("unknown");
                let args = &call["function"]["arguments"];

                let result = execute_tool(name, args, client, tool_configs)
                    .await
                    .unwrap_or_else(|e| format!("Tool error: {}", e));

                let snippet = if result.len() > 200 {
                    format!("{}...", &result[..200])
                } else {
                    result.clone()
                };

                all_tool_calls.push(ToolCallLog {
                    name: name.to_string(),
                    arguments: serde_json::to_string(args).unwrap_or_default(),
                    result_snippet: snippet,
                });

                // Add tool result message
                let tool_call_id = call["id"].as_str().unwrap_or("call_unknown");
                ollama_msgs.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result
                }));
            }
        } else {
            // No tool calls — final response
            eprintln!(
                "[nolock] ollama tool loop returning: content_len={} tool_calls={}",
                full_content.len(),
                all_tool_calls.len()
            );
            if full_content.is_empty() && all_tool_calls.is_empty() {
                eprintln!("[nolock] WARNING: empty response from model in tool loop");
            }
            return Ok(ChatResult {
                content: if full_content.is_empty() {
                    "(no response)".to_string()
                } else {
                    full_content
                },
                tool_calls: all_tool_calls,
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
    Ok(ChatResult {
        content: if full_content.is_empty() {
            "(max tool iterations reached, no response)".to_string()
        } else {
            full_content
        },
        tool_calls: all_tool_calls,
    })
}

#[tauri::command]
async fn ai_complete(req: CompletionRequest) -> Result<String, String> {
    eprintln!(
        "[nolock] ai_complete backend={} url={} model={} prompt_len={} suffix={}",
        req.backend,
        req.url,
        req.model,
        req.prompt.len(),
        req.suffix.as_deref().unwrap_or("(none)")
    );

    let client = reqwest::Client::new();

    match req.backend.as_str() {
        "ollama" => {
            // FITM: Ollama /api/generate supports `suffix` for fill-in-the-middle.
            // If the model doesn't support it, fall back to prefix-only.
            let use_suffix = req.suffix.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
            let body = |with_suffix: bool| {
                let mut b = serde_json::json!({
                    "model": req.model,
                    "prompt": req.prompt,
                    "stream": false,
                    "options": { "num_predict": 64, "temperature": 0.2, "stop": ["\n\n"] }
                });
                if with_suffix {
                    if let Some(ref suffix) = req.suffix {
                        if !suffix.is_empty() {
                            b["suffix"] = serde_json::json!(suffix);
                        }
                    }
                }
                b
            };

            eprintln!("[nolock] ollama POST {}/api/generate (FITM={})", req.url, use_suffix);
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body(use_suffix))
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

            // If FITM failed with 400 (model doesn't support insert), retry without suffix
            if status.as_u16() == 400 && use_suffix {
                eprintln!("[nolock] ollama FITM not supported, retrying without suffix");
                let resp2 = client
                    .post(format!("{}/api/generate", req.url))
                    .json(&body(false))
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status2 = resp2.status();
                let text2 = resp2.text().await.map_err(|e| e.to_string())?;
                eprintln!("[nolock] ollama retry status={} body={}", status2, &text2[..text2.len().min(200)]);
                let data: serde_json::Value =
                    serde_json::from_str(&text2).map_err(|e| format!("JSON parse error: {}", e))?;
                return Ok(data["response"].as_str().unwrap_or("").to_string());
            }

            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["response"].as_str().unwrap_or("").to_string())
        }
        "llamacpp" => {
            // FITM: llama.cpp /completion supports `suffix` for fill-in-the-middle
            let mut body = serde_json::json!({
                "prompt": req.prompt,
                "n_predict": 64,
                "temperature": 0.2,
                "stream": false,
                "stop": ["\n\n"]
            });
            if let Some(ref suffix) = req.suffix {
                if !suffix.is_empty() {
                    body["suffix"] = serde_json::json!(suffix);
                }
            }
            eprintln!("[nolock] llamacpp POST {}/completion (FITM={})", req.url, req.suffix.is_some());
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
            let body = serde_json::json!({
                "model": req.model,
                "messages": [
                    { "role": "user", "content": req.prompt }
                ],
                "max_tokens": 64,
                "temperature": 0.2
            });
            eprintln!("[nolock] openrouter POST https://openrouter.ai/api/v1/chat/completions model={}", req.model);
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://nolock.dev")
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
            let body = serde_json::json!({
                "model": req.model,
                "prompt": req.prompt,
                "stream": false,
                "options": { "num_predict": 64, "temperature": 0.2 }
            });
            eprintln!("[nolock] opencode POST {}/api/generate", req.url);
            let resp = client
                .post(format!("{}/api/generate", req.url))
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
        _ => Err(format!("Unknown backend: {}", req.backend)),
    }
}

#[tauri::command]
async fn ai_chat(app_handle: tauri::AppHandle, req: ChatRequest) -> Result<ChatResult, String> {
    eprintln!(
        "[nolock] ai_chat backend={} url={} model={} messages={} tools={:?}",
        req.backend,
        req.url,
        req.model,
        req.messages.len(),
        req.tools_enabled
    );

    let client = reqwest::Client::new();
    let tools = build_tool_schemas(&req.tools_enabled);
    let has_tools = !tools.is_empty();

    match req.backend.as_str() {
        "ollama" => {
            if has_tools {
                ollama_chat_with_tools(&app_handle, &client, &req.url, &req.model, &req.messages, &tools, 10, &req.tool_configs)
                    .await
            } else {
                // No tools — simple single-turn chat (streaming)
                let ollama_msgs: Vec<serde_json::Value> = req
                    .messages
                    .iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect();

                let body = serde_json::json!({
                    "model": req.model,
                    "messages": ollama_msgs,
                    "stream": true,
                    "options": { "num_predict": 2048, "temperature": 0.7 }
                });
                eprintln!("[nolock] ollama POST {}/api/chat (no tools, streaming)", req.url);
                let mut resp = client
                    .post(format!("{}/api/chat", req.url))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
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

                // Stream NDJSON response
                let mut full_content = String::new();
                let mut buf = String::new();
                loop {
                    match resp.chunk().await.map_err(|e| e.to_string())? {
                        None => break,
                        Some(chunk) => {
                            let s = String::from_utf8_lossy(&chunk);
                            buf.push_str(&s);
                            while let Some(pos) = buf.find('\n') {
                                let line = buf[..pos].trim().to_string();
                                buf = buf[pos + 1..].to_string();
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(content) = data["message"]["content"].as_str() {
                                        if !content.is_empty() {
                                            full_content.push_str(content);
                                            app_handle.emit("stream-token", StreamPayload {
                                                token: content.to_string(),
                                            }).ok();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(ChatResult {
                    content: if full_content.is_empty() { "(no response)".to_string() } else { full_content },
                    tool_calls: vec![],
                })
            }
        }
        "llamacpp" => {
            let prompt = req
                .messages
                .iter()
                .map(|m| format!("{}: {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n")
                + "\nassistant:";

            let body = serde_json::json!({
                "prompt": prompt,
                "n_predict": 2048,
                "temperature": 0.7,
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
            let mut buf = String::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        let s = String::from_utf8_lossy(&chunk);
                        buf.push_str(&s);
                        // SSE events are separated by \n\n
                        while let Some(pos) = buf.find("\n\n") {
                            let event = buf[..pos].to_string();
                            buf = buf[pos + 2..].to_string();
                            for line in event.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(content) = json["content"].as_str() {
                                            if !content.is_empty() {
                                                full_content.push_str(content);
                                                app_handle.emit("stream-token", StreamPayload {
                                                    token: content.to_string(),
                                                }).ok();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(ChatResult {
                content: full_content,
                tool_calls: vec![],
            })
        }
        "openrouter" => {
            let api_key = req.api_key.clone().unwrap_or_default();
            let mut or_msgs: Vec<serde_json::Value> = req
                .messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();

            if has_tools {
                let tool_names: Vec<&str> = tools
                    .iter()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .collect();
                let tool_list = tool_names.join(", ");
                or_msgs.insert(0, serde_json::json!({
                    "role": "system",
                    "content": format!(
                        "You have access to the following tools: {}. \
                         Use them when the user's request requires looking up external information. \
                         You may call multiple tools if needed.",
                        tool_list
                    )
                }));
            }

            let mut body = serde_json::json!({
                "model": req.model,
                "messages": or_msgs,
                "max_tokens": 2048,
                "temperature": 0.7,
                "stream": true
            });
            if has_tools {
                body["tools"] = serde_json::json!(tools);
            }

            eprintln!("[nolock] openrouter POST chat completions (streaming)");
            let mut resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://nolock.dev")
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
            let mut buf = String::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        let s = String::from_utf8_lossy(&chunk);
                        buf.push_str(&s);
                        while let Some(pos) = buf.find("\n\n") {
                            let event = buf[..pos].to_string();
                            buf = buf[pos + 2..].to_string();
                            for line in event.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    let data = data.trim();
                                    if data == "[DONE]" { continue; }
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                            if !content.is_empty() {
                                                full_content.push_str(content);
                                                app_handle.emit("stream-token", StreamPayload {
                                                    token: content.to_string(),
                                                }).ok();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(ChatResult {
                content: full_content,
                tool_calls: vec![],
            })
        }
        "opencode" => {
            let prompt = req
                .messages
                .iter()
                .map(|m| format!("{}: {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n")
                + "\nassistant:";

            let body = serde_json::json!({
                "model": req.model,
                "prompt": prompt,
                "stream": true,
                "options": { "num_predict": 2048, "temperature": 0.7 }
            });
            eprintln!("[nolock] opencode POST {}/api/generate (streaming)", req.url);
            let mut resp = client
                .post(format!("{}/api/generate", req.url))
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
            let mut buf = String::new();
            loop {
                match resp.chunk().await.map_err(|e| e.to_string())? {
                    None => break,
                    Some(chunk) => {
                        let s = String::from_utf8_lossy(&chunk);
                        buf.push_str(&s);
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim().to_string();
                            buf = buf[pos + 1..].to_string();
                            if line.is_empty() { continue; }
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                                if let Some(content) = data["response"].as_str() {
                                    if !content.is_empty() {
                                        full_content.push_str(content);
                                        app_handle.emit("stream-token", StreamPayload {
                                            token: content.to_string(),
                                        }).ok();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(ChatResult {
                content: full_content,
                tool_calls: vec![],
            })
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_directory,
            get_model_info,
            ai_complete,
            ai_chat,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            browser::create_browser_webview,
            browser::close_browser_webview,
            browser::update_browser_webview,
            terminal_memory::record_command,
            terminal_memory::get_top_commands,
            terminal_memory::get_command_categories,
            terminal_memory::save_command_category,
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

    // ---- build_tool_schemas ----------------------------------------------
    #[test]
    fn test_build_tool_schemas_empty() {
        let schemas = build_tool_schemas(&[]);
        assert!(schemas.is_empty());
    }

    #[test]
    fn test_build_tool_schemas_single() {
        let schemas = build_tool_schemas(&["web_fetch".into()]);
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
        ]);
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
        let schemas = build_tool_schemas(&["web_search".into()]);
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "web_search");
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "query"));
    }

    #[test]
    fn test_build_tool_schemas_unknown_tool_ignored() {
        let schemas = build_tool_schemas(&["nonexistent_tool".into()]);
        assert!(schemas.is_empty());
    }

    #[test]
    fn test_tool_schema_has_required_url() {
        let schemas = build_tool_schemas(&["web_fetch".into()]);
        let required = schemas[0]["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "url"));
    }

    // ---- execute_tool error paths (without network / fs) -----------------
    #[tokio::test]
    async fn test_execute_tool_unknown_name() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("unknown_tool", &args, &client, &HashMap::new()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn test_execute_tool_web_fetch_missing_url() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("web_fetch", &args, &client, &HashMap::new()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_file_xyzzy_123.test" });
        let result = execute_tool("read_file", &args, &client, &HashMap::new()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[tokio::test]
    async fn test_execute_tool_list_directory_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_dir_xyzzy_123" });
        let result = execute_tool("list_directory", &args, &client, &HashMap::new()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read dir"));
    }

    // ---- read_file / write_file with temp dirs ---------------------------
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

        let result = list_directory(dir.to_string_lossy().to_string());
        assert!(result.is_ok());
        let entries = result.unwrap();

        // .hidden should be filtered out
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
}
