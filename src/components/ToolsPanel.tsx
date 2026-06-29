import { useState, useEffect } from "react";
import { setSecret } from "../lib/secrets";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface ToolConfig {
  [toolId: string]: {
    provider?: string;
    api_key?: string;
  };
}

const AVAILABLE_TOOLS = [
  { id: "web_search", label: "Web Search", description: "Search the internet to discover relevant URLs before fetching them" },
  { id: "web_fetch", label: "Web Fetch", description: "Fetch and read web page content from a specific URL" },
  { id: "read_file", label: "Read File", description: "Read file contents from disk" },
  { id: "write_file", label: "Write File", description: "Create and modify files on disk" },
  { id: "list_directory", label: "List Directory", description: "Explore project structure" },
];

const WEB_SEARCH_PROVIDERS = [
  { value: "duckduckgo", label: "DuckDuckGo (experimental)", description: "Free, no API key. Uses Instant Answer API — limited results, best for broad topics." },
  { value: "brave", label: "Brave Search", description: "Real web search results. Requires a free API key from brave.com/search/api/" },
];

export default function ToolsPanel({ visible, onClose }: Props) {
  const [toolsEnabled, setToolsEnabled] = useState<string[]>([]);
  const [toolConfig, setToolConfig] = useState<ToolConfig>({});

  // Determine if current backend supports tools
  const backend = (typeof window !== "undefined" ? localStorage.getItem("nolock.backend") : null) || "ollama";
  const supportsTools = backend === "ollama" || backend === "openrouter";

  useEffect(() => {
    if (!visible) return;
    const toolsRaw = localStorage.getItem("nolock.toolsEnabled");
    const toolConfigRaw = localStorage.getItem("nolock.toolConfig");
    setToolsEnabled(toolsRaw ? JSON.parse(toolsRaw) : []);
    setToolConfig(toolConfigRaw ? JSON.parse(toolConfigRaw) : {});
  }, [visible]);

  const toggleTool = (toolId: string) => {
    setToolsEnabled((prev) =>
      prev.includes(toolId)
        ? prev.filter((t) => t !== toolId)
        : [...prev, toolId],
    );
  };

  const updateToolConfig = (toolId: string, field: string, value: string) => {
    setToolConfig((prev) => ({
      ...prev,
      [toolId]: { ...(prev[toolId] || {}), [field]: value },
    }));
  };

  const save = () => {
    localStorage.setItem("nolock.toolsEnabled", JSON.stringify(toolsEnabled));
    localStorage.setItem("nolock.toolConfig", JSON.stringify(toolConfig));
    setSecret("toolConfig", JSON.stringify(toolConfig));
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Agent Tools</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <span style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 12, lineHeight: 1.5 }}>
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
                checked={toolsEnabled.includes(tool.id)}
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
          {supportsTools && toolsEnabled.includes("web_search") && (
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
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
