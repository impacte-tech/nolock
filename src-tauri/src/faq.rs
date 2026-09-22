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
    collections::HashMap,
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
/// Meta key recording the last indexing failure (diagnostics for the .faq UI).
const META_LAST_ERROR_KEY: &str = "last_error";

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
    /// Minimum cosine similarity (0.0–1.0) for auto-categorization: questions
    /// more similar than this (to a category's most-asked representative) are
    /// grouped into the same category. Default 0.85.
    #[serde(default)]
    pub min_similarity: f64,
}

impl FaqConfig {
    pub fn default() -> Self {
        FaqConfig {
            embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
            ranking: ranking_default(),
            top_k: 3,
            min_similarity: DEFAULT_SIMILARITY_THRESHOLD,
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
        if self.min_similarity <= 0.0 || self.min_similarity > 1.0 {
            self.min_similarity = DEFAULT_SIMILARITY_THRESHOLD;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<u64>,
    /// Model that produced the answer (switchyard routing etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider/backend the answer came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
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
    /// Last failed indexing attempt, e.g. the embedding provider rejecting the
    /// model. Surfaces in the .faq panel so failures are never silent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// A category holding learned question → answer pairs. `is_auto` marks clusters
/// the application creates automatically from the "Top K" config.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaqCategory {
    pub id: u64,
    pub name: String,
    pub is_auto: bool,
    pub needs_name: bool,
    pub size: u64,
    pub entries: Vec<FaqEntry>,
}

/// The full knowledge-base layout: categories plus entries not in any category.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaqCategoryList {
    pub categories: Vec<FaqCategory>,
    pub uncategorized: Vec<FaqEntry>,
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

/// Create the text + metadata tables (idempotent) and migrate existing
/// databases (add category/model/backend columns) before building the index
/// that references them.
fn ensure_text_schema(conn: &Connection) -> Result<(), String> {
    // 1) Create the newest table shapes (no-ops on pre-existing databases).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS faq_meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS faq_categories (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           name       TEXT NOT NULL UNIQUE,
           is_auto    INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS faq_entries (
           id          INTEGER PRIMARY KEY AUTOINCREMENT,
           question    TEXT NOT NULL UNIQUE,
           answer      TEXT NOT NULL DEFAULT '',
           frequency   INTEGER NOT NULL DEFAULT 1,
           last_asked  INTEGER NOT NULL DEFAULT 0,
           created_at  INTEGER NOT NULL DEFAULT 0,
           updated_at  INTEGER NOT NULL DEFAULT 0,
           category_id INTEGER REFERENCES faq_categories(id) ON DELETE SET NULL,
           model       TEXT,
           backend     TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_faq_entries_frequency
           ON faq_entries (frequency DESC, last_asked DESC);",
    )
    .map_err(|e| format!("Failed to create FAQ schema: {}", e))?;

    // 2) Migrate OLD databases that predate a column. Existing tables don't get
    //    the column from CREATE TABLE IF NOT EXISTS, so add it explicitly.
    //    "duplicate column name" simply means the column already exists.
    for (column, ddl) in [
        ("category_id", "INTEGER REFERENCES faq_categories(id)"),
        ("model", "TEXT"),
        ("backend", "TEXT"),
        ("category_manual", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if let Err(e) = conn.execute(
            &format!("ALTER TABLE faq_entries ADD COLUMN {} {}", column, ddl),
            rusqlite::params!(),
        ) {
            if !format!("{}", e).contains("duplicate column") {
                return Err(format!("Failed to migrate FAQ schema: {}", e));
            }
        }
    }

    // 3) Indexes that depend on the migrated column — created only now.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_faq_entries_category
           ON faq_entries (category_id);",
    )
    .map_err(|e| format!("Failed to create FAQ schema: {}", e))?;
    Ok(())
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
        category_id: None,
        model: None,
        backend: None,
        similarity: None,
        score: None,
    }
}

const ENTRY_SELECT: &str =
    "SELECT id, question, answer, frequency, last_asked, updated_at, category_id, model, backend FROM faq_entries";

/// Full row mapper including the nullable category/model/backend columns.
fn row_to_entry_full(row: &rusqlite::Row) -> FaqEntry {
    let mut entry = row_to_entry(row);
    entry.category_id = row
        .get::<usize, Option<i64>>(6)
        .ok()
        .and_then(|v| v.map(|c| c as u64));
    entry.model = row.get::<usize, Option<String>>(7).ok().and_then(|v| v);
    entry.backend = row.get::<usize, Option<String>>(8).ok().and_then(|v| v);
    entry
}

fn entry_by_id(conn: &Connection, id: u64) -> Result<FaqEntry, String> {
    conn.query_row(
        &format!("{} WHERE id = ?", ENTRY_SELECT),
        rusqlite::params!(id as i64),
        |row| Ok(row_to_entry_full(row)),
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
            Ok(Some(row)) => out.push(row_to_entry_full(row)),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ entries: {}", e)),
        }
    }
    Ok(out)
}

/// Insert or update the plain-text Q→A row (frequency bumps on re-ask).
/// `model`/`backend` record which provider produced the answer (empty = N/A).
/// The vector index is optional — learning is never lost when embedding is
/// temporarily unavailable.
fn insert_text_entry(
    conn: &Connection,
    question: &str,
    answer: &str,
    model: &str,
    backend: &str,
) -> Result<FaqEntry, String> {
    ensure_text_schema(conn)?;
    let now = now_secs();
    let model_opt: Option<String> = if model.trim().is_empty() {
        None
    } else {
        Some(model.trim().to_string())
    };
    let backend_opt: Option<String> = if backend.trim().is_empty() {
        None
    } else {
        Some(backend.trim().to_string())
    };

    conn.execute(
        "INSERT INTO faq_entries (question, answer, frequency, last_asked, created_at, updated_at, model, backend)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(question) DO UPDATE SET
           answer       = excluded.answer,
           frequency    = faq_entries.frequency + 1,
           last_asked   = excluded.last_asked,
           updated_at   = excluded.updated_at,
           category_id  = faq_entries.category_id,
           model        = excluded.model,
           backend      = excluded.backend",
        rusqlite::params!(&question, &answer, now as i64, now as i64, now as i64, &model_opt, &backend_opt),
    )
    .map_err(|e| format!("Failed to upsert FAQ entry: {}", e))?;

    let id = conn
        .query_row(
            "SELECT id FROM faq_entries WHERE question = ?",
            rusqlite::params!(&question),
            |row| Ok(row.get_unwrap::<usize, i64>(0)),
        )
        .map_err(|e| format!("Failed to read FAQ entry id: {}", e))?;
    entry_by_id(conn, id as u64)
}

/// Index an entry's embedding into the vec0 table (replacing any old vector).
fn index_vector(
    conn: &Connection,
    id: u64,
    embedding: &Vec<f64>,
    model: &str,
) -> Result<(), String> {
    ensure_vec_schema(conn, embedding)?;
    if !model.trim().is_empty() {
        meta_set(conn, META_MODEL_KEY, model.to_string())
            .map_err(|e| format!("Failed to write FAQ meta: {}", e))?;
    }
    let vec_json = vec_to_json(embedding)?;
    let _ = conn
        .execute_batch(&format!("DELETE FROM faq_vec WHERE rowid = {}", id))
        .map_err(|e| format!("Failed to replace FAQ vector: {}", e))?;
    conn.execute(
        "INSERT INTO faq_vec (rowid, embedding) VALUES (?, ?)",
        rusqlite::params!(id as i64, &vec_json),
    )
    .map_err(|e| format!("Failed to index FAQ vector: {}", e))
    .map(|_| ())
}

/// Persist (or update) a question → answer pair given an already-computed
/// embedding. Frequencies increment when the same question is asked again.
fn upsert_embedded(
    conn: &Connection,
    question: &str,
    answer: &str,
    embedding: &Vec<f64>,
    model: &str,
    backend: &str,
) -> Result<FaqEntry, String> {
    let entry = insert_text_entry(conn, question, answer, model, backend)?;
    index_vector(conn, entry.id, embedding, model)?;
    Ok(entry)
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
// Clustering (group historically-asked questions in the .faq UI)
// ---------------------------------------------------------------------------

/// Minimum cosine similarity for a question to join an existing auto-category.
/// Questions more than this similar (to the category's most-asked
/// representative) are grouped together; below it, a new category is spawned.
/// Exposed to the user in the Chat Model panel (Learning mode).
pub const DEFAULT_SIMILARITY_THRESHOLD: f64 = 0.85;

/// Cosine similarity over stored (unnormalized) vectors — the same metric
/// vec0 uses behind `distance_metric=cosine`.
fn cosine_sim(a: &Vec<f64>, b: &Vec<f64>) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        let x = a[i];
        let y = b[i];
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Load every stored vector (rowid → embedding) via sqlite-vec's `vec_to_json`
/// helper. Entries embedded before a model/dimension change may be missing; a
/// store that never vectorized anything simply yields an empty map.
fn load_all_vectors(conn: &Connection) -> Result<HashMap<u64, Vec<f64>>, String> {
    let mut stmt = match conn.prepare("SELECT rowid, vec_to_json(embedding) FROM faq_vec") {
        Ok(stmt) => stmt,
        Err(e) if format!("{}", e).contains("no such table") => return Ok(HashMap::new()),
        Err(e) => return Err(format!("Failed to prepare FAQ vector load: {}", e)),
    };
    let mut out: HashMap<u64, Vec<f64>> = HashMap::new();
    let mut iter = stmt
        .query(rusqlite::params!())
        .map_err(|e| format!("Failed to run FAQ vector load: {}", e))?;
    loop {
        match iter.next() {
            Ok(Some(row)) => {
                let id = row.get_unwrap::<usize, i64>(0) as u64;
                let json = row.get_unwrap::<usize, String>(1);
                if let Ok(embedding) = serde_json::from_str::<Vec<f64>>(&json) {
                    out.insert(id, embedding);
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ vectors: {}", e)),
        }
    }
    Ok(out)
}

/// Greedy leader clustering: `entries` (already frequency-sorted so the most
/// asked question leads a group) is split into clusters of at most `top_k`
/// members that are cosine-similar (≥ `min_similarity`) to their group
/// representative. Returns groups of entry ids, leader first.
fn cluster_ids(
    entries: &Vec<FaqEntry>,
    vectors: &HashMap<u64, Vec<f64>>,
    top_k: u32,
    min_similarity: f64,
) -> Vec<Vec<u64>> {
    let mut group_idx: Vec<Vec<u64>> = Vec::new();
    let mut group_repr: Vec<Vec<f64>> = Vec::new();
    for i in 0..entries.len() {
        let Some(entry) = entries.get(i) else {
            break;
        };
        if !vectors.contains_key(&entry.id) {
            // Not vectorized (embedding was unavailable) — its own group.
            group_idx.push(vec![entry.id]);
            group_repr.push(Vec::new());
            continue;
        }
        let v = vectors.get(&entry.id).unwrap();
        let mut best_group: usize = group_idx.len();
        let mut best_sim: f64 = min_similarity;
        for g in 0..group_idx.len() {
            if group_idx[g].len() >= top_k as usize {
                continue; // group is full
            }
            if group_repr[g].is_empty() {
                continue; // leader has no vector
            }
            let sim = cosine_sim(v, &group_repr[g]);
            if sim >= best_sim {
                best_sim = sim;
                best_group = g;
            }
        }
        if best_group < group_idx.len() {
            group_idx[best_group].push(entry.id);
        } else {
            group_idx.push(vec![entry.id]);
            group_repr.push(v.clone());
        }
    }
    group_idx
}

/// Condense a question into a category label (short, single line).
fn truncate_label(text: &str) -> String {
    let mut out = text.trim().split_whitespace()
        .collect::<Vec<&str>>().join(" ");
    if out.chars().count() > 90 {
        out = out.chars().take(90).collect();
        out.push('…');
    }
    out
}

fn is_placeholder_category(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower == "topic" { return true; }
    lower.strip_prefix("topic ").and_then(|tail| tail.split_whitespace().next())
        .map(|word| word.parse::<u64>().is_ok() || matches!(word, "one" | "two" | "three" | "four" | "five" | "six" | "seven" | "eight" | "nine" | "ten"))
        .unwrap_or(false)
}

fn category_row(conn: &Connection, id: u64) -> Result<(u64, String, bool), String> {
    conn.query_row(
        "SELECT id, name, is_auto FROM faq_categories WHERE id = ?",
        rusqlite::params!(id as i64),
        |row| Ok((
            row.get_unwrap::<usize, i64>(0) as u64,
            row.get_unwrap::<usize, String>(1),
            row.get_unwrap::<usize, i64>(2) != 0,
        )),
    )
    .map_err(|e| format!("Failed to read FAQ category: {}", e))
}

fn load_categories(conn: &Connection) -> Result<Vec<(u64, String, bool)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, is_auto FROM faq_categories ORDER BY name")
        .map_err(|e| format!("Failed to prepare FAQ category query: {}", e))?;
    let mut iter = stmt
        .query(rusqlite::params!())
        .map_err(|e| format!("Failed to run FAQ category query: {}", e))?;
    let mut out: Vec<(u64, String, bool)> = Vec::new();
    loop {
        match iter.next() {
            Ok(Some(row)) => out.push((
                row.get_unwrap::<usize, i64>(0) as u64,
                row.get_unwrap::<usize, String>(1),
                row.get_unwrap::<usize, i64>(2) != 0,
            )),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ categories: {}", e)),
        }
    }
    Ok(out)
}

/// Create a distinct pending category; a name collision must not merge clusters.
fn create_auto_category(conn: &Connection, label: &str) -> Result<u64, String> {
    let mut name = label.to_string();
    let mut suffix = 2;
    while conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM faq_categories WHERE name = ?)",
        [&name], |row| row.get::<_, bool>(0),
    ).map_err(|e| e.to_string())? {
        name = format!("{} ({})", label, suffix);
        suffix += 1;
    }
    conn.execute(
        "INSERT INTO faq_categories (name, is_auto, created_at) VALUES (?, 1, ?)",
        rusqlite::params!(&name, now_secs() as i64),
    ).map_err(|e| format!("Failed to create FAQ category: {}", e))?;
    Ok(conn.last_insert_rowid() as u64)
}

fn entries_in_category(conn: &Connection, category_id: u64) -> Result<Vec<FaqEntry>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{} WHERE category_id = ? ORDER BY frequency DESC, last_asked DESC",
            ENTRY_SELECT
        ))
        .map_err(|e| format!("Failed to prepare FAQ category entries query: {}", e))?;
    let mut iter = stmt
        .query(rusqlite::params!(category_id as i64))
        .map_err(|e| format!("Failed to run FAQ category entries query: {}", e))?;
    let mut out: Vec<FaqEntry> = Vec::new();
    loop {
        match iter.next() {
            Ok(Some(row)) => out.push(row_to_entry_full(row)),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ category entries: {}", e)),
        }
    }
    Ok(out)
}

