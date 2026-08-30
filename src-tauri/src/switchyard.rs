//! switchyard-libsy integration — "general routers" for nolock's agent flows.
//!
//! This module plugs NVIDIA's `switchyard-libsy` routing algorithms into nolock
//! WITHOUT changing how agents are written or how transport works. nolock keeps
//! its own Ollama/OpenAI streaming transport (so the nemotron thinking/tool
//! pipeline is untouched); libsy only *decides* which model/backend serves a
//! request.
//!
//! Routing policy lives in a per-project `.routers/switchyard.json` file (next to
//! `.agents/`), so routes are versioned project config. The file is deliberately
//! secret-free: targets reference `(backend, model)` only, and credentials keep
//! coming from the request's `providers` map / OS keychain at request time.
//!
//! Supported algorithms ("general routers"):
//!   - `passthrough`   — always call one configured target.
//!   - `random`        — pick among N targets with uniform or weighted routing.
//!   - `llm-classifier`— a judge model classifies the task and routes between an
//!                       "efficient" and a "capable" target.
//!
//! The integration is fail-safe: any config/parse/libsy error falls through to
//! nolock's current provider resolution — routing never blocks a chat.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use switchyard_libsy::{
    Algorithm, ClassifierContractConfig, LlmClassifierConfig, LlmTarget, LlmTargetSet,
    LlmTaskClassifier, Passthrough, Random, Step, TaskClassifierConfig,
};
use switchyard_protocol::{
    Context, LlmResponse, Request, Response, text_request, text_response,
};

// ---------------------------------------------------------------------------
// Config schema — mirrors `.routers/switchyard.json`
// ---------------------------------------------------------------------------

/// The whole `.routers/switchyard.json` document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchyardConfig {
    /// Global switch for the whole project. When `false` (the default) routing
    /// is skipped entirely and nolock behaves exactly as before.
    #[serde(default)]
    pub enabled: bool,
    /// Ordered routing policies. The first route whose `purpose` matches the
    /// request is used.
    #[serde(default)]
    pub routes: Vec<SwitchyardRoute>,
}

/// One routing policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchyardRoute {
    /// Human-readable name (shown in the Switchyard panel / logs).
    pub name: String,
    /// Which request kind this route applies to.
    #[serde(default = "default_purpose")]
    pub purpose: RoutePurpose,
    /// Which routing algorithm to run.
    #[serde(default = "default_algorithm")]
    pub algorithm: RouteAlgorithm,
    /// The candidate targets the router may pick from.
    pub targets: Vec<SwitchyardTarget>,
    /// Optional relative weights for `random` routing (same order as targets).
    #[serde(default)]
    pub weights: Option<Vec<f64>>,
    /// Judge model config for `llm-classifier` routes.
    #[serde(default)]
    pub judge: Option<SwitchyardJudge>,
    /// Target `id` to fall back to when the router produces no usable decision.
    #[serde(default)]
    pub fallback: Option<String>,
}

fn default_purpose() -> RoutePurpose {
    RoutePurpose::Chat
}
fn default_algorithm() -> RouteAlgorithm {
    RouteAlgorithm::Random
}

/// The request kinds a route can govern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutePurpose {
    /// The main agent chat / orchestrator request.
    Chat,
    /// A spawned sub-agent request.
    Subagent,
    /// Choosing which sub-agent should run (agent selection).
    AgentSelect,
    /// Inline completion (FITM) requests.
    Fitm,
}

/// The routing algorithms libsy provides that nolock exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteAlgorithm {
    Passthrough,
    Random,
    LlmClassifier,
}

/// One candidate routing destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchyardTarget {
    /// Unique id within the route; the router's decision names this id.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Provider/backend name (ollama, openrouter, …) — resolved against the
    /// request's `providers` map for url + api key.
    pub backend: String,
    /// Provider model id.
    pub model: String,
    /// For `llm-classifier`: `"efficient"` or `"capable"`.
    #[serde(default)]
    pub tier: Option<String>,
    /// For `random`: per-target weight (relative).
    #[serde(default)]
    pub weight: Option<f64>,
}

