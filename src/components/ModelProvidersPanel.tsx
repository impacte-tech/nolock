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
  { value: "opencode", label: "OpenCode Zen", defaultUrl: "http://localhost:11435" },
];

export default function ModelProvidersPanel({ visible, onClose }: Props) {
  const [backend, setBackend] = useState("ollama");
  const [url, setUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!visible) return;

    setBackend(localStorage.getItem("nolock.backend") || "ollama");
    setUrl(localStorage.getItem("nolock.url") || "http://localhost:11434");
    setApiKey(localStorage.getItem("nolock.apiKey") || "");

    // Upgrade from OS keychain if available
    (async () => {
      const storedApiKey = await getSecret("apiKey");
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
    }
  };

  const save = () => {
    localStorage.setItem("nolock.backend", backend);
    localStorage.setItem("nolock.url", url);
    setSecret("apiKey", apiKey);
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

          {backend === "openrouter" && (
            <>
              <label className="field-label" htmlFor="mp-api-key">API Key</label>
              <input
                id="mp-api-key"
                className="field-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-..."
              />
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
