//! Native JSONL histories. Only canonical conversation records are displayed;
//! mirrored progress events and compacted replacement histories are not replayed.
use super::{text, Conversation};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const SCAN_LIMIT: u64 = 128 * 1024 * 1024;
const MESSAGE_LIMIT: usize = 2000;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Agent {
    Codex,
    Claude,
}
struct History {
    id: String,
    created: u64,
    updated: u64,
    title: String,
    messages: Vec<Value>,
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn timestamp(v: &Value) -> Option<u64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .and_then(|t| u64::try_from(t.timestamp()).ok())
        .or_else(|| {
            v.as_u64()
                .map(|n| if n > 10_000_000_000 { n / 1000 } else { n })
        })
}
/// Do not expose image data, signatures, or encrypted reasoning as prose.
fn content(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.into();
    }
    v.as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| match string(b, "type") {
                    "text" | "input_text" | "output_text" | "summary_text" | "tool_text" => {
                        b["text"].as_str().map(str::to_owned)
                    }
                    "image" | "input_image" => Some("[Image attachment]".into()),
                    "document" => Some("[Document attachment]".into()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}
fn message(role: &str, body: String, time: Option<u64>, model: &str) -> Value {
    json!({"role":role,"content":body,"createdAt":time,"model":model,"toolCalls":[]})
}
fn warning(warnings: &mut Vec<String>, value: &str) {
    if !warnings.iter().any(|s| s == value) {
        warnings.push(value.into());
    }
}
fn paths(base: &Path, depth: usize, found: &mut Vec<PathBuf>, warnings: &mut Vec<String>) {
    if depth == 0 || found.len() >= 5000 {
        warning(
            warnings,
            "History scan limit reached; some conversations may be missing.",
        );
        return;
    }
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            warning(warnings, "Some history directories could not be read.");
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            warning(warnings, "Some history entries could not be read.");
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        // Claude subagents have their own files; do not blend them into a terminal's main conversation.
        if kind.is_dir() && entry.file_name() != "subagents" {
            paths(&entry.path(), depth - 1, found, warnings);
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            found.push(entry.path());
        }
        if found.len() >= 5000 {
            warning(
                warnings,
                "History scan limit reached; some conversations may be missing.",
            );
            break;
        }
    }
}
fn metadata(v: &Value, agent: Agent) -> Option<(String, String, bool)> {
    if agent == Agent::Codex {
        if string(v, "type") != "session_meta" {
            return None;
        }
        let p = &v["payload"];
        let id = p["id"]
            .as_str()
            .or_else(|| p["session_id"].as_str())
            .unwrap_or("");
        Some((
            id.into(),
            string(p, "cwd").into(),
            p["source"].get("subagent").is_some() || string(p, "source").starts_with("subagent"),
        ))
    } else if !string(v, "sessionId").is_empty() && !string(v, "cwd").is_empty() {
        Some((
            string(v, "sessionId").into(),
            string(v, "cwd").into(),
            v["isSidechain"] == true,
        ))
    } else {
        None
    }
}
fn load(
    path: &Path,
    agent: Agent,
    cwd: &Path,
    budget: &mut u64,
    warnings: &mut Vec<String>,
) -> Option<History> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            warning(warnings, "Some native histories could not be read.");
            return None;
        }
    };
    // Inspect only the header of other projects' histories.
    let header = BufReader::new(file.take(256 * 1024));
    let mut identity = None;
    for line in header.lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(meta) = metadata(&v, agent) {
                identity = Some(meta);
                break;
            }
        }
    }
    let Some((id, directory, sidechain)) = identity else {
        return None;
    };
    if id.is_empty()
        || sidechain
        || Path::new(&directory).canonicalize().ok().as_deref() != Some(cwd)
    {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let limit = FILE_LIMIT.min(*budget);
    if limit == 0 {
        warning(
            warnings,
            "History scan limit reached; some conversations may be missing.",
        );
        return None;
    }
    let mut data = Vec::new();
    if file.take(limit + 1).read_to_end(&mut data).is_err() {
        warning(warnings, "Some native histories could not be read.");
        return None;
    }
    *budget = budget.saturating_sub(data.len() as u64);
    if data.len() as u64 > limit {
        data.truncate(limit as usize);
        warning(
            warnings,
            "Large native history truncated; some messages may be missing.",
        );
    }
    let mut records = Vec::new();
    for line in data.split_inclusive(|byte| *byte == b'\n') {
        match serde_json::from_slice::<Value>(line) {
            Ok(v) => records.push(v),
            Err(_) if !line.ends_with(b"\n") => {} // an in-progress append, retried on the next refresh
            Err(_) => warning(
                warnings,
                "Some native history records could not be decoded.",
            ),
        }
    }
    let created = records
        .iter()
        .filter_map(|v| timestamp(&v["timestamp"]))
        .min()
        .unwrap_or(0);
    let updated = records
        .iter()
        .filter_map(|v| timestamp(&v["timestamp"]))
        .max()
        .unwrap_or(0);
    let mut messages = if agent == Agent::Codex {
        codex(&records)
    } else {
        claude(&records)
    };
    if messages.len() > MESSAGE_LIMIT {
        messages.truncate(MESSAGE_LIMIT);
        warning(
            warnings,
            "Conversation preview truncated to 2,000 messages.",
        );
    }
    let title = messages
        .iter()
        .find(|m| m["role"] == "user" && !string(m, "content").is_empty())
        .map(|m| {
            string(m, "content")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(100)
                .collect()
        })
        .unwrap_or_else(|| id.clone());
    Some(History {
        id,
        created,
        updated,
        title,
        messages,
    })
}

