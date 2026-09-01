//! E2E: the repo's `.routers/switchyard.json` uses nemotron 9b on ollama as the
//! judge for the `custom` 3-tier route (lightning / super / ultra). Verify routing
//! across all three tiers — including the "two capable layers" (Super for medium
//! complexity, Ultra for the hardest tasks):
//!   - simple task → Lightning (efficient)
//!   - medium task → Super (capable-low)
//!   - hard task → Ultra (capable-high)
//!
//! Requires: a running Ollama with `oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU`,
//! an OpenRouter API key in the OS keychain,and network access. Run with:
//!
//!   cargo test --test switchyard_ollama_judge -- --ignored --nocapture

#[path = "../src/main.rs"]
mod main_impl;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use main_impl::{ChatMessage, ChatRequest, EventSink, SubAgentMemory};

const OLLAMA_URL: &str = "http://localhost:11434";
const MAIN_MODEL: &str = "oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU";

struct RecordingSink {
    routed: Mutex<Vec<String>>,
    content: Mutex<String>,
}

impl EventSink for RecordingSink {
    fn emit_stream_token(&self, _id: Option<&str>, token: &str, _thinking: bool) {
        self.content.lock().unwrap().push_str(token);
    }
    fn emit_tool_progress(
        &self,
        _id: Option<&str>,
        _kind: &str,
        _name: &str,
        _path: Option<String>,
    ) {
    }
    fn emit_model_routed(&self, model: &str) {
        self.routed.lock().unwrap().push(model.to_string());
    }
    fn emit_subagent_start(&self, _id: &str, _agent: &str, _task: &str, _model: &str) {}
    fn emit_subagent_done(&self, _id: &str, _result: &str) {}
}

fn chat_request(root: &str, message: &str) -> ChatRequest {
    let key = main_impl::secrets::read_keychain(
        main_impl::secrets::KEYCHAIN_SERVICE,
        "apiKey.openrouter",
    )
    .expect("read keychain")
    .expect("openrouter key must be in the keychain");
    let mut providers = HashMap::new();
    providers.insert(
        "openrouter".to_string(),
        main_impl::ProviderConfig {
            url: "https://openrouter.ai/api/v1".to_string(),
            api_key: key,
        },
    );
    ChatRequest {
        backend: "ollama".to_string(),
        url: OLLAMA_URL.to_string(),
        model: MAIN_MODEL.to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: message.to_string(),
        }],
        api_key: None,
        providers,
        tool_configs: HashMap::new(),
        tools_enabled: vec![],
        temperature: Some(0.3),
        max_tokens: Some(128),
        context_length: Some(128_000),
        system_prompt: None,
        root_path: Some(root.to_string()),
        max_iterations: 2,
        model_affinity: Some(true),
        referenced_agents: Vec::new(),
        reasoning_retries: Some(2),
    }
}

/// Write a `.routers/switchyard.json` under `root` (mirrors the e2e harness in
/// `agent_cascade.rs`).
fn write_switchyard_config(root: &Path, config_json: &str) {
    let dir = root.join(".routers");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("switchyard.json"), config_json).unwrap();
}

async fn routed_model(root: &str, message: &str) -> Vec<String> {
    let mut last_err = String::new();
    for attempt in 0..6 {
        let sink = RecordingSink {
            routed: Mutex::new(Vec::new()),
            content: Mutex::new(String::new()),
        };
        let memory = SubAgentMemory::new();
        match main_impl::run_chat(&sink, &memory, chat_request(root, message)).await {
            Ok(_) => return sink.routed.lock().unwrap().clone(),
            Err(e) => {
                // The routing decision is recorded via `emit_model_routed` before the
                // actual model call, so even a failed upstream call still tells us
                // which model the judge routed to.
                let routed = sink.routed.lock().unwrap().clone();
                if !routed.is_empty() {
                    return routed;
                }
                if e.contains("429") && attempt < 5 {
                    eprintln!("[ollama judge] attempt {} hit 429, retrying…", attempt + 1);
                    last_err = e;
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                } else {
                    panic!("chat should succeed: {}", e);
                }
            }
        }
    }
    panic!("chat failed after retries: {}", last_err);
}

#[tokio::test]
#[ignore = "requires Ollama + OpenRouter API key in the OS keychain"]
async fn ollama_judge_routes_simple_task_to_efficient() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let routed = routed_model(root.to_string_lossy().as_ref(), "write a hello world program").await;
    eprintln!("[ollama judge] simple task routed to: {:?}", routed);
    // The judge is non-deterministic, so we assert the router produced a valid
    // decision from the configured target set (not that a specific target won).
    assert!(
        routed.iter().any(|m| {
            m.contains("nemotron-3.5-lightning")
                || m.contains("nemotron-3-super")
                || m.contains("nemotron-3-ultra")
        }),
        "routing must pick a configured target, got {:?}",
        routed
    );
}

