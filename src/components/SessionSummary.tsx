import { useState, useEffect, useRef } from "react";
import {
  type SessionRecord,
  summarizeUsage,
  formatTokens,
  formatSessionTime,
} from "../lib/sessions";
import { formatCurrency } from "../lib/pricing";

// ---------------------------------------------------------------------------
// SessionSummary — overlay shown when the user clicks a session in the agent
// chat. Displays the full session log (every user prompt + every tool call) and
// a token-expense summary split by provider / model, with an estimated USD cost
// when pricing is known for the models that were used.
// ---------------------------------------------------------------------------

interface Props {
  session: SessionRecord;
  onClose: () => void;
}

const PREVIEW_CHARS = 400;

function truncateText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One tool call row in the message log. */
function ToolCallRow({ call }: { call: { name: string; arguments: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="session-summary-toolcall">
      <span className="session-summary-toolcall-chevron">{open ? "\u25BC" : "\u25B6"}</span>
      <span className="session-summary-toolcall-name">{call.name}</span>
      {!open && call.arguments && (
        <span className="session-summary-toolcall-summary">{truncateText(call.arguments, 80)}</span>
      )}
      {open && call.arguments && (
        <pre className="session-summary-toolcall-args">{call.arguments}</pre>
      )}
    </div>
  );
}

/** A single message entry in the log. */
function LogMessage({ msg }: { msg: NonNullable<SessionRecord["messages"]>[number] }) {
  const [expanded, setExpanded] = useState(false);
  const raw = msg.displayContent || msg.content || "";
  const showToggle = raw.length > PREVIEW_CHARS;
  return (
    <div className={`session-summary-msg session-summary-msg-${msg.role}`}>
      <div className="session-summary-msg-header">
        <span className={`session-summary-msg-role ${msg.role}`}>{msg.role}</span>
        {msg.model && <span className="session-summary-msg-model" title={msg.model}>{msg.model}</span>}
        {msg.tokens != null && msg.tokens > 0 && (
          <span className="session-summary-msg-tokens">{msg.tokens.toLocaleString()} tok</span>
        )}
        <span className="session-summary-msg-time">
          {msg.createdAt ? formatSessionTime(msg.createdAt) : ""}
        </span>
      </div>
      {raw && (
        <div className="session-summary-msg-body" onClick={() => showToggle && setExpanded((e) => !e)}>
          {showToggle ? (
            <p className="session-summary-msg-text">
              {expanded ? raw : truncateText(raw, PREVIEW_CHARS)}
              {!expanded && <span className="session-summary-msg-more"> (click to expand)</span>}
            </p>
          ) : (
            <p className="session-summary-msg-text">{raw}</p>
          )}
        </div>
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="session-summary-toolcalls">
          {msg.toolCalls.map((tc, i) => (
            <ToolCallRow key={i} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function SessionSummary({ session, onClose }: Props) {
  const usageSummary = summarizeUsage(session.usage);
  const messages = session.messages ?? [];
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasCost = usageSummary.totalCost != null;
  const title = session.summary || session.firstMessage || session.id;

  return (
    <div className="session-summary-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} ref={rootRef}>
      <div className="session-summary">
        <div className="session-summary-header">
          <div className="session-summary-title-block">
            <span className="session-summary-title">{title}</span>
            <span className="session-summary-meta">
              {session.status}
              {" · created "}{formatSessionTime(session.createdAt)}
              {" · updated "}{formatSessionTime(session.updatedAt)}
            </span>
            <span className="session-summary-stats">
              {session.messageCount} msg{session.messageCount === 1 ? "" : "s"}
              {" · "}{session.toolCallCount} tool call{session.toolCallCount === 1 ? "" : "s"}
              {session.contextWindow > 0 && (
                <> {" · "}{formatTokens(session.tokenUsage)} / {formatTokens(session.contextWindow)} tok context</>
              )}
            </span>
          </div>
          <button className="session-summary-close" onClick={onClose} title="Close session summary">
            &times;
          </button>
        </div>

        {/* Token expenses — split by provider/model with price + cost. */}
        <div className="session-summary-section">
          <div className="session-summary-section-title">Token expenses</div>
          {usageSummary.rows.length === 0 ? (
            <div className="session-summary-empty">
              No token usage recorded for this session yet. Token counts appear
              per iteration after each request/response.
            </div>
          ) : (
            <>
              <div className="session-summary-total">
                <span>{formatTokens(usageSummary.totalTokens)} tokens</span>
                <span className={hasCost ? "session-summary-total-cost" : "session-summary-total-cost muted"}>
                  {hasCost ? `${formatCurrency(usageSummary.totalCost)} est.` : "cost unavailable"}
                </span>
              </div>
              <table className="session-summary-usage-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th className="num">Prompt</th>
                    <th className="num">Completion</th>
                    <th className="num">Total</th>
                    <th className="num">$/1M in/out</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usageSummary.rows.map((row) => (
                    <tr key={`${row.provider}-${row.model}`}>
                      <td>{row.provider}</td>
                      <td className="session-summary-model-cell" title={row.model}>{row.model}</td>
                      <td className="num">{formatTokens(row.promptTokens)}</td>
                      <td className="num">{formatTokens(row.completionTokens)}</td>
                      <td className="num">{formatTokens(row.totalTokens)}</td>
                      <td className="num">
                        {row.promptPricePerM != null
                          ? `$${row.promptPricePerM.toFixed(2)}/$${row.completionPricePerM?.toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="num">{formatCurrency(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* Full conversation log — every user prompt and tool call. */}
        <div className="session-summary-section">
          <div className="session-summary-section-title">
            Conversation log
            <span className="session-summary-section-sub">
              {messages.length} message{messages.length === 1 ? "" : "s"} — user prompts and tool calls are logged without exception
            </span>
          </div>
          {messages.length === 0 ? (
            <div className="session-summary-empty">No messages logged yet.</div>
          ) : (
            <div className="session-summary-messages">
              {messages.map((m, i) => (
                <LogMessage key={i} msg={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}