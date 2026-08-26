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
  /** Optional provider override — empty string means "use default chat backend". */
  backend: string;
  /** Comma-separated tool names the sub-agent may use; empty = default set. */
  tools: string;
  /** Micro-agent delegation (see plan: hierarchical-micro-agent-cascade). */
  canSpawnMicroAgents: boolean;
  allowedMicroAgents: string;
  /** Deterministic validation flags */
  validationRustCheck: boolean;
  validationJsTsLint: boolean;
  validationPythonCheck: boolean;
  validationGoCheck: boolean;
  validationRequireAllPass: boolean;
  validationMaxRetries: number;
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
  initialTab?: "agents" | "skills" | "micro-agents";
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
  backend: "",
  tools: "",
  canSpawnMicroAgents: false,
  allowedMicroAgents: "",
  validationRustCheck: false,
  validationJsTsLint: false,
  validationPythonCheck: false,
  validationGoCheck: false,
  validationRequireAllPass: true,
  validationMaxRetries: 3,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentManager({ visible, onClose, rootPath, onAgentsChanged, onOpenFile, initialTab }: Props) {
  // Tab state — reset to initialTab whenever the modal becomes visible
  const [activeTab, setActiveTab] = useState<"agents" | "skills" | "micro-agents">(initialTab || "agents");

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

  // ---- Micro-agent state ----
  const [microAgents, setMicroAgents] = useState<AgentEntry[]>([]);
  const [loadingMicroAgents, setLoadingMicroAgents] = useState(false);
  const [creatingMicroAgent, setCreatingMicroAgent] = useState(false);
  const [newMicroAgentName, setNewMicroAgentName] = useState("");

  // ---- Load micro-agents ----
  const loadMicroAgents = useCallback(async () => {
    if (!rootPath) return;
    setLoadingMicroAgents(true);
    try {
      const entries: AgentEntry[] = await invoke("list_micro_agents", { rootPath });
      setMicroAgents(entries);
    } catch (e) {
      console.error("Failed to load micro-agents:", e);
      setMicroAgents([]);
    }
    setLoadingMicroAgents(false);
  }, [rootPath]);

  useEffect(() => {
    if (visible && rootPath) {
      loadMicroAgents();
    }
  }, [visible, rootPath, loadMicroAgents]);

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
        backend: data.backend || "",
        tools: Array.isArray(data.tools) ? data.tools.join(", ") : (data.tools || ""),
        canSpawnMicroAgents: !!data.can_spawn_micro_agents,
        allowedMicroAgents: Array.isArray(data.allowed_micro_agents)
          ? data.allowed_micro_agents.join(", ")
          : (data.allowed_micro_agents || ""),
        validationRustCheck: !!data.validation?.rust_check,
        validationJsTsLint: !!data.validation?.js_ts_lint,
        validationPythonCheck: !!data.validation?.python_check,
        validationGoCheck: !!data.validation?.go_check,
        validationRequireAllPass: data.validation?.require_all_pass !== false,
        validationMaxRetries: typeof data.validation?.max_retries === "number"
          ? data.validation.max_retries
          : 3,
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
backend: ${editing.backend || ""}
temperature: ${editing.temperature}
tools: ${editing.tools || ""}
can_spawn_micro_agents: ${editing.canSpawnMicroAgents}
allowed_micro_agents: ${editing.allowedMicroAgents || "[]"}
validation:
  rust_check: ${editing.validationRustCheck}
  js_ts_lint: ${editing.validationJsTsLint}
  python_check: ${editing.validationPythonCheck}
  go_check: ${editing.validationGoCheck}
  require_all_pass: ${editing.validationRequireAllPass}
  max_retries: ${editing.validationMaxRetries}
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

  // ---- Micro-agent actions ----

  const startCreateMicroAgent = useCallback(() => {
    setCreatingMicroAgent(true);
    setNewMicroAgentName("");
    setError(null);
  }, []);

  const cancelCreateMicroAgent = useCallback(() => {
    setCreatingMicroAgent(false);
    setNewMicroAgentName("");
    setError(null);
  }, []);

  const createMicroAgent = useCallback(async () => {
    const name = newMicroAgentName.trim();
    if (!name) {
      setError("Micro-agent name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fileName = `${name}.md`;
      const filePath = `${rootPath}/.micro-agents/${fileName}`;
      const content = `---
name: ${name}
description: ${name}
model: qwen2.5-coder:1.5b
backend: ollama
temperature: 0.1
tools: [read_file, edit, write_file, bash_sandbox]
validation:
  max_retries: 3
---

You are a focused micro-agent for "${name}". Complete the task with MINIMAL
changes and verify your result with the configured validation commands.
`;
      await invoke("write_file", { path: filePath, content });
      setCreatingMicroAgent(false);
      setNewMicroAgentName("");
      await loadMicroAgents();
    } catch (e) {
      setError(`Failed to create micro-agent: ${e}`);
    }
    setSaving(false);
  }, [newMicroAgentName, rootPath, loadMicroAgents]);

  const editMicroAgent = useCallback(async (entry: AgentEntry) => {
    onOpenFile?.(entry.path, entry.name);
    onClose();
  }, [onOpenFile, onClose]);

  const deleteMicroAgent = useCallback(async (entry: AgentEntry) => {
    if (!confirm(`Delete micro-agent "${entry.name}"?`)) return;
    try {
      await invoke("delete_file", { path: entry.path });
      await loadMicroAgents();
    } catch (e) {
      setError(`Failed to delete micro-agent: ${e}`);
    }
  }, [loadMicroAgents]);

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
        className={`agent-tab ${activeTab === "micro-agents" ? "active" : ""}`}
        onClick={() => setActiveTab("micro-agents")}
      >
        Micro-Agents
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

            <label className="field-label">Provider Override (optional)</label>
            <select
              className="field-input"
              value={editing.backend}
              onChange={(e) => updateAgentField("backend", e.target.value)}
            >
              <option value="">Use default chat backend</option>
              <option value="ollama">Ollama (local executor)</option>
              <option value="llamacpp">llama.cpp (local executor)</option>
              <option value="openrouter">OpenRouter (online planning)</option>
              <option value="opencode">OpenCode Zen (online planning)</option>
              <option value="digitalocean">DigitalOcean Inference Router (online planning)</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
              When this agent runs as a sub-agent, it uses this provider instead of the main chat backend.
              Local executors (Ollama / llama.cpp) are cheap for focused tasks; online planning providers
              are better for complex reasoning.
            </span>

            <label className="field-label">Allowed Tools (comma-separated, optional)</label>
            <input
              className="field-input"
              value={editing.tools}
              onChange={(e) => updateAgentField("tools", e.target.value)}
              placeholder="e.g. read_file, grep, web_search (empty = default set)"
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
              Tools this sub-agent may use: read_file, list_directory, grep, edit, write_file,
              web_fetch, web_search, bash_sandbox. Leave empty for the default set.
            </span>

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

            {/* ---- Micro-agent delegation (hierarchical cascade) ---- */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid var(--border)` }}>
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={editing.canSpawnMicroAgents}
                  onChange={(e) => updateAgentField("canSpawnMicroAgents", e.target.checked)}
                  style={{ marginRight: 6, accentColor: "var(--accent)" }}
                />
                Can spawn micro-agents
              </label>
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
                When enabled, this sub-agent can delegate mechanical work (error fixes, lint, tests)
                to small micro-agents via the <code>spawn_micro_agent</code> tool.
              </span>

              <label className="field-label">Allowed Micro-Agents (comma-separated, optional)</label>
              <input
                className="field-input"
                value={editing.allowedMicroAgents}
                onChange={(e) => updateAgentField("allowedMicroAgents", e.target.value)}
                placeholder="e.g. rust-fixer, ts-type-fixer (empty = all)"
              />

              <label className="field-label" style={{ marginTop: 10 }}>Deterministic Validation</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 4 }}>
                {[
                  { key: "validationRustCheck", label: "cargo check" },
                  { key: "validationJsTsLint", label: "npm lint + tsc" },
                  { key: "validationPythonCheck", label: "ruff + py_compile" },
                  { key: "validationGoCheck", label: "go build + vet" },
                ].map((v) => (
                  <label key={v.key} style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={(editing as any)[v.key]}
                      onChange={(e) => updateAgentField(v.key as keyof AgentConfig, e.target.checked)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    {v.label}
                  </label>
                ))}
              </div>

              <div style={{ display: "flex", gap: 16, marginTop: 8, alignItems: "center" }}>
                <label style={{ fontSize: 11 }} className="field-label">
                  Max retries:
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={editing.validationMaxRetries}
                    onChange={(e) => updateAgentField("validationMaxRetries", parseInt(e.target.value) || 3)}
                    style={{ width: 52, marginLeft: 6 }}
                  />
                </label>
                <label style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }} className="field-label">
                  <input
                    type="checkbox"
                    checked={editing.validationRequireAllPass}
                    onChange={(e) => updateAgentField("validationRequireAllPass", e.target.checked)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  Require all checks to pass
                </label>
              </div>
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

  // ===== Micro-agent creation form =====
  if (creatingMicroAgent) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal agent-manager-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>New Micro-Agent</span>
            <button onClick={cancelCreateMicroAgent}>&times;</button>
          </div>
          <div className="modal-body">
            {error && <div className="agent-error">{error}</div>}
            <label className="field-label">Micro-Agent Name</label>
            <input
              className="field-input"
              value={newMicroAgentName}
              onChange={(e) => setNewMicroAgentName(e.target.value)}
              placeholder="e.g. rust-fixer"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") createMicroAgent(); }}
            />
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
              A markdown file will be created at <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>.micro-agents/{newMicroAgentName || "..."}.md</code>
              with sensible defaults (qwen2.5-coder, low temperature, validation retries).
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={cancelCreateMicroAgent}>Cancel</button>
            <button className="btn-primary" onClick={createMicroAgent} disabled={saving || !newMicroAgentName.trim()}>
              {saving ? "Creating..." : "Create Micro-Agent"}
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
          ) : activeTab === "micro-agents" ? (
            // ===== Micro-Agents list =====
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Micro-agents are small, focused agents stored in the <code style={{ background: "var(--bg-surface)", padding: "1px 5px", borderRadius: 3 }}>.micro-agents/</code> folder.
                Sub-agents with <strong>can_spawn_micro_agents</strong> enabled can delegate
                mechanical work (fixing errors, writing tests, lint) to them. Their results are
                validated with deterministic checks (cargo check, tsc, ruff, etc.).
              </div>
              {loadingMicroAgents ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  Loading micro-agents...
                </div>
              ) : microAgents.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  No micro-agents yet in this project. Create your first one!
                </div>
              ) : (
                <div className="agent-list">
                  {microAgents.map((agent) => (
                    <div key={agent.path} className="agent-list-item">
                      <div className="agent-list-item-info">
                        <span className="agent-list-item-name">{agent.name}</span>
                        <span className="agent-list-item-path">{agent.path}</span>
                      </div>
                      <div className="agent-list-item-actions">
                        <button
                          className="agent-action-btn"
                          onClick={() => editMicroAgent(agent)}
                          title="Edit micro-agent in editor"
                        >
                          Edit
                        </button>
                        <button
                          className="agent-action-btn agent-action-btn-danger"
                          onClick={() => deleteMicroAgent(agent)}
                          title="Delete micro-agent"
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
          ) : activeTab === "micro-agents" ? (
            <button
              className="btn-primary"
              onClick={startCreateMicroAgent}
              disabled={noFolder}
              title={noFolder ? "Open a folder first to create micro-agents" : "Create a new micro-agent"}
              style={noFolder ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              New Micro-Agent
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
