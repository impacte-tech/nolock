//! Explicitly approved exchanges. Drafts stay in the UI; publication is atomic.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub text: String,
    pub summary: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub question: String,
    pub answer: String,
    pub category: String,
    pub chunks: Vec<Chunk>,
    pub model: String,
    pub backend: String,
    pub revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub review: Option<Review>,
    pub categories: Vec<String>,
}
fn key(question: &str, answer: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(question, answer)).unwrap())
    )
}
fn schema(conn: &Connection) -> Result<(), String> {
    ensure_text_schema(conn)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS faq_reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS faq_review_entries (review_id TEXT NOT NULL, entry_id INTEGER NOT NULL);")
        .map_err(|e| e.to_string())
}
/// Preview is read-only, including when no database has been created yet.
pub fn preview(root_path: String, question: String, answer: String) -> Result<Preview, String> {
    let path = faq_db_path(&root_path);
    let mut result = Preview {
        review: None,
        categories: vec![],
    };
    if !path.exists() {
        return Ok(result);
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    for table in ["faq_reviews", "faq_categories"] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        if table == "faq_reviews" {
            use rusqlite::OptionalExtension;
            let data: Option<String> = conn
                .query_row(
                    "SELECT data FROM faq_reviews WHERE id = ?",
                    [key(&question, &answer)],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            result.review = data
                .map(|s| serde_json::from_str(&s))
                .transpose()
                .map_err(|e| e.to_string())?;
        } else {
            let mut statement = conn
                .prepare("SELECT name FROM faq_categories ORDER BY name")
                .map_err(|e| e.to_string())?;
            result.categories = statement
                .query_map([], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}
fn validate(review: &Review) -> Result<(), String> {
    if review.question.trim().is_empty()
        || review.answer.trim().is_empty()
        || review.category.trim().is_empty()
        || review.category.len() > 200
    {
        return Err(
            "A source question, answer and category (up to 200 bytes) are required.".into(),
        );
    }
    if review.chunks.is_empty()
        || review.chunks.len() > 100
        || review
            .chunks
            .iter()
            .any(|c| c.text.trim().is_empty() || c.text.len() + c.summary.len() > 32_000)
        || review.question.len() + review.answer.len() > 1_000_000
    {
        return Err("Use 1–100 nonempty chunks, at most 32 KB each; the original exchange must fit within 1 MB.".into());
    }
    Ok(())
}
fn publish(
    root: &str,
    mut review: Review,
    vectors: Vec<Vec<f64>>,
    embedding_model: &str,
) -> Result<Review, String> {
    validate(&review)?;
    if vectors.len() != review.chunks.len()
        || vectors.iter().any(|v| {
            v.is_empty() || v.len() != vectors[0].len() || v.iter().any(|n| !n.is_finite())
        })
    {
        return Err("Invalid chunk embeddings.".into());
    }
    let mut conn = open_db(root)?;
    schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = key(&review.question, &review.answer);
    use rusqlite::OptionalExtension;
    let previous: Option<String> = tx
        .query_row("SELECT data FROM faq_reviews WHERE id = ?", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let version = previous
        .map(|s| serde_json::from_str::<Review>(&s))
        .transpose()
        .map_err(|e| e.to_string())?
        .map(|r| r.revision)
        .unwrap_or(0);
    if version != review.revision {
        return Err("This review changed elsewhere. Close and reopen it before saving.".into());
    }
    let dim = meta_get(&tx, META_DIM_KEY)?
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    if dim != 0 && dim != vectors[0].len() {
        return Err("Embedding dimensions differ from this knowledge base. Use the existing embedding model; no entries were changed.".into());
    }
    if let Some(current) = meta_get(&tx, "review_embedding_model")? {
        if current != embedding_model {
            return Err("Reviewed entries use a different embedding model. Restore that model before saving.".into());
        }
    }
    // Delete only rows belonging to this exact reviewed exchange; retry replaces them.
    let old: Vec<i64> = {
        let mut q = tx
            .prepare("SELECT entry_id FROM faq_review_entries WHERE review_id = ?")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([&id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    for entry in old {
        tx.execute("DELETE FROM faq_vec WHERE rowid = ?", [entry])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM faq_entries WHERE id = ?", [entry])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM faq_review_entries WHERE review_id = ?", [&id])
        .map_err(|e| e.to_string())?;
    let category = review.category.trim();
    tx.execute(
        "INSERT OR IGNORE INTO faq_categories(name,is_auto,created_at) VALUES (?,0,?)",
        rusqlite::params![category, now_secs() as i64],
    )
    .map_err(|e| e.to_string())?;
    let category_id: i64 = tx
        .query_row(
            "SELECT id FROM faq_categories WHERE name = ?",
            [category],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    for (i, (chunk, vector)) in review.chunks.iter().zip(vectors.iter()).enumerate() {
        let question = format!(
            "{}\n[Reviewed exchange {} · chunk {}]",
            review.question,
            id,
            i + 1
        );
        let answer = if chunk.summary.trim().is_empty() {
            chunk.text.clone()
        } else {
            format!("Summary: {}\n\n{}", chunk.summary, chunk.text)
        };
        let entry = insert_text_entry(&tx, &question, &answer, &review.model, &review.backend)?;
        index_vector(&tx, entry.id, vector, embedding_model)?;
        tx.execute(
            "UPDATE faq_entries SET category_id = ?, category_manual = 1 WHERE id = ?",
            rusqlite::params![category_id, entry.id as i64],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO faq_review_entries VALUES (?,?)",
            rusqlite::params![id, entry.id as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    review.revision = version + 1;
    tx.execute(
        "INSERT OR REPLACE INTO faq_reviews VALUES (?,?)",
        rusqlite::params![
            id,
            serde_json::to_string(&review).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    meta_set(&tx, "review_embedding_model", embedding_model.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(review)
}
pub async fn save(
    root_path: String,
    backend: String,
    url: String,
    api_key: String,
    review: Review,
    mut config: FaqConfig,
) -> Result<Review, String> {
    validate(&review)?;
    config.normalize();
    let client = reqwest::Client::new();
    let mut vectors = Vec::new();
    // No database writes until every approved chunk embeds successfully.
    for chunk in &review.chunks {
        let input = format!(
            "Question: {}\nSummary: {}\nPassage: {}",
            review.question, chunk.summary, chunk.text
        );
        vectors.push(
            embed_text(
                &client,
                &backend,
                &url,
                &api_key,
                &config.embedding_model,
                &input,
            )
            .await?,
        );
    }
    publish(&root_path, review, vectors, &config.embedding_model)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_does_not_create_database_and_publication_is_atomic() {
        let root = std::env::temp_dir().join(format!(
            "nolock-review-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let path = root.to_string_lossy().to_string();
        assert!(preview(path.clone(), "q".into(), "a".into())
            .unwrap()
            .review
            .is_none());
        assert!(!root.exists());
        let draft = Review {
            question: "q".into(),
            answer: "a".into(),
            category: "Approved".into(),
            chunks: vec![Chunk {
                text: "a".into(),
                summary: "summary".into(),
            }],
            model: "answer-model".into(),
            backend: "local".into(),
            revision: 0,
        };
        let saved = publish(&path, draft.clone(), vec![vec![1., 0.]], "embed").unwrap();
        assert_eq!(saved.revision, 1);
        assert!(publish(&path, draft, vec![vec![1., 0.]], "embed").is_err());
        assert!(publish(&path, saved.clone(), vec![vec![1., 0., 0.]], "embed").is_err());
        let conn = open_db(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_review BEFORE INSERT ON faq_entries BEGIN SELECT RAISE(ABORT, 'simulated publication failure'); END;").unwrap();
        assert!(publish(&path, saved.clone(), vec![vec![0., 1.]], "embed").is_err());
        assert_eq!(super::super::list(path.clone()).unwrap().len(), 1);
        assert_eq!(
            preview(path.clone(), "q".into(), "a".into())
                .unwrap()
                .review
                .unwrap()
                .revision,
            1
        );
        conn.execute_batch("DROP TRIGGER reject_review").unwrap();
        drop(conn);
        let updated = publish(&path, saved, vec![vec![0., 1.]], "embed").unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(super::super::list(path.clone()).unwrap().len(), 1);
        assert_eq!(
            preview(path, "q".into(), "a".into())
                .unwrap()
                .review
                .unwrap()
                .answer,
            "a"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
