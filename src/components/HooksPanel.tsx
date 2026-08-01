import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type HookConfig,
  type HookEntryWithConfig,
  type HookTrigger,
  listHookEntriesWithConfig,
  runHook,
  saveHook,
} from "../lib/hooks";
import { describeCron } from "../lib/cron";

// ---------------------------------------------------------------------------
// Built-in tool ids (mirrors the AVAILABLE_TOOLS list in ToolsPanel.tsx).
// Custom tools from `.tools/` are appended dynamically.
// ---------------------------------------------------------------------------
const BUILTIN_TOOLS = [
  "web_search",
  "web_fetch",
  "grep",
  "read_file",
  "edit",
  "write_file",
  "list_directory",
  "rust_repl",
  "bash_sandbox",
];

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath: string;
}

interface AgentEntry {
  name: string;
  path: string;
}

interface SkillEntry {
  name: string;
  path: string;
}

interface CustomToolEntry {
  name: string;
  path: string;
  description: string;
}

function emptyConfig(): HookConfig {
  return {
    name: "",
    description: "",
    trigger: { type: "command", command: "" },
    agent: { name: "", prompt: "", skills: [], tools: [] },
  };
}

function triggerLabel(config: HookConfig): string {
  const t = config.trigger;
  if (t.type === "command") return `After command: \`${t.command || "(empty)"}\``;
  if (t.type === "cron") {
    const desc = describeCron(t.schedule);
    return desc ? `Cron: ${desc}` : `Cron: \`${t.schedule || "(empty)"}\``;
  }
  return "Unknown trigger";
}

export default function HooksPanel({ visible, onClose, rootPath }: Props) {
  // ---- List state ----
  const [hooks, setHooks] = useState<HookEntryWithConfig[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // ---- Editor state ----
  const [editing, setEditing] = useState<HookConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Reference lists for the editor ----
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [customTools, setCustomTools] = useState<CustomToolEntry[]>([]);

  const loadHooks = useCallback(async () => {
    if (!rootPath) {
      setHooks([]);
      return;
    }
    setLoadingList(true);
    try {
      setHooks(await listHookEntriesWithConfig(rootPath));
    } catch (e) {
      console.error("Failed to load hooks:", e);
      setHooks([]);
    }
    setLoadingList(false);
  }, [rootPath]);

  const loadReferenceLists = useCallback(async () => {
    if (!rootPath) return;
    try {
      const [agentList, skillList, toolList] = await Promise.all([
        invoke<AgentEntry[]>("list_agents", { rootPath }),
        invoke<SkillEntry[]>("list_skills", { rootPath }),
        invoke<CustomToolEntry[]>("list_tools", { rootPath }),
      ]);
      setAgents(agentList);
      setSkills(skillList);
      setCustomTools(toolList);
    } catch (e) {
      console.error("Failed to load agent/skill/tool lists:", e);
    }
  }, [rootPath]);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    loadHooks();
    loadReferenceLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rootPath]);

  // ---- List actions ----

  const startNew = useCallback(() => {
    setEditing(emptyConfig());
    setIsNew(true);
    setError(null);
  }, []);

  const startEdit = useCallback((item: HookEntryWithConfig) => {
    setEditing({
      ...item.config,
      agent: { ...item.config.agent, skills: [...item.config.agent.skills], tools: [...item.config.agent.tools] },
    });
    setIsNew(false);
    setError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setIsNew(false);
    setError(null);
  }, []);

  const deleteHook = useCallback(async (item: HookEntryWithConfig) => {
    if (!confirm(`Delete hook "${item.config.name}"?`)) return;
    try {
      await invoke("delete_file", { path: item.entry.path });
      await loadHooks();
    } catch (e) {
      setError(`Failed to delete hook: ${e}`);
    }
  }, [loadHooks]);

  const runNow = useCallback(async (item: HookEntryWithConfig) => {
    try {
      // Fire-and-forget: the run continues in the background and its feedback
      // appears as a hook run card in the chat panel (which auto-opens).
      await runHook(rootPath, item.config, { kind: "manual" });
    } catch (e) {
      setError(`Failed to run hook: ${e}`);
    }
  }, [rootPath]);

  // ---- Editor actions ----

  const updateField = useCallback(<K extends keyof HookConfig>(field: K, value: HookConfig[K]) => {
    setEditing((prev) => (prev ? { ...prev, [field]: value } : prev));
  }, []);

  const updateTrigger = useCallback((trigger: HookTrigger) => {
    setEditing((prev) => (prev ? { ...prev, trigger } : prev));
  }, []);

  const toggleListItem = useCallback(
    (field: "skills" | "tools", name: string) => {
      setEditing((prev) => {
        if (!prev) return prev;
        const list = prev.agent[field];
        const next = list.includes(name) ? list.filter((s) => s !== name) : [...list, name];
        return { ...prev, agent: { ...prev.agent, [field]: next } };
      });
    },
    [],
  );

  const save = useCallback(async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setError("Hook name is required.");
      return;
    }
    if (editing.trigger.type === "command" && !editing.trigger.command.trim()) {
      setError("A command pattern is required for command-triggered hooks (e.g. \"git commit\").");
      return;
    }
    if (editing.trigger.type === "cron" && !editing.trigger.schedule.trim()) {
      setError("A cron schedule is required (e.g. \"0 9 * * 1-5\").");
      return;
    }
    if (!editing.agent.prompt.trim() && !editing.agent.name.trim()) {
      setError("Choose an agent or provide an inline system prompt.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveHook(rootPath, name, editing);
      setEditing(null);
      setIsNew(false);
      await loadHooks();
    } catch (e) {
      setError(`Failed to save hook: ${e}`);
    }
    setSaving(false);
  }, [editing, rootPath, loadHooks]);

  if (!visible) return null;

  // ===== Editor view =====
  if (editing) {
    const isCommand = editing.trigger.type === "command";
    const cronDesc = editing.trigger.type === "cron" ? describeCron(editing.trigger.schedule) : undefined;
    const toolOptions = [
      ...BUILTIN_TOOLS.map((id) => ({ id, label: id, custom: false })),
      ...customTools.map((t) => ({ id: t.name, label: t.name, custom: true })),
    ];

    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal hook-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>{isNew ? "New Hook" : `Edit Hook: ${editing.name}`}</span>
            <button onClick={cancelEdit}>&times;</button>
          </div>
          <div className="modal-body">
            {error && <div className="agent-error">{error}</div>}

            <label className="field-label">Name</label>
            <input
              className="field-input"
              value={editing.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="e.g. commit-review"
              disabled={!isNew}
              style={!isNew ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
            />
            {!isNew && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                Rename by deleting and re-creating the hook file.
              </span>
            )}

            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={editing.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Short description of what this hook does"
            />

            {/* ---- Trigger ---- */}
            <label className="field-label">Trigger</label>
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="radio"
                  name="hook-trigger"
                  checked={isCommand}
                  onChange={() => updateTrigger({ type: "command", command: editing.trigger.type === "command" ? editing.trigger.command : "git commit" })}
                  style={{ accentColor: "var(--accent)" }}
                />
                CLI command
              </label>
              <label style={{ fontSize: 12, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="radio"
                  name="hook-trigger"
                  checked={!isCommand}
                  onChange={() => updateTrigger({ type: "cron", schedule: editing.trigger.type === "cron" ? editing.trigger.schedule : "0 9 * * 1-5" })}
                  style={{ accentColor: "var(--accent)" }}
                />
                Cron schedule
              </label>
            </div>

            {isCommand ? (
              <>
                <input
                  className="field-input"
                  value={editing.trigger.type === "command" ? editing.trigger.command : ""}
                  onChange={(e) => updateTrigger({ type: "command", command: e.target.value })}
                  placeholder="git commit"
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                  Fires after any command whose leading words match — e.g. <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>git commit</code> matches <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>git commit -m "hi"</code>. Fires whether you or the AI run it.
                </div>
              </>
            ) : (
              <>
                <input
                  className="field-input"
                  value={editing.trigger.type === "cron" ? editing.trigger.schedule : ""}
                  onChange={(e) => updateTrigger({ type: "cron", schedule: e.target.value })}
                  placeholder="0 9 * * 1-5"
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  5-field cron: <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>minute hour day-of-month month day-of-week</code>
                  {cronDesc ? <span style={{ color: "var(--accent)" }}> — {cronDesc}</span> : null}
                  {editing.trigger.type === "cron" && editing.trigger.schedule.trim() && !cronDesc ? (
                    <span style={{ color: "#e5c07b" }}> (schedule too complex to describe in one line)</span>
                  ) : null}
                </div>
              </>
            )}

            {/* ---- Agent ---- */}
            <label className="field-label">Agent (optional)</label>
            <select
              className="field-input"
              value={editing.agent.name}
              onChange={(e) => setEditing((prev) => (prev ? { ...prev, agent: { ...prev.agent, name: e.target.value } } : prev))}
              style={{ fontSize: 12 }}
            >
              <option value="">None — use inline prompt below</option>
              {agents.map((a) => (
                <option key={a.path} value={a.name}>{a.name}</option>
              ))}
            </select>
            {editing.agent.name && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                Uses the system prompt from <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>.agents/{editing.agent.name}</code> unless an inline prompt is set.
              </div>
            )}

            <label className="field-label">Inline System Prompt (takes precedence)</label>
            <textarea
              className="field-input agent-prompt-input"
              value={editing.agent.prompt}
              onChange={(e) => setEditing((prev) => (prev ? { ...prev, agent: { ...prev.agent, prompt: e.target.value } } : prev))}
              placeholder="You are a commit-review hook. Inspect the staged changes..."
              rows={6}
              style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12, minHeight: 90 }}
            />

            {/* ---- Skills ---- */}
            <label className="field-label">Skills</label>
            {skills.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", marginBottom: 8 }}>
                No skills yet. Create markdown files in <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>.skills/</code>.
              </div>
            ) : (
              <div className="agent-list" style={{ maxHeight: 130, overflowY: "auto", marginBottom: 8 }}>
                {skills.map((s) => (
                  <label key={s.path} className="hook-check-item">
                    <input
                      type="checkbox"
                      checked={editing.agent.skills.includes(s.name)}
                      onChange={() => toggleListItem("skills", s.name)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <span className="hook-check-label">/{s.name}</span>
                  </label>
                ))}
              </div>
            )}

            {/* ---- Tools ---- */}
            <label className="field-label">Tools</label>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              Leave empty to use your global enabled tools (Tools panel).
            </div>
            <div className="agent-list" style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
              {toolOptions.map((t) => (
                <label key={t.id} className="hook-check-item">
                  <input
                    type="checkbox"
                    checked={editing.agent.tools.includes(t.id)}
                    onChange={() => toggleListItem("tools", t.id)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span className="hook-check-label">{t.id}{t.custom ? " (custom)" : ""}</span>
                </label>
              ))}
            </div>

            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Saved to <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 2 }}>.hooks/{editing.name.trim() || "..."}.yaml</code>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save Hook"}
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
      <div className="modal hook-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Hooks</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="agent-error">{error}</div>}

          {noFolder ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No folder is open. Open a folder first (Ctrl+F, O) to create and manage hooks.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Hooks are YAML files in the <code style={{ background: "var(--bg-surface)", padding: "1px 5px", borderRadius: 3 }}>.hooks/</code> folder. They trigger an agent after a CLI command, on a cron schedule, or manually with <strong>!hook-name</strong> in chat. Feedback appears in the chat panel.
              </div>
              {loadingList ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  Loading hooks...
                </div>
              ) : hooks.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  No hooks yet in this project. Create your first one!
                </div>
              ) : (
                <div className="agent-list">
                  {hooks.map((item) => (
                    <div key={item.entry.path} className="agent-list-item">
                      <div className="agent-list-item-info">
                        <span className="agent-list-item-name">{item.config.name}</span>
                        <span className="agent-list-item-path">{triggerLabel(item.config)}</span>
                        {item.config.description && (
                          <span className="agent-list-item-path">{item.config.description}</span>
                        )}
                      </div>
                      <div className="agent-list-item-actions">
                        <button className="agent-action-btn" onClick={() => runNow(item)} title="Run this hook now">
                          Run now
                        </button>
                        <button className="agent-action-btn" onClick={() => startEdit(item)} title="Edit hook">
                          Edit
                        </button>
                        <button
                          className="agent-action-btn agent-action-btn-danger"
                          onClick={() => deleteHook(item)}
                          title="Delete hook"
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
          <button
            className="btn-primary"
            onClick={startNew}
            disabled={noFolder}
            title={noFolder ? "Open a folder first to create hooks" : "Create a new hook"}
            style={noFolder ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            New Hook
          </button>
        </div>
      </div>
    </div>
  );
}