fn codex(records: &[Value]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut calls: HashMap<String, usize> = HashMap::new();
    let mut seen = HashSet::new();
    let mut model = String::new();
    // Older rollouts may contain event messages only. Prefer canonical response
    // items when both streams exist, avoiding doubled prompts and answers.
    let canonical_roles: HashSet<&str> = records
        .iter()
        .filter(|v| {
            string(v, "type") == "response_item" && string(&v["payload"], "type") == "message"
        })
        .map(|v| string(&v["payload"], "role"))
        .collect();
    let has_reasoning = records.iter().any(|v| {
        string(v, "type") == "response_item"
            && string(&v["payload"], "type") == "reasoning"
            && !content(&v["payload"]["summary"]).is_empty()
    });
    for v in records {
        let p = &v["payload"];
        let time = timestamp(&v["timestamp"]);
        match string(v, "type") {
            "turn_context" => {
                model = string(p, "model").into();
            }
            "response_item" => {
                let kind = string(p, "type");
                let id = string(p, "id");
                if !id.is_empty() && !seen.insert((kind.to_owned(), id.to_owned())) {
                    continue;
                }
                match kind {
                    "message" => {
                        let role = string(p, "role");
                        if !matches!(role, "user" | "assistant" | "system") {
                            continue;
                        }
                        let body = content(&p["content"]);
                        if !body.is_empty() {
                            messages.push(message(
                                role,
                                body,
                                time,
                                if role == "assistant" { &model } else { "" },
                            ));
                        }
                    }
                    "reasoning" => {
                        let body = content(&p["summary"]);
                        if !body.is_empty() {
                            let mut m = message("assistant", String::new(), time, &model);
                            m["reasoning"] = json!(body);
                            messages.push(m);
                        }
                    }
                    "function_call" | "custom_tool_call" => {
                        let call_id = string(p, "call_id");
                        if !call_id.is_empty() && calls.contains_key(call_id) {
                            continue;
                        }
                        let mut m = message("assistant", String::new(), time, &model);
                        m["toolCalls"] = json!([{"name":string(p,"name"),"arguments":text(p.get("arguments").or_else(|| p.get("input")).unwrap_or(&Value::Null))}]);
                        if !call_id.is_empty() {
                            calls.insert(call_id.into(), messages.len());
                        }
                        messages.push(m);
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let output = if p["output"].is_array() {
                            content(&p["output"])
                        } else {
                            text(&p["output"])
                        };
                        if let Some(index) = calls.get(string(p, "call_id")) {
                            messages[*index]["toolCalls"][0]["result_full"] = json!(output);
                        } else if !output.is_empty() {
                            messages.push(message(
                                "system",
                                format!("Tool result (call unavailable):\n{output}"),
                                time,
                                "",
                            ));
                        }
                    }
                    _ => {}
                }
            }
            "event_msg" => {
                let role = match string(p, "type") {
                    "user_message" => "user",
                    "agent_message" => "assistant",
                    _ => "",
                };
                if !role.is_empty() && !canonical_roles.contains(role) {
                    messages.push(message(
                        role,
                        text(&p["message"]),
                        time,
                        if role == "assistant" { &model } else { "" },
                    ));
                }
                if string(p, "type") == "agent_reasoning"
                    && !has_reasoning
                    && !string(p, "text").is_empty()
                {
                    let mut m = message("assistant", String::new(), time, &model);
                    m["reasoning"] = p["text"].clone();
                    messages.push(m);
                }
            }
            _ => {}
        }
    }
    messages
}
fn claude(records: &[Value]) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut blocks: HashMap<usize, BTreeMap<usize, Value>> = HashMap::new();
    let mut ids: HashMap<String, usize> = HashMap::new();
    let mut seen = HashSet::new();
    let mut results = HashMap::new();
    for v in records {
        if v["isSidechain"] == true {
            continue;
        }
        let role = string(v, "type");
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let uuid = string(v, "uuid");
        if !uuid.is_empty() && !seen.insert(uuid.to_owned()) {
            continue;
        }
        let raw = &v["message"];
        let id = if role == "assistant" && !string(raw, "id").is_empty() {
            format!("assistant:{}", string(raw, "id"))
        } else {
            format!(
                "{role}:{}",
                if uuid.is_empty() {
                    format!("row-{}", messages.len())
                } else {
                    uuid.to_owned()
                }
            )
        };
        let index = *ids.entry(id).or_insert_with(|| {
            messages.push(message(
                role,
                String::new(),
                timestamp(&v["timestamp"]),
                string(raw, "model"),
            ));
            messages.len() - 1
        });
        let parts = if let Some(parts) = raw["content"].as_array() {
            parts.clone()
        } else {
            vec![json!({"type":"text","text":text(&raw["content"])})]
        };
        let stored = blocks.entry(index).or_default();
        if let Some(block_index) = v["apiBlockIndex"].as_u64() {
            for (offset, part) in parts.into_iter().enumerate() {
                stored.insert(block_index as usize + offset, part);
            }
        } else {
            for part in parts {
                if string(&part, "type") == "tool_result" {
                    results.insert(
                        string(&part, "tool_use_id").to_owned(),
                        content(&part["content"]),
                    );
                }
                if let Some((_, prior)) = stored.iter_mut().find(|(_, prior)| {
                    **prior == part
                        || (!string(&part, "id").is_empty()
                            && string(prior, "id") == string(&part, "id"))
                }) {
                    *prior = part;
                } else {
                    stored.insert(stored.len(), part);
                }
            }
        }
    }
    for (index, stored) in blocks {
        let mut bodies = Vec::new();
        let mut reasoning = Vec::new();
        let mut calls = Vec::new();
        for part in stored.values() {
            match string(part, "type") {
                "text" => bodies.push(text(&part["text"])),
                "thinking" => reasoning.push(text(&part["thinking"])),
                "tool_use" => calls.push(json!({"name":string(part,"name"),"arguments":text(&part["input"]),"result_full":results.get(string(part,"id"))})),
                "image" | "document" => bodies.push(format!("[{} attachment]", string(part,"type"))),
                _ => {}
            }
        }
        messages[index]["content"] = json!(bodies.join("\n\n"));
        messages[index]["reasoning"] = json!(reasoning.join("\n\n"));
        messages[index]["toolCalls"] = json!(calls);
    }
    messages
        .into_iter()
        .filter(|m| {
            !string(m, "content").is_empty()
                || !string(m, "reasoning").is_empty()
                || m["toolCalls"]
                    .as_array()
                    .is_some_and(|calls| !calls.is_empty())
        })
        .collect()
}
pub(super) fn read(
    base: &Path,
    agent: Agent,
    cwd: &Path,
    start: u64,
    end: u64,
    native_id: Option<String>,
) -> Result<Conversation, String> {
    let mut warnings = Vec::new();
    let mut found = Vec::new();
    if agent == Agent::Codex {
        paths(&base.join("sessions"), 8, &mut found, &mut warnings);
        paths(
            &base.join("archived_sessions"),
            8,
            &mut found,
            &mut warnings,
        );
    } else {
        paths(&base.join("projects"), 3, &mut found, &mut warnings);
    }
    found
        .sort_by_cached_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    let mut histories: BTreeMap<String, History> = BTreeMap::new();
    let mut budget = SCAN_LIMIT;
    for path in found {
        if fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .is_some_and(|t| t.as_secs() < start)
        {
            continue;
        }
        if let Some(history) = load(&path, agent, cwd, &mut budget, &mut warnings) {
            if history.created == 0
                || history.created > end.saturating_add(1)
                || history.updated < start
            {
                continue;
            }
            let replace = histories.get(&history.id).is_none_or(|old| {
                (history.messages.len(), history.updated) > (old.messages.len(), old.updated)
            });
            if replace {
                histories.insert(history.id.clone(), history);
            }
        }
        if budget == 0 {
            break;
        }
    }
    let mut values: Vec<_> = histories.into_values().collect();
    values.sort_by_key(|h| std::cmp::Reverse(h.created));
    let selected = native_id
        .filter(|id| values.iter().any(|h| &h.id == id))
        .or_else(|| {
            if values.len() == 1 {
                Some(values[0].id.clone())
            } else {
                None
            }
        });
    let candidates = values
        .iter()
        .map(|h| json!({"id":h.id,"title":h.title,"createdAt":h.created}))
        .collect();
    let messages = values
        .into_iter()
        .find(|h| Some(&h.id) == selected.as_ref())
        .map(|h| h.messages.into_iter().map(super::redact_value).collect())
        .unwrap_or_default();
    Ok(Conversation {
        candidates,
        selected_id: selected,
        messages,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" "))
        },
    })
}
