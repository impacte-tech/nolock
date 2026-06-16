use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Manager;
use tauri::Emitter;

mod browser;

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
    tools
}

async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    client: &reqwest::Client,
) -> Result<String, String> {
    match name {
        "web_fetch" => {
            let url = args["url"]
                .as_str()
                .ok_or("Missing required parameter: url")?;
            eprintln!("[zencode] tool web_fetch url={}", url);
            let resp = client
                .get(url)
                .timeout(std::time::Duration::from_secs(15))
                .header("User-Agent", "Zencode/0.1")
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
            eprintln!("[zencode] tool read_file path={}", path);
            std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {}", path, e))
        }
        "list_directory" => {
            let path = args["path"]
                .as_str()
                .ok_or("Missing required parameter: path")?;
            eprintln!("[zencode] tool list_directory path={}", path);
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
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Ollama tool-calling loop
// ---------------------------------------------------------------------------

async fn ollama_chat_with_tools(
    client: &reqwest::Client,
    url: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    max_iterations: usize,
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

    for iteration in 0..max_iterations {
        let mut body = serde_json::json!({
            "model": model,
            "messages": ollama_msgs,
            "stream": false,
            "options": { "num_predict": 2048, "temperature": 0.7 }
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }

        eprintln!(
            "[zencode] ollama tool loop iteration={}, POST {}/api/chat",
            iteration, url
        );
        let resp = client
            .post(format!("{}/api/chat", url))
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| {
                eprintln!("[zencode] ollama tool loop error: {}", e);
                e.to_string()
            })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        eprintln!(
            "[zencode] ollama tool loop status={} body={}",
            status,
            &text[..text.len().min(300)]
        );

        let data: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;

        let content = data["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let tool_calls = data["message"]["tool_calls"].as_array();

        if let Some(calls) = tool_calls {
            if calls.is_empty() {
                // No tool calls — final response
                return Ok(ChatResult {
                    content,
                    tool_calls: all_tool_calls,
                });
            }

            // Push the assistant message (with tool_calls) so Ollama knows the context
            ollama_msgs.push(serde_json::json!({
                "role": "assistant",
                "content": content,
                "tool_calls": calls
            }));

            // Execute each tool call and add results
            for call in calls {
                let name = call["function"]["name"].as_str().unwrap_or("unknown");
                let args = &call["function"]["arguments"];

                let result = execute_tool(name, args, client)
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
                ollama_msgs.push(serde_json::json!({
                    "role": "tool",
                    "tool_name": name,
                    "content": result
                }));
            }
        } else {
            // No tool_calls array at all — final response
            return Ok(ChatResult {
                content,
                tool_calls: all_tool_calls,
            });
        }
    }

    // If we exhausted iterations, return what we have
    Ok(ChatResult {
        content: "(max tool iterations reached)".to_string(),
        tool_calls: all_tool_calls,
    })
}

#[tauri::command]
async fn ai_complete(req: CompletionRequest) -> Result<String, String> {
    eprintln!(
        "[zencode] ai_complete backend={} url={} model={} prompt_len={} suffix={}",
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

            eprintln!("[zencode] ollama POST {}/api/generate (FITM={})", req.url, use_suffix);
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body(use_suffix))
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[zencode] ollama error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] ollama status={} body={}", status, &text[..text.len().min(300)]);

            // If FITM failed with 400 (model doesn't support insert), retry without suffix
            if status.as_u16() == 400 && use_suffix {
                eprintln!("[zencode] ollama FITM not supported, retrying without suffix");
                let resp2 = client
                    .post(format!("{}/api/generate", req.url))
                    .json(&body(false))
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status2 = resp2.status();
                let text2 = resp2.text().await.map_err(|e| e.to_string())?;
                eprintln!("[zencode] ollama retry status={} body={}", status2, &text2[..text2.len().min(200)]);
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
            eprintln!("[zencode] llamacpp POST {}/completion (FITM={})", req.url, req.suffix.is_some());
            let resp = client
                .post(format!("{}/completion", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[zencode] llamacpp error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] llamacpp status={} body={}", status, &text[..text.len().min(200)]);
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
            eprintln!("[zencode] openrouter POST https://openrouter.ai/api/v1/chat/completions model={}", req.model);
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://zencode.dev")
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[zencode] openrouter error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] openrouter status={} body={}", status, &text[..text.len().min(200)]);
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
            eprintln!("[zencode] opencode POST {}/api/generate", req.url);
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| {
                    eprintln!("[zencode] opencode error: {}", e);
                    e.to_string()
                })?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] opencode status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(data["response"].as_str().unwrap_or("").to_string())
        }
        _ => Err(format!("Unknown backend: {}", req.backend)),
    }
}

