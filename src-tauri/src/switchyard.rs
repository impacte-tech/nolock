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
    Algorithm, ClassifierContractConfig, CustomClassifierConfig, CustomClassifierPolicy,
    LlmClassifierConfig, LlmTarget, LlmTargetSet, LlmTaskClassifier, Passthrough, Random,
    Step, TaskClassifierConfig,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights: Option<Vec<f64>>,
    /// Judge model config for `llm-classifier` routes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<SwitchyardJudge>,
    /// Target `id` to fall back to when the router produces no usable decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    /// Judge-backed routing among N named targets (e.g. lightning / super /
    /// ultra). The judge's verdict carries a label field (see `judge.selector`)
    /// that selects one target exactly — no "cheapest in tier" override.
    Custom,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// For `random`: per-target weight (relative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    /// Cost in USD per 1K input tokens. Used for cost-aware routing: when the
    /// router picks a tier (efficient/capable), the cheapest target in that
    /// tier is selected. Optional — when absent, the router keeps the exact
    /// target the algorithm chose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_per_1k: Option<f64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Solve-probability threshold that routes a supported task to the
    /// efficient target. Defaults to 0.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_threshold: Option<f64>,
    /// Inner JSON Schema (the `schema` object, not the `json_schema` wrapper)
    /// the judge's verdict must satisfy. Required for `custom` routes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_schema: Option<serde_json::Value>,
    /// JSON Pointer (e.g. `/route`) to the verdict field holding the target label
    /// the judge selected. Required for `custom` routes; defaults to `/route`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
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
/// Params: `(backend, model, url, api_key, system_prompt, user_task, response_format)` →
/// judge completion text. The system prompt carries the classifier contract;the task
/// is the user request being classified;`response_format` is the provider structured-output
/// config libsy attached to the judge request (the `json_schema` wrapper with the inner
/// schema), so the host can enforce the exact verdict shape for ANY classifier mode.
/// nolock implements this over its own reqwest transport; tests mock it.
pub type JudgeTransport = Arc<
    dyn Fn(
            String,
            String,
            String,
            String,
            String,
            String,
            Option<serde_json::Value>,
        ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
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
        if route.algorithm == RouteAlgorithm::Custom {
            let judge = route.judge.as_ref().ok_or_else(|| {
                format!("route '{}' uses custom but has no judge", route.name)
            })?;
            if judge.prompt.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(format!("route '{}' uses custom but has no judge.prompt", route.name));
            }
            if judge.response_schema.is_none() {
                return Err(format!(
                    "route '{}' uses custom but has no judge.responseSchema",
                    route.name
                ));
            }
            let fallback = route.fallback.as_deref().ok_or_else(|| {
                format!("route '{}' uses custom but has no fallback", route.name)
            })?;
            if !route.targets.iter().any(|t| t.id == fallback) {
                return Err(format!(
                    "route '{}' fallback '{}' must be one of the target ids",
                    route.name, fallback
                ));
            }
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

    // Map the router's selected semantic name (a target id) back to a target,
    // preferring the cheapest model in the chosen tier (cost-aware routing).
    let target = select_target_for_decision(route, &decision.selected);
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

/// Select the target for a routing decision.
///
/// For `llm-classifier` routes the decision names a *tier* (the efficient or
/// capable target the algorithm chose). Among the targets in that tier we pick
/// the **cheapest** (by `cost_per_1k`) so the router is cost-aware — e.g. a
/// capable tier holding both Super and Ultra will prefer Super. For other
/// algorithms the decision names a specific target id, which is matched exactly.
fn select_target_for_decision<'a>(
    route: &'a SwitchyardRoute,
    selected: &str,
) -> Option<&'a SwitchyardTarget> {
    // Determine the tier implied by the decision (the selected target's tier).
    // Only `llm-classifier` decisions name a *tier*; `custom` decisions name a
    // specific target id, which must be matched exactly (no tier override).
    let tier = if route.algorithm == RouteAlgorithm::LlmClassifier {
        route
            .targets
            .iter()
            .find(|t| t.id == selected || t.model == selected)
            .and_then(|t| t.tier.clone())
    } else {
        None
    };
    if let Some(tier) = tier {
        // Cost-aware: pick the cheapest target in the chosen tier.
        let mut in_tier: Vec<&SwitchyardTarget> = route
            .targets
            .iter()
            .filter(|t| t.tier.as_deref() == Some(tier.as_str()))
            .collect();
        if !in_tier.is_empty() {
            in_tier.sort_by(|a, b| {
                a.cost_per_1k
                    .unwrap_or(f64::MAX)
                    .partial_cmp(&b.cost_per_1k.unwrap_or(f64::MAX))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            return in_tier.first().copied();
        }
    }
    // Fall back to exact id/model match, then fallback, then first.
    route
        .targets
        .iter()
        .find(|t| t.id == selected)
        .or_else(|| route.targets.iter().find(|t| t.model == selected))
        .or_else(|| {
            route
                .fallback
                .as_deref()
                .and_then(|fb| route.targets.iter().find(|t| t.id == fb))
        })
        .or_else(|| route.targets.first())
}

/// Derive cost-based weights for a `random` route: each target's weight is the
/// inverse of its `cost_per_1k`, so cheaper models are picked more often. Returns
/// `None` when no target has a cost (falls back to uniform random).
fn cost_weights(route: &SwitchyardRoute) -> Option<Vec<f64>> {
    let costs: Vec<f64> = route
        .targets
        .iter()
        .map(|t| t.cost_per_1k.unwrap_or(f64::MAX))
        .collect();
    if costs.iter().all(|c| *c == f64::MAX) {
        return None;
    }
    // Inverse cost; guard against zero/negative costs.
    let inv: Vec<f64> = costs
        .iter()
        .map(|c| if *c > 0.0 { 1.0 / c } else { 1.0 })
        .collect();
    Some(inv)
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
            // Cost-aware random: when no explicit weights are given but targets
            // carry a `cost_per_1k`, weight each target by the inverse of its
            // cost so cheaper models are selected more often. This is the robust
            // "ideal" routing — cost-aware without depending on a judge model.
            let weights = route.weights.clone().or_else(|| cost_weights(route));
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
        RouteAlgorithm::Custom => {
            // Judge-backed routing among N named targets: the judge's verdict
            // carries a label field (via `judge.selector`, a JSON Pointer) that
            // selects one target exactly. No "cheapest in tier" override — the
            // judge decides which capable tier (e.g. Super vs Ultra) is needed.
            let judge = route
                .judge
                .as_ref()
                .ok_or_else(|| "custom route requires a judge".to_string())?;
            let judge_target = LlmTarget {
                semantic_name: format!("judge:{}", judge.model),
                llm_client: None,
            };
            let prompt = judge
                .prompt
                .clone()
                .ok_or_else(|| "custom route requires judge.prompt".to_string())?;
            let response_schema = judge
                .response_schema
                .clone()
                .ok_or_else(|| "custom route requires judge.responseSchema".to_string())?;
            let selector = judge.selector.clone().unwrap_or_else(|| "/route".to_string());
            let default_target = route
                .fallback
                .clone()
                .ok_or_else(|| "custom route requires fallback".to_string())?;
            let targets: Vec<(String, LlmTarget)> = route
                .targets
                .iter()
                .map(|t| {
                    (
                        t.id.clone(),
                        LlmTarget {
                            semantic_name: t.id.clone(),
                            llm_client: None,
                        },
                    )
                })
                .collect();
            let config = CustomClassifierConfig::new(
                prompt,
                response_schema,
                CustomClassifierPolicy::target_selector(selector),
            );
            LlmTaskClassifier::new(LlmClassifierConfig::Custom {
                judge_target,
                targets,
                default_target,
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
                    let (system_prompt, user_task) = judge_prompt(call.get_request());
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
                    let judge_text = judge_transport(
                        backend,
                        model.clone(),
                        url,
                        api_key,
                        system_prompt,
                        user_task,
                        call.get_request().llm_request.output.response_format.clone(),
                    )
                    .await?;
                    eprintln!(
                        "[switchyard] judge '{}' reply: {}",
                        model,
                        judge_text.chars().take(300).collect::<String>()
                    );
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

/// Split a classifier judge request into its system prompt (the classifier
/// contract) and the user task text. These are sent as separate messages so the
/// judge model honors the structured-output contract instead of echoing the
/// whole prompt back as prose.
fn judge_prompt(request: &Request) -> (String, String) {
    let mut system = String::new();
    for instruction in &request.llm_request.instructions {
        for block in &instruction.content {
            if let switchyard_protocol::ContentBlock::Text { text } = block {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(text);
            }
        }
    }
    let user_text = switchyard_protocol::prompt_text(&request.llm_request);
    (system, user_text)
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
        Arc::new(|_b, _m, _u, _k, _s, _t, _rf| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
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
                cost_per_1k: None,
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
                cost_per_1k: None,
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
                cost_per_1k: None,
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
                            cost_per_1k: None,
                        },
                        SwitchyardTarget {
                            id: "capable".to_string(),
                            label: "Capable".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-ultra".to_string(),
                            tier: Some("capable".to_string()),
                            weight: None,
                            cost_per_1k: None,
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "openrouter".to_string(),
                        model: "nvidia/nemotron-3.5-lightning".to_string(),
                        prompt: None,
                        base_threshold: Some(0.5),
                        response_schema: None,
                        selector: None,
                    }),
                    fallback: None,
                }],
            },
        );
        // Judge verdict: supported, p_solve 0.9 >= 0.5 → efficient.
        let judge = Arc::new(|_b, _m, _u, _k, _s, _t, _rf| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
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
                            cost_per_1k: None,
                        },
                        SwitchyardTarget {
                            id: "capable".to_string(),
                            label: "Capable".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-ultra".to_string(),
                            tier: Some("capable".to_string()),
                            weight: None,
                            cost_per_1k: None,
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "openrouter".to_string(),
                        model: "nvidia/nemotron-3.5-lightning".to_string(),
                        prompt: None,
                        base_threshold: Some(0.5),
                        response_schema: None,
                        selector: None,
                    }),
                    fallback: None,
                }],
            },
        );
        // Judge verdict: unsupported → capable.
        let judge = Arc::new(|_b, _m, _u, _k, _s, _t, _rf| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
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
    fn cost_aware_selection_picks_cheapest_in_tier() {
        // A capable tier holding Super (cheaper) + Ultra: when the classifier
        // routes to the capable tier, the router must pick Super (cheapest).
        let route = SwitchyardRoute {
            name: "capability".to_string(),
            purpose: RoutePurpose::Chat,
            algorithm: RouteAlgorithm::LlmClassifier,
            targets: vec![
                SwitchyardTarget {
                    id: "lightning".to_string(),
                    label: "Lightning".to_string(),
                    backend: "openrouter".to_string(),
                    model: "nvidia/nemotron-3.5-lightning".to_string(),
                    tier: Some("efficient".to_string()),
                    weight: None,
                    cost_per_1k: Some(0.00008),
                },
                SwitchyardTarget {
                    id: "super".to_string(),
                    label: "Super".to_string(),
                    backend: "openrouter".to_string(),
                    model: "nvidia/nemotron-3-super-120b-a12b".to_string(),
                    tier: Some("capable".to_string()),
                    weight: None,
                    cost_per_1k: Some(0.000085),
                },
                SwitchyardTarget {
                    id: "ultra".to_string(),
                    label: "Ultra".to_string(),
                    backend: "openrouter".to_string(),
                    model: "nvidia/nemotron-3-ultra-550b-a55b".to_string(),
                    tier: Some("capable".to_string()),
                    weight: None,
                    cost_per_1k: Some(0.0005),
                },
            ],
            weights: None,
            judge: Some(SwitchyardJudge {
                backend: "openrouter".to_string(),
                model: "nvidia/nemotron-3.5-lightning".to_string(),
                prompt: None,
                base_threshold: Some(0.5),
                response_schema: None,
                selector: None,
            }),
            fallback: None,
        };

        // Decision names the capable tier (via the classifier's capable target).
        let t = select_target_for_decision(&route, "super").expect("target");
        assert_eq!(t.id, "super", "cheapest capable target must be selected");

        // Decision names the efficient tier → lightning.
        let t = select_target_for_decision(&route, "lightning").expect("target");
        assert_eq!(t.id, "lightning");

// Unknown decision falls back to exact match / first.
        let t = select_target_for_decision(&route, "nope").expect("target");
        assert_eq!(t.id, "lightning");
    }

    #[tokio::test]
    async fn custom_classifier_routes_to_the_named_target() {
        let root = std::env::temp_dir().join(format!("nolock_sy_custom_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "three-tier".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::Custom,
                    targets: vec![
                        SwitchyardTarget {
                            id: "lightning".to_string(),
                            label: "Lightning".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3.5-lightning".to_string(),
                            tier: None,
                            weight: None,
                            cost_per_1k: Some(0.00008),
                        },
                        SwitchyardTarget {
                            id: "super".to_string(),
                            label: "Super".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3-super-120b-a12b".to_string(),
                            tier: None,
                            weight: None,
                            cost_per_1k: Some(0.000085),
                        },
                        SwitchyardTarget {
                            id: "ultra".to_string(),
                            label: "Ultra".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3-ultra-550b-a55b".to_string(),
                            tier: None,
                            weight: None,
                            cost_per_1k: Some(0.0005),
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "ollama".to_string(),
                        model: "nemotron-nano-9b".to_string(),
                        prompt: Some("You are a model router. Output a route label.".to_string()),
                        base_threshold: None,
                        response_schema: Some(serde_json::json!({
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["route"],
                            "properties": {
                                "route": { "type": "string", "enum": ["lightning", "super", "ultra"] }
                            }
                        })),
                        selector: Some("/route".to_string()),
                    }),
                    fallback: Some("super".to_string()),
                }],
            },
        );
        // Judge verdict names "ultra" → must route to Ultra exactly (no tier override).
        let judge = Arc::new(|_b, _m, _u, _k, _s, _t, _rf| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            Box::pin(async move { Ok(r#"{"route":"ultra"}"#.to_string()) })
        });
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "migrate the legacy COBOL batch system",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            judge,
        )
        .await
        .unwrap()
        .expect("custom classifier should route");
        assert_eq!(out.model, "nvidia/nemotron-3-ultra-550b-a55b");
        assert_eq!(out.algorithm, RouteAlgorithm::Custom);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn custom_classifier_falls_back_when_judge_abstains() {
        let root = std::env::temp_dir().join(format!("nolock_sy_custom2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_config(
            root.to_str().unwrap(),
            &SwitchyardConfig {
                enabled: true,
                routes: vec![SwitchyardRoute {
                    name: "three-tier".to_string(),
                    purpose: RoutePurpose::Chat,
                    algorithm: RouteAlgorithm::Custom,
                    targets: vec![
                        SwitchyardTarget {
                            id: "lightning".to_string(),
                            label: "Lightning".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3.5-lightning".to_string(),
                            tier: None,
                            weight: None,
                            cost_per_1k: None,
                        },
                        SwitchyardTarget {
                            id: "super".to_string(),
                            label: "Super".to_string(),
                            backend: "openrouter".to_string(),
                            model: "nvidia/nemotron-3-super-120b-a12b".to_string(),
                            tier: None,
                            weight: None,
                            cost_per_1k: None,
                        },
                    ],
                    weights: None,
                    judge: Some(SwitchyardJudge {
                        backend: "ollama".to_string(),
                        model: "nemotron-nano-9b".to_string(),
                        prompt: Some("You are a model router. Output a route label.".to_string()),
                        base_threshold: None,
                        response_schema: Some(serde_json::json!({
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["route"],
                            "properties": {
                                "route": { "type": "string", "enum": ["lightning", "super"] }
                            }
                        })),
                        selector: Some("/route".to_string()),
                    }),
                    fallback: Some("super".to_string()),
                }],
            },
        );
        // Judge verdict names an unknown label → policy abstains → fallback.

        let judge = Arc::new(|_b, _m, _u, _k, _s, _t, _rf| -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            Box::pin(async move { Ok(r#"{"route":"unknown"}"#.to_string()) })
        });
        let out = resolve_route(
            root.to_str().unwrap(),
            RoutePurpose::Chat,
            "some task",
            &providers(),
            "ollama",
            "default",
            "http://localhost:11434",
            "",
            judge,
        )
        .await
        .unwrap()
        .expect("custom classifier should fall back");
        assert_eq!(out.model, "nvidia/nemotron-3-super-120b-a12b");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn validation_rejects_bad_custom_config() {
        // Custom routes need judge.prompt, judge.responseSchema, and a fallback
        // that names one of the targets.

        let missing_prompt = SwitchyardConfig {
            enabled: true,
            routes: vec![SwitchyardRoute {
                name: "c".to_string(),
                purpose: RoutePurpose::Chat,
                algorithm: RouteAlgorithm::Custom,
                targets: vec![SwitchyardTarget {
                    id: "t".to_string(),
                    label: "T".to_string(),
                    backend: "openrouter".to_string(),
                    model: "m".to_string(),
                    tier: None,
                    weight: None,
                    cost_per_1k: None,
                }],
                weights: None,
                judge: Some(SwitchyardJudge {
                    backend: "ollama".to_string(),
                    model: "m".to_string(),
                    prompt: None,
                    base_threshold: None,
                    response_schema: Some(serde_json::json!({ "type": "object" })),
                    selector: None,
                }),
                fallback: Some("t".to_string()),
            }],
        };
        let err = validate_switchyard_config(&missing_prompt).unwrap_err();
        assert!(err.contains("judge.prompt"), "{err}");

        let missing_schema = SwitchyardConfig {
            enabled: true,
            routes: vec![SwitchyardRoute {
                name: "c".to_string(),
                purpose: RoutePurpose::Chat,
                algorithm: RouteAlgorithm::Custom,
                targets: vec![SwitchyardTarget {
                    id: "t".to_string(),
                    label: "T".to_string(),
                    backend: "openrouter".to_string(),
                    model: "m".to_string(),
                    tier: None,
                    weight: None,
                    cost_per_1k: None,
                }],
                weights: None,
                judge: Some(SwitchyardJudge {
                    backend: "ollama".to_string(),
                    model: "m".to_string(),
                    prompt: Some("p".to_string()),
                    base_threshold: None,
                    response_schema: None,
                    selector: None,
                }),
                fallback: Some("t".to_string()),
            }],
        };
        let err = validate_switchyard_config(&missing_schema).unwrap_err();
        assert!(err.contains("responseSchema"), "{err}");

        let bad_fallback = SwitchyardConfig {
            enabled: true,
            routes: vec![SwitchyardRoute {
                name: "c".to_string(),
                purpose: RoutePurpose::Chat,
                algorithm: RouteAlgorithm::Custom,
                targets: vec![SwitchyardTarget {
                    id: "t".to_string(),
                    label: "T".to_string(),
                    backend: "openrouter".to_string(),
                    model: "m".to_string(),
                    tier: None,
                    weight: None,
                    cost_per_1k: None,
                }],
                weights: None,
                judge: Some(SwitchyardJudge {
                    backend:"ollama".to_string(),
                    model: "m".to_string(),
                    prompt: Some("p".to_string()),
                    base_threshold: None,
                    response_schema: Some(serde_json::json!({ "type": "object" })),
                    selector: None,
                }),
                fallback: Some("nope".to_string()),
            }],
        };
        let err = validate_switchyard_config(&bad_fallback).unwrap_err();
        assert!(err.contains("fallback"), "{err}");
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
                cost_per_1k: None,
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
                cost_per_1k: None,
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
    fn serialization_omits_none_fields() {
        // Writing a config with unset optional fields must NOT emit `null`
        // entries — keeps `.routers/switchyard.json` clean and stable.
        let root = std::env::temp_dir().join(format!("nolock_sy_ser_{}", std::process::id()));
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
                cost_per_1k: None,
                }],
                weights: None,
                judge: None,
                fallback: None,
            }],
        };
        write_config(root.to_str().unwrap(), &cfg);
        let content = std::fs::read_to_string(root.join(".routers/switchyard.json")).unwrap();
        assert!(
            !content.contains("null"),
            "serialized config must not contain null fields:\n{}",
            content
        );
        let _ = std::fs::remove_dir_all(&root);
    }

#[test]
    fn repo_config_is_valid() {
        // Regression guard:the checked-in `.routers/switchyard.json` (the
        // nemotron-3-tier custom route) must parse + validate against the schema.

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
            .find(|r| r.name == "nemotron-3-tier")
            .expect("nemotron-3-tier route present");
        assert_eq!(route.purpose, RoutePurpose::Chat);
        assert_eq!(route.algorithm, RouteAlgorithm::Custom);
        assert_eq!(route.targets.len(), 3);
        // Three tiers: efficient (lightning) + two capable layers (super, ultra).
        // The judge picks the exact target via `selector` — no tier override.
        assert!(route.judge.is_some());
        let judge = route.judge.as_ref().unwrap();
        assert!(judge.response_schema.is_some());
        assert_eq!(judge.selector.as_deref(), Some("/route"));
        assert_eq!(route.fallback.as_deref(), Some("super"));
        let super_t = route.targets.iter().find(|t| t.id == "super").unwrap();
        let ultra_t = route.targets.iter().find(|t| t.id == "ultra").unwrap();
        assert!(super_t.cost_per_1k.unwrap() < ultra_t.cost_per_1k.unwrap());
    }
}