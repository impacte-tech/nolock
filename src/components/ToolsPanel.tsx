import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setSecret } from "../lib/secrets";

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath?: string;
}

interface ToolConfig {
  [toolId: string]: {
    provider?: string;
    api_key?: string;
  };
}

interface CustomToolEntry {
  name: string;
  path: string;
  description: string;
}

const EXAMPLE_TOOL_FORM = {
  name: "http_request",
  description: "Make an HTTP request to a URL and return the status code. Use {param} placeholders in the command that get substituted from the AI's arguments.",
  command: 'curl -s -o /dev/null -w "%{http_code}" {url}',
  parameters: '{\n  "type": "object",\n  "properties": {\n    "url": {\n      "type": "string",\n      "description": "The URL to request (required)"\n    }\n  },\n  "required": ["url"]\n}',
};

const AVAILABLE_TOOLS = [
  { id: "web_search", label: "Web Search", description: "Search the internet to discover relevant URLs before fetching them" },
  { id: "web_fetch", label: "Web Fetch", description: "Fetch and read web page content from a specific URL" },
  { id: "read_file", label: "Read File", description: "Read file contents from disk" },
  { id: "list_directory", label: "List Directory", description: "Explore project structure" },
];

const WEB_SEARCH_PROVIDERS = [
  { value: "duckduckgo", label: "DuckDuckGo (experimental)", description: "Free, no API key. Uses Instant Answer API — limited results, best for broad topics." },
  { value: "brave", label: "Brave Search", description: "Real web search results. Requires a free API key from brave.com/search/api/" },
];