/// Judge model config for `llm-classifier` routes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchyardJudge {
    /// Provider/backend name for the judge model.
    pub backend: String,
    /// Judge model id.
    pub model: String,
    /// Optional override for the packaged capability-classifier prompt.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Solve-probability threshold that routes a supported task to the
    /// efficient target. Defaults to 0.5.
    #[serde(default)]
    pub base_threshold: Option<f64>,
}

/// A resolved provider endpoint (url + api key) for a backend, mirroring
/// main.rs's `ProviderConfig` without coupling this module to it.
#[derive(Debug, Clone, Default)]
pub struct ProviderEndpoint {
    pub url: String,
    pub api_key: String,
}

/// The outcome of a routing decision: the concrete provider to call.
#[derive(Debug, Clone)]
pub struct SelectedTarget {
    pub route_name: String,
    pub algorithm: RouteAlgorithm,
    pub backend: String,
    pub model: String,
    pub url: String,
    pub api_key: String,
    pub reasoning: Option<String>,
}

/// Transport callback the host provides to serve classifier/judge model calls.
/// Params: `(backend, model, url, api_key, prompt)` → judge completion text.
/// nolock implements this over its own reqwest transport; tests mock it.
pub type JudgeTransport = Arc<
    dyn Fn(String, String, String, String, String) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/// Load `.routers/switchyard.json` under `root_path`. A missing file yields the
/// default (disabled) config; a malformed file is an error.
pub fn read_switchyard_config(root_path: &str) -> Result<SwitchyardConfig, String> {
    let path = Path::new(root_path).join(".routers").join("switchyard.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(SwitchyardConfig::default()),
    };
    serde_json::from_str(&content)
        .map_err(|e| format!("invalid .routers/switchyard.json: {}", e))
}

/// Write `.routers/switchyard.json` under `root_path`, creating `.routers/`.
pub fn write_switchyard_config(root_path: &str, config: &SwitchyardConfig) -> Result<(), String> {
    let dir = Path::new(root_path).join(".routers");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create .routers: {}", e))?;
    let path = dir.join("switchyard.json");
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("failed to write {}: {}", path.display(), e))
}

