// ---------------------------------------------------------------------------
// FAQ Learning-mode vector store — SQLite + sqlite-vec.
//
// Learning mode keeps a persistent, per-repository knowledge base of
// question → answer pairs ("FAQ entries"). This module persists entries in a
// SQLite database (`<root>/.faq/nolock-faq.db`) and indexes their embeddings
// with sqlite-vec's `vec0` virtual table so past exchanges can be retrieved
// semantically and fed back into the conversation context.
//
// The plain-text `.faq/README.md` the chat model maintains is untouched; this
// store adds a machine-readable, similarity-searchable layer on top of it.
// ---------------------------------------------------------------------------

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// FAQ directory name (sibling of the model-maintained plain-text README).
pub const FAQ_DIR: &str = ".faq";
/// SQLite file living inside the FAQ directory.
pub const FAQ_DB_FILE: &str = "nolock-faq.db";
/// Default embedding model for local backends (Ollama).
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";
/// Ranking strategies for retrieving learned entries.
pub const RANKING_SEMANTIC: &str = "semantic";
pub const RANKING_FREQUENCY: &str = "frequency";
pub const RANKING_HYBRID: &str = "hybrid";

fn ranking_default() -> String {
    RANKING_HYBRID.into()
}

/// Meta key recording the embedding dimension the `vec0` table was built for.
const META_DIM_KEY: &str = "embedding_dim";
/// Meta key recording the embedding model id used for the stored vectors.
const META_MODEL_KEY: &str = "embedding_model";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// Learning-mode retrieval configuration. Sent from the Chat Model panel.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaqConfig {
    #[serde(default)]
    pub embedding_model: String,
    /// One of `semantic`, `frequency`, `hybrid`.
    #[serde(default)]
    pub ranking: String,
    #[serde(default)]
    pub top_k: u32,
}

impl FaqConfig {
    pub fn default() -> Self {
        FaqConfig {
            embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
            ranking: ranking_default(),
            top_k: 3,
        }
    }

    pub fn normalize(&mut self) {
        if self.embedding_model.trim().is_empty() {
            self.embedding_model = DEFAULT_EMBEDDING_MODEL.into();
        }
        let ranking = self.ranking.as_str();
        if ranking != RANKING_SEMANTIC
            && ranking != RANKING_FREQUENCY
            && ranking != RANKING_HYBRID
        {
            self.ranking = ranking_default();
        }
        if self.top_k == 0 || self.top_k > 50 {
            self.top_k = 3;
        }
    }
}

/// A single learned question → answer entry. `similarity`/`score` are set only
/// on semantic/hybrid searches (the score used to surface this entry).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaqEntry {
    pub id: u64,
    pub question: String,
    pub answer: String,
    pub frequency: u64,
    pub last_asked: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaqStats {
    pub count: u64,
    pub dimension: u32,
    pub model: String,
    pub db_path: String,
}

// ---------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------

/// Register the sqlite-vec extension for every connection opened afterwards.
/// Safe to call more than once (SQLite ignores duplicate registrations).
fn ensure_vec_extension() -> Result<(), String> {
    unsafe {
        let ffi = rusqlite::ffi::sqlite3_auto_extension;
        ffi(Some(std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ())));
    }
    Ok(())
}

fn faq_dir(root_path: &str) -> PathBuf {
    Path::new(root_path).join(FAQ_DIR)
}

fn faq_db_path(root_path: &str) -> PathBuf {
    faq_dir(root_path).join(FAQ_DB_FILE)
}

/// Open (creating if needed) the FAQ database. WAL + busy timeout keep the
/// lightweight per-command connections from stepping on each other.
fn open_db(root_path: &str) -> Result<Connection, String> {
    ensure_vec_extension()?;
    let dir = faq_dir(root_path);
    if dir.exists() {
        let meta = std::fs::metadata(&dir).map_err(|e| e.to_string())?;
        if !meta.is_dir() {
            return Err(format!("{} exists and is not a directory", dir.display()));
        }
    } else {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }
    let conn = Connection::open(&faq_db_path(root_path))
        .map_err(|e| format!("Failed to open FAQ database: {}", e))?;
    let _ = conn
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("Failed to configure FAQ database: {}", e))?;
    Ok(conn)
}