#[tauri::command]
async fn ai_chat(req: ChatRequest) -> Result<ChatResult, String> {
    eprintln!(
        "[zencode] ai_chat backend={} url={} model={} messages={} tools={:?}",
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
                // Use the tool-calling loop
                ollama_chat_with_tools(&client, &req.url, &req.model, &req.messages, &tools, 10)
                    .await
            } else {
                // No tools — simple single-turn chat
                let ollama_msgs: Vec<serde_json::Value> = req
                    .messages
                    .iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect();

                let body = serde_json::json!({
                    "model": req.model,
                    "messages": ollama_msgs,
                    "stream": false,
                    "options": { "num_predict": 2048, "temperature": 0.7 }
                });
                eprintln!("[zencode] ollama POST {}/api/chat (no tools)", req.url);
                let resp = client
                    .post(format!("{}/api/chat", req.url))
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| {
                        eprintln!("[zencode] ollama chat error: {}", e);
                        e.to_string()
                    })?;
                let status = resp.status();
                let text = resp.text().await.map_err(|e| e.to_string())?;
                eprintln!("[zencode] ollama chat status={} body={}", status, &text[..text.len().min(200)]);
                let data: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
                Ok(ChatResult {
                    content: data["message"]["content"]
                        .as_str()
                        .unwrap_or("(no response)")
                        .to_string(),
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
                "stream": false
            });
            eprintln!("[zencode] llamacpp POST {}/completion", req.url);
            let resp = client
                .post(format!("{}/completion", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] llamacpp chat status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(ChatResult {
                content: data["content"].as_str().unwrap_or("").to_string(),
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

            // Add system message about tools for OpenRouter
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
                "temperature": 0.7
            });
            if has_tools {
                body["tools"] = serde_json::json!(tools);
            }

            eprintln!("[zencode] openrouter POST chat completions");
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("HTTP-Referer", "https://zencode.dev")
                .json(&body)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            eprintln!("[zencode] openrouter chat status={} body={}", status, &text[..text.len().min(200)]);
            let data: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {}", e))?;
            Ok(ChatResult {
                content: data["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
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
                "stream": false,
                "options": { "num_predict": 2048, "temperature": 0.7 }
            });
            let resp = client
                .post(format!("{}/api/generate", req.url))
                .json(&body)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok(ChatResult {
                content: data["response"].as_str().unwrap_or("").to_string(),
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
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_directory,
            ai_complete,
            ai_chat,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            browser::create_browser_webview,
            browser::close_browser_webview,
            browser::update_browser_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running zencode");
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
        ]);
        assert_eq!(schemas.len(), 3);

        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"web_fetch"));
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"list_directory"));
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
        let result = execute_tool("unknown_tool", &args, &client).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn test_execute_tool_web_fetch_missing_url() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({});
        let result = execute_tool("web_fetch", &args, &client).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn test_execute_tool_read_file_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_file_xyzzy_123.test" });
        let result = execute_tool("read_file", &args, &client).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[tokio::test]
    async fn test_execute_tool_list_directory_nonexistent() {
        let client = reqwest::Client::new();
        let args = serde_json::json!({ "path": "/tmp/nonexistent_dir_xyzzy_123" });
        let result = execute_tool("list_directory", &args, &client).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read dir"));
    }

    // ---- read_file / write_file with temp dirs ---------------------------
    #[test]
    fn test_write_and_read_file() {
        let dir = std::env::temp_dir().join("zencode_test_write_read");
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
        let result = read_file("/tmp/definitely_not_a_real_file_zencode.test".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    // ---- list_directory with temp dir ------------------------------------
    #[test]
    fn test_list_directory_temp() {
        let dir = std::env::temp_dir().join("zencode_test_list_dir");
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
