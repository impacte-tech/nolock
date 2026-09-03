import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  type SessionRecord,
  type SessionLogMessage,
  summarizeUsage,
  formatTokens,
  formatSessionTime,
} from "../lib/sessions";
import { formatCurrency } from "../lib/pricing";
import {
  type GitChangedFile,
  type GitFileDiff,
  listSessionChangedFiles,
  getSessionFileDiff,
  gitStatusBadge,
} from "../lib/git";

// ---------------------------------------------------------------------------
// SessionSummary — overlay shown when the user clicks a session in the agent
// chat. Displays the full session log (every user prompt + every tool call),
// a token-expense summary split by provider / model with an estimated USD cost
// when pricing is known for the models that were used, and the files the
// session changed (computed from git) with a per-file diff viewer.
// ---------------------------------------------------------------------------

interface Props {
  session: SessionRecord;
  /** Open project folder — used to compute the git changed-file list. */
  rootPath: string;
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

// ---------------------------------------------------------------------------
// Token expenses helpers
// ---------------------------------------------------------------------------

/** "$2.50 / $10.00" — per side "—" when unknown (never renders "undefined"). */
function formatPricePair(prompt: number | null, completion: number | null): string {
  if (prompt == null && completion == null) return "—";
  const p = prompt != null ? `$${prompt.toFixed(2)}` : "—";
  const c = completion != null ? `$${completion.toFixed(2)}` : "—";
  return `${p} / ${c}`;
}

// ---------------------------------------------------------------------------
// Changed files (git) — scrollable list + per-file diff viewer
// ---------------------------------------------------------------------------

/** Cap the rendered diff so a monster patch can't freeze the webview. */
const DIFF_MAX_LINES = 2000;

/** Diff line kind → the app's shared diff classes (same palette as the main
 *  chat's file-change diffs). */
function diffLineKind(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
  if (line.startsWith("diff --git")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  // File headers must be classified before the +/- prefixes ("+++ b/x" starts
  // with "+", "--- a/x" with "-"). Only the canonical header forms match so a
  // content line that happens to start with dashes stays a deletion.
  if (
    line.startsWith("--- a/") || line.startsWith("--- b/") || line.startsWith("--- i/") ||
    line.startsWith("--- /dev/null") ||
    line.startsWith("+++ a/") || line.startsWith("+++ b/") || line.startsWith("+++ i/") ||
    line.startsWith("+++ /dev/null")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (
    line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode") ||
    line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
    line.startsWith("rename from") || line.startsWith("rename to") ||
    line.startsWith("copy from") || line.startsWith("copy to") ||
    line.startsWith("similarity index") || line.startsWith("dissimilarity index") ||
    line.startsWith("Binary files") || line.startsWith("\\ No newline")
  ) {
    return "meta";
  }
  return "context";
}

/** Unified-diff renderer reusing the app's shared diff styles (add/red/green
 *  markers, surface background) so it looks exactly like diffs in the chat. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  // A trailing newline yields one empty last element — drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > DIFF_MAX_LINES;
  const shown = truncated ? lines.slice(0, DIFF_MAX_LINES) : lines;
  return (
    <pre className="file-diff-block session-summary-diff-pre">
      {shown.map((line, i) => {
        const kind = diffLineKind(line);
        const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
        return (
          <span key={i} className={`diff-line diff-${kind}`}>
            <span className="diff-marker">{marker}</span>
            <span className="diff-text">{line || " "}</span>
          </span>
        );
      })}
      {truncated && (
        <span className="diff-line diff-meta">
          <span className="diff-marker">{" "}</span>
          <span className="diff-text">
            … {lines.length - DIFF_MAX_LINES} more lines truncated — open the file in the editor for the full content
          </span>
        </span>
      )}
    </pre>
  );
}

/** One row in the changed-files list; expands to the file's session diff. */
function ChangedFileRow({
  file,
  rootPath,
  sinceTs,
}: {
  file: GitChangedFile;
  rootPath: string;
  sinceTs: number;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setOpen((o) => !o);
  }, []);

  // Lazy-load the diff the first time the row expands.
  useEffect(() => {
    if (!open || diff || loading || !rootPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSessionFileDiff(rootPath, file.path, sinceTs)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rootPath, sinceTs, file.path]);

  const binary = file.insertions == null && file.deletions == null && !file.untracked;

  return (
    <div className={`session-summary-file ${open ? "active" : ""}`}>
      <button
        type="button"
        className="session-summary-file-row"
        onClick={toggle}
        title={file.path}
      >
        <span className={`session-summary-file-status ${file.status}`}>
          {gitStatusBadge(file.status)}
        </span>
        <span className="session-summary-file-path">
          {file.status === "renamed" && file.oldPath && (
            <span className="session-summary-file-oldpath">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        {file.untracked && <span className="session-summary-file-flag">untracked</span>}
        <span className="session-summary-file-stats">
          {binary ? (
            "binary"
          ) : (
            <>
              {file.insertions != null && file.insertions > 0 && (
                <span className="ins">+{file.insertions.toLocaleString()}</span>
              )}
              {file.deletions != null && file.deletions > 0 && (
                <span className="del">−{file.deletions.toLocaleString()}</span>
              )}
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="session-summary-file-diff">
          {loading && <div className="session-summary-diff-loading">Loading diff…</div>}
          {error && <div className="session-summary-diff-error">{error}</div>}
          {!loading && !error && diff && (
            diff.diff.trim() ? <DiffView diff={diff.diff} /> : (
              <div className="session-summary-diff-empty">
                No textual changes recorded for this file.
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** The whole "Changed files" section — git diff of the session window. */
function ChangedFilesSection({
  rootPath,
  sinceTs,
  query = "",
}: {
  rootPath: string;
  sinceTs: number;
  query?: string;
}) {
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setError(null);
    setFiles(null);
    listSessionChangedFiles(rootPath, sinceTs)
      .then((f) => {
        if (!cancelled) setFiles(f);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, sinceTs]);

  const notGit = error != null && /not a git repository/i.test(error);
  const friendlyError = notGit
    ? "This project is not a git repository — the changed-file list needs git history to compute the session's diff."
    : error;

  // Search filter — match on the path (and the old path for renames).
  const isMatch = useMemo(() => makeMatcher(query), [query]);
  const searching = query.trim().length > 0;
  const visibleFiles = useMemo<GitChangedFile[]>(() => {
    if (!files) return [];
    if (!searching) return files;
    return files.filter((f) => isMatch(f.path) || isMatch(f.oldPath));
  }, [files, searching, isMatch]);

  return (
    <div className="session-summary-section session-summary-section-scroll">
      <div className="session-summary-section-title">
        Changed files
        {files && files.length > 0 && (
          <span className="session-summary-section-sub">
            {searching
              ? `${visibleFiles.length} of ${files.length} file${files.length === 1 ? "" : "s"} match${visibleFiles.length === 1 ? "es" : ""}`
              : `${files.length} file${files.length === 1 ? "" : "s"} — git diff from the last commit before
            this session to the current working tree`}
          </span>
        )}
      </div>
      {error != null ? (
        <div className="session-summary-empty">{friendlyError}</div>
      ) : files == null ? (
        <div className="session-summary-empty">Loading changed files…</div>
      ) : files.length === 0 ? (
        <div className="session-summary-empty">
          No files changed during this session window.
        </div>
      ) : searching && visibleFiles.length === 0 ? (
        <div className="session-summary-empty">No changed files match &ldquo;{query.trim()}&rdquo;.</div>
      ) : (
        <div className="session-summary-files">
          {visibleFiles.map((f) => (
            <ChangedFileRow key={`${f.status}-${f.path}`} file={f} rootPath={rootPath} sinceTs={sinceTs} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call log — every tool call of the session, flattened into one
// scrollable list. Reuses the main chat's tool-call-window markup so the
// look is identical; expanding shows the input (arguments) and the output.
// ---------------------------------------------------------------------------

/** Pretty-print a JSON arguments string (best effort). */
function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

/** A short human-readable summary of a tool call's arguments (e.g. the path). */
function summarizeToolArgs(args: string): string {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(args); } catch { /* raw text below */ }
  if (!parsed || typeof parsed !== "object") {
    return args ? truncateText(args, 60) : "";
  }
  const a = parsed as Record<string, unknown>;
  if (typeof a.agent === "string" && a.agent) return `@${a.agent}`;
  if (typeof a.path === "string" && a.path) return a.path;
  if (typeof a.query === "string" && a.query) return truncateText(a.query, 60);
  if (typeof a.url === "string" && a.url) return a.url;
  if (typeof a.command === "string" && a.command) return truncateText(a.command, 60);
  if (typeof a.pattern === "string" && a.pattern) return truncateText(a.pattern, 60);
  return truncateText(JSON.stringify(parsed), 60);
}

/** One expandable tool-call row (same markup as the main chat's windows). */
function ToolCallLogRow({ call }: { call: SessionToolCallLog }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolArgs(call.arguments || "");
  const output = call.result_full || call.result_snippet || "";
  return (
    <div className="tool-call-window">
      <div className="tool-call-window-header" onClick={() => setExpanded((e) => !e)}>
        <span className="tool-call-window-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="tool-call-window-name">{call.name}</span>
        {summary && <span className="tool-call-window-summary" title={summary}>{summary}</span>}
      </div>
      {expanded && (
        <div className="tool-call-window-body">
          {call.arguments && (
            <div className="tool-call-window-args">
              <div className="tool-call-window-label">Input</div>
              <pre className="tool-call-window-pre">{prettyJson(call.arguments)}</pre>
            </div>
          )}
          <div className="tool-call-window-result">
            <div className="tool-call-window-label">Output</div>
            <pre className="tool-call-window-pre">{output || "(no output recorded)"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Flattened tool call entry with the message it came from (for the count). */
interface SessionToolCallLog {
  name: string;
  arguments: string;
  result_snippet?: string;
  result_full?: string;
}

/** The dedicated "Tool calls" section — every call in one scrollable list. */
function ToolCallLogSection({
  messages,
  query = "",
}: {
  messages: SessionLogMessage[];
  query?: string;
}) {
  const calls = useMemo<SessionToolCallLog[]>(() => {
    const out: SessionToolCallLog[] = [];
    for (const m of messages) {
      for (const tc of m.toolCalls ?? []) {
        out.push({
          name: tc.name,
          arguments: tc.arguments || "",
          result_snippet: tc.result_snippet,
          result_full: tc.result_full,
        });
      }
    }
    return out;
  }, [messages]);

  // Search filter — match on the name, arguments and output.
  const isMatch = useMemo(() => makeMatcher(query), [query]);
  const searching = query.trim().length > 0;
  const visibleCalls = useMemo(() => {
    if (!searching) return calls;
    return calls.filter(
      (tc) => isMatch(tc.name) || isMatch(tc.arguments) || isMatch(tc.result_snippet) || isMatch(tc.result_full),
    );
  }, [calls, searching, isMatch]);

  return (
    <div className="session-summary-section session-summary-section-scroll session-summary-section-tools">
      <div className="session-summary-section-title">
        Tool calls
        <span className="session-summary-section-sub">
          {searching
            ? `${visibleCalls.length} of ${calls.length} call${calls.length === 1 ? "" : "s"} match${visibleCalls.length === 1 ? "es" : ""}`
            : `${calls.length} call${calls.length === 1 ? "" : "s"} — click a call to inspect its input and output`}
        </span>
      </div>
      {calls.length === 0 ? (
        <div className="session-summary-empty">No tool calls in this session.</div>
      ) : searching && visibleCalls.length === 0 ? (
        <div className="session-summary-empty">No tool calls match &ldquo;{query.trim()}&rdquo;.</div>
      ) : (
        <div className="session-summary-toollog">
          {visibleCalls.map((tc, i) => (
            <ToolCallLogRow key={i} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main overlay
// ---------------------------------------------------------------------------

/** Case-insensitive substring matcher; empty query matches everything. */
function makeMatcher(query: string) {
  const q = query.trim().toLowerCase();
  return (text: string | null | undefined) =>
    !q || (text ?? "").toLowerCase().includes(q);
}

export default function SessionSummary({ session, onClose, rootPath = "" }: Props) {
  const usageSummary = summarizeUsage(session.usage);
  const messages = session.messages ?? [];
  // Session-wide search — filters the tool call log, changed files and chat log.
  const [query, setQuery] = useState("");
  const isMatch = useMemo(() => makeMatcher(query), [query]);
  const searching = query.trim().length > 0;

  // Messages that match the query directly OR through one of their tool calls.
  const visibleMessages = useMemo(() => {
    if (!searching) return messages;
    return messages.filter(
      (m) =>
        isMatch(m.displayContent) ||
        isMatch(m.content) ||
        isMatch(m.model) ||
        (m.toolCalls ?? []).some(
          (tc) =>
            isMatch(tc.name) || isMatch(tc.arguments) || isMatch(tc.result_snippet) || isMatch(tc.result_full),
        ),
    );
  }, [messages, searching, isMatch]);

  // The overlay fills the whole window and only closes via its X button —
  // no Escape or click-outside handling.

  const hasCost = usageSummary.totalCost != null;
  const title = session.summary || session.firstMessage || session.id;
  const totalRequests = usageSummary.rows.reduce((n, r) => n + r.requests, 0);

  return (
    <div className="session-summary-overlay">
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

        {/* Session-wide search — filters the tool calls, changed files and chat log. */}
        <div className="session-summary-search">
          <svg
            className="session-summary-search-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            className="session-summary-search-input"
            type="text"
            placeholder="Search messages, tool calls, files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Clear the search field (the overlay only closes via X).
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button
              className="session-summary-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {/* Token expenses — split by provider/model with price + cost. */}
        <div className="session-summary-section session-summary-section-fixed">
          <div className="session-summary-section-title">
            Token expenses
            {totalRequests > 0 && (
              <span className="session-summary-section-sub">
                {totalRequests} model request{totalRequests === 1 ? "" : "s"} — every tool-loop
                iteration re-sends the context, so tokens are summed per request
              </span>
            )}
          </div>
          {usageSummary.rows.length === 0 ? (
            <div className="session-summary-empty">
              No token usage recorded for this session yet. Token counts appear
              per iteration after each request/response.
            </div>
          ) : (
            <>
              <div className="session-summary-total">
                <span>{formatTokens(usageSummary.totalTokens)} tokens</span>
                <span
                  className={
                    hasCost
                      ? `session-summary-total-cost${usageSummary.partialCost ? " partial" : ""}`
                      : "session-summary-total-cost muted"
                  }
                  title={
                    usageSummary.partialCost
                      ? "Some models used in this session have no price data — this is a lower bound"
                      : !hasCost
                        ? "No pricing data for the models used in this session"
                        : undefined
                  }
                >
                  {hasCost
                    ? `${usageSummary.partialCost ? "\u2265 " : ""}${formatCurrency(usageSummary.totalCost)} est.`
                    : "\u2014"}
                </span>
              </div>
              <table className="session-summary-usage-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th className="num">Reqs</th>
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
                      <td className="num">{row.requests}</td>
                      <td className="num">{formatTokens(row.promptTokens)}</td>
                      <td className="num">{formatTokens(row.completionTokens)}</td>
                      <td className="num">{formatTokens(row.totalTokens)}</td>
                      <td className="num" title={row.promptPricePerM != null || row.completionPricePerM != null
                        ? `In: ${row.promptPricePerM ?? "?"} / Out: ${row.completionPricePerM ?? "?"} USD per 1M tokens`
                        : undefined}>
                        {formatPricePair(row.promptPricePerM, row.completionPricePerM)}
                      </td>
                      <td className="num">{formatCurrency(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* Files changed during this session (git) — click a file for its diff. */}
        <ChangedFilesSection
          rootPath={rootPath}
          sinceTs={session.createdAt}
          query={query}
        />

        {/* Every tool call in one scrollable log — click to inspect input/output.
            Receives ALL messages and applies the search filter internally so the
            call list is independent of the chat-log filter. */}
        <ToolCallLogSection messages={messages} query={query} />

        {/* Full conversation log — every user prompt and tool call. */}
        <div className="session-summary-section session-summary-section-scroll session-summary-section-log">
          <div className="session-summary-section-title">
            Conversation log
            <span className="session-summary-section-sub">
              {searching
                ? `${visibleMessages.length} of ${messages.length} message${messages.length === 1 ? "" : "s"} match${visibleMessages.length === 1 ? "es" : ""}`
                : `${messages.length} message${messages.length === 1 ? "" : "s"} — user prompts and tool calls are logged without exception`}
            </span>
          </div>
          {messages.length === 0 ? (
            <div className="session-summary-empty">No messages logged yet.</div>
          ) : visibleMessages.length === 0 ? (
            <div className="session-summary-empty">No messages match &ldquo;{query.trim()}&rdquo;.</div>
          ) : (
            <div className="session-summary-messages">
              {visibleMessages.map((m, i) => (
                <LogMessage key={i} msg={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