fn entries_without_category(conn: &Connection) -> Result<Vec<FaqEntry>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{} WHERE category_id IS NULL ORDER BY frequency DESC, last_asked DESC",
            ENTRY_SELECT
        ))
        .map_err(|e| format!("Failed to prepare FAQ uncategorized query: {}", e))?;
    let mut iter = stmt
        .query(rusqlite::params!())
        .map_err(|e| format!("Failed to run FAQ uncategorized query: {}", e))?;
    let mut out: Vec<FaqEntry> = Vec::new();
    loop {
        match iter.next() {
            Ok(Some(row)) => out.push(row_to_entry_full(row)),
            Ok(None) => break,
            Err(e) => return Err(format!("Failed to iterate FAQ uncategorized: {}", e)),
        }
    }
    Ok(out)
}

/// Full list of categories + uncategorized entries. Auto-categories are
/// reconciled COOPERATIVELY on every read: uncategorized entries are clustered
/// into groups of at most `top_k` similar questions (the "Top K" config),
/// grouped only when their cosine similarity to the group's representative is
/// at least `min_similarity` (default 0.85 — user-configurable). Each group
/// becomes an auto-category labeled with its most-asked question; the chat
/// model's naming pass (needs_name) may later refine that label. Entries the
/// user placed in ANY category are never re-clustered — they are treated as
/// curated and stay put. Empty auto-categories are pruned.
pub fn list_categories(
    root_path: String,
    mut top_k: u32,
    mut min_similarity: f64,
) -> Result<FaqCategoryList, String> {
    if top_k == 0 || top_k > 50 {
        top_k = 3;
    }
    if min_similarity <= 0.0 || min_similarity > 1.0 {
        min_similarity = DEFAULT_SIMILARITY_THRESHOLD;
    }
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    // Keep names stable across reconciliation and never release user assignments.
    let previous = top_by_frequency(&conn, 1000)?;
    conn.execute(
        "UPDATE faq_entries SET category_id = NULL WHERE category_manual = 0 AND category_id IN
         (SELECT id FROM faq_categories WHERE is_auto = 1)", [],
    ).map_err(|e| e.to_string())?;
    let mut used_categories = std::collections::HashSet::new();
    let entries = top_by_frequency(&conn, 1000)?;
    let vectors = load_all_vectors(&conn)?;

    let mut uncategorized: Vec<FaqEntry> = Vec::new();
    for entry in entries.iter() {
        let curated: bool = conn.query_row("SELECT category_manual FROM faq_entries WHERE id = ?", [entry.id as i64], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? != 0;
        if entry.category_id.is_none() && !curated {
            uncategorized.push(entry.clone());
        }
    }
    // Match new questions against curated categories as well as automatic groups.
    // A user's explicit Unassigned choice remains excluded above.
    let mut remaining = Vec::new();
    for entry in uncategorized {
        let matched = vectors.get(&entry.id).and_then(|v| {
            entries.iter().filter(|e| e.category_id.is_some()).filter_map(|e| {
                vectors.get(&e.id).map(|other| (e.category_id.unwrap(), cosine_sim(v, other)))
            }).filter(|(_, similarity)| *similarity >= min_similarity)
              .max_by(|a, b| a.1.total_cmp(&b.1))
        });
        if let Some((category_id, _)) = matched {
            conn.execute("UPDATE faq_entries SET category_id = ? WHERE id = ?",
                rusqlite::params!(category_id as i64, entry.id as i64)).map_err(|e| e.to_string())?;
        } else { remaining.push(entry); }
    }
    let uncategorized = remaining;
    let clusters = cluster_ids(&uncategorized, &vectors, top_k, min_similarity);
    for cluster in clusters.iter() {
        if cluster.is_empty() {
            continue;
        }
        let Some(leader) = uncategorized.iter().find(|e| e.id == cluster[0]) else {
            continue;
        };
        let prior = previous.iter().find(|e| e.id == leader.id).and_then(|e| e.category_id)
            .filter(|id| !used_categories.contains(id));
        let auto_id = if let Some(id) = prior {
            id
        } else {
            // Immediate, deterministic label: the group's most-asked question.
            // Never a "Topic N" placeholder — the UI must always show a real
            // name; the chat-model naming pass only refines it.
            create_auto_category(&conn, &truncate_label(&leader.question))?
        };
        used_categories.insert(auto_id);
        for id in cluster.iter() {
            let _ = conn
                .execute(
                    "UPDATE faq_entries SET category_id = ? WHERE id = ? AND category_id IS NULL",
                    rusqlite::params!(auto_id as i64, *id as i64),
                )
                .map_err(|e| format!("Failed to assign FAQ category: {}", e))?;
        }
    }
    // Prune auto-categories left with no members.
    let _ = conn
        .execute(
            "DELETE FROM faq_categories WHERE is_auto = 1 AND id NOT IN
               (SELECT DISTINCT category_id FROM faq_entries WHERE category_id IS NOT NULL)",
            rusqlite::params!(),
        )
        .map_err(|e| format!("Failed to prune FAQ categories: {}", e))?;

    let mut categories: Vec<FaqCategory> = Vec::new();
    for (id, name, is_auto) in load_categories(&conn)? {
        let mut member_entries = entries_in_category(&conn, id)?;
        // Auto categories report each member's similarity to the label.
        if is_auto && !member_entries.is_empty() {
            if let Some(lv) = vectors.get(&member_entries[0].id) {
                for i in 1..member_entries.len() {
                    if let Some(v) = vectors.get(&member_entries[i].id) {
                        member_entries[i].similarity = Some(cosine_sim(v, lv));
                    }
                }
            }
        }
        categories.push(FaqCategory {
            id,
            needs_name: is_auto && (is_placeholder_category(&name) || meta_get(&conn, &format!("category_named_{}", id))?.is_none()),
            name,
            is_auto,
            size: member_entries.len() as u64,
            entries: member_entries,
        });
    }
    let uncategorized = entries_without_category(&conn)?;
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(FaqCategoryList { categories, uncategorized })
}

/// Create a manual category.
pub fn create_category(root_path: String, name: String) -> Result<FaqCategory, String> {
    let normalized = name.trim().to_string();
    if normalized.is_empty() {
        return Err("Category name cannot be empty".into());
    }
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    conn.execute(
        "INSERT INTO faq_categories (name, is_auto, created_at) VALUES (?, 0, ?)",
        rusqlite::params!(&normalized, now_secs() as i64),
    )
    .map_err(|e| format!("Failed to create FAQ category: {}", e))?;
    let (id, name, is_auto) = conn
        .query_row(
            "SELECT id, name, is_auto FROM faq_categories WHERE name = ?",
            rusqlite::params!(&normalized),
            |row| Ok((
                row.get_unwrap::<usize, i64>(0) as u64,
                row.get_unwrap::<usize, String>(1),
                row.get_unwrap::<usize, i64>(2) != 0,
            )),
        )
        .map_err(|e| format!("Failed to read FAQ category: {}", e))?;
    Ok(FaqCategory {
        id,
        name,
        is_auto,
        needs_name: false,
        size: 0,
        entries: Vec::new(),
    })
}

/// Rename any category and mark it as curated so its label and members persist.
pub fn rename_category(root_path: String, id: u64, name: String) -> Result<(), String> {
    let normalized = name.trim().to_string();
    if normalized.is_empty() {
        return Err("Category name cannot be empty".into());
    }
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let rows = conn
        .execute(
            "UPDATE faq_categories SET name = ?, is_auto = 0 WHERE id = ?",
            rusqlite::params!(&normalized, id as i64),
        )
        .map_err(|e| format!("Failed to rename FAQ category: {}", e))?;
    if rows == 0 {
        return Err("Category not found".into());
    }
    Ok(())
}

/// Save a model-generated label only while the category still needs one.
/// A concurrent manual rename always wins.
pub fn name_auto_category(root_path: String, id: u64, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("Expected a category name of 1–60 characters".into());
    }
    let mut conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (_, current_name, is_auto) = category_row(&tx, id)?;
    if !is_auto || (meta_get(&tx, &format!("category_named_{}", id))?.is_some() && !is_placeholder_category(&current_name)) { return Ok(()); }
    let mut unique = name.to_string();
    let mut suffix = 2;
    while tx.query_row("SELECT EXISTS(SELECT 1 FROM faq_categories WHERE name = ? AND id != ?)",
        rusqlite::params!(&unique, id as i64), |r| r.get::<_, bool>(0)).map_err(|e| e.to_string())? {
        unique = format!("{} ({})", name.chars().take(50).collect::<String>(), suffix);
        suffix += 1;
    }
    let changed = tx.execute("UPDATE faq_categories SET name = ? WHERE id = ? AND is_auto = 1",
        rusqlite::params!(&unique, id as i64)).map_err(|e| e.to_string())?;
    if changed > 0 { meta_set(&tx, &format!("category_named_{}", id), "true".into())?; }
    tx.commit().map_err(|e| e.to_string())
}