/// Create the text + metadata tables (idempotent).
fn ensure_text_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS faq_meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS faq_entries (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           question   TEXT NOT NULL UNIQUE,
           answer     TEXT NOT NULL DEFAULT '',
           frequency  INTEGER NOT NULL DEFAULT 1,
           last_asked INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_faq_entries_frequency
           ON faq_entries (frequency DESC, last_asked DESC);",
    )
    .map_err(|e| format!("Failed to create FAQ schema: {}", e))
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    match conn.query_row(
        "SELECT value FROM faq_meta WHERE key = ?",
        rusqlite::params!(key),
        |row| Ok(row.get_unwrap::<usize, String>(0)),
    ) {
        Ok(value) => Ok(Some(value)),
        Err(e) if format!("{}", e).contains("no rows") => Ok(None),
        Err(e) => Err(format!("Failed to read FAQ meta: {}", e)),
    }
}

fn meta_set(conn: &Connection, key: &str, value: String) -> Result<(), String> {
    let _ = conn
        .execute(
            "INSERT INTO faq_meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params!(key, value),
        )
        .map_err(|e| format!("Failed to write FAQ meta: {}", e))?;
    Ok(())
}

/// Bring the `vec0` table in line with the current embedding dimension.
/// If the model changed dimension we drop the vector index (text entries are
/// kept and re-indexed lazily on the next upserts).
fn ensure_vec_schema(conn: &Connection, embedding: &Vec<f64>) -> Result<(), String> {
    let dim = embedding.len() as u32;
    let current = meta_get(conn, META_DIM_KEY)
        .map_err(|e| format!("Failed to read FAQ meta: {}", e))?
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if current != dim {
        let _ = conn
            .execute_batch("DROP TABLE IF EXISTS faq_vec;")
            .map_err(|e| format!("Failed to reset FAQ vector table: {}", e))?;
        let ddl = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS faq_vec USING vec0(embedding float[{}] distance_metric=cosine)",
            dim,
        );
        conn.execute_batch(&ddl)
            .map_err(|e| format!("Failed to create FAQ vector table: {}", e))?;
        meta_set(conn, META_DIM_KEY, format!("{}", dim))
            .map_err(|e| format!("Failed to write FAQ meta: {}", e))?;
    }
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Serialize an embedding to the JSON array string sqlite-vec accepts.
fn vec_to_json(embedding: &Vec<f64>) -> Result<String, String> {
    serde_json::to_string(embedding).map_err(|e| format!("Failed to serialize embedding: {}", e))
}

// ---------------------------------------------------------------------------
// Embedding (provider call)
// ---------------------------------------------------------------------------

fn embed_endpoint(backend: &str, url: &str) -> String {
    if backend == "ollama" {
        format!("{}/api/embed", url)
    } else {
        format!("{}/embeddings", url)
    }
}

/// Embed a single text with the configured provider. Ollama uses `/api/embed`,
/// every other backend uses the OpenAI-compatible `/embeddings` shape.
async fn embed_text(
    client: &reqwest::Client,
    backend: &str,
    url: &str,
    api_key: &str,
    model: &str,
    text: &str,
) -> Result<Vec<f64>, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("Nothing to embed".into());
    }
    let model = if model.trim().is_empty() { DEFAULT_EMBEDDING_MODEL } else { model.trim() };
    let body = if backend == "ollama" {
        serde_json::json!({ "model": model, "input": trimmed })
    } else {
        serde_json::json!({ "model": model, "input": [trimmed] })
    };
    let mut request = client
        .post(&embed_endpoint(backend, url))
        .json(&body)
        .timeout(Duration::from_secs(120));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("Embedding request failed: {}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Embedding read failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Embedding HTTP {}: {}", status, text));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Embedding parse failed: {}", e))?;
    let emb: Option<&Vec<serde_json::Value>> = if backend == "ollama" {
        v["embeddings"][0]
            .as_array()
            .or_else(|| v["embedding"].as_array())
    } else {
        v["data"][0]["embedding"].as_array()
    };
    let mut out: Vec<f64> = Vec::new();
    if let Some(emb) = emb {
        for item in emb.iter() {
            out.push(item.as_f64().unwrap_or(0.0));
        }
    }
    if out.is_empty() {
        return Err("Embedding response had no vector".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Storage + retrieval
// ---------------------------------------------------------------------------

fn row_to_entry(row: &rusqlite::Row) -> FaqEntry {
    FaqEntry {
        id: row.get_unwrap::<usize, i64>(0) as u64,
        question: row.get_unwrap::<usize, String>(1),
        answer: row.get_unwrap::<usize, String>(2),
        frequency: row.get_unwrap::<usize, i64>(3) as u64,
        last_asked: row.get_unwrap::<usize, i64>(4) as u64,
        updated_at: row.get_unwrap::<usize, i64>(5) as u64,
        similarity: None,
        score: None,
    }
}

const ENTRY_SELECT: &str =
    "SELECT id, question, answer, frequency, last_asked, updated_at FROM faq_entries";

fn entry_by_id(conn: &Connection, id: u64) -> Result<FaqEntry, String> {
    conn.query_row(
        &format!("{} WHERE id = ?", ENTRY_SELECT),
        rusqlite::params!(id as i64),
        |row| Ok(row_to_entry(row)),
    )
    .map_err(|e| format!("Failed to read FAQ entry: {}", e))
}

fn top_by_frequency(conn: &Connection, limit: u32) -> Result<Vec<FaqEntry>, String> {
    let mut stmt = conn
        .prepare(&format!("{} ORDER BY frequency DESC, last_asked DESC LIMIT ?", ENTRY_SELECT))
        .map_err(|e| format!("Failed to prepare FAQ frequency query: {}", e))?;
    let mut iter = stmt
        .query(rusqlite::params!(limit as i64))
        .map_err(|e| format!("Failed to run FAQ frequency query: {}", e))?;
    let mut out: Vec<FaqEntry> = Vec::new();
    loop {
        match iter.next() {
            Ok(Some(row)) => out.push(row_to_entry(row)),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ entries: {}", e)),
        }
    }
    Ok(out)
}

/// Persist (or update) a question → answer pair given an already-computed
/// embedding. Frequencies increment when the same question is asked again.
fn upsert_embedded(
    conn: &Connection,
    question: &str,
    answer: &str,
    embedding: &Vec<f64>,
    model: &str,
) -> Result<FaqEntry, String> {
    ensure_text_schema(conn)?;
    ensure_vec_schema(conn, embedding)?;
    let now = now_secs();

    conn.execute(
        "INSERT INTO faq_entries (question, answer, frequency, last_asked, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(question) DO UPDATE SET
           answer       = excluded.answer,
           frequency    = faq_entries.frequency + 1,
           last_asked   = excluded.last_asked,
           updated_at   = excluded.updated_at",
        rusqlite::params!(&question, &answer, now as i64, now as i64, now as i64),
    )
    .map_err(|e| format!("Failed to upsert FAQ entry: {}", e))?;
    if !model.trim().is_empty() {
        meta_set(conn, META_MODEL_KEY, model.to_string())
            .map_err(|e| format!("Failed to write FAQ meta: {}", e))?;
    }

    let id = conn
        .query_row(
            "SELECT id FROM faq_entries WHERE question = ?",
            rusqlite::params!(&question),
            |row| Ok(row.get_unwrap::<usize, i64>(0)),
        )
        .map_err(|e| format!("Failed to read FAQ entry id: {}", e))?;
    let vec_json = vec_to_json(embedding)?;
    let _ = conn
        .execute_batch(&format!("DELETE FROM faq_vec WHERE rowid = {}", id))
        .map_err(|e| format!("Failed to replace FAQ vector: {}", e))?;
    conn.execute(
        "INSERT INTO faq_vec (rowid, embedding) VALUES (?, ?)",
        rusqlite::params!(id, &vec_json),
    )
    .map_err(|e| format!("Failed to index FAQ vector: {}", e))?;

    entry_by_id(conn, id as u64)
}

/// Raw vec0 kNN scan: returns `(rowid, distance)` pairs, nearest first.
fn nearest_neighbors(
    conn: &Connection,
    query: &Vec<f64>,
    limit: u32,
) -> Result<Vec<(u64, f64)>, String> {
    let vec_json = vec_to_json(query)?;
    let mut stmt = conn
        .prepare("SELECT rowid, distance FROM faq_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
        .map_err(|e| format!("Failed to prepare FAQ vector query: {}", e))?;
    let mut iter = stmt
        .query(rusqlite::params!(&vec_json, limit as i64))
        .map_err(|e| format!("Failed to run FAQ vector query: {}", e))?;
    let mut out: Vec<(u64, f64)> = Vec::new();
    loop {
        match iter.next() {
            Ok(Some(row)) => out.push((
                row.get_unwrap::<usize, i64>(0) as u64,
                row.get_unwrap::<usize, f64>(1),
            )),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ vectors: {}", e)),
        }
    }
    Ok(out)
}

/// Rank retrieved entries by the configured strategy and attach scores.
fn rank_matches(
    conn: &Connection,
    neighbors: &Vec<(u64, f64)>,
    ranking: &str,
    top_k: u32,
) -> Result<Vec<FaqEntry>, String> {
    // Fetch candidate entries + their cosine similarities.
    let mut fetched: Vec<(f64, FaqEntry)> = Vec::new();
    for pair in neighbors.iter() {
        let sim = 1.0 - pair.1;
        let entry = entry_by_id(conn, pair.0)?;
        fetched.push((sim, entry));
    }
    let mut max_freq: f64 = 1.0;
    for item in fetched.iter() {
        let freq = item.1.frequency as f64;
        if freq > max_freq {
            max_freq = freq;
        }
    }
    // Score each candidate, then sort descending by score (most recently asked
    // breaks ties). Floats are compared by folding them into a 1e-6 integer
    // key (see the f64 total-ordering note in the std vec docs).
    let mut scored: Vec<(i64, i64, FaqEntry)> = Vec::new();
    for item in fetched.iter() {
        let mut entry = item.1.clone();
        let freq_norm = if max_freq > 0.0 { entry.frequency as f64 / max_freq } else { 0.0 };
        let similarity = item.0;
        let score = if ranking == RANKING_SEMANTIC {
            similarity
        } else if ranking == RANKING_FREQUENCY {
            freq_norm
        } else {
            0.5 * similarity + 0.5 * freq_norm
        };
        if ranking != RANKING_FREQUENCY {
            entry.similarity = Some(similarity);
        }
        entry.score = Some(if ranking == RANKING_FREQUENCY {
            entry.frequency as f64
        } else {
            score
        });
        scored.push(((score * 1_000_000.0) as i64, entry.last_asked as i64, entry));
    }
    scored.sort_by(|a, b| {
        b.0
            .cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
    });
    let mut out: Vec<FaqEntry> = Vec::new();
    let mut count: u32 = 0;
    for item in scored.iter() {
        out.push(item.2.clone());
        count += 1;
        if count >= top_k {
            break;
        }
    }
    Ok(out)
}

fn count_entries(conn: &Connection) -> u64 {
    conn.query_row(
        "SELECT count(*) FROM faq_entries",
        rusqlite::params!(),
        |row| Ok(row.get_unwrap::<usize, i64>(0)),
    )
    .unwrap_or(0) as u64
}

/// Number of vec0 candidates to scan before re-ranking (a superset of top_k
/// so frequency/hybrid strategies have room to select).
fn scan_limit(top_k: u32) -> u32 {
    if top_k * 4 > 10 {
        top_k * 4
    } else {
        10
    }
}

// ---------------------------------------------------------------------------
// Public API — shared by the Tauri commands and the headless web server
// ---------------------------------------------------------------------------

/// Retrieve the most relevant learned entries for `query`. `config.ranking`
/// selects the ordering: semantic (cosine), frequency (most-asked), or hybrid.
pub async fn search(
    root_path: String,
    backend: String,
    url: String,
    api_key: String,
    query: String,
    mut config: FaqConfig,
) -> Result<Vec<FaqEntry>, String> {
    config.normalize();
    let q = query.trim().to_string();
    if q.is_empty() || config.top_k == 0 {
        return Ok(Vec::new());
    }
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    if count_entries(&conn) == 0 {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::new();
    let embedding = embed_text(
        &client,
        &backend,
        &url,
        &api_key,
        &config.embedding_model,
        &q,
    )
    .await?;
    let neighbors = nearest_neighbors(&conn, &embedding, scan_limit(config.top_k))?;
    rank_matches(&conn, &neighbors, config.ranking.as_str(), config.top_k)
        .map_err(|e| e.to_string())
}

/// Record a new learned exchange (question → answer), embedding it first.
pub async fn upsert(
    root_path: String,
    backend: String,
    url: String,
    api_key: String,
    question: String,
    answer: String,
    mut config: FaqConfig,
) -> Result<FaqEntry, String> {
    config.normalize();
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".into());
    }
    let conn = open_db(&root_path)?;
    let client = reqwest::Client::new();
    let embedding = embed_text(
        &client,
        &backend,
        &url,
        &api_key,
        &config.embedding_model,
        &q,
    )
    .await?;
    upsert_embedded(&conn, &q, &answer, &embedding, &config.embedding_model)
        .map_err(|e| e.to_string())
}

/// Record a learned exchange when an embedding is already available (used by
/// callers/tests that have computed the vector themselves).
pub fn upsert_with_embedding(
    root_path: String,
    question: String,
    answer: String,
    embedding: Vec<f64>,
) -> Result<FaqEntry, String> {
    let conn = open_db(&root_path)?;
    upsert_embedded(&conn, &question, &answer, &embedding, "")
        .map_err(|e| e.to_string())
}

/// List every learned entry, most-asked first.
pub fn list(root_path: String) -> Result<Vec<FaqEntry>, String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    top_by_frequency(&conn, 1000).map_err(|e| e.to_string())
}

/// Remove a learned entry by its question text (case-sensitive exact match).
pub fn delete(root_path: String, question: String) -> Result<(), String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let _ = conn
        .execute(
            "DELETE FROM faq_vec WHERE rowid IN (SELECT id FROM faq_entries WHERE question = ?)",
            rusqlite::params!(&question),
        )
        .map_err(|e| format!("Failed to delete FAQ vector: {}", e))?;
    let _ = conn
        .execute(
            "DELETE FROM faq_entries WHERE question = ?",
            rusqlite::params!(&question),
        )
        .map_err(|e| format!("Failed to delete FAQ entry: {}", e))?;
    Ok(())
}

/// Store statistics (entry count, vector dimension, embedding model, path).
pub fn stats(root_path: String) -> Result<FaqStats, String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let dim = meta_get(&conn, META_DIM_KEY)
        .map_err(|e| format!("Failed to read FAQ meta: {}", e))?
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let model = meta_get(&conn, META_MODEL_KEY)
        .map_err(|e| format!("Failed to read FAQ meta: {}", e))?
        .unwrap_or(DEFAULT_EMBEDDING_MODEL.to_string());
    Ok(FaqStats {
        count: count_entries(&conn),
        dimension: dim,
        model,
        db_path: faq_db_path(&root_path).to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/tmp/nolock-faq-test";
    const Q1: &str = "How does the agent tool loop decide when to stop?";
    const Q2: &str = "Why does the context length cap output tokens?";
    const A1: &str = "It stops after max_iterations or when the model returns no tool calls.";
    const A2: &str = "So input + output never exceeds the model context window.";

    fn test_root(name: &str) -> String {
        format!("{}-{}-{}", ROOT, std::process::id(), name)
    }

    fn seed(root: &String) {
        upsert_with_embedding(root.clone(), Q1.into(), A1.into(), vec![1.0, 0.0, 0.0, 0.0]).unwrap();
        upsert_with_embedding(root.clone(), Q2.into(), A2.into(), vec![0.0, 1.0, 0.0, 0.0]).unwrap();
    }

    #[test]
    fn empty_store_has_zero_stats() {
        let root = test_root("stats");
        let _ = std::fs::remove_dir_all(&root);
        let s = stats(root.clone()).unwrap();
        assert_eq!(s.count, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn upsert_with_embedding_roundtrips_and_bumps_frequency() {
        let root = test_root("roundtrip");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        // Asking the same question again bumps its frequency.
        upsert_with_embedding(root.clone(), Q1.into(), A1.into(), vec![1.0, 0.0, 0.0, 0.0]).unwrap();

        let entries = list(root.clone()).unwrap();
        assert_eq!(entries.len(), 2);
        let first = entries.iter().find(|e| e.question.as_str() == Q1).unwrap();
        assert_eq!(first.frequency, 2);
        assert_eq!(first.answer.as_str(), A1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn semantic_ranking_returns_closest_question_first() {
        let root = test_root("semantic");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);

        let conn = open_db(&root).unwrap();
        let query = vec![0.98, 0.02, 0.0, 0.0];
        let near = nearest_neighbors(&conn, &query, 10).unwrap();
        let hits = rank_matches(&conn, &near, RANKING_SEMANTIC, 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].question.as_str(), Q1);
        assert!(hits[0].similarity.unwrap() >= 0.95);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hybrid_favours_frequent_entries_within_cosine_neighbourhood() {
        let root = test_root("hybrid");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        // Q2 asked 3 more times → 4 total vs Q1's 1.
        for _ in [0, 1, 2] {
            upsert_with_embedding(root.clone(), Q2.into(), A2.into(), vec![0.0, 1.0, 0.0, 0.0]).unwrap();
        }

        let conn = open_db(&root).unwrap();
        let query = vec![0.5, 0.5, 0.0, 0.0];
        let near = nearest_neighbors(&conn, &query, 10).unwrap();
        let hits = rank_matches(&conn, &near, RANKING_HYBRID, 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].question.as_str(), Q2);
        assert!(hits[0].score.unwrap() > hits[1].score.unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_entry_and_vector() {
        let root = test_root("delete");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        assert_eq!(list(root.clone()).unwrap().len(), 2);
        delete(root.clone(), Q1.into()).unwrap();
        assert_eq!(list(root.clone()).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}