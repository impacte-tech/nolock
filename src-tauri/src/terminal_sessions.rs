//! Terminal activity is a session sidecar, so chat saves cannot overwrite it.
//! Input events carry no keystrokes. Only explicit recordings contain output.
use serde::{Deserialize, Serialize};
use std::{io::{BufRead, Write}, sync::Mutex};
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    id: String,
    terminal_id: String,
    label: String,
    kind: String,
    created_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}
fn path(root: &str, id: &str) -> Result<std::path::PathBuf, String> {
    super::sanitize_session_id(id)?;
    Ok(super::sessions_dir(root)?.join(format!("{id}.terminals.jsonl")))
}
fn validate(events: &[Event]) -> Result<(), String> {
    if events.len() > 4096 { return Err("Too many terminal events in one batch.".into()); }
    for event in events {
        if event.id.len() > 128 || event.terminal_id.len() > 128 || event.label.len() > 256 || !event.created_at.is_finite()
            || !matches!(event.kind.as_str(), "opened" | "attached" | "input" | "output" | "exited" | "closed" | "recording-on" | "recording-off") {
            return Err("Invalid terminal event.".into());
        }
        if event.kind != "output" && event.text.is_some() { return Err("Terminal input must never include keystrokes or command text.".into()); }
        if event.text.as_ref().is_some_and(|text| text.len() > 65536) { return Err("Terminal output chunk too large.".into()); }
    }
    Ok(())
}
#[tauri::command]
pub fn append_terminal_session_events(root_path: String, session_id: String, mut events: Vec<Event>) -> Result<(), String> {
    validate(&events)?;
    // Model/leak boundary: transcripts are the durable copy of terminal
    // output and feed the session summary UI. Recorded output can echo a
    // model-provider key registered in this process, so redact known values
    // before they reach disk.
    for event in events.iter_mut() {
        if event.kind == "output" {
            if let Some(text) = event.text.take() {
                event.text = Some(super::redaction::redact(&text));
            }
        }
    }
    let path = path(&root_path, &session_id)?;
    let _lock = JOURNAL_LOCK.lock().map_err(|_| "Terminal journal busy.")?;
    if path.with_extension("deleted").exists() { return Err("Session was deleted.".into()); }
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|_| "Cannot create session directory.")?;
    super::agent_file_policy::check_path(&path)?;
    let mut bytes = Vec::new();
    for event in events { serde_json::to_writer(&mut bytes, &event).map_err(|_| "Cannot encode terminal event.")?; bytes.push(b'\n'); }
    if path.metadata().map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 > MAX_BYTES {
        return Err("Terminal session journal reached its 8 MiB limit. Start a new session to continue recording.".into());
    }
    let mut options = std::fs::OpenOptions::new(); options.create(true).append(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    options.open(&path).and_then(|mut file| file.write_all(&bytes)).map_err(|_| "Cannot write terminal activity.")?;
    // Terminal-only sessions appear in the same session picker. Never replace chat data.
    let record = serde_json::json!({"id":session_id,"summary":"Terminal session","status":"active","createdAt":super::now_secs(),"updatedAt":super::now_secs(),"messageCount":0,"toolCallCount":0,"firstMessage":"","lastMessage":"","tokenUsage":0,"contextWindow":0});
    let mut options = std::fs::OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    match options.open(dir.join(format!("{session_id}.json"))) {
        Ok(mut file) => file.write_all(serde_json::to_string_pretty(&record).unwrap().as_bytes()).map_err(|_| "Cannot create terminal session.")?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err("Cannot create terminal session.".into()),
    }
    Ok(())
}
#[tauri::command]
pub fn read_terminal_session_events(root_path: String, session_id: String) -> Result<Vec<Event>, String> {
    let path = path(&root_path, &session_id)?;
    let _lock = JOURNAL_LOCK.lock().map_err(|_| "Terminal journal busy.")?;
    if !path.exists() { return Ok(vec![]); }
    super::agent_file_policy::check_path(&path)?;
    if path.metadata().map_err(|_| "Cannot read terminal journal.")?.len() > MAX_BYTES { return Err("Terminal journal too large.".into()); }
    let file = std::fs::File::open(path).map_err(|_| "Cannot read terminal journal.")?;
    std::io::BufReader::new(file).lines().map(|line| {
        serde_json::from_str(&line.map_err(|_| "Cannot read terminal event.")?).map_err(|_| "Invalid terminal event.".into())
    }).collect()
}
pub fn delete(root: &str, id: &str) -> Result<(), String> {
    let _lock = JOURNAL_LOCK.lock().map_err(|_| "Terminal journal busy.")?;
    let path = path(root, id)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Cannot access sessions.")?;
    std::fs::write(path.with_extension("deleted"), b"").map_err(|_| "Cannot mark session deleted.")?;
    if path.exists() { std::fs::remove_file(path).map_err(|_| "Cannot delete terminal activity.")?; }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn input_never_contains_text() {
        let event = Event { id:"1".into(), terminal_id:"term-1".into(), label:"Terminal 1".into(), kind:"input".into(), created_at:1.0, text:Some("password".into()) };
        assert!(validate(&[event]).is_err());
    }
    #[test] fn transcripts_redact_registered_secrets() {
        let root = std::env::temp_dir().join(format!("nolock-terminal-redaction-{}",std::process::id()));
        let r = root.to_string_lossy().to_string();
        let secret = format!("nolock-transcript-canary-{}", std::process::id());
        super::super::redaction::register(&secret);
        let opened = Event { id:"t".into(), terminal_id:"t".into(), label:"Terminal".into(), kind:"opened".into(), created_at:1.0, text:None };
        let output = Event { id:"o".into(), terminal_id:"t".into(), label:"Terminal".into(), kind:"output".into(), created_at:2.0, text:Some(format!("export TOKEN={secret}\ndone")) };
        append_terminal_session_events(r.clone(),"redaction_session".into(),vec![opened,output]).unwrap();
        let events = read_terminal_session_events(r.clone(),"redaction_session".into()).unwrap();
        let text = events.iter().find_map(|e| e.text.clone()).unwrap();
        assert!(!text.contains(&secret), "transcript must not contain the registered secret");
        assert!(text.contains(super::super::redaction::PLACEHOLDER));
        delete(&r,"redaction_session").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn journals_share_a_session_without_overwriting_chat() {
        let root = std::env::temp_dir().join(format!("nolock-terminal-test-{}",std::process::id()));
        let r = root.to_string_lossy().to_string();
        for terminal in ["a","b"] {
            let event = Event { id:terminal.into(), terminal_id:terminal.into(),label:terminal.into(),kind:"opened".into(),created_at:1.0,text:None };
            append_terminal_session_events(r.clone(),"test_session".into(),vec![event]).unwrap();
        }
        assert_eq!(read_terminal_session_events(r.clone(),"test_session".into()).unwrap().len(),2);
        assert!(root.join(".sessions/test_session.json").exists());
        assert!(read_terminal_session_events(r.clone(),"../escape".into()).is_err());
        delete(&r,"test_session").unwrap();
        assert!(read_terminal_session_events(r,"test_session".into()).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