/// Delete a category; its entries move back to Unassigned (never lost).
pub fn delete_category(root_path: String, id: u64) -> Result<(), String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let _ = conn
        .execute(
            "UPDATE faq_entries SET category_id = NULL, category_manual = 1 WHERE category_id = ?",
            rusqlite::params!(id as i64),
        )
        .map_err(|e| format!("Failed to unassign FAQ entries: {}", e))?;
    let _ = conn
        .execute(
            "DELETE FROM faq_categories WHERE id = ?",
            rusqlite::params!(id as i64),
        )
        .map_err(|e| format!("Failed to delete FAQ category: {}", e))?;
    Ok(())
}

/// Move an entry to a category (`None` = Unassigned).
pub fn set_entry_category(
    root_path: String,
    entry_id: u64,
    category_id: Option<u64>,
) -> Result<(), String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    if let Some(cid) = category_id {
        category_row(&conn, cid)?; // validates existence
    }
    let rows = conn
        .execute(
            "UPDATE faq_entries SET category_id = ?, category_manual = 1, updated_at = ? WHERE id = ?",
            rusqlite::params!(category_id.map(|c| c as i64), now_secs() as i64, entry_id as i64),
        )
        .map_err(|e| format!("Failed to move FAQ entry: {}", e))?;
    if rows == 0 {
        return Err("FAQ entry not found".into());
    }
    Ok(())
}

