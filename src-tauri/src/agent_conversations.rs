//! Read structured coding-agent conversations without modifying native histories.
mod jsonl;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    candidates: Vec<Value>,
    selected_id: Option<String>,
    messages: Vec<Value>,
    warning: Option<String>,
}
fn text(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_else(|| {
        if value.is_null() {
            String::new()
        } else {
            value.to_string()
        }
    })
}
fn redact_value(mut value: Value) -> Value {
    match &mut value {
        Value::String(s) => *s = super::redaction::redact(s),
        Value::Array(items) => {
            for item in items {
                *item = redact_value(item.take());
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                *item = redact_value(item.take());
            }
        }
        _ => {}
    }
    value
}
fn read(
    path: &Path,
    cwd: &Path,
    start: u64,
    end: u64,
    native_id: Option<String>,
) -> Result<Conversation, String> {
    if !path.exists() {
        return Ok(Conversation {
            candidates: vec![],
            selected_id: None,
            messages: vec![],
            warning: None,
        });
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    let read = || -> rusqlite::Result<Conversation> {
        let mut result = Conversation {
            candidates: vec![],
            selected_id: None,
            messages: vec![],
            warning: None,
        };
        let mut query = db.prepare("SELECT id, title, directory, time_created FROM session WHERE time_updated >= ?1 AND time_created <= ?2 ORDER BY time_created DESC LIMIT 500")?;
        let candidates = query.query_map(
            rusqlite::params![
                start.saturating_mul(1000).min(i64::MAX as u64) as i64,
                end.saturating_add(1)
                    .saturating_mul(1000)
                    .min(i64::MAX as u64) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
        for candidate in candidates {
            let (id, title, directory, created) = candidate?;
            if Path::new(&directory).canonicalize().ok().as_deref() != Some(cwd) {
                continue;
            }
            result
                .candidates
                .push(json!({"id":id,"title":title,"createdAt":created / 1000}));
        }
        // A recording has no native session ID. Never combine overlapping histories.
        let selected = native_id.filter(|id| {
            result
                .candidates
                .iter()
                .any(|c| c["id"].as_str() == Some(id))
        });
        let selected = selected.or_else(|| {
            if result.candidates.len() == 1 {
                result.candidates[0]["id"].as_str().map(str::to_owned)
            } else {
                None
            }
        });
        let Some(selected) = selected else {
            return Ok(result);
        };
        result.selected_id = Some(selected.clone());
        let mut query = db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ?1 ORDER BY time_created, id LIMIT 2001")?;
        let rows = query.query_map([&selected], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        let mut bytes = 0;
        for row in rows {
            let (id, data, created) = row?;
            if result.messages.len() >= 2000 || bytes > 8 * 1024 * 1024 {
                result.warning = Some("Conversation preview truncated.".into());
                break;
            }
            let Ok(message) = serde_json::from_str::<Value>(&data) else {
                result.warning = Some("Some messages could not be decoded.".into());
                continue;
            };
            let role = message["role"].as_str().unwrap_or("");
            if !matches!(role, "user" | "assistant" | "system") {
                continue;
            }
            let mut content = Vec::new();
            let mut reasoning = Vec::new();
            let mut calls = Vec::new();
            let mut parts = db.prepare("SELECT data FROM part WHERE session_id = ?1 AND message_id = ?2 ORDER BY time_created, id")?;
            for part in parts.query_map([&selected, &id], |r| r.get::<_, String>(0))? {
                let raw = part?;
                bytes += raw.len();
                if bytes > 8 * 1024 * 1024 {
                    result.warning = Some("Conversation preview truncated.".into());
                    break;
                }
                let Ok(part) = serde_json::from_str::<Value>(&raw) else {
                    result.warning = Some("Some message parts could not be decoded.".into());
                    continue;
                };
                match part["type"].as_str().unwrap_or("") {
                    "text" => content.push(text(&part["text"])),
                    "reasoning" => reasoning.push(text(&part["text"])),
                    "tool" => calls.push(json!({"name":text(&part["tool"]),"arguments":text(&part["state"]["input"]),"result_full":text(part["state"].get("output").or_else(|| part["state"].get("error")).unwrap_or(&Value::Null))})),
                    "file" => content.push(format!("Attachment: {}", text(&part["filename"]))),
                    _ => {}
                }
            }
            let model = message
                .get("modelID")
                .or_else(|| message.get("model").and_then(|m| m.get("modelID")))
                .and_then(Value::as_str);
            let entry = json!({"role":role,"content":content.join("\n\n"),"reasoning":reasoning.join("\n\n"),"createdAt":created/1000,"model":model,"toolCalls":calls});
            result.messages.push(redact_value(entry));
        }
        Ok(result)
    };
    read().map_err(|e| format!("OpenCode conversation could not be read: {e}"))
}
#[tauri::command]
pub async fn read_agent_conversation(
    root_path: String,
    session_id: String,
    native_id: Option<String>,
) -> Result<Conversation, String> {
    tokio::task::spawn_blocking(move || {
        let session = super::read_session(root_path, session_id)?;
        let agent = session.agent.ok_or("This is not a coding-agent session.")?;
        let cwd = PathBuf::from(agent["cwd"].as_str().ok_or("Missing agent working directory.")?).canonicalize().map_err(|e| e.to_string())?;
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home directory unavailable.")?);
        let end = if session.status == "active" { super::now_secs() } else { session.updated_at };
        match agent["name"].as_str().unwrap_or("") {
            "opencode" => {
                let path = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("opencode/opencode.db");
                read(&path, &cwd, session.created_at, end, native_id)
            },
            "codex" => {
                let base = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
                jsonl::read(&base, jsonl::Agent::Codex, &cwd, session.created_at, end, native_id)
            },
            "claude" | "claude-code" => {
                let base = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
                jsonl::read(&base, jsonl::Agent::Claude, &cwd, session.created_at, end, native_id)
            },
            _ => Err("Structured history is not available for this agent. The terminal recording is available below.".into()),
        }
    }).await.map_err(|_| "Conversation read failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_roles_tools_and_reasoning_without_merging_concurrent_sessions() {
        let root = std::env::temp_dir().join(format!(
            "nolock-conversations-{}-{}",
            std::process::id(),
            super::super::now_secs()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let cwd = root.canonicalize().unwrap();
        let path = root.join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);").unwrap();
        db.execute(
            "INSERT INTO session VALUES ('one', 'First conversation', ?1, 100000, 110000)",
            [cwd.to_str().unwrap()],
        )
        .unwrap();
        db.execute("INSERT INTO session VALUES ('other-project', 'Not this project', '/different', 100000, 110000)", []).unwrap();
        for (id, role) in [("u", "user"), ("a", "assistant")] {
            db.execute(
                "INSERT INTO message VALUES (?1,'one',?2,100000)",
                [id, &json!({"role":role,"modelID":"test-model"}).to_string()],
            )
            .unwrap();
        }
        for (id, message, data) in [
            ("1", "u", json!({"type":"text","text":"hey are you there?"})),
            ("2", "a", json!({"type":"reasoning","text":"Checking"})),
            ("3", "a", json!({"type":"text","text":"Yes, I am here"})),
            (
                "4",
                "a",
                json!({"type":"tool","tool":"read_file","state":{"input":{"path":"a.txt"},"output":"file contents"}}),
            ),
        ] {
            db.execute(
                "INSERT INTO part VALUES (?1,'one',?2,?3,100000)",
                [id, message, &data.to_string()],
            )
            .unwrap();
        }
        let result = read(&path, &cwd, 99, 120, None).unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.selected_id.as_deref(), Some("one"));
        assert_eq!(result.messages.len(), 2);
        let assistant = result
            .messages
            .iter()
            .find(|m| m["role"] == "assistant")
            .unwrap();
        assert_eq!(assistant["content"], "Yes, I am here");
        assert_eq!(assistant["reasoning"], "Checking");
        assert_eq!(assistant["toolCalls"][0]["result_full"], "file contents");
        db.execute(
            "INSERT INTO session VALUES ('two','Concurrent',?1,101000,111000)",
            [cwd.to_str().unwrap()],
        )
        .unwrap();
        let ambiguous = read(&path, &cwd, 99, 120, None).unwrap();
        assert_eq!(ambiguous.candidates.len(), 2);
        assert!(ambiguous.messages.is_empty());
        assert!(read(&path, &cwd, 99, 120, Some("other-project".into()))
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(
            read(&path, &cwd, 99, 120, Some("one".into()))
                .unwrap()
                .messages
                .len(),
            2
        );
        assert!(read(&path, &cwd, 200, 210, None)
            .unwrap()
            .candidates
            .is_empty());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
