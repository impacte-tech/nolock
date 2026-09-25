//! Read native usage counters without importing conversation text or modifying agent stores.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    agent: String,
    provider: String,
    model: String,
    sessions: usize,
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
    cache_write_tokens: u64,
    reasoning_tokens: u64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    rows: Vec<Row>,
    sessions: usize,
    sessions_without_usage: usize,
    warnings: Vec<String>,
}
#[derive(Default)]
struct Session {
    agent: String,
    id: String,
    cwd: PathBuf,
    uncertain_fork: bool,
    rows: BTreeMap<(String, String), Row>,
}
fn n(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn add(session: &mut Session, provider: &str, model: &str, counts: [u64; 5]) {
    let model = if model.is_empty() {
        "Unknown model"
    } else {
        model
    };
    let row = session
        .rows
        .entry((provider.into(), model.into()))
        .or_insert_with(|| Row {
            agent: session.agent.clone(),
            provider: provider.into(),
            model: model.into(),
            ..Default::default()
        });
    row.input_tokens += counts[0];
    row.output_tokens += counts[1];
    row.cached_input_tokens += counts[2];
    row.cache_write_tokens += counts[3];
    row.reasoning_tokens += counts[4];
}
fn counts(v: &Value) -> [u64; 5] {
    [
        n(v, "input_tokens"),
        n(v, "output_tokens"),
        n(v, "cached_input_tokens"),
        n(v, "cache_write_input_tokens"),
        n(v, "reasoning_output_tokens"),
    ]
}
fn in_project(cwd: &Path, root: &Path) -> bool {
    !cwd.as_os_str().is_empty()
        && cwd
            .canonicalize()
            .unwrap_or_else(|_| cwd.into())
            .starts_with(root)
}

fn jsonl(path: &Path, agent: &str, root: Option<&Path>) -> Result<Session, String> {
    let file = fs::File::open(path).map_err(|_| "A native session could not be read.")?;
    let mut session = Session {
        agent: agent.into(),
        ..Default::default()
    };
    let mut model = String::new();
    let mut provider = String::new();
    let mut previous = [0; 5];
    let mut fork = false;
    let mut first = true;
    let mut history_start = None;
    // Claude can write several content blocks and later usage updates for one message.
    let mut messages: BTreeMap<String, (String, [u64; 5])> = BTreeMap::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|_| "A native session could not be read.")?;
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        }; // partial live append
        if agent == "Codex" {
            let p = &v["payload"];
            match s(&v, "type") {
                "session_meta" => {
                    session.id = s(p, "id").into();
                    if session.id.is_empty() {
                        session.id = s(p, "session_id").into();
                    }
                    session.cwd = s(p, "cwd").into();
                    provider = s(p, "model_provider").into();
                    fork = p
                        .get("parent_thread_id")
                        .or_else(|| p.get("forked_from_id"))
                        .is_some_and(|v| !v.is_null());
                    history_start = p
                        .get("subagent_history_start_ordinal")
                        .and_then(Value::as_u64);
                    session.uncertain_fork = fork && history_start.is_none();
                    if root.is_some_and(|root| !in_project(&session.cwd, root)) {
                        break;
                    }
                }
                "turn_context" => {
                    model = s(p, "model").into();
                }
                "event_msg"
                    if s(p, "type") == "token_count"
                        && (p["info"]["total_token_usage"]["input_tokens"].is_u64()
                            || p["info"]["total_token_usage"]["output_tokens"].is_u64()) =>
                {
                    if history_start.is_some_and(|start| {
                        v.get("ordinal")
                            .and_then(Value::as_u64)
                            .is_some_and(|ordinal| ordinal < start)
                    }) {
                        continue;
                    }
                    let total = counts(&p["info"]["total_token_usage"]);
                    let delta = if first && fork {
                        counts(&p["info"]["last_token_usage"])
                    } else {
                        std::array::from_fn(|i| total[i].saturating_sub(previous[i]))
                    };
                    // Repeated snapshots are not new requests. Counter resets establish a new baseline.
                    if first || total != previous {
                        add(&mut session, &provider, &model, delta);
                    }
                    previous = total;
                    first = false;
                }
                _ => {}
            }
        } else {
            if !s(&v, "cwd").is_empty() {
                session.cwd = s(&v, "cwd").into();
                if root.is_some_and(|root| !in_project(&session.cwd, root)) {
                    break;
                }
            }
            if !s(&v, "sessionId").is_empty() {
                session.id = s(&v, "sessionId").into();
            }
            let m = &v["message"];
            let u = &m["usage"];
            if s(&v, "type") == "assistant"
                && (u["input_tokens"].is_u64() || u["output_tokens"].is_u64())
                && !s(m, "id").is_empty()
            {
                let cache = n(u, "cache_read_input_tokens");
                let write = n(u, "cache_creation_input_tokens");
                let values = [
                    n(u, "input_tokens") + cache + write,
                    n(u, "output_tokens"),
                    cache,
                    write,
                    n(&u["output_tokens_details"], "thinking_tokens"),
                ];
                let entry = messages
                    .entry(s(m, "id").into())
                    .or_insert((s(m, "model").into(), [0; 5]));
                for i in 0..5 {
                    entry.1[i] = entry.1[i].max(values[i]);
                }
            }
        }
    }
    if agent == "Claude Code"
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|p| p == "subagents")
    {
        session.id = format!(
            "{}:{}",
            session.id,
            path.file_stem().unwrap_or_default().to_string_lossy()
        );
    }
    for (_, (model, values)) in messages {
        add(&mut session, "", &model, values);
    }
    Ok(session)
}
fn walk(root: &Path, depth: usize, paths: &mut Vec<PathBuf>, failed: &mut bool) {
    if !root.exists() || depth == 0 {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(_) => {
            *failed = true;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *failed = true;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *failed = true;
            continue;
        };
        if kind.is_dir() {
            walk(&entry.path(), depth - 1, paths, failed);
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "jsonl") {
            paths.push(entry.path());
        }
    }
}
fn opencode(path: &Path, root: &Path) -> Result<Vec<Session>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let read = || -> rusqlite::Result<Vec<Session>> {
        let db = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        let mut query = db.prepare("SELECT id, directory FROM session")?;
        let entries =
            query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut result = Vec::new();
        for entry in entries {
            let (id, cwd) = entry?;
            if !in_project(Path::new(&cwd), root) {
                continue;
            }
            let mut session = Session {
                agent: "OpenCode".into(),
                id,
                cwd: cwd.into(),
                ..Default::default()
            };
            let mut messages = db.prepare("SELECT data FROM message WHERE session_id = ?1")?;
            for message in messages.query_map([&session.id], |r| r.get::<_, String>(0))? {
                let v: Value = serde_json::from_str(&message?).unwrap_or(Value::Null);
                if s(&v, "role") != "assistant"
                    || !(v["tokens"]["input"].is_u64() || v["tokens"]["output"].is_u64())
                {
                    continue;
                }
                let t = &v["tokens"];
                let cache = n(&t["cache"], "read");
                let write = n(&t["cache"], "write");
                add(
                    &mut session,
                    s(&v, "providerID"),
                    s(&v, "modelID"),
                    [
                        n(t, "input") + cache + write,
                        n(t, "output") + n(t, "reasoning"),
                        cache,
                        write,
                        n(t, "reasoning"),
                    ],
                );
            }
            result.push(session);
        }
        Ok(result)
    };
    read().map_err(|_| {
        "OpenCode usage could not be read (database unavailable or unsupported schema).".into()
    })
}
fn collect(root: &Path, codex: &Path, claude: &Path, open: &Path) -> Report {
    let mut report = Report::default();
    let mut sessions = BTreeMap::new();
    for (agent, base, depth) in [("Codex", codex, 6), ("Claude Code", claude, 5)] {
        let mut paths = Vec::new();
        let mut failed = false;
        if agent == "Codex" {
            walk(&base.join("sessions"), depth, &mut paths, &mut failed);
            walk(
                &base.join("archived_sessions"),
                depth,
                &mut paths,
                &mut failed,
            );
        } else {
            walk(base, depth, &mut paths, &mut failed);
        }
        paths.sort();
        for path in paths {
            match jsonl(&path, agent, Some(root)) {
                Ok(session) if in_project(&session.cwd, root) && !session.id.is_empty() => {
                    // A native session may appear in archived/copied logs. Prefer the fullest record.
                    let key = (session.agent.clone(), session.id.clone());
                    let weight = |s: &Session| {
                        s.rows
                            .values()
                            .map(|r| r.input_tokens + r.output_tokens)
                            .sum::<u64>()
                    };
                    if sessions
                        .get(&key)
                        .is_none_or(|old| weight(&session) > weight(old))
                    {
                        sessions.insert(key, session);
                    }
                }
                Ok(_) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            report.warnings.push(format!(
                "Some {agent} histories could not be read; totals may be incomplete."
            ));
        }
    }
    match opencode(open, root) {
        Ok(found) => {
            for session in found {
                sessions.insert((session.agent.clone(), session.id.clone()), session);
            }
        }
        Err(e) => report.warnings.push(e),
    }
    let mut rows: BTreeMap<(String, String, String), (Row, BTreeSet<String>)> = BTreeMap::new();
    report.sessions = sessions.len();
    if sessions.values().any(|session| session.uncertain_fork) {
        report.warnings.push("Some forked Codex histories lack an ownership boundary. Their first usage snapshot uses last-request counters; inherited usage may not be fully distinguishable.".into());
    }
    for session in sessions.into_values() {
        if session.rows.is_empty() {
            report.sessions_without_usage += 1;
        }
        for row in session.rows.into_values() {
            let entry = rows
                .entry((row.agent.clone(), row.provider.clone(), row.model.clone()))
                .or_insert_with(|| {
                    (
                        Row {
                            agent: row.agent.clone(),
                            provider: row.provider.clone(),
                            model: row.model.clone(),
                            ..Default::default()
                        },
                        BTreeSet::new(),
                    )
                });
            entry.1.insert(session.id.clone());
            entry.0.input_tokens += row.input_tokens;
            entry.0.output_tokens += row.output_tokens;
            entry.0.cached_input_tokens += row.cached_input_tokens;
            entry.0.cache_write_tokens += row.cache_write_tokens;
            entry.0.reasoning_tokens += row.reasoning_tokens;
        }
    }
    report.rows = rows
        .into_values()
        .map(|(mut row, ids)| {
            row.sessions = ids.len();
            row
        })
        .collect();
    report
}
#[tauri::command]
pub async fn agent_usage(root_path: String) -> Result<Report, String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|_| "Open a project folder first.")?;
    if !root.is_dir() {
        return Err("Open a project folder first.".into());
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home unavailable.")?);
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects");
    let open = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"))
        .join("opencode/opencode.db");
    tokio::task::spawn_blocking(move || collect(&root, &codex, &claude, &open))
        .await
        .map_err(|_| "Usage scan failed.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nolock-usage-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn log(&self, path: &str, events: Vec<Value>) -> PathBuf {
            let p = self.0.join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(
                &p,
                events
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn codex_meta(id: &str, cwd: &Path) -> Value {
        json!({"type":"session_meta","payload":{"id":id,"cwd":cwd,"model_provider":"local"}})
    }
    fn context(model: &str) -> Value {
        json!({"type":"turn_context","payload":{"model":model}})
    }
    fn tokens(input: u64, output: u64) -> Value {
        json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":input/2,"reasoning_output_tokens":output/2}}}})
    }
    #[test]
    fn cumulative_snapshots_deduplicate_and_split_models() {
        let f = Fixture::new();
        let p = f.log(
            "run.jsonl",
            vec![
                codex_meta("one", &f.0),
                context("alpha"),
                tokens(100, 10),
                tokens(100, 10),
                context("beta"),
                tokens(130, 18),
            ],
        );
        let s = jsonl(&p, "Codex", None).unwrap();
        let a = &s.rows[&("local".into(), "alpha".into())];
        let b = &s.rows[&("local".into(), "beta".into())];
        assert_eq!(
            (a.input_tokens, a.output_tokens, a.cached_input_tokens),
            (100, 10, 50)
        );
        assert_eq!(
            (b.input_tokens, b.output_tokens, b.reasoning_tokens),
            (30, 8, 4)
        );
    }
    #[test]
    fn fork_history_boundary_excludes_inherited_usage() {
        let f = Fixture::new();
        let mut meta = codex_meta("child", &f.0);
        meta["payload"]["parent_thread_id"] = json!("parent");
        meta["payload"]["subagent_history_start_ordinal"] = json!(20);
        let mut inherited = tokens(100, 10);
        inherited["ordinal"] = json!(10);
        let mut owned = tokens(140, 15);
        owned["ordinal"] = json!(22);
        owned["payload"]["info"]["last_token_usage"] = json!({"input_tokens":40,"output_tokens":5});
        let p = f.log(
            "child.jsonl",
            vec![meta, context("model"), inherited, owned],
        );
        let session = jsonl(&p, "Codex", None).unwrap();
        let row = session.rows.values().next().unwrap();
        assert_eq!((row.input_tokens, row.output_tokens), (40, 5));
        assert!(!session.uncertain_fork);
    }
    #[test]
    fn claude_blocks_are_one_message_and_cache_is_included_once() {
        let f = Fixture::new();
        let event = |id: &str, output: u64| json!({"type":"assistant","sessionId":"claude-session","cwd":f.0,"message":{"id":id,"model":"local-model","usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":10,"output_tokens":output}}});
        let p = f.log(
            "claude.jsonl",
            vec![
                event("msg-1", 0),
                event("msg-1", 20),
                event("msg-1", 20),
                event("msg-2", 4),
            ],
        );
        let s = jsonl(&p, "Claude Code", None).unwrap();
        let row = s.rows.values().next().unwrap();
        assert_eq!(
            (
                row.input_tokens,
                row.output_tokens,
                row.cached_input_tokens,
                row.cache_write_tokens
            ),
            (230, 24, 200, 20)
        );
    }
    #[test]
    fn project_filter_archive_dedup_and_missing_usage() {
        let f = Fixture::new();
        let root = f.0.join("project");
        fs::create_dir_all(&root).unwrap();
        let events = vec![codex_meta("one", &root), context("model"), tokens(100, 5)];
        f.log("codex/sessions/a.jsonl", events.clone());
        f.log("codex/archived_sessions/copy.jsonl", events);
        f.log(
            "codex/sessions/other.jsonl",
            vec![
                codex_meta("other", &f.0.join("project-sibling")),
                context("model"),
                tokens(900, 20),
            ],
        );
        f.log(
            "codex/sessions/empty.jsonl",
            vec![codex_meta("empty", &root)],
        );
        let report = collect(
            &root.canonicalize().unwrap(),
            &f.0.join("codex"),
            &f.0.join("claude"),
            &f.0.join("missing.db"),
        );
        assert_eq!(report.sessions, 2);
        assert_eq!(report.sessions_without_usage, 1);
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].input_tokens, 100);
        assert_eq!(report.rows[0].sessions, 1);
    }
    #[test]
    fn opencode_reads_native_database_without_mutation() {
        let f = Fixture::new();
        let p = f.0.join("opencode.db");
        {
            let db = rusqlite::Connection::open(&p).unwrap();
            db.execute_batch("CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);").unwrap();
            db.execute(
                "INSERT INTO session VALUES ('s',?1)",
                [f.0.to_str().unwrap()],
            )
            .unwrap();
            let message = json!({"role":"assistant","modelID":"m","providerID":"ollama","tokens":{"input":10,"output":8,"reasoning":3,"cache":{"read":20,"write":5}}});
            db.execute(
                "INSERT INTO message VALUES ('m','s',?1)",
                [message.to_string()],
            )
            .unwrap();
        }
        let before = fs::read(&p).unwrap();
        let sessions = opencode(&p, &f.0.canonicalize().unwrap()).unwrap();
        let row = sessions[0].rows.values().next().unwrap();
        assert_eq!(
            (row.input_tokens, row.output_tokens, row.reasoning_tokens),
            (35, 11, 3)
        );
        assert_eq!(before, fs::read(&p).unwrap());
    }
}
