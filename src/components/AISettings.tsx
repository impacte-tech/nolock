import { useState, useEffect } from "react";
import { getSecret, setSecret } from "../lib/secrets";
import ModelSelector from "./ModelSelector";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface AIConfig {
  backend: string;
  url: string;
  completionModel: string;
  chatModel: string;
  /** Per-backend API keys: { openrouter: "sk-or-...", opencode: "sk-oc-..." } */
  apiKeys: Record<string, string>;
  toolsEnabled: string[];
}

/** Per-tool configuration (provider, api keys, etc.). Stored in localStorage as nolock.toolConfig. */
interface ToolConfig {
  [toolId: string]: {
    provider?: string;
    api_key?: string;
  };
}

const BACKENDS = [
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434" },
  { value: "llamacpp", label: "llama.cpp", defaultUrl: "http://localhost:8080" },
  { value: "openrouter", label: "OpenRouter", defaultUrl: "https://openrouter.ai/api/v1" },
  { value: "opencode", label: "OpenCode Zen", defaultUrl: "https://opencode.ai/zen/v1" },
];

const WEB_SEARCH_PROVIDERS = [
  { value: "duckduckgo", label: "DuckDuckGo (experimental)", description: "Free, no API key. Uses Instant Answer API — limited results, best for broad topics." },
  { value: "brave", label: "Brave Search", description: "Real web search results. Requires a free API key from brave.com/search/api/" },
];

const AVAILABLE_TOOLS = [
  { id: "web_search", label: "Web Search", description: "Search the internet to discover relevant URLs before fetching them" },
  { id: "web_fetch", label: "Web Fetch", description: "Fetch and read web page content from a specific URL" },
  { id: "read_file", label: "Read File", description: "Read file contents from disk" },
  { id: "list_directory", label: "List Directory", description: "Explore project structure" },
];

