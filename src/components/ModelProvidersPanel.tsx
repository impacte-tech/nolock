import { useState, useEffect, useRef } from "react";
import { getSecret, setSecret } from "../lib/secrets";
import { BACKENDS, isPlanningBackend, resolveBackendUrl, migrateRemovedProviders } from "../lib/backends";
import ModelPullPanel from "./ModelPullPanel";

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function ModelProvidersPanel({ visible, onClose }: Props) {
  const [backend, setBackend] = useState("ollama");
  const [url, setUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const keyLoadRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    migrateRemovedProviders();

    const currentBackend = localStorage.getItem("nolock.backend") || "ollama";
    setBackend(currentBackend);
    setUrl(resolveBackendUrl(currentBackend));
    setApiKey("");

    // Ignore stale session reads after switching providers or typing a key.
    const keyRequest = ++keyLoadRef.current;
    (async () => {
      const storedApiKey = await getSecret(`apiKey.${currentBackend}`);
      if (storedApiKey != null && keyLoadRef.current === keyRequest) {
        setApiKey(storedApiKey);
      }
    })();
  }, [visible]);

  const selectBackend = (value: string) => {
    const found = BACKENDS.find((b) => b.value === value);
    if (found) {
      setBackend(value);
      setUrl(resolveBackendUrl(value));
      // Load the new backend's API key
      setApiKey("");
      const keyRequest = ++keyLoadRef.current;
    void getSecret(`apiKey.${value}`).then((key) => {
      if (keyLoadRef.current === keyRequest) setApiKey(key || "");
    });
    }
  };

  const save = () => {
    localStorage.setItem("nolock.backend", backend);
    localStorage.setItem("nolock.url", url);
    setSecret(`apiKey.${backend}`, apiKey);
    // Notify the bottom bar / status readers that the provider changed.
    window.dispatchEvent(new CustomEvent("nolock:settings-changed"));
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Model Providers</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Provider</label>
          <div className="backend-grid">
            {BACKENDS.map((b) => (
              <div
                key={b.value}
                className={`backend-card ${backend === b.value ? "active" : ""}`}
                onClick={() => selectBackend(b.value)}
              >
                <span className="backend-name">{b.label}</span>
                <span className="backend-url">{b.defaultUrl}</span>
                <span className={`backend-role ${isPlanningBackend(b.value) ? "planning" : "executor"}`}>
                  {isPlanningBackend(b.value) ? "Planning · online" : "Task executor · local"}
                </span>
              </div>
            ))}
          </div>
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 4, lineHeight: 1.5 }}>
            <strong>Planning</strong> providers (online) act as the main orchestrator model.{" "}
            <strong>Task executor</strong> providers (local Ollama / llama.cpp) run small,
            cheap sub-agents that report back — saving tokens on long agentic runs.
          </span>

          <label className="field-label">Server URL</label>
          <input
            className="field-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:11434"
          />

          {backend === "openrouter" && (
            <>
              <label className="field-label" htmlFor="mp-api-key">API Key</label>
              <input
                id="mp-api-key"
                className="field-input"
                type="password"
                value={apiKey}
                onChange={(e) => { keyLoadRef.current++; setApiKey(e.target.value); }}
                placeholder="sk-or-..."
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                Required for OpenRouter. Kept for this session only. Re-enter after restarting.
              </span>
            </>
          )}

          {(backend === "ollama" || backend === "llamacpp") && <ModelPullPanel backend={backend} url={url} />}


        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