/// Validate a config before persisting it (mirrors `validate_agents`).
pub fn validate_switchyard_config(config: &SwitchyardConfig) -> Result<(), String> {
    for route in &config.routes {
        if route.name.trim().is_empty() {
            return Err("route name must not be empty".to_string());
        }
        if route.targets.is_empty() {
            return Err(format!("route '{}' has no targets", route.name));
        }
        for t in &route.targets {
            if t.id.trim().is_empty() || t.model.trim().is_empty() {
                return Err(format!(
                    "route '{}' has a target with an empty id or model",
                    route.name
                ));
            }
        }
        if route.algorithm == RouteAlgorithm::LlmClassifier && route.judge.is_none() {
            return Err(format!(
                "route '{}' uses llm-classifier but has no judge",
                route.name
            ));
        }
        if let Some(weights) = &route.weights {
            if weights.len() != route.targets.len() {
                return Err(format!(
                    "route '{}' has {} weights for {} targets",
                    route.name,
                    weights.len(),
                    route.targets.len()
                ));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/// Resolve the provider for `purpose` under `root_path`.
///
/// Returns `Ok(None)` when routing is disabled, no route matches, or the router
/// produced no usable decision — the caller then uses its current resolution.
/// Any error is logged and also falls through (`Ok(None)`), never blocking a chat.
pub async fn resolve_route(
    root_path: &str,
    purpose: RoutePurpose,
    task: &str,
    providers: &HashMap<String, ProviderEndpoint>,
    default_backend: &str,
    default_model: &str,
    default_url: &str,
    default_api_key: &str,
    judge_transport: JudgeTransport,
) -> Result<Option<SelectedTarget>, String> {
    let config = read_switchyard_config(root_path)?;
    if !config.enabled {
        return Ok(None);
    }
    let Some(route) = config.routes.iter().find(|r| r.purpose == purpose) else {
        return Ok(None);
    };
    if route.targets.is_empty() {
        return Ok(None);
    }

    let algorithm = build_algorithm(route)?;
    let decision = match drive_algorithm(
        algorithm,
        task,
        &judge_transport,
        route.judge.as_ref(),
        providers,
        default_backend,
        default_model,
        default_url,
        default_api_key,
    )
    .await
    {
        Ok(Some(d)) => d,
        Ok(None) => return Ok(None),
        Err(e) => {
            eprintln!("[switchyard] route '{}' failed: {}", route.name, e);
            return Ok(None);
        }
    };

    // Map the router's selected semantic name (a target id) back to a target.
    let target = route
        .targets
        .iter()
        .find(|t| t.id == decision.selected)
        .or_else(|| route.targets.iter().find(|t| t.model == decision.selected))
        .or_else(|| {
            route
                .fallback
                .as_deref()
                .and_then(|fb| route.targets.iter().find(|t| t.id == fb))
        })
        .or_else(|| route.targets.first());
    let Some(target) = target else {
        return Ok(None);
    };

    let ep = providers.get(&target.backend);
    let url = ep
        .and_then(|e| if e.url.is_empty() { None } else { Some(e.url.clone()) })
        .unwrap_or_else(|| default_url.to_string());
    let api_key = ep
        .and_then(|e| if e.api_key.is_empty() { None } else { Some(e.api_key.clone()) })
        .unwrap_or_else(|| default_api_key.to_string());

    Ok(Some(SelectedTarget {
        route_name: route.name.clone(),
        algorithm: route.algorithm,
        backend: target.backend.clone(),
        model: target.model.clone(),
        url,
        api_key,
        reasoning: decision.reasoning,
    }))
}

/// Build the libsy algorithm for a route. Targets carry no default client —
/// nolock serves every offloaded call itself (see `drive_algorithm`).
fn build_algorithm(route: &SwitchyardRoute) -> Result<Arc<dyn Algorithm>, String> {
    let targets: Vec<LlmTarget> = route
        .targets
        .iter()
        .map(|t| LlmTarget {
            semantic_name: t.id.clone(),
            llm_client: None,
        })
        .collect();
    let target_set = LlmTargetSet::new(targets);

    match route.algorithm {
        RouteAlgorithm::Passthrough => {
            let target = target_set
                .targets()
                .first()
                .cloned()
                .ok_or_else(|| "passthrough route has no targets".to_string())?;
            Ok(Arc::new(Passthrough::new(target)))
        }
        RouteAlgorithm::Random => {
            let weights = route.weights.clone();
            Random::new(target_set, weights, None)
                .map(|r| Arc::new(r) as Arc<dyn Algorithm>)
                .map_err(|e| e.to_string())
        }
        RouteAlgorithm::LlmClassifier => {
            let judge = route
                .judge
                .as_ref()
                .ok_or_else(|| "llm-classifier route requires a judge".to_string())?;
            let judge_target = LlmTarget {
                semantic_name: format!("judge:{}", judge.model),
                llm_client: None,
            };
            let efficient = route
                .targets
                .iter()
                .find(|t| t.tier.as_deref() == Some("efficient"))
                .or_else(|| route.targets.first());
            let capable = route
                .targets
                .iter()
                .find(|t| t.tier.as_deref() == Some("capable"))
                .or_else(|| route.targets.get(1));
            let (Some(efficient), Some(capable)) = (efficient, capable) else {
                return Err(
                    "llm-classifier route needs at least two targets (efficient + capable)"
                        .to_string(),
                );
            };
            let efficient_target = LlmTarget {
                semantic_name: efficient.id.clone(),
                llm_client: None,
            };
            let capable_target = LlmTarget {
                semantic_name: capable.id.clone(),
                llm_client: None,
            };
            let mut config = TaskClassifierConfig::default();
            config.base_threshold = judge.base_threshold.unwrap_or(0.5);
            if let Some(prompt) = &judge.prompt {
                config.contract = ClassifierContractConfig::default().with_prompt(prompt.clone());
            }
            LlmTaskClassifier::new(LlmClassifierConfig::Capability {
                judge_target,
                efficient_target,
                capable_target,
                config,
            })
            .map(|r| Arc::new(r) as Arc<dyn Algorithm>)
            .map_err(|e| e.to_string())
        }
    }
}

/// A routing decision captured from the algorithm's `Step::Decision` stream.
struct RoutingDecision {
    selected: String,
    reasoning: Option<String>,
}

/// Drive a libsy algorithm's step stream to its routing decision.
///
/// nolock serves every offloaded model call itself:
///   - routed calls (`is_routed_call()`) are answered with a synthetic empty
///     response — nolock makes the real model call after routing, so the
///     algorithm's own answer is irrelevant.
///   - judge/classifier calls are answered with a real completion via
///     `judge_transport` so the classifier can produce its verdict.
async fn drive_algorithm(
    algorithm: Arc<dyn Algorithm>,
    task: &str,
    judge_transport: &JudgeTransport,
    judge: Option<&SwitchyardJudge>,
    providers: &HashMap<String, ProviderEndpoint>,
    default_backend: &str,
    default_model: &str,
    default_url: &str,
    default_api_key: &str,
) -> Result<Option<RoutingDecision>, String> {
    let request = Request {
        llm_request: text_request(None, task.to_string()),
        raw_request: None,
        metadata: None,
    };
    let stream = algorithm.run_stream(Context::default(), request, None);
    tokio::pin!(stream);

    let mut selected: Option<String> = None;
    let mut reasoning: Option<String> = None;
    while let Some(step) = stream.next().await {
        match step.map_err(|e| e.to_string())? {
            Step::Decision(decision) => {
                selected = Some(decision.selected_model().to_string());
                reasoning = decision.reasoning().map(str::to_string);
            }
            Step::CallLlm(call) => {
                if call.get_decision().is_routed_call() {
                    // The routing decision is already captured; nolock will make
                    // the real call itself, so a synthetic response is enough.
                    call.respond(Ok(Response {
                        llm_response: LlmResponse::Agg(text_response(None, "")),
                        metadata: None,
                    }))
                    .map_err(|e| e.to_string())?;
                } else {
                    // Judge/classifier call — serve it with a real completion.
                    let prompt = judge_prompt(call.get_request());
                    let (backend, model, url, api_key) = match judge {
                        Some(j) => {
                            let ep = providers.get(&j.backend);
                            (
                                j.backend.clone(),
                                j.model.clone(),
                                ep.and_then(|e| {
                                    if e.url.is_empty() {
                                        None
                                    } else {
                                        Some(e.url.clone())
                                    }
                                })
                                .unwrap_or_else(|| default_url.to_string()),
                                ep.and_then(|e| {
                                    if e.api_key.is_empty() {
                                        None
                                    } else {
                                        Some(e.api_key.clone())
                                    }
                                })
                                .unwrap_or_else(|| default_api_key.to_string()),
                            )
                        }
                        None => (
                            default_backend.to_string(),
                            default_model.to_string(),
                            default_url.to_string(),
                            default_api_key.to_string(),
                        ),
                    };
                    let judge_text = judge_transport(backend, model, url, api_key, prompt).await?;
                    call.respond(Ok(Response {
                        llm_response: LlmResponse::Agg(text_response(None, judge_text)),
                        metadata: None,
                    }))
                    .map_err(|e| e.to_string())?;
                }
            }
            Step::ReturnToAgent(_) => break,
        }
    }

    Ok(selected.map(|selected| RoutingDecision { selected, reasoning }))
}

/// Build the prompt sent to a classifier judge: the classifier instructions
/// (if any) followed by the user task text.
fn judge_prompt(request: &Request) -> String {
    let mut parts: Vec<String> = Vec::new();
    for instruction in &request.llm_request.instructions {
        for block in &instruction.content {
            if let switchyard_protocol::ContentBlock::Text { text } = block {
                parts.push(text.clone());
            }
        }
    }
    let user_text = switchyard_protocol::prompt_text(&request.llm_request);
    if !user_text.is_empty() {
        parts.push(user_text);
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn providers() -> HashMap<String, ProviderEndpoint> {
        let mut m = HashMap::new();
        m.insert(
            "openrouter".to_string(),
            ProviderEndpoint {
                url: "https://openrouter.ai/api/v1".to_string(),
                api_key: "sk-test".to_string(),
            },
        );
        m
    }

    fn noop_judge() -> JudgeTransport {
        Arc::new(|_b, _m, _u, _k, _p| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            Box::pin(async move { Ok(String::new()) })
        })
    }

    fn write_config(root: &str, config: &SwitchyardConfig) {
        write_switchyard_config(root, config).unwrap();
    }

    #[tokio::test]
    async fn disabled_config_returns_none() {
        let root = std::env::temp_dir().join(format!("nolock_sy_disabled_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: false,
                routes: vec![SwitchyardRoute {
                    name: "r".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::Random,
                    targets: vec![SwitchyardTarget {
                        id: "t1".to_string(),
                        label: "T1".to_string(),
                        backend: "openrouter".to_string(),
                        model: "m1".to_string(),
                        tier: None,
                        weight: None,
                    }],
                    weights: None,
                    judge: None,
                    fallback: None,
                }],
            },
        );
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "hello",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            noop_judge(),
        )
        .await
        .unwrap();
        assert!(out.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn passthrough_always_selects_the_single_target() {
        let root = std::env::temp_dir().join(format!("nolock_sy_pt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "pt".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::Passthrough,
                    targets: vec![SwitchyardTarget {
                        id: "nemotron-ultra".to_string(),
                        label: "Nemotron Ultra".to_string(),
                        backend: "openrouter".to_string(),
                        model: "nvidia/nemotron-ultra".to_string(),
                        tier: None,
                        weight: None,
                    }],
                    weights: None,
                    judge: None,
                    fallback: None,
                }],
            },
        );
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "hello",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            noop_judge(),
        )
        .await
        .unwrap()
        .expect("passthrough should route");
        assert_eq!(out.model, "nvidia/nemotron-ultra");
        assert_eq!(out.backend, "openrouter");
        assert_eq!(out.url, "https://openrouter.ai/api/v1");
        assert_eq!(out.api_key, "sk-test");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn random_selects_a_target_from_the_set() {
        let root = std::env::temp_dir().join(format!("nolock_sy_rand_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let models = ["nvidia/nemotron-ultra", "nvidia/nemotron-super", "nvidia/nemotron-3.5-lightning"];
        let targets = models
            .iter()
            .enumerate()
            .map(|(i, m)| SwitchyardTarget {
                id: format!("t{}", i),
                label: m.to_string(),
                backend: "openrouter".to_string(),
                model: m.to_string(),
                tier: None,
                weight: None,
            })
            .collect();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "nemotron-family".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::Random,
                    targets,
                    weights: None,
                    judge: None,
                    fallback: None,
                }],
            },
        );
        let mut seen = std::collections::HashSet::new();
        for _ in 0..30 {
            let out = resolve_route(
                root.to_str().unwrap(),
                RoutePurpose::Chat,
                "hello",
                &providers(),
                "ollama",
                "default",
                "http://localhost:11434",
                "",
                noop_judge(),
            )
            .await
            .unwrap()
            .expect("random should route");
            assert!(models.contains(&out.model.as_str()), "unexpected {}", out.model);
            seen.insert(out.model);
        }
        assert_eq!(seen.len(), 3, "expected all three targets to be selected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn classifier_routes_to_efficient_when_judge_says_supported() {
        let root = std::env::temp_dir().join(format!("nolock_sy_cls_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "capability".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::LlmClassifier,
                    targets: vec![
                        SwitchyardTarget {
                            id: "efficient".to_string(),
                            label: "Efficient".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3.5-lightning".to_string(),
                            tier: Some("efficient".to_string()),
                            weight: None,
                        },
                        SwitchyardTarget {
                            id: "capable".to_string(),
                            label: "Capable".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-ultra".to_string(),
                            tier: Some("capable".to_string()),
                            weight: None,
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "openrouter".to_string(),
                        model: "nvidia/nemotron-3.5-lightning".to_string(),
                        prompt: None,
                        base_threshold: Some(0.5),
                    }),
                    fallback: None,
                }],
            },
        );
        // Judge verdict: supported, p_solve 0.9 >= 0.5 → efficient.
        let judge = Arc::new(|_b, _m, _u, _k, _p| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            Box::pin(async move {
                Ok(r#"{"crux":"bounded task","primary_rule":"SUP-1","capability_boundary":"supported","p_solve":0.9}"#
                    .to_string())
            })
        });
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "add a test",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            judge,
        )
        .await
        .unwrap()
        .expect("classifier should route");
        assert_eq!(out.model, "nvidia/nemotron-3.5-lightning");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn classifier_routes_to_capable_when_judge_says_unsupported() {
        let root = std::env::temp_dir().join(format!("nolock_sy_cls2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "capability".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::LlmClassifier,
                    targets: vec![
                        SwitchyardTarget {
                            id: "efficient".to_string(),
                            label: "Efficient".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3.5-lightning".to_string(),
                            tier: Some("efficient".to_string()),
                            weight: None,
                        },
                        SwitchyardTarget {
                            id: "capable".to_string(),
                            label: "Capable".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-ultra".to_string(),
                            tier: Some("capable".to_string()),
                            weight: None,
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "openrouter".to_string(),
                        model: "nvidia/nemotron-3.5-lightning".to_string(),
                        prompt: None,
                        base_threshold: Some(0.5),
                    }),
                    fallback: None,
                }],
            },
        );
        // Judge verdict: unsupported → capable.
        let judge = Arc::new(|_b, _m, _u, _k, _p| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            Box::pin(async move {
                Ok(r#"{"crux":"hard task","primary_rule":"LIM-1","capability_boundary":"unsupported","p_solve":0.1}"#
                    .to_string())
            })
        });
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "refactor the whole codebase",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            judge,
        )
        .await
        .unwrap()
        .expect("classifier should route");
        assert_eq!(out.model, "nvidia/nemotron-ultra");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn validation_rejects_bad_config() {
        let bad = SwitchyardConfig {
            enabled: true,
            routes: vec![SwitchyardRoute {
                name: "x".to_string(),
                purpose: RoutePurpose::Chat,
                algorithm: RouteAlgorithm::LlmClassifier,
                targets: vec![SwitchyardTarget {
                    id: "t".to_string(),
                    label: "T".to_string(),
                    backend: "openrouter".to_string(),
                    model: "m".to_string(),
                    tier: None,
                    weight: None,
                }],
                weights: None,
                judge: None, // missing judge for llm-classifier
                fallback: None,
            }],
        };
        let err = validate_switchyard_config(&bad).unwrap_err();
        assert!(err.contains("no judge"));
    }

    #[test]
    fn read_write_round_trips() {
        let root = std::env::temp_dir().join(format!("nolock_sy_rw_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cfg = SwitchyardConfig {
            enabled: true,
            routes: vec![SwitchyardRoute {
                name: "r".to_string(),
                purpose: RoutePurpose::Chat,
                algorithm: RouteAlgorithm::Random,
                targets: vec![SwitchyardTarget {
                    id: "t".to_string(),
                    label: "T".to_string(),
                    backend: "openrouter".to_string(),
                    model: "m".to_string(),
                    tier: None,
                    weight: None,
                }],
                weights: None,
                judge: None,
                fallback: None,
            }],
        };
        write_config(root.to_str().unwrap(), &cfg);
        let loaded = read_switchyard_config(root.to_str().unwrap()).unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.routes.len(), 1);
        assert_eq!(loaded.routes[0].targets[0].model, "m");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn repo_config_is_valid() {
        // Regression guard: the checked-in `.routers/switchyard.json` (the
        // nemotron-family route) must parse + validate against the schema.
        // Cargo runs tests from the `src-tauri` dir, so the repo root is `..`.
        let content =
            std::fs::read_to_string("../.routers/switchyard.json").expect("config file exists");
        let config: SwitchyardConfig = serde_json::from_str(&content)
            .expect("config parses against the SwitchyardConfig schema");
        assert!(validate_switchyard_config(&config).is_ok());
        assert!(config.enabled);
        let route = config
            .routes
            .iter()
            .find(|r| r.name == "nemotron-family")
            .expect("nemotron-family route present");
        assert_eq!(route.purpose, RoutePurpose::Chat);
        assert_eq!(route.algorithm, RouteAlgorithm::Random);
        assert_eq!(route.targets.len(), 3);
    }
}