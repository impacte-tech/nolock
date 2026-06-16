import { useState, useEffect } from "react";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface AIConfig {
  backend: string;
  url: string;
  completionModel: string;
  chatModel: string;
  apiKey: string;
  toolsEnabled: string[];
}

const BACKENDS = [
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434" },
  { value: "llamacpp", label: "llama.cpp", defaultUrl: "http://localhost:8080" },
  { value: "openrouter", label: "OpenRouter", defaultUrl: "https://openrouter.ai/api/v1" },
  { value: "opencode", label: "OpenCode Zen", defaultUrl: "http://localhost:11435" },
];

const AVAILABLE_TOOLS = [
  { id: "web_fetch", label: "Web Fetch", description: "Fetch and read web page content" },
  { id: "read_file", label: "Read File", description: "Read file contents from disk" },
  { id: "list_directory", label: "List Directory", description: "Explore project structure" },
];

export default function AISettings({ visible, onClose }: Props) {
  const [config, setConfig] = useState<AIConfig>({
    backend: "ollama",
    url: "http://localhost:11434",
    completionModel: "",
    chatModel: "",
    apiKey: "",
    toolsEnabled: [],
  });

  useEffect(() => {
    if (visible) {
      const oldModel = localStorage.getItem("zencode.model");
      const toolsRaw = localStorage.getItem("zencode.toolsEnabled");
      setConfig({
        backend: localStorage.getItem("zencode.backend") || "ollama",
        url: localStorage.getItem("zencode.url") || "http://localhost:11434",
        completionModel: localStorage.getItem("zencode.completionModel") || oldModel || "",
        chatModel: localStorage.getItem("zencode.chatModel") || oldModel || "",
        apiKey: localStorage.getItem("zencode.apiKey") || "",
        toolsEnabled: toolsRaw ? JSON.parse(toolsRaw) : [],
      });
    }
  }, [visible]);

  const save = () => {
    localStorage.setItem("zencode.backend", config.backend);
    localStorage.setItem("zencode.url", config.url);
    localStorage.setItem("zencode.completionModel", config.completionModel);
    localStorage.setItem("zencode.chatModel", config.chatModel);
    localStorage.setItem("zencode.apiKey", config.apiKey);
    localStorage.setItem("zencode.toolsEnabled", JSON.stringify(config.toolsEnabled));
    localStorage.setItem("zencode.model", config.completionModel);
    onClose();
  };

  const selectBackend = (backend: string) => {
    const found = BACKENDS.find((b) => b.value === backend);
    if (found) {
      setConfig({ ...config, backend, url: found.defaultUrl });
    }
  };

  const toggleTool = (toolId: string) => {
    setConfig((prev) => {
      const enabled = prev.toolsEnabled.includes(toolId)
        ? prev.toolsEnabled.filter((t) => t !== toolId)
        : [...prev.toolsEnabled, toolId];
      return { ...prev, toolsEnabled: enabled };
    });
  };

  const supportsTools = config.backend === "ollama" || config.backend === "openrouter";

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>AI Integrations</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Provider</label>
          <div className="backend-grid">
            {BACKENDS.map((b) => (
              <div
                key={b.value}
                className={`backend-card ${config.backend === b.value ? "active" : ""}`}
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
            value={config.url}
            onChange={(e) => setConfig({ ...config, url: e.target.value })}
            placeholder="http://localhost:11434"
          />

          <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0", paddingTop: "12px" }}>
            <label className="field-label">Code Completion Model (FITM)</label>
            <input
              className="field-input"
              value={config.completionModel}
              onChange={(e) => setConfig({ ...config, completionModel: e.target.value })}
              placeholder="e.g. qwen2.5-coder:1.5b"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              Smaller/faster model for inline code suggestions. Uses Fill-In-The-Middle (prefix+suffix).
            </span>
          </div>

          <div>
            <label className="field-label">Chat Model</label>
            <input
              className="field-input"
              value={config.chatModel}
              onChange={(e) => setConfig({ ...config, chatModel: e.target.value })}
              placeholder="e.g. qwen3:8b"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              Larger model for the Agent Chat panel. Uses multi-turn conversations.
            </span>
          </div>

          {config.backend === "openrouter" && (
            <>
              <label className="field-label" htmlFor="ai-api-key">API Key</label>
              <input
                id="ai-api-key"
                className="field-input"
                type="password"
                value={config.apiKey}
                onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                placeholder="sk-or-..."
              />
            </>
          )}

          {/* --- Agent Tools --- */}
          <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0", paddingTop: "12px" }}>
            <label className="field-label">Agent Tools</label>
            <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
              {supportsTools
                ? "Enable tools the AI agent can use during chat. The model decides when to call them."
                : "Tool calling is only supported with Ollama and OpenRouter backends."}
            </span>
            {AVAILABLE_TOOLS.map((tool) => (
              <label
                key={tool.id}
                className="tool-toggle"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 0",
                  opacity: supportsTools ? 1 : 0.4,
                  cursor: supportsTools ? "pointer" : "not-allowed",
                }}
              >
                <input
                  type="checkbox"
                  checked={config.toolsEnabled.includes(tool.id)}
                  onChange={() => supportsTools && toggleTool(tool.id)}
                  disabled={!supportsTools}
                  style={{ accentColor: "var(--accent)" }}
                />
                <div>
                  <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{tool.label}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{tool.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
