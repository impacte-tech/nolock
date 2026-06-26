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

export interface SkillEntry {
  name: string;
  path: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath: string;
  /** Called after creating/updating an agent so the parent can refresh. */
  onAgentsChanged?: () => void;
  /** Called when user wants to edit a skill in the main editor. */
  onOpenFile?: (path: string, name: string) => void;
  /** Which tab to show when opened (default: "agents"). */
  initialTab?: "agents" | "skills";
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

export default function AgentManager({ visible, onClose, rootPath, onAgentsChanged, onOpenFile, initialTab }: Props) {
  // Tab state — reset to initialTab whenever the modal becomes visible
  const [activeTab, setActiveTab] = useState<"agents" | "skills">(initialTab || "agents");

  useEffect(() => {
    if (visible && initialTab) {
      setActiveTab(initialTab);
    }
  }, [visible, initialTab]);

  // ---- Agent state ----
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // Agent editor state: null = list view, AgentConfig = editing/creating
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [isNew, setIsNew] = useState(false);

  // Agent save state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Skill state ----
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");

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

  // ---- Load skills on mount / visibility change / tab switch ----
  const loadSkills = useCallback(async () => {
    if (!rootPath) return;
    setLoadingSkills(true);
    try {
      const entries: SkillEntry[] = await invoke("list_skills", { rootPath });
      setSkills(entries);
    } catch (e) {
      console.error("Failed to load skills:", e);
      setSkills([]);
    }
    setLoadingSkills(false);
  }, [rootPath]);

  // Load skills whenever visible (needed for the agent editor's skill reference section too)
  useEffect(() => {
    if (visible && rootPath) {
      loadSkills();
    }
  }, [visible, rootPath, loadSkills]);

  // ---- Agent actions ----

  const startNew = useCallback(() => {
    setEditing({ ...DEFAULT_CONFIG });
    setIsNew(true);
    setError(null);
  }, []);

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

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setIsNew(false);
    setError(null);
  }, []);

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
      const fileName = `${editing.name.trim()}.md`;
      const filePath = `${rootPath}/.agents/${fileName}`;
      // Format as markdown with YAML-like frontmatter
      const content = `---
name: ${editing.name}
description: ${editing.description || ""}
model: ${editing.model || ""}
temperature: ${editing.temperature}
---

${editing.prompt}`;

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

  const updateAgentField = useCallback(<K extends keyof AgentConfig>(
    field: K,
    value: AgentConfig[K],
  ) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  }, [editing]);

  // ---- Skill actions ----

  const startCreateSkill = useCallback(() => {
    setCreatingSkill(true);
    setNewSkillName("");
    setError(null);
  }, []);

  const cancelCreateSkill = useCallback(() => {
    setCreatingSkill(false);
    setNewSkillName("");
    setError(null);
  }, []);

  const createSkill = useCallback(async () => {
    const name = newSkillName.trim();
    if (!name) {
      setError("Skill name is required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const fileName = `${name}.md`;
      const filePath = `${rootPath}/.skills/${fileName}`;
      const content = `# ${name}\n\nYour skill description and instructions here.\n`;
      await invoke("write_file", { path: filePath, content });
      setCreatingSkill(false);
      setNewSkillName("");
      await loadSkills();
    } catch (e) {
      setError(`Failed to create skill: ${e}`);
    }
    setSaving(false);
  }, [newSkillName, rootPath, loadSkills]);

  const editSkill = useCallback(async (entry: SkillEntry) => {
    onOpenFile?.(entry.path, entry.name);
    onClose();
  }, [onOpenFile, onClose]);

  const deleteSkill = useCallback(async (entry: SkillEntry) => {
    if (!confirm(`Delete skill "${entry.name}"?`)) return;
    try {
      await invoke("delete_file", { path: entry.path });
      await loadSkills();
    } catch (e) {
      setError(`Failed to delete skill: ${e}`);
    }
  }, [loadSkills]);

  /** Append a skill's content to the agent prompt being edited. */
  const appendSkillToPrompt = useCallback(async (entry: SkillEntry) => {
    if (!editing) return;
    try {
      const content: string = await invoke("read_file", { path: entry.path });
      const appendText = `\n\n---\n## Referenced Skill: ${entry.name}\n${content}\n---`;
      setEditing({ ...editing, prompt: editing.prompt + appendText });
    } catch (e) {
      setError(`Failed to read skill: ${e}`);
    }
  }, [editing]);

  if (!visible) return null;

  // ===== Tab bar =====
  const renderTabBar = () => (
    <div className="agent-tab-bar">
      <button
        className={`agent-tab ${activeTab === "agents" ? "active" : ""}`}
        onClick={() => setActiveTab("agents")}
      >
        Agents
      </button>
      <button
        className={`agent-tab ${activeTab === "skills" ? "active" : ""}`}
        onClick={() => setActiveTab("skills")}
      >
        Skills
      </button>
    </div>
  );

  // ===== Agent editor view =====
  if (editing && activeTab === "agents") {
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
              onChange={(e) => updateAgentField("name", e.target.value)}
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
              onChange={(e) => updateAgentField("description", e.target.value)}
              placeholder="Short description for the @mention list"
            />

            <label className="field-label">System Prompt</label>
            <textarea
              className="field-input agent-prompt-input"
              value={editing.prompt}
              onChange={(e) => updateAgentField("prompt", e.target.value)}
              placeholder="You are an expert AI agent that..."
              rows={10}
              style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12, minHeight: 120 }}
            />

            {/* ---- Referenced Skills section ---- */}
            {skills.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label className="field-label">Referenced Skills</label>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                  Click a skill to append its content to the prompt above.
                </div>
                <div className="agent-list" style={{ maxHeight: 150, overflowY: "auto" }}>
                  {skills.map((skill) => (
                    <div key={skill.path} className="agent-list-item" style={{ padding: "4px 8px" }}>
                      <div className="agent-list-item-info">
                        <span className="agent-list-item-name">{skill.name}</span>
                      </div>
                      <button
                        className="agent-action-btn"
                        onClick={() => appendSkillToPrompt(skill)}
                        title="Append skill content to prompt"
                        style={{ fontSize: 11, padding: "2px 8px" }}
                      >
                        Append to prompt
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <label className="field-label">Model Override (optional)</label>
            <input
              className="field-input"
              value={editing.model}
              onChange={(e) => updateAgentField("model", e.target.value)}
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
              onChange={(e) => updateAgentField("temperature", parseFloat(e.target.value))}
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

  // ===== Skills: creation form =====
  if (creatingSkill) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal agent-manager-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>New Skill</span>
            <button onClick={cancelCreateSkill}>&times;</button>
          </div>
          <div className="modal-body">
            {error && <div className="agent-error">{error}</div>}
            <label className="field-label">Skill Name</label>
            <input
              className="field-input"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="e.g. code-review-checklist"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") createSkill(); }}
            />
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
              A markdown file will be created at <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>.skills/{newSkillName || "..."}.md</code>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={cancelCreateSkill}>Cancel</button>
            <button className="btn-primary" onClick={createSkill} disabled={saving || !newSkillName.trim()}>
              {saving ? "Creating..." : "Create Skill"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== List view: shared layout with tabs =====
  const noFolder = !rootPath;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal agent-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>AI Agents & Skills</span>
          </div>
          <button onClick={onClose}>&times;</button>
        </div>
        {renderTabBar()}
        <div className="modal-body">
          {error && <div className="agent-error">{error}</div>}

          {noFolder ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No folder is open. Open a folder first (Ctrl+F, O) to create and manage AI agents and skills.
            </div>
          ) : activeTab === "agents" ? (
            // ===== Agents list =====
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Agents are stored as markdown files in the <code style={{ background: "var(--bg-surface)", padding: "1px 5px", borderRadius: 3 }}>.agents/</code> folder.
                You can edit them here or directly in the file explorer.
                Use <strong>@agent-name</strong> in chat to invoke an agent.
              </div>
              {loadingList ? (
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
            </>
          ) : (
            // ===== Skills list =====
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Skills are markdown files stored in the <code style={{ background: "var(--bg-surface)", padding: "1px 5px", borderRadius: 3 }}>.skills/</code> folder.
                Create them here, in the terminal, or in the file editor.
                Agents can reference skills to include their content as context.
              </div>
              {loadingSkills ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  Loading skills...
                </div>
              ) : skills.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  No skills yet in this project. Create your first one!
                </div>
              ) : (
                <div className="agent-list">
                  {skills.map((skill) => (
                    <div key={skill.path} className="agent-list-item">
                      <div className="agent-list-item-info">
                        <span className="agent-list-item-name">{skill.name}</span>
                        <span className="agent-list-item-path">{skill.path}</span>
                      </div>
                      <div className="agent-list-item-actions">
                        <button
                          className="agent-action-btn"
                          onClick={() => editSkill(skill)}
                          title="Edit skill in editor"
                        >
                          Edit
                        </button>
                        <button
                          className="agent-action-btn agent-action-btn-danger"
                          onClick={() => deleteSkill(skill)}
                          title="Delete skill"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          {activeTab === "agents" ? (
            <button
              className="btn-primary"
              onClick={startNew}
              disabled={noFolder}
              title={noFolder ? "Open a folder first to create agents" : "Create a new agent"}
              style={noFolder ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              New Agent
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={startCreateSkill}
              disabled={noFolder}
              title={noFolder ? "Open a folder first to create skills" : "Create a new skill"}
              style={noFolder ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              New Skill
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
