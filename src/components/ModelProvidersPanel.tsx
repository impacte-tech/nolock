import { useState, useEffect } from "react";
import { getSecret, setSecret } from "../lib/secrets";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const BACKENDS = [
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434" },
  { value: "llamacpp", label: "llama.cpp", defaultUrl: "http://localhost:8080" },
  { value: "openrouter", label: "OpenRouter", defaultUrl: "https://openrouter.ai/api/v1" },
  { value: "opencode", label: "OpenCode Zen", defaultUrl: "https://opencode.ai/zen/v1" },
];

export default function ModelProvidersPanel({ visible, onClose }: Props) {
  const [backend, setBackend] = useState("ollama");
  const [url, setUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!visible) return;

    const currentBackend = localStorage.getItem("nolock.backend") || "ollama";
    setBackend(currentBackend);
    setUrl(localStorage.getItem("nolock.url") || "http://localhost:11434");

    // Load the current backend's API key
    setApiKey(localStorage.getItem(`nolock.apiKey.${currentBackend}`) || "");

    // Upgrade from OS keychain if available
    (async () => {
      const storedApiKey = await getSecret(`apiKey.${currentBackend}`);
      if (storedApiKey != null) {
        setApiKey(storedApiKey);
      }
    })();
  }, [visible]);

  const selectBackend = (value: string) => {
    const found = BACKENDS.find((b) => b.value === value);
    if (found) {
      setBackend(value);
      setUrl(found.defaultUrl);
      // Load the new backend's API key
      setApiKey(localStorage.getItem(`nolock.apiKey.${value}`) || "");
    }
  };

  const save = () => {
    localStorage.setItem("nolock.backend", backend);
    localStorage.setItem("nolock.url", url);
    setSecret(`apiKey.${backend}`, apiKey);
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
              </div>
            ))}
          </div>

          <label className="field-label">Server URL</label>
          <input
            className="field-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:11434"
          />

          {(backend === "openrouter" || backend === "opencode") && (
            <>
              <label className="field-label" htmlFor="mp-api-key">API Key</label>
              <input
                id="mp-api-key"
                className="field-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={backend === "openrouter" ? "sk-or-..." : "sk-oc-..."}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {backend === "openrouter"
                  ? "Required for OpenRouter API."
                  : "Required for the remote OpenCode Zen API. Leave blank for local servers."}
              </span>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
