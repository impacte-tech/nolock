//! nolock CLI — headless chat client for the full main/sub/micro-agent stack.
//!
//! Invokes the same `run_chat` core as the Tauri app (same tool loops, same
//! sub-agent spawning, micro-agent deterministic validation, repetition /
//! context-summarization recovery) but reports progress to stdout/stderr via a
//! `CliSink` instead of emitting frontend events.
//!
//! Examples:
//!   # Main agent alone (plain chat, no tools)
//!   nolock-cli --message "hello"
//!
//!   # Full agent stack against a project with .agents + .micro-agents
//!   nolock-cli --message "@code-reviewer review src/main.rs" \
//!       --root /path/to/project --tools read_file,edit,write_file,grep,bash_sandbox
//!
//!   # Explicit routing to a model per tier (ollama local)
//!   nolock-cli --message "fix the rust errors in src/" \
//!       --url http://localhost:11434 --model nemotron-nano-9b-v2 \
//!       --root . --tools read_file,edit,write_file,bash_sandbox

// The CLI crate includes the full nolock app module; most of its functions are
// only reachable through `run_chat`, so silence dead-code noise here.
#![allow(dead_code)]

use std::collections::HashMap;

#[path = "../main.rs"]
mod main_impl;

use main_impl::{ChatMessage, ChatRequest, ChatResult, CliSink, SubAgentMemory};

fn print_usage() {
    eprintln!(
        "nolock-cli — drive nolock's main/sub/micro-agent chat from the terminal\n\n\
         USAGE:\n  \
         nolock-cli [FLAGS] --message <text>\n\n\
         FLAGS:\n  \
         --backend <ollama|openrouter|opencode|digitalocean|llamacpp>  (default: ollama)\n  \
         --url <url>                    backend endpoint (default ~ localhost:11434)\n  \
         --model <model>                main agent model (default: nemotron-nano-9b-v2)\n  \
         --message <text>               the user prompt (required)\n  \
         --system <text>                optional system prompt\n  \
         --root <path>                  project root with .agents / .micro-agents\n  \
         --tools <a,b,c>                tool names to enable for the tool loop\n  \
         --temperature <float>          sampling temperature (default 0.7)\n  \
         --max-tokens <int>             max output tokens\n  \
         --context-length <int>         model context window (default 128000)\n  \
         --max-iterations <int>         tool-loop iterations (default 10)\n  \
         --referenced-agents <a,b>      pre-spawn @agent mentions\n  \
         --api-key <key>                API key for cloud backends\n  \
         --reasoning-retries <int>      thinking-only retry budget (default 8)\n  \
         --no-color                     disable ANSI in streamed output\n"
    );
}

fn parse_args(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(key) = a.strip_prefix("--") {
            if key == "help" || key == "h" {
                print_usage();
                std::process::exit(0);
            }
            if i + 1 < args.len() {
                map.insert(key.to_string(), args[i + 1].clone());
                i += 2;
            } else {
                return Err(format!("missing value for --{}", key));
            }
        } else {
            return Err(format!("unexpected positional argument: {}", a));
        }
    }
    Ok(map)
}

fn build_request(args: &HashMap<String, String>) -> Result<ChatRequest, String> {
    let message = args
        .get("message")
        .ok_or_else(|| "missing required --message".to_string())?
        .clone();

    let mut messages: Vec<ChatMessage> = Vec::new();
    if let Some(sys) = args.get("system") {
        messages.push(ChatMessage { role: "system".to_string(), content: sys.clone() });
    }
    messages.push(ChatMessage { role: "user".to_string(), content: message.clone() });

    let tools: Vec<String> = args
        .get("tools")
        .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let referenced_agents: Vec<String> = args
        .get("referenced-agents")
        .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    Ok(ChatRequest {
        backend: args.get("backend").cloned().unwrap_or_else(|| "ollama".to_string()),
        url: args
            .get("url")
            .cloned()
            .unwrap_or_else(|| "http://localhost:11434".to_string()),
        model: args
            .get("model")
            .cloned()
            .unwrap_or_else(|| "nemotron-nano-9b-v2".to_string()),
        messages,
        api_key: args.get("api-key").cloned(),
        providers: HashMap::new(),
        tool_configs: HashMap::new(),
        tools_enabled: tools,
        temperature: args.get("temperature").and_then(|v| v.parse().ok()),
        max_tokens: args.get("max-tokens").and_then(|v| v.parse().ok()),
        context_length: args
            .get("context-length")
            .and_then(|v| v.parse::<u32>().ok()),
        system_prompt: args.get("system").cloned(),
        root_path: args.get("root").cloned(),
        max_iterations: args
            .get("max-iterations")
            .and_then(|v| v.parse().ok())
            .unwrap_or(10),
        model_affinity: Some(true),
        referenced_agents,
        reasoning_retries: args.get("reasoning-retries").and_then(|v| v.parse().ok()),
    })
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let map = match parse_args(&args) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: {}", e);
            print_usage();
            std::process::exit(2);
        }
    };

    let req = match build_request(&map) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            print_usage();
            std::process::exit(2);
        }
    };

    let sink = CliSink;
    let memory = SubAgentMemory::new();

    eprintln!(
        "nolock-cli: backend={} model={} tools={} root={}",
        req.backend,
        req.model,
        req.tools_enabled.join(","),
        req.root_path.clone().unwrap_or_default()
    );

    match main_impl::run_chat(&sink, &memory, req).await {
        Ok(ChatResult { content, tool_calls, context_tokens, thinking_tokens }) => {
            println!("\n\n{}", content);
            if !tool_calls.is_empty() {
                eprintln!("\n[trace] {} tool call(s), context ~{} tokens (incl. ~{} thinking)",
                    tool_calls.len(), context_tokens, thinking_tokens);
            }
        }
        Err(e) => {
            eprintln!("\nerror: {}", e);
            std::process::exit(1);
        }
    }
}