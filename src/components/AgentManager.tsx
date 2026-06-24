import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  description: string;
  prompt: string;
  /** Optional model override — empty string means "use default chat model". */
  model: string;
  /** Optional temperature override (0.0–2.0). */
  temperature: number;
}

export interface AgentEntry {
  name: string;
  path: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath: string;
  /** Called after creating/updating an agent so the parent can refresh. */
  onAgentsChanged?: () => void;
}

// ---------------------------------------------------------------------------
// Default config for a new agent
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AgentConfig = {
  name: "",
  description: "",
  prompt: "",
  model: "",
  temperature: 0.7,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentManager({ visible, onClose, rootPath, onAgentsChanged }: Props) {
  // Agent list
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // Editor state: null = list view, AgentConfig = editing/creating
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [isNew, setIsNew] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Load agents on mount / visibility change ----
  const loadAgents = useCallback(async () => {
    if (!rootPath) return;
    setLoadingList(true);
    try {
      const entries: AgentEntry[] = await invoke("list_agents", { rootPath });
      setAgents(entries);
    } catch (e) {
      console.error("Failed to load agents:", e);
      setAgents([]);
    }
    setLoadingList(false);
  }, [rootPath]);

  useEffect(() => {
    if (visible && rootPath) {
      loadAgents();
    }
  }, [visible, rootPath, loadAgents]);

  // ---- Start creating a new agent ----
  const startNew = useCallback(() => {
    setEditing({ ...DEFAULT_CONFIG });
    setIsNew(true);
    setError(null);
  }, []);

  // ---- Start editing an existing agent ----
  const startEdit = useCallback(async (entry: AgentEntry) => {
    setError(null);
    try {
      const data: any = await invoke("read_agent", { path: entry.path });
      const config: AgentConfig = {
        name: data.name || entry.name,
        description: data.description || "",
        prompt: data.prompt || "",
        model: data.model || "",
        temperature: typeof data.temperature === "number" ? data.temperature : 0.7,
      };
      setEditing(config);
      setIsNew(false);
    } catch (e) {
      setError(`Failed to read agent: ${e}`);
    }
  }, []);

  // ---- Cancel editing ----
  const cancelEdit = useCallback(() => {
    setEditing(null);
    setIsNew(false);
    setError(null);
  }, []);

  // ---- Save agent ----
  const saveAgent = useCallback(async () => {
    if (!editing || !editing.name.trim()) {
      setError("Agent name is required.");
      return;
    }
    if (!editing.prompt.trim()) {
      setError("Agent prompt is required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const fileName = `${editing.name.trim()}.json`;
      const filePath = `${rootPath}/.agents/${fileName}`;
      const content = JSON.stringify(editing, null, 2);

      await invoke("write_file", { path: filePath, content });
      await loadAgents();
      onAgentsChanged?.();
      setEditing(null);
      setIsNew(false);
    } catch (e) {
      setError(`Failed to save agent: ${e}`);
    }
    setSaving(false);
  }, [editing, rootPath, loadAgents, onAgentsChanged]);

  // ---- Delete agent ----
  const deleteAgent = useCallback(async (entry: AgentEntry) => {
    if (!confirm(`Delete agent "${entry.name}"?`)) return;
    try {
      await invoke("delete_file", { path: entry.path });
      await loadAgents();
      onAgentsChanged?.();
    } catch (e) {
      setError(`Failed to delete agent: ${e}`);
    }
  }, [loadAgents, onAgentsChanged]);

  // ---- Update a field in the editor ----
  const updateField = useCallback(<K extends keyof AgentConfig>(
    field: K,
    value: AgentConfig[K],
  ) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  }, [editing]);

  if (!visible) return null;

  // ===== Editor view =====
  if (editing) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal agent-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>{isNew ? "New Agent" : `Edit Agent: ${editing.name}`}</span>
            <button onClick={cancelEdit}>&times;</button>
          </div>
          <div className="modal-body">
            {error && <div className="agent-error">{error}</div>}

            <label className="field-label">Name</label>
            <input
              className="field-input"
              value={editing.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="e.g. code-reviewer"
              disabled={!isNew}
              style={!isNew ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
            />
            {!isNew && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                Rename by deleting and re-creating the agent file.
              </span>
            )}

            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={editing.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Short description for the @mention list"
            />

            <label className="field-label">System Prompt</label>
            <textarea
              className="field-input agent-prompt-input"
              value={editing.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder="You are an expert AI agent that..."
              rows={10}
              style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12, minHeight: 120 }}
            />

            <label className="field-label">Model Override (optional)</label>
            <input
              className="field-input"
              value={editing.model}
              onChange={(e) => updateField("model", e.target.value)}
              placeholder="Leave empty to use default chat model"
            />

            <label className="field-label">
              Temperature: {editing.temperature.toFixed(1)}
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={editing.temperature}
              onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)" }}>
              <span>Precise (0.0)</span>
              <span>Creative (2.0)</span>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
            <button className="btn-primary" onClick={saveAgent} disabled={saving}>
              {saving ? "Saving..." : "Save Agent"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== List view =====
  const noFolder = !rootPath;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal agent-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>AI Agents</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="agent-error">{error}</div>}

          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Agents are stored as JSON files in the <code style={{ background: "var(--bg-surface)", padding: "1px 5px", borderRadius: 3 }}>.agents/</code> folder.
            You can edit them here or directly in the file explorer.
            Use <strong>@agent-name</strong> in chat to invoke an agent.
          </div>

          {noFolder ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No folder is open. Open a folder first (Ctrl+F, O) to create and manage AI agents.
            </div>
          ) : loadingList ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Loading agents...
            </div>
          ) : agents.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No agents yet in this project. Create your first one!
            </div>
          ) : (
            <div className="agent-list">
              {agents.map((agent) => (
                <div key={agent.path} className="agent-list-item">
                  <div className="agent-list-item-info">
                    <span className="agent-list-item-name">{agent.name}</span>
                    <span className="agent-list-item-path">{agent.path}</span>
                  </div>
                  <div className="agent-list-item-actions">
                    <button
                      className="agent-action-btn"
                      onClick={() => startEdit(agent)}
                      title="Edit agent"
                    >
                      Edit
                    </button>
                    <button
                      className="agent-action-btn agent-action-btn-danger"
                      onClick={() => deleteAgent(agent)}
                      title="Delete agent"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button
            className="btn-primary"
            onClick={startNew}
            disabled={noFolder}
            title={noFolder ? "Open a folder first to create agents" : "Create a new agent"}
            style={noFolder ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            New Agent
          </button>
        </div>
      </div>
    </div>
  );
}
