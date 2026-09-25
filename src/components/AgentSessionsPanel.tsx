import { useEffect, useState } from "react";
import { listSessions, deleteSession, formatSessionTime, type SessionRecord } from "../lib/sessions";
import AgentUsage from "./AgentUsage";
import SessionSummary from "./SessionSummary";

export default function AgentSessionsPanel({ visible, rootPath, onClose }: { visible: boolean; rootPath: string; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setSessions([]); setSelected(null); setError("");
    const refresh = () => { void listSessions(rootPath).then(all => {
      if (active) { setSessions(all.filter(s => s.agent)); setError(""); }
    }).catch(() => { if (active) setError("Could not load agent sessions."); }); };
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [visible, rootPath]);
  if (!visible) return null;
  const current = sessions.find(s => s.id === selected);
  if (current) return <SessionSummary session={current} rootPath={rootPath} onClose={() => setSelected(null)} />;
  return <div className="modal-overlay" onClick={onClose}><div className="modal mcp-modal" role="dialog" aria-modal="true" aria-labelledby="agent-sessions-title" onClick={e => e.stopPropagation()}>
    <div className="modal-header"><span id="agent-sessions-title">Terminal agent sessions</span><button aria-label="Close agent sessions" onClick={onClose}>×</button></div>
    <div className="modal-body mcp-body">
      <p>Each coding-agent launch is saved separately, including concurrent runs in different terminals. Output is recorded automatically; native agent conversation histories remain in their usual locations.</p>
      <AgentUsage rootPath={rootPath} />
      <h3>Terminal recordings</h3>
      {!rootPath && <p>Open a project to see its agent sessions.</p>}
      {rootPath && !sessions.length && <p>No agent sessions yet. Start codex, claude or opencode in a terminal, or use <code>nolock-agent run COMMAND</code> for another agent.</p>}
      <ul className="mcp-server-list">{sessions.map(session => <li key={session.id}>
        <button className="agent-session-open" onClick={() => setSelected(session.id)}><strong>{session.summary}</strong>
          <span>{formatSessionTime(session.createdAt)} · {session.agent?.terminalId} · {session.agent?.interrupted ? "Interrupted" : session.status === "active" ? "Running" : `Exited ${session.agent?.exitCode ?? "—"}`}</span></button>
        <button className="btn-secondary" aria-label={`Delete ${session.summary}`} onClick={() => {
          void deleteSession(rootPath, session.id).then(() => setSessions(prev => prev.filter(s => s.id !== session.id))).catch(() => setError("Could not delete the session."));
        }}>Delete recording</button>
      </li>)}</ul>
      {error && <p role="alert">{error}</p>}
    </div>
  </div></div>;
}