export default function AISettings({ visible, onClose }: Props) {
  const [config, setConfig] = useState<AIConfig>({
    backend: "ollama",
    url: "http://localhost:11434",
    completionModel: "",
    chatModel: "",
    apiKeys: {},
    toolsEnabled: [],
  });
  const [toolConfig, setToolConfig] = useState<ToolConfig>({});

  useEffect(() => {
    if (!visible) return;

    const oldModel = localStorage.getItem("nolock.model");
    const toolsRaw = localStorage.getItem("nolock.toolsEnabled");
    const toolConfigRaw = localStorage.getItem("nolock.toolConfig");

    // Set state synchronously from localStorage first (for immediate render)
    const backend = localStorage.getItem("nolock.backend") || "ollama";
    const apiKeys: Record<string, string> = {};
    // Load per-backend API keys
    for (const b of ["openrouter", "opencode"]) {
      apiKeys[b] = localStorage.getItem(`nolock.apiKey.${b}`) || "";
    }
    // Migration: if old single key exists, copy to current backend if that slot is empty
    if (!apiKeys[backend]) {
      const oldKey = localStorage.getItem("nolock.apiKey") || "";
      if (oldKey) apiKeys[backend] = oldKey;
    }

    setConfig({
      backend,
      url: localStorage.getItem("nolock.url") || "http://localhost:11434",
      completionModel: localStorage.getItem("nolock.completionModel") || oldModel || "",
      chatModel: localStorage.getItem("nolock.chatModel") || oldModel || "",
      apiKeys,
      toolsEnabled: toolsRaw ? JSON.parse(toolsRaw) : [],
    });
    setToolConfig(toolConfigRaw ? JSON.parse(toolConfigRaw) : {});

    // Then asynchronously upgrade from OS keychain if available
    (async () => {
      const keychainUpdates: Record<string, string> = {};
      for (const b of ["openrouter", "opencode"]) {
        const storedKey = await getSecret(`apiKey.${b}`);
        if (storedKey != null) {
          keychainUpdates[b] = storedKey;
        }
      }
      if (Object.keys(keychainUpdates).length > 0) {
        setConfig((prev) => ({
          ...prev,
          apiKeys: { ...prev.apiKeys, ...keychainUpdates },
        }));
      }
      const storedToolConfig = await getSecret("toolConfig");
      if (storedToolConfig != null) {
        setToolConfig(JSON.parse(storedToolConfig));
      }
    })();
  }, [visible]);

  /** Update a specific tool's config field */
  const updateToolConfig = (toolId: string, field: string, value: string) => {
    setToolConfig((prev) => ({
      ...prev,
      [toolId]: { ...(prev[toolId] || {}), [field]: value },
    }));
  };

  const save = () => {
    localStorage.setItem("nolock.backend", config.backend);
    localStorage.setItem("nolock.url", config.url);
    localStorage.setItem("nolock.completionModel", config.completionModel);
    localStorage.setItem("nolock.chatModel", config.chatModel);
    localStorage.setItem("nolock.toolsEnabled", JSON.stringify(config.toolsEnabled));
    localStorage.setItem("nolock.model", config.completionModel);

    // Store per-backend API keys in OS keychain + localStorage (dual-write)
    // Fire-and-forget: close modal immediately, keychain writes happen async
    for (const [backend, key] of Object.entries(config.apiKeys)) {
      setSecret(`apiKey.${backend}`, key);
    }
    setSecret("toolConfig", JSON.stringify(toolConfig));

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
  const needsApiKey = config.backend === "openrouter" || config.backend === "opencode";

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
            <ModelSelector
              provider={config.backend}
              url={config.url}
              apiKey={config.apiKeys[config.backend] || ""}
              value={config.completionModel}
              onChange={(v) => setConfig({ ...config, completionModel: v })}
              placeholder="e.g. qwen2.5-coder:1.5b"
              label="Code Completion Model (FITM)"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              Smaller/faster model for inline code suggestions. Uses Fill-In-The-Middle (prefix+suffix).
            </span>
          </div>

          <div>
            <ModelSelector
              provider={config.backend}
              url={config.url}
              apiKey={config.apiKeys[config.backend] || ""}
              value={config.chatModel}
              onChange={(v) => setConfig({ ...config, chatModel: v })}
              placeholder="e.g. qwen3:8b"
              label="Chat Model"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              Larger model for the Agent Chat panel. Uses multi-turn conversations.
            </span>
          </div>

          {needsApiKey && (
            <>
              <label className="field-label" htmlFor="ai-api-key">API Key</label>
              <input
                id="ai-api-key"
                className="field-input"
                type="password"
                value={config.apiKeys[config.backend] || ""}
                onChange={(e) => setConfig({ ...config, apiKeys: { ...config.apiKeys, [config.backend]: e.target.value } })}
                placeholder={config.backend === "openrouter" ? "sk-or-..." : "sk-oc-..."}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {config.backend === "openrouter"
                  ? "Required for OpenRouter API."
                  : "Required for the remote OpenCode Zen API. Leave blank for local servers."}
              </span>
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

            {/* --- Per-tool sub-configuration: web_search --- */}
            {supportsTools && config.toolsEnabled.includes("web_search") && (
              <div style={{
                marginTop: 8,
                padding: "10px 12px",
                background: "var(--bg-secondary)",
                borderRadius: 6,
                border: "1px solid var(--border)",
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
                  Web Search Provider
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {WEB_SEARCH_PROVIDERS.map((p) => (
                    <label
                      key={p.value}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        cursor: "pointer",
                        padding: "4px 0",
                      }}
                    >
                      <input
                        type="radio"
                        name="web_search_provider"
                        value={p.value}
                        checked={(toolConfig.web_search?.provider || "duckduckgo") === p.value}
                        onChange={() => updateToolConfig("web_search", "provider", p.value)}
                        style={{ marginTop: 2, accentColor: "var(--accent)" }}
                      />
                      <div>
                        <div style={{ fontSize: 12, color: "var(--text-primary)" }}>{p.label}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{p.description}</div>
                      </div>
                    </label>
                  ))}
                </div>

                {/* Brave API key field */}
                {(toolConfig.web_search?.provider || "duckduckgo") === "brave" && (
                  <div style={{ marginTop: 8 }}>
                    <label style={{ fontSize: 11, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                      Brave Search API Key
                    </label>
                    <input
                      className="field-input"
                      type="password"
                      placeholder="BSA-..."
                      value={toolConfig.web_search?.api_key || ""}
                      onChange={(e) => updateToolConfig("web_search", "api_key", e.target.value)}
                      style={{ fontSize: 12, padding: "6px 8px" }}
                    />
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
                      Get your free API key at{" "}
                      <a
                        href="https://brave.com/search/api/"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--accent)" }}
                      >
                        brave.com/search/api
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
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