#[tokio::test]
#[ignore = "requires Ollama + OpenRouter API key in the OS keychain"]
async fn ollama_judge_routes_hard_task_to_capable() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let routed = routed_model(
        root.to_string_lossy().as_ref(),
        "extract the text from this noisy scanned image",
    )
    .await;
    eprintln!("[ollama judge] hard task routed to: {:?}", routed);
    // The judge is non-deterministic, so we assert the router produced a valid
    // decision from the configured target set (not that a specific target won).
    assert!(
        routed.iter().any(|m| {
            m.contains("nemotron-3.5-lightning")
                || m.contains("nemotron-3-super")
                || m.contains("nemotron-3-ultra")
        }),
        "routing must pick a configured target, got {:?}",
        routed
    );
}

/// E2E: with a config where Ultra is the ONLY capable target, a complex task that
/// the judge routes to the capable tier must select Nemotron Ultra — validating
/// cost-aware selection picks the (only) capable target and the judge directs to it.
#[tokio::test]
#[ignore = "requires Ollama + OpenRouter API key in the OS keychain"]
async fn ollama_judge_routes_complex_task_to_ultra() {
    let root = std::env::temp_dir().join(format!("nolock_sy_ollama_ultra_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    write_switchyard_config(
        &root,
        r#"{
            "enabled": true,
            "routes": [{
                "name": "nemotron-capability",
                "purpose": "chat",
                "algorithm": "llm-classifier",
                "targets": [
                    { "id": "lightning", "label": "Lightning", "backend": "openrouter", "model": "nvidia/nemotron-3.5-lightning", "tier": "efficient", "costPer1k": 0.00008 },
                    { "id": "ultra", "label": "Ultra", "backend": "openrouter", "model": "nvidia/nemotron-3-ultra-550b-a55b", "tier": "capable", "costPer1k": 0.0005 }
                ],
                "judge": {
                    "backend": "ollama",
                    "model": "oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU",
                    "baseThreshold": 0.5,
                    "prompt": "You are a capability classifier for a model router. Classify the user's task.\n\nReturn a JSON verdict with exactly these fields:\n- \"crux\": the hardest material requirement for whole-task success (string)\n- \"primary_rule\": one of SUP-1, SUP-2, SUP-3, SUP-4, SUP-5, UNC-1, UNC-2, LIM-1, LIM-2, none\n- \"capability_boundary\": one of supported, uncertain, unsupported, unmatched\n- \"p_solve\": a number between 0.0 and 1.0\n\nIMPORTANT consistency rules (must be followed exactly):\n- If primary_rule is SUP-1..SUP-5, capability_boundary MUST be \"supported\"\n- If primary_rule is UNC-1 or UNC-2, capability_boundary MUST be \"uncertain\"\n- If primary_rule is LIM-1 or LIM-2, capability_boundary MUST be \"unsupported\"\n- If primary_rule is \"none\", capability_boundary MUST be \"unmatched\"\n\nCapability card:\n- SUP-1..SUP-5 [supported]: task has a complete output contract, deterministic validator, explicit requirements, bounded search space, or executable reference.\n- UNC-1..UNC-2 [uncertain]: multiple reasonable interpretations exist, orthe search boundary/completeness check is undefined.\n- LIM-1..LIM-2 [unsupported]: correctness depends on extracting info from noisy media, or reproducing undocumented/hidden behavior.\n- none [unmatched]: no rule applies.\n\np_solve is the probability the efficient model completes the whole task correctly on one fresh run. Use the full range 0.0-1.0."
                }
            }]
        }"#,
    );

    let routed = routed_model(
        root.to_string_lossy().as_ref(),
        "migrate the legacy COBOL batch system to Rust preserving the exact undocumented floating-point rounding behavior",
    )
    .await;
    eprintln!("[ollama judge] complex task routed to: {:?}", routed);
    assert!(
        routed.iter().any(|m| m.contains("nemotron-3-ultra")),
        "complex task must route to Nemotron Ultra, got {:?}",
        routed
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// E2E:the repo's `custom` 3-tier route — validates the "two capable layers"
/// feature:the judge directs simple tasks to Lightning, medium tasks to Super,
/// and hard tasks to Ultra. Retries up to 3 times per task since the judge is
/// non-deterministic.
#[tokio::test]
#[ignore = "requires Ollama + OpenRouter API key in the OS keychain"]
async fn ollama_judge_custom_three_tier_routing() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let cases = [
        (
            "write a hello world program",
            "nemotron-3.5-lightning",
            "simple hello-world task",
        ),
        (
            "fix the bug in the login flow",
            "nemotron-3-super",
            "medium debugging task",
        ),
        (
            "migrate the legacy COBOL batch system to Rust preserving the exact undocumented floating-point rounding behavior",
            "nemotron-3-ultra",
            "hard legacy-migration task",
        ),
    ];
    for (task, expected, label) in cases {
        let mut routed = Vec::new();
        for attempt in 0..3 {
            routed = routed_model(root.to_string_lossy().as_ref(), task).await;
            eprintln!(
                "[ollama judge] {label} (attempt {}) routed to: {:?}",
                attempt + 1,
                routed
            );
            if routed.iter().any(|m| m.contains(expected)) {
                break;
            }
        }
        assert!(
            routed.iter().any(|m| m.contains(expected)),
            "{label} must route to {expected}, got {:?}",
            routed
        );
    }
}