/// Edit a question/answer pair (and optionally its category), re-embedding the
/// question so semantic search + auto-categories stay in sync. A failed embed
/// is recorded in `last_error` but the edit is never lost.
pub async fn update_entry(
    root_path: String,
    backend: String,
    url: String,
    api_key: String,
    id: u64,
    question: String,
    answer: String,
    category_id: Option<u64>,
    model: String,
    mut config: FaqConfig,
) -> Result<FaqEntry, String> {
    config.normalize();
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".into());
    }
    let model_opt: Option<String> = if model.trim().is_empty() {
        None
    } else {
        Some(model.trim().to_string())
    };
    let backend_opt: Option<String> = if backend.trim().is_empty() {
        None
    } else {
        Some(backend.trim().to_string())
    };
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    if let Some(cid) = category_id {
        category_row(&conn, cid)?;
    }
    let rows = conn
        .execute(
            "UPDATE faq_entries SET question = ?1, answer = ?2, category_manual = CASE WHEN category_id IS NOT ?3 THEN 1 ELSE category_manual END, category_id = ?3, model = ?4, backend = ?5, updated_at = ?6 WHERE id = ?7",
            rusqlite::params!(&q, &answer, category_id.map(|c| c as i64), &model_opt, &backend_opt, now_secs() as i64, id as i64),
        )
        .map_err(|e| format!("Failed to update FAQ entry: {}", e))?;
    if rows == 0 {
        return Err("FAQ entry not found".into());
    }
    let client = reqwest::Client::new();
    match embed_text(&client, &backend, &url, &api_key, &config.embedding_model, &q).await {
        Ok(embedding) => {
            index_vector(&conn, id, &embedding, &config.embedding_model)
                .map_err(|e| format!("Failed to re-index FAQ entry: {}", e))?;
            let _ = meta_set(&conn, META_LAST_ERROR_KEY, "".to_string());
        }
        Err(e) => {
            let _ = meta_set(&conn, META_LAST_ERROR_KEY, e.to_string());
        }
    }
    entry_by_id(&conn, id)
}

