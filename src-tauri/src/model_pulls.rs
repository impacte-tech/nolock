//! Background model pulls shared by the web server and desktop IPC.
//! llama.cpp downloads are delegated to the store beside its model volume.
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
pub struct PullRequest {
    pub backend: String,
    pub url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PullJob {
    pub id: String,
    pub model: String,
    pub backend: String,
    pub status: String,
    pub message: String,
    pub completed: u64,
    pub total: u64,
    pub created_at: u64,
    pub path: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
}

struct Entry {
    job: PullJob,
    url: String,
    abort: Option<tokio::task::AbortHandle>,
}
type Jobs = Arc<Mutex<HashMap<String, Entry>>>;
static JOBS: OnceLock<Jobs> = OnceLock::new();
fn jobs() -> Jobs {
    JOBS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}
fn active(status: &str) -> bool {
    matches!(status, "queued" | "downloading" | "resolving")
}

fn base_url(value: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(value.trim()).map_err(|_| "Enter a valid provider Server URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an http(s) provider URL without credentials, query, or fragment.".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub fn hf_model(value: &str) -> Result<String, String> {
    let mut value = value.trim();
    for prefix in [
        "https://huggingface.co/",
        "https://hf.co/",
        "huggingface.co/",
        "hf.co/",
    ] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim_end_matches('/');
            break;
        }
    }
    let valid =
        regex::Regex::new(r"^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$").unwrap();
    if value.len() > 300 || value.contains("..") || !valid.is_match(value) {
        return Err("Use a Hugging Face identifier such as owner/model-GGUF, optionally followed by :Q4_K_M.".into());
    }
    Ok(value.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize model download client.".into())
}

async fn store(req: &PullRequest, action: &str) -> Result<serde_json::Value, String> {
    let provider = base_url(&req.url)?;
    let configured = std::env::var("LLAMACPP_MODEL_STORE_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let endpoint = if let Some(ref configured) = configured {
        let inference = std::env::var("LLAMACPP_URL")
            .map_err(|_| "Set LLAMACPP_URL alongside LLAMACPP_MODEL_STORE_URL.")?;
        if base_url(&inference)? != provider {
            return Err("This model store belongs to the configured llama.cpp server. Select its Server URL to pull models.".into());
        }
        base_url(configured)?
    } else {
        let mut url = reqwest::Url::parse(&provider).unwrap();
        url.set_port(Some(8081))
            .map_err(|_| "Invalid model store address.")?;
        url.set_path("");
        url.to_string().trim_end_matches('/').to_string()
    };
    let suffix = if action == "cancel" {
        if req.id.len() != 32 || !req.id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid pull ID.".into());
        }
        format!("/pulls/{}/cancel", req.id)
    } else {
        "/pulls".into()
    };
    let client = client()?;
    let mut request = if action == "list" {
        client.get(format!("{endpoint}{suffix}"))
    } else {
        client
            .post(format!("{endpoint}{suffix}"))
            .json(&serde_json::json!({"model": req.model, "filename": req.filename}))
    };
    // Never send a deployment secret to a URL supplied by a browser client.
    if configured.is_some() {
        if let Ok(token) = std::env::var("NOLOCK_MODEL_PULL_TOKEN") {
            request = request.bearer_auth(token);
        }
    }
    let response = request.timeout(Duration::from_secs(15)).send().await
        .map_err(|_| "Cannot reach the llama.cpp model store. Run deploy/llamacpp/model_store.py beside llama.cpp and configure LLAMACPP_MODEL_STORE_URL on nolock.".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "The model store returned an invalid response.")?;
    if !status.is_success() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Model store request failed.")
            .into());
    }
    Ok(body)
}

pub async fn list(req: PullRequest) -> Result<Vec<PullJob>, String> {
    if req.backend == "llamacpp" {
        return serde_json::from_value(store(&req, "list").await?)
            .map_err(|_| "Invalid model store job list.".into());
    }
    if req.backend != "ollama" {
        return Err("Model pulling is supported by Ollama and llama.cpp.".into());
    }
    let url = base_url(&req.url)?;
    let registry = jobs();
    let lock = registry
        .lock()
        .map_err(|_| "Model pull registry is unavailable.")?;
    let mut result: Vec<_> = lock
        .values()
        .filter(|e| e.url == url)
        .map(|e| e.job.clone())
        .collect();
    result.sort_by_key(|j| std::cmp::Reverse(j.created_at));
    result.truncate(20);
    Ok(result)
}

