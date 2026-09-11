import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ModelPullJob {
  id: string;
  backend: string;
  model: string;
  status: "queued" | "resolving" | "downloading" | "completed" | "failed" | "cancelled";
  message: string;
  completed: number;
  total: number;
  created_at: number;
  path: string | null;
  filename?: string | null;
}

const isActive = (job: ModelPullJob) => ["queued", "resolving", "downloading"].includes(job.status);
const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;

export default function ModelPullPanel({ backend, url }: { backend: string; url: string }) {
  const [model, setModel] = useState("");
  const [filename, setFilename] = useState("");
  const [jobs, setJobs] = useState<ModelPullJob[]>([]);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const generation = useRef(0);
  const completedJobs = useRef(new Set<string>());
  const polling = useRef(false);
  const mutationVersion = useRef(0);
  const request = () => ({ backend, url: url.trim() });

  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setJobs([]);
    setError("");
    setConnectionError("");
    setBusy(false);
    setCancelling(null);
    polling.current = false;
    const refresh = async () => {
      const version = mutationVersion.current;
      try {
        const result = await invoke<ModelPullJob[]>("list_model_pulls", { req: { backend, url: url.trim() } });
        if (disposed || current !== generation.current) return;
        if (!polling.current && version === mutationVersion.current) setJobs(result);
        setConnectionError("");
        for (const job of result) {
          if (job.status === "completed" && !completedJobs.current.has(job.id)) {
            completedJobs.current.add(job.id);
            window.dispatchEvent(new CustomEvent("nolock:models-changed", { detail: { backend } }));
          }
        }
      } catch (err) {
        if (!disposed && current === generation.current) setConnectionError(String(err));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1500);
      }
    };
    // Debounce URL edits, then poll sequentially (no overlapping requests).
    timer = setTimeout(refresh, 300);
    return () => { disposed = true; clearTimeout(timer); generation.current++; };
  }, [backend, url]);

  const pull = async () => {
    if (busy || !model.trim() || jobs.some(isActive)) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    polling.current = true;
    mutationVersion.current++;
    try {
      const job = await invoke<ModelPullJob>("start_model_pull", {
        req: { ...request(), model: model.trim(), filename: backend === "llamacpp" ? filename.trim() : "" },
      });
      if (current === generation.current) {
        setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]);
        setConnectionError("");
      }
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) { setBusy(false); polling.current = false; }
    }
  };

  const cancel = async (id: string) => {
    const current = generation.current;
    setCancelling(id);
    setError("");
    polling.current = true;
    mutationVersion.current++;
    try {
      const job = await invoke<ModelPullJob>("cancel_model_pull", { req: { ...request(), id } });
      if (current === generation.current) setJobs(previous => previous.map(item => item.id === id ? job : item));
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) { setCancelling(null); polling.current = false; }
    }
  };

  const active = jobs.some(isActive);
  return (
    <section className="model-pull-panel" aria-labelledby="model-pull-title">
      <h3 id="model-pull-title">Pull a model</h3>
      <label className="field-label" htmlFor="model-pull-id">Hugging Face model identifier</label>
      <div className="model-pull-input-row">
        <input id="model-pull-id" className="field-input" value={model}
          onChange={event => setModel(event.target.value)} placeholder="owner/model-GGUF:Q4_K_M"
          aria-describedby="model-pull-hint" disabled={busy || active}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void pull(); } }} />
        <button type="button" className="btn-primary" disabled={busy || active || !model.trim() || !url.trim()} onClick={() => void pull()}>
          {busy ? "Starting…" : "Pull"}
        </button>
      </div>
      <p id="model-pull-hint" className="model-pull-hint">
        On a <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noreferrer">Hugging Face GGUF model page</a>,
        copy <code>owner/model-name</code> from the title or URL. You can also paste the page URL.
        Add <code>:Q4_K_M</code> to choose a quantization; otherwise Q4_K_M is preferred when available.
      </p>
      {backend === "llamacpp" && <details>
        <summary>Choose a specific GGUF file (optional)</summary>
        <label className="field-label" htmlFor="model-pull-file">GGUF filename</label>
        <input id="model-pull-file" className="field-input" value={filename} disabled={busy || active}
          onChange={event => setFilename(event.target.value)} placeholder="model-q4_k_m.gguf" />
        <p className="model-pull-hint">Find this under Files and versions on the model page. All parts of a split GGUF are downloaded together.</p>
      </details>}
      <p className="model-pull-hint">
        {backend === "ollama"
          ? "Saved in the selected Ollama server’s model storage."
          : "Saved on the llama.cpp server’s model volume. Pulling downloads files; it does not replace the active inference model."}
        {" "}Downloads continue when this panel is closed.
      </p>
      {(error || connectionError) && <p className="model-pull-error" role="alert">{error || connectionError}</p>}
      <div className="model-pull-jobs" aria-live="polite">
        {jobs.slice(0, 5).map(job => (
          <div className="model-pull-job" key={job.id}>
            <div className="model-pull-job-heading"><strong>{job.model}</strong><span>{job.status}</span></div>
            <p className={job.status === "failed" ? "model-pull-error" : "model-pull-hint"}>{job.message}</p>
            {isActive(job) && <>
              <progress aria-label={`Download progress for ${job.model}`} max={job.total || undefined} value={job.total ? Math.min(job.completed, job.total) : undefined} />
              {job.total > 0 && <span className="model-pull-hint">{bytes(job.completed)} / {bytes(job.total)}{backend === "ollama" ? " · current layer" : ""}</span>}
              <button type="button" className="btn-secondary" disabled={cancelling === job.id} onClick={() => void cancel(job.id)}>{cancelling === job.id ? "Cancelling…" : "Cancel pull"}</button>
            </>}
            {job.path && <code className="model-pull-path">{job.path}</code>}
            {(job.status === "failed" || job.status === "cancelled") && !active && <button type="button" className="btn-secondary" onClick={() => { setModel(job.model); setFilename(job.filename || ""); setError(""); document.getElementById("model-pull-id")?.focus(); }}>Use identifier again</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