export default function ToolsPanel({ visible, onClose, rootPath = "" }: Props) {
  const [toolsEnabled, setToolsEnabled] = useState<string[]>([]);
  const [toolConfig, setToolConfig] = useState<ToolConfig>({});
  const [maxIterations, setMaxIterations] = useState(10);

  // Custom tool management state
  const [customTools, setCustomTools] = useState<CustomToolEntry[]>([]);
  const [showNewToolForm, setShowNewToolForm] = useState(false);
  const [toolForm, setToolForm] = useState({ ...EXAMPLE_TOOL_FORM });
  const [toolFormError, setToolFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // Determine if current backend supports tools
  const backend = (typeof window !== "undefined" ? localStorage.getItem("nolock.backend") : null) || "ollama";
  const supportsTools = backend === "ollama" || backend === "openrouter";

  const loadCustomTools = useCallback(async () => {
    if (!rootPath) return;
    try {
      const entries: CustomToolEntry[] = await invoke("list_tools", { rootPath });
      setCustomTools(entries);
    } catch {
      setCustomTools([]);
    }
  }, [rootPath]);

  useEffect(() => {
    if (!visible) return;
    const toolsRaw = localStorage.getItem("nolock.toolsEnabled");
    const toolConfigRaw = localStorage.getItem("nolock.toolConfig");
    setToolsEnabled(toolsRaw ? JSON.parse(toolsRaw) : []);
    setToolConfig(toolConfigRaw ? JSON.parse(toolConfigRaw) : {});
    const savedMax = localStorage.getItem("nolock.toolMaxIterations");
    setMaxIterations(savedMax ? parseInt(savedMax, 10) : 10);
    setShowNewToolForm(false);
    setToolForm({ ...EXAMPLE_TOOL_FORM });
    setToolFormError("");
    loadCustomTools();
  }, [visible, loadCustomTools]);

  const startCreateTool = useCallback(() => {
    setToolForm({ ...EXAMPLE_TOOL_FORM });
    setToolFormError("");
    setShowNewToolForm(true);
  }, []);

  const cancelCreateTool = useCallback(() => {
    setShowNewToolForm(false);
    setToolFormError("");
  }, []);

  const createCustomTool = useCallback(async () => {
    const name = toolForm.name.trim();
    if (!name) { setToolFormError("Tool name is required."); return; }
    if (!toolForm.command.trim()) { setToolFormError("Command is required."); return; }

    let params: object;
    try {
      params = JSON.parse(toolForm.parameters);
    } catch {
      setToolFormError("Parameters must be valid JSON.");
      return;
    }

    setSaving(true);
    setToolFormError("");
    try {
      const filePath = `${rootPath}/.tools/${name}.json`;
      const content = JSON.stringify({
        name,
        description: toolForm.description.trim(),
        command: toolForm.command.trim(),
        parameters: params,
      }, null, 2);
      await invoke("write_file", { path: filePath, content });
      setShowNewToolForm(false);
      setToolForm({ ...EXAMPLE_TOOL_FORM });
      await loadCustomTools();
    } catch (e) {
      setToolFormError(`Failed to create tool: ${e}`);
    }
    setSaving(false);
  }, [toolForm, rootPath, loadCustomTools]);

  const deleteCustomTool = useCallback(async (entry: CustomToolEntry) => {
    if (!confirm(`Delete tool "${entry.name}"?`)) return;
    try {
      await invoke("delete_file", { path: entry.path });
      await loadCustomTools();
    } catch (e) {
      console.error("Failed to delete tool:", e);
    }
  }, [loadCustomTools]);

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
    localStorage.setItem("nolock.toolMaxIterations", String(maxIterations));
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

          {supportsTools && (
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", display: "block", marginBottom: 4 }}>
                Max Tool Iterations
              </label>
              <input
                className="field-input"
                type="number"
                min={1}
                max={100}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Math.max(1, parseInt(e.target.value, 10) || 1))}
                style={{ fontSize: 12, padding: "6px 8px", width: 80 }}
              />
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
                How many tool calls the agent can make per request before stopping (default: 10).
              </div>
            </div>
          )}

          {/* --- Custom Tools (from .tools/) --- */}
          {supportsTools && rootPath && (
            <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Custom Tools</span>
                {!showNewToolForm && (
                  <button className="btn-secondary" onClick={startCreateTool} style={{ fontSize: 11, padding: "3px 10px" }}>
                    + New Tool
                  </button>
                )}
              </div>

              {/* New Tool Form */}
              {showNewToolForm && (
                <div style={{
                  marginBottom: 12,
                  padding: "10px 12px",
                  background: "var(--bg-secondary)",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}>
                  <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Create Custom Tool</div>

                  <label style={{ display: "block", color: "var(--text-secondary)", marginBottom: 2, fontSize: 11 }}>Name</label>
                  <input
                    className="field-input"
                    value={toolForm.name}
                    onChange={(e) => setToolForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="my_tool"
                    style={{ fontSize: 12, padding: "5px 8px", marginBottom: 8, width: "100%" }}
                  />

                  <label style={{ display: "block", color: "var(--text-secondary)", marginBottom: 2, fontSize: 11 }}>Description</label>
                  <input
                    className="field-input"
                    value={toolForm.description}
                    onChange={(e) => setToolForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder="What this tool does (shown to the AI)"
                    style={{ fontSize: 12, padding: "5px 8px", marginBottom: 8, width: "100%" }}
                  />

                  <label style={{ display: "block", color: "var(--text-secondary)", marginBottom: 2, fontSize: 11 }}>Command</label>
                  <input
                    className="field-input"
                    value={toolForm.command}
                    onChange={(e) => setToolForm((p) => ({ ...p, command: e.target.value }))}
                    placeholder="wc {path}"
                    style={{ fontSize: 12, padding: "5px 8px", marginBottom: 8, width: "100%" }}
                  />
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: -6, marginBottom: 8 }}>
                    Use <code>{'{param_name}'}</code> placeholders for AI-provided arguments.
                  </div>

                  <label style={{ display: "block", color: "var(--text-secondary)", marginBottom: 2, fontSize: 11 }}>Parameters (JSON Schema)</label>
                  <textarea
                    className="field-input"
                    value={toolForm.parameters}
                    onChange={(e) => setToolForm((p) => ({ ...p, parameters: e.target.value }))}
                    rows={5}
                    style={{ fontSize: 11, padding: "5px 8px", marginBottom: 8, width: "100%", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", resize: "vertical" }}
                  />
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: -6, marginBottom: 8 }}>
                    JSON Schema defining the tool's parameters. See <code>.tools/example.json</code> for reference.
                  </div>

                  {toolFormError && (
                    <div style={{ color: "#e06c75", fontSize: 11, marginBottom: 8 }}>{toolFormError}</div>
                  )}

                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button className="btn-secondary" onClick={cancelCreateTool} disabled={saving} style={{ fontSize: 11, padding: "4px 12px" }}>Cancel</button>
                    <button className="btn-primary" onClick={createCustomTool} disabled={saving} style={{ fontSize: 11, padding: "4px 12px" }}>{saving ? "Creating..." : "Create Tool"}</button>
                  </div>
                </div>
              )}

              {/* Custom tool list */}
              {customTools.length === 0 && !showNewToolForm && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                  No custom tools yet. Create JSON files in <code>.tools/</code> or click "+ New Tool".
                </div>
              )}
              {customTools.map((tool) => (
                <div
                  key={tool.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    fontSize: 12,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div>
                    <span style={{ color: "var(--text-primary)", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 11 }}>
                      {tool.name}
                    </span>
                    {tool.description && (
                      <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: 11 }}>{tool.description}</span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteCustomTool(tool)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: "0 4px",
                      lineHeight: 1,
                    }}
                    title="Delete tool"
                  >
                    &times;
                  </button>
                </div>
              ))}
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