pub async fn start(mut req: PullRequest) -> Result<PullJob, String> {
    req.model = hf_model(&req.model)?;
    if req.backend == "llamacpp" {
        return serde_json::from_value(store(&req, "start").await?)
            .map_err(|_| "Invalid model store response.".into());
    }
    if req.backend != "ollama" {
        return Err("Model pulling is supported by Ollama and llama.cpp.".into());
    }
    if !req.filename.is_empty() {
        return Err(
            "For Ollama, append the quantization or GGUF filename as :tag to the identifier."
                .into(),
        );
    }
    let url = base_url(&req.url)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid.")?;
    let id = format!("{:032x}", now.as_nanos());
    let job = PullJob {
        id: id.clone(),
        model: format!("hf.co/{}", req.model),
        backend: "ollama".into(),
        status: "queued".into(),
        message: "Connecting to Ollama…".into(),
        completed: 0,
        total: 0,
        created_at: now.as_secs(),
        path: None,
        filename: None,
    };
    let registry = jobs();
    let mut lock = registry
        .lock()
        .map_err(|_| "Model pull registry is unavailable.")?;
    if lock.values().any(|e| e.url == url && active(&e.job.status)) {
        return Err(
            "A model is already being pulled from this server. Wait or cancel it first.".into(),
        );
    }
    // Bound retained history without evicting active jobs.
    if lock.len() >= 100 {
        lock.retain(|_, e| active(&e.job.status));
    }
    if lock.values().filter(|e| active(&e.job.status)).count() >= 4 {
        return Err("Too many active model pulls. Wait for an existing pull to finish.".into());
    }
    lock.insert(
        id.clone(),
        Entry {
            job: job.clone(),
            url: url.clone(),
            abort: None,
        },
    );
    let task_job = job.clone();
    let handle = tokio::spawn(async move {
        let result = pull_ollama(&url, &task_job).await;
        update(&task_job.id, |j| {
            if j.status == "cancelled" {
                return;
            }
            match result {
                Ok(()) => {
                    j.status = "completed".into();
                    j.message = "Model saved in Ollama's model storage and ready to select.".into();
                }
                Err(error) => {
                    j.status = "failed".into();
                    j.message = error;
                }
            }
        });
    });
    lock.get_mut(&id).unwrap().abort = Some(handle.abort_handle());
    Ok(job)
}

fn update(id: &str, f: impl FnOnce(&mut PullJob)) {
    if let Ok(mut lock) = jobs().lock() {
        if let Some(e) = lock.get_mut(id) {
            f(&mut e.job);
        }
    }
}

async fn pull_ollama(url: &str, job: &PullJob) -> Result<(), String> {
    let response = client()?
        .post(format!("{url}/api/pull"))
        .json(&serde_json::json!({"model": job.model, "stream": true}))
        .timeout(Duration::from_secs(6 * 60 * 60))
        .send()
        .await
        .map_err(|_| "Could not connect to Ollama's pull API.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama refused the pull (HTTP {}). Check its URL and Hugging Face model access.",
            response.status()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut success = false;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(300), stream.next())
        .await
        .map_err(|_| "Ollama stopped reporting progress. Pull again to retry.")?
    {
        pending.extend_from_slice(
            &chunk.map_err(|_| "Ollama's download connection was interrupted.")?,
        );
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = pending.drain(..=end).collect();
            if !line.iter().all(u8::is_ascii_whitespace) {
                success |= ollama_progress(&job.id, &line)?;
            }
        }
        if pending.len() > 1024 * 1024 {
            return Err("Ollama returned an oversized progress message.".into());
        }
    }
    if !pending.is_empty() {
        success |= ollama_progress(&job.id, &pending)?;
    }
    if success {
        Ok(())
    } else {
        Err("Ollama ended the download without confirming success. Pull again to retry.".into())
    }
}

fn ollama_progress(id: &str, line: &[u8]) -> Result<bool, String> {
    let data: serde_json::Value =
        serde_json::from_slice(line).map_err(|_| "Ollama returned invalid progress data.")?;
    if let Some(error) = data["error"].as_str() {
        return Err(error.chars().take(500).collect());
    }
    let status = data["status"].as_str().unwrap_or("Downloading…");
    update(id, |j| {
        if j.status == "cancelled" {
            return;
        }
        j.status = "downloading".into();
        j.message = status.chars().take(200).collect();
        j.completed = data["completed"].as_u64().unwrap_or(0);
        j.total = data["total"].as_u64().unwrap_or(0);
    });
    Ok(status == "success")
}

pub async fn cancel(req: PullRequest) -> Result<PullJob, String> {
    if req.backend == "llamacpp" {
        return serde_json::from_value(store(&req, "cancel").await?)
            .map_err(|_| "Invalid model store response.".into());
    }
    if req.backend != "ollama" {
        return Err("Unsupported model provider.".into());
    }
    let url = base_url(&req.url)?;
    let registry = jobs();
    let mut lock = registry
        .lock()
        .map_err(|_| "Model pull registry is unavailable.")?;
    let entry = lock
        .get_mut(&req.id)
        .filter(|e| e.url == url)
        .ok_or("Download not found.")?;
    if active(&entry.job.status) {
        if let Some(handle) = entry.abort.take() {
            handle.abort();
        }
        entry.job.status = "cancelled".into();
        entry.job.message =
            "Pull cancelled. Ollama can resume cached layers when you pull again.".into();
    }
    Ok(entry.job.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hf_identifiers() {
        for input in [
            "owner/model-GGUF",
            "https://huggingface.co/owner/model-GGUF/",
            "hf.co/owner/model-GGUF",
        ] {
            assert_eq!(hf_model(input).unwrap(), "owner/model-GGUF");
        }
        assert_eq!(
            hf_model("owner/model:Q4_K_M").unwrap(),
            "owner/model:Q4_K_M"
        );
        for input in [
            "",
            "../model",
            "https://evil.test/model",
            "owner/repo/blob/main/a.gguf",
            "owner/model?token=x",
            "owner/repo; rm -rf /",
        ] {
            assert!(hf_model(input).is_err());
        }
    }
    #[test]
    fn progress_checks_error_and_success() {
        assert!(!ollama_progress(
            "missing",
            br#"{"status":"pulling","completed":5,"total":10}"#
        )
        .unwrap());
        assert!(ollama_progress("missing", br#"{"status":"success"}"#).unwrap());
        assert_eq!(
            ollama_progress("missing", br#"{"error":"disk full"}"#).unwrap_err(),
            "disk full"
        );
        assert!(ollama_progress("missing", b"not json").is_err());
    }
    #[test]
    fn provider_urls() {
        assert_eq!(
            base_url("http://localhost:11434/").unwrap(),
            "http://localhost:11434"
        );
        for input in [
            "file:///etc/passwd",
            "http://user:pass@host",
            "http://host?token=secret",
        ] {
            assert!(base_url(input).is_err());
        }
    }
    async fn mock_ollama(body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.ends_with(b"}") {
                    break;
                }
            }
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(headers.as_bytes()).await.unwrap();
            // Split JSON records across writes, including a final record without newline.
            for part in body.as_bytes().chunks(7) {
                stream.write_all(part).await.unwrap();
                tokio::task::yield_now().await;
            }
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}"), server)
    }

    fn test_job() -> PullJob {
        PullJob {
            id: "transport-test".into(),
            model: "hf.co/owner/model:Q4_K_M".into(),
            backend: "ollama".into(),
            status: "queued".into(),
            message: String::new(),
            completed: 0,
            total: 0,
            created_at: 0,
            path: None,
            filename: None,
        }
    }

    #[tokio::test]
    async fn ollama_http_stream_and_normalized_model() {
        let (url, server) = mock_ollama(
            "{\"status\":\"pulling\",\"completed\":5,\"total\":10}\n{\"status\":\"success\"}",
        )
        .await;
        pull_ollama(&url, &test_job()).await.unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /api/pull "));
        assert!(request.contains("hf.co/owner/model:Q4_K_M"));
        assert!(request.contains("\"stream\":true"));
    }

    #[tokio::test]
    async fn ollama_http_incomplete_stream_is_not_success() {
        let (url, server) = mock_ollama("{\"status\":\"pulling\"}\n").await;
        let error = pull_ollama(&url, &test_job()).await.unwrap_err();
        assert!(error.contains("without confirming success"));
        server.await.unwrap();
    }
}