/// Delete a question/answer pair by id (removes its vector too).
pub fn delete_entry(root_path: String, id: u64) -> Result<(), String> {
    let conn = open_db(&root_path)?;
    ensure_text_schema(&conn)?;
    let _ = conn
        .execute_batch(&format!("DELETE FROM faq_vec WHERE rowid = {}", id))
        .map_err(|e| format!("Failed to delete FAQ vector: {}", e))?;
    let rows = conn
        .execute(
            "DELETE FROM faq_entries WHERE id = ?",
            rusqlite::params!(id as i64),
        )
        .map_err(|e| format!("Failed to delete FAQ entry: {}", e))?;
    if rows == 0 {
        return Err("FAQ entry not found".into());
    }
    Ok(())
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
/// The plain Q→A record is ALWAYS kept (learning is never lost); when the
/// embedding provider fails we persist the text entry anyway and record the
/// error in `last_error` so the .faq UI can surface it.
pub async fn upsert(
    root_path: String,
    backend: String,
    url: String,
    api_key: String,
    question: String,
    answer: String,
    model: String,
    mut config: FaqConfig,
) -> Result<FaqEntry, String> {
    config.normalize();
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("Question cannot be empty".into());
    }
    let conn = open_db(&root_path)?;
    let client = reqwest::Client::new();
    match embed_text(
        &client,
        &backend,
        &url,
        &api_key,
        &config.embedding_model,
        &q,
    )
    .await {
        Ok(embedding) => {
            let entry = upsert_embedded(&conn, &q, &answer, &embedding, &model, &backend)
                .map_err(|e| e.to_string())?;
            let _ = meta_set(&conn, META_LAST_ERROR_KEY, "".to_string());
            Ok(entry)
        }
        Err(e) => {
            let entry = insert_text_entry(&conn, &q, &answer, &model, &backend)
                .map_err(|e| e.to_string())?;
            let _ = meta_set(&conn, META_LAST_ERROR_KEY, e.to_string());
            Ok(entry)
        }
    }
}

