import { useEffect, useState } from "react";
import { agentConversationLabel, readAgentConversation, listSessions, formatSessionTime, type SessionRecord } from "../lib/sessions";
import { flushTerminalActivity, readTerminalActivity, terminalDisplayText } from "../lib/terminalSessions";
import SessionSummary from "./SessionSummary";

type Entry = { session: SessionRecord; text: string; terminal: boolean; chat: boolean };
export default function SessionsPanel({ visible, rootPath, onClose }: { visible: boolean; rootPath: string; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setEntries([]); setSelected(null); setQuery(""); setError(""); setLoading(!!rootPath);
    const refresh = async () => {
      if (!rootPath) return;
      try {
        await flushTerminalActivity();
        const sessions = await listSessions(rootPath);
        const next: Entry[] = [];
        let partial = false;
        for (const session of sessions) {
          if (cancelled) return;
          const events = await readTerminalActivity(rootPath, session.id).catch(() => { partial = true; return []; });
          const native = agentConversationLabel(session.agent?.name) ? await readAgentConversation(rootPath, session.id).catch(() => { partial = true; return null; }) : null;
          const messages = native?.selectedId ? native.messages : session.messages ?? [];
          next.push({ session, terminal: !!session.agent || events.length > 0, chat: !session.agent && (session.messageCount > 0 || !!session.messages?.length),
            text: terminalDisplayText([session.summary, session.firstMessage, session.lastMessage, session.agent?.terminalId,
              ...messages.flatMap(m => [m.content, m.displayContent, m.reasoning, ...(m.toolCalls ?? []).flatMap(t => [t.name, t.arguments, t.result_full, t.result_snippet])]),
              ...events.flatMap(e => [e.label, e.terminalId, e.text])].filter(Boolean).join("\n")) });
        }
        if (!cancelled) { setEntries(next); setError(partial ? "Some terminal recordings or agent conversations could not be searched." : ""); }
      } catch (e) { if (!cancelled) setError(`Could not load sessions: ${String(e)}`); }
      finally { if (!cancelled) { setLoading(false); timer = setTimeout(refresh, 2000); } }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, rootPath]);
  if (!visible) return null;
  const current = entries.find(e => e.session.id === selected)?.session;
  if (current) return <SessionSummary session={current} rootPath={rootPath} onClose={() => setSelected(null)} />;
  const needle = query.trim().toLocaleLowerCase();
  const results = entries.filter(e => (filter === "all" || (filter === "terminal" ? e.terminal : e.chat)) && e.text.toLocaleLowerCase().includes(needle));
  return <div className="modal-overlay" onClick={onClose}><div className="modal mcp-modal" role="dialog" aria-modal="true" aria-labelledby="sessions-title" onClick={e => e.stopPropagation()}>
    <div className="modal-header"><span id="sessions-title">Sessions</span><button aria-label="Close sessions" onClick={onClose}>×</button></div>
    <div className="modal-body mcp-body">
      <div className="sessions-search"><input autoFocus aria-label="Search sessions" placeholder="Search messages, tools and terminal recordings…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Session type" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All sessions</option><option value="chat">Chat</option><option value="terminal">Terminal</option></select></div>
      <p>Search this project's chat history and saved terminal recordings. Open a session to inspect its messages, tools, usage and terminal activity.</p>
      {loading && <p role="status">Refreshing sessions…</p>}
      {error && <p role="alert">{error}</p>}
      {!rootPath ? <p>Open a project to browse sessions.</p> : !loading && !results.length && <p>{needle ? "No matching sessions." : "No sessions yet."}</p>}
      <ul className="mcp-server-list">{results.map(({ session, text, terminal, chat }) => {
        const match = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
        return <li key={session.id}><button className="agent-session-open" onClick={() => setSelected(session.id)}><strong>{session.summary || session.firstMessage || session.id}</strong><span>{terminal && chat ? "Chat + Terminal" : terminal ? "Terminal" : "Chat"} · {formatSessionTime(session.updatedAt)} · {session.status}</span>{match >= 0 && <span className="session-match">{text.slice(Math.max(0, match - 50), match + needle.length + 120)}</span>}</button></li>;
      })}</ul>
    </div>
  </div></div>;
}