/// Record a learned exchange when an embedding is already available (used by
/// callers/tests that have computed the vector themselves). No model/backend
/// provenance is recorded here.
pub fn upsert_with_embedding(
    root_path: String,
    question: String,
    answer: String,
    embedding: Vec<f64>,
) -> Result<FaqEntry, String> {
    let conn = open_db(&root_path)?;
    upsert_embedded(&conn, &question, &answer, &embedding, "", "")
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
    let last_error = meta_get(&conn, META_LAST_ERROR_KEY)
        .map_err(|e| format!("Failed to read FAQ meta: {}", e))?
        .filter(|value| !value.is_empty());
    Ok(FaqStats {
        count: count_entries(&conn),
        dimension: dim,
        model,
        last_error,
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

    #[test]
    fn auto_categories_are_created_from_topk_clusters() {
        let root = test_root("autocat");
        let _ = std::fs::remove_dir_all(&root);
        upsert_with_embedding(root.clone(), "How does the agent loop stop?".into(), A1.into(), vec![1.0, 0.0, 0.0, 0.0]).unwrap();
        upsert_with_embedding(root.clone(), "When does the agent loop stop?".into(), A1.into(), vec![0.95, 0.3, 0.0, 0.0]).unwrap();
        upsert_with_embedding(root.clone(), "What makes the loop finish?".into(), A1.into(), vec![0.9, 0.4, 0.0, 0.0]).unwrap();
        upsert_with_embedding(root.clone(), "Why cap output tokens?".into(), A2.into(), vec![0.0, 1.0, 0.0, 0.0]).unwrap();

        // top_k = 3 → the three near-identical questions share one auto
        // category; the unrelated one gets its own; nothing stays uncategorized.
        let list3 = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert_eq!(list3.categories.len(), 2);
        assert!(list3.categories.iter().all(|c| c.is_auto));
        let group = list3.categories.iter().find(|c| c.size == 3).unwrap();
        assert_eq!(group.entries.len(), 3);
        assert_eq!(group.entries[0].question.as_str(), "How does the agent loop stop?");
        // Non-leader members carry their similarity to the group label.
        assert!(group.entries[1].similarity.unwrap() >= 0.9);
        assert!(group.entries[2].similarity.unwrap() >= 0.9);
        assert_eq!(list3.uncategorized.len(), 0);

        // top_k = 2 → the third similar question overflows into its own auto
        // category.
        let list2 = list_categories(root.clone(), 2, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert_eq!(list2.categories.len(), 3);

        // re-reading is idempotent — no endless reshuffling of curated entries.
        let again = list_categories(root.clone(), 2, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert_eq!(again.categories.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manual_category_crud_and_movement() {
        let root = test_root("catcrud");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);

        let cat = create_category(root.clone(), "Concepts".into()).unwrap();
        assert_eq!(cat.name.as_str(), "Concepts");
        assert_eq!(cat.is_auto, false);

        // Move Q1 into the manual category.
        let entries = list(root.clone()).unwrap();
        let Some(q1) = entries.iter().find(|e| e.question.as_str() == Q1).cloned() else {
            panic!("Q1 should exist");
        };
        set_entry_category(root.clone(), q1.id, Some(cat.id)).unwrap();
        let list = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        let concepts = list.categories.iter().find(|c| c.name.as_str() == "Concepts").unwrap();
        assert_eq!(concepts.size, 1);
        assert_eq!(concepts.entries[0].question.as_str(), Q1);
        // The remaining entry is still auto-categorized (not lost).
        assert!(list.categories.iter().any(|c| c.is_auto && c.size == 1));

        // Rename + delete category → no trace remains; the entry is either
        // uncategorized again or re-swept into an auto category by the Top K
        // reconciliation (automatic re-categorization is by design).
        rename_category(root.clone(), cat.id, "General".into()).unwrap();
        let renamed = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert!(renamed.categories.iter().any(|c| c.name.as_str() == "General"));
        delete_category(root.clone(), cat.id).unwrap();
        let after = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert!(!after.categories.iter().any(|c| c.name.as_str() == "General"));
        let q1_again = after
            .categories
            .iter()
            .flat_map(|c| c.entries.iter())
            .any(|e| e.question.as_str() == Q1)
            || after.uncategorized.iter().any(|e| e.question.as_str() == Q1);
        assert!(q1_again);

        // Moving an entry to a missing category must fail.
        let Err(_) = set_entry_category(root.clone(), q1.id, Some(9_999_999)) else {
            panic!("moving to a missing category should fail");
        };
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_entry_by_id_removes_pair_and_vector() {
        let root = test_root("entrydel");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        let entries = list(root.clone()).unwrap();
        let Some(q1) = entries.iter().find(|e| e.question.as_str() == Q1).cloned() else {
            panic!("Q1 should exist");
        };
        delete_entry(root.clone(), q1.id).unwrap();
        assert_eq!(list(root.clone()).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

#[test]
    fn answers_record_the_model_that_produced_them() {
        let root = test_root("model");
        let _ = std::fs::remove_dir_all(&root);
        upsert_with_embedding(root.clone(), Q1.into(), A1.into(), vec![1.0, 0.0, 0.0, 0.0]).unwrap();

        // Direct write carries provenance when the caller supplies it.
        let conn = open_db(&root).unwrap();
        upsert_embedded(&conn, Q2, A2, &vec![0.0, 1.0, 0.0, 0.0], "qwen3:8b", "ollama").unwrap();
        let listed = list(root.clone()).unwrap();
        let q2 = listed.iter().find(|e| e.question.as_str() == Q2).unwrap();
        assert_eq!(q2.model.as_ref().map(|s| s.as_str()), Some("qwen3:8b"));
        assert_eq!(q2.backend.as_ref().map(|s| s.as_str()), Some("ollama"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn similarity_threshold_controls_auto_category_merging() {
        let root = test_root("threshold");
        let _ = std::fs::remove_dir_all(&root);
        let _a = upsert_with_embedding(root.clone(), "A".into(), A1.into(), vec![1.0, 0.0, 0.0, 0.0]).unwrap();
        let b = upsert_with_embedding(root.clone(), "B".into(), A1.into(), vec![0.9, 0.4, 0.0, 0.0]).unwrap();
        // cosine(a, b) ≈ 0.914.

        // Threshold 0.85 → both questions share one auto-category.
        let loose = list_categories(root.clone(), 3, 0.85).unwrap();
        assert_eq!(loose.categories.len(), 1, "0.85 threshold merges 0.914-similar questions");
        assert_eq!(loose.categories[0].size, 2);

        // Threshold 0.95 → similarity is below it, so each gets its own category.
        let strict = list_categories(root.clone(), 3, 0.95).unwrap();
        assert_eq!(strict.categories.len(), 2, "0.95 threshold splits 0.914-similar questions");

        // Moving a question to a manual category still freezes it out of
        // auto-clustering regardless of the threshold.
        set_entry_category(root.clone(), b.id, Some(loose.categories[0].id)).unwrap();
        let frozen = list_categories(root.clone(), 3, 0.95).unwrap();
        assert_eq!(frozen.categories.iter().flat_map(|c| &c.entries).find(|e| e.id == b.id).unwrap().category_id, Some(loose.categories[0].id));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrates_a_legacy_database_without_category_columns() {
        // Regression: an existing DB created before categories existed has no
        // category_id/model/backend columns. Opening the Knowledge Base must
        // migrate it in place instead of failing on the category index.
        let root = test_root("legacy");
        let _ = std::fs::remove_dir_all(&root);
        let conn = open_db(&root).unwrap();
        conn.execute_batch(
            "CREATE TABLE faq_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO faq_meta (key, value) VALUES ('embedding_dim', '4');
             CREATE TABLE faq_entries (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               question   TEXT NOT NULL UNIQUE,
               answer     TEXT NOT NULL DEFAULT '',
               frequency  INTEGER NOT NULL DEFAULT 1,
               last_asked INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO faq_entries (question, answer, frequency) VALUES ('legacy question?', 'legacy answer.', 1);",
        )
        .unwrap();
        drop(conn);

        let listed = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert_eq!(listed.categories.len(), 1, "legacy row must be auto-categorized after migration");
        assert_eq!(listed.categories[0].entries.len(), 1);
        assert_eq!(listed.categories[0].entries[0].question.as_str(), "legacy question?");
        // Columns were actually added and are usable.
        assert_eq!(listed.categories[0].entries[0].category_id, Some(listed.categories[0].id));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn first_question_creates_a_category_visible_in_the_ui() {
        // Exactly what happens after the very first exchange: one uncategorized
        // entry. Opening the Knowledge Base must surface it as an auto-category.
        let root = test_root("first");
        let _ = std::fs::remove_dir_all(&root);
        upsert_with_embedding(
            root.clone(),
            "How does the tool loop stop?".into(),
            A1.into(),
            vec![1.0, 0.0, 0.0, 0.0],
        )
        .unwrap();
        let list = list_categories(root.clone(), 3, DEFAULT_SIMILARITY_THRESHOLD).unwrap();
        assert_eq!(list.categories.len(), 1);
        assert_eq!(list.categories[0].size, 1);
        assert_eq!(list.categories[0].is_auto, true);
        // The category is labeled immediately with its most-asked question —
        // never a "Topic N"/"Awaiting category name" placeholder.
        assert_eq!(list.categories[0].name, "How does the tool loop stop?");
        assert_eq!(list.categories[0].entries.len(), 1);
        assert_eq!(list.categories[0].entries[0].question.as_str(), "How does the tool loop stop?");
        assert_eq!(list.uncategorized.len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn curated_assignments_and_local_names_survive_refresh() {
        let root = test_root("curated_names");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        let initial = list_categories(root.clone(), 3, 0.85).unwrap();
        let category = &initial.categories[0];
        assert!(category.needs_name);
        name_auto_category(root.clone(), category.id, "Local topic".into()).unwrap();
        let refreshed = list_categories(root.clone(), 3, 0.85).unwrap();
        let named = refreshed.categories.iter().find(|c| c.id == category.id).unwrap();
        assert_eq!(named.name, "Local topic");
        assert!(!named.needs_name);
        let entry = named.entries[0].id;
        set_entry_category(root.clone(), entry, None).unwrap();
        let unassigned = list_categories(root.clone(), 1, 0.99).unwrap();
        assert!(unassigned.uncategorized.iter().any(|e| e.id == entry));
        let target = &unassigned.categories[0];
        set_entry_category(root.clone(), entry, Some(target.id)).unwrap();
        let moved = list_categories(root.clone(), 1, 0.99).unwrap();
        assert!(moved.categories.iter().find(|c| c.id == target.id).unwrap().entries.iter().any(|e| e.id == entry));
        rename_category(root.clone(), target.id, "My category".into()).unwrap();
        name_auto_category(root.clone(), target.id, "Late model result".into()).unwrap();
        let renamed = list_categories(root.clone(), 1, 0.99).unwrap();
        assert!(renamed.categories.iter().any(|c| c.name == "My category" && !c.is_auto));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn new_questions_match_curated_knowledge() {
        let root = test_root("curated_match");
        let _ = std::fs::remove_dir_all(&root);
        let a = upsert_with_embedding(root.clone(), "Password reset".into(), "Answer".into(), vec![1.0, 0.0]).unwrap();
        let category = create_category(root.clone(), "Account access".into()).unwrap();
        set_entry_category(root.clone(), a.id, Some(category.id)).unwrap();
        let b = upsert_with_embedding(root.clone(), "Forgot password".into(), "Answer".into(), vec![1.0, 0.01]).unwrap();
        let result = list_categories(root.clone(), 3, 0.85).unwrap();
        assert_eq!(result.categories.len(), 1);
        assert!(result.categories[0].entries.iter().any(|e| e.id == b.id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn previously_saved_numbered_topics_are_renamed() {
        let root = test_root("placeholder_retry");
        let _ = std::fs::remove_dir_all(&root);
        seed(&root);
        let initial = list_categories(root.clone(), 3, 0.85).unwrap();
        let id = initial.categories[0].id;
        name_auto_category(root.clone(), id, "Topic five".into()).unwrap();
        let pending = list_categories(root.clone(), 3, 0.85).unwrap();
        assert!(pending.categories.iter().find(|c| c.id == id).unwrap().needs_name);
        name_auto_category(root.clone(), id, "Agent execution".into()).unwrap();
        let named = list_categories(root.clone(), 3, 0.85).unwrap();
        let category = named.categories.iter().find(|c| c.id == id).unwrap();
        assert_eq!(category.name, "Agent execution");
        assert!(!category.needs_name);
        let _ = std::fs::remove_dir_all(root);
    }

}