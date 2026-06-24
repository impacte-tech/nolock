import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Marked } from "marked";
import FileAutocomplete, { type AgentRef } from "./FileAutocomplete";
import { countTokens } from "../lib/tokenizer";
import { getSecret } from "../lib/secrets";

// ---------------------------------------------------------------------------
// Markdown renderer — used to format assistant responses with code blocks,
// inline code, bold, italic, headers, lists, etc.
// ---------------------------------------------------------------------------
const marked = new Marked({ gfm: true, breaks: true });

export interface ToolCallLog {
  name: string;
  arguments: string;
  result_snippet: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  /** Text to display in the chat UI (user sees this instead of the full API content) */
  displayContent?: string;
  toolCalls?: ToolCallLog[];
  /** File and agent @mentions referenced in this message (for context badges). */
  contextRefs?: { type: "file" | "agent"; name: string }[];
}

export interface FileRef {
  path: string;
  name: string;
  /** Internal: token count of file content (populated after first read). */
  _tokenCount?: number;
}

interface Props {
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  rootPath?: string;
  style?: React.CSSProperties;
  /** Called to open the agent manager UI */
  onOpenAgentManager?: () => void;
}

// Mutable ref set by ChatPanel so MarkdownContent can call it without props drilling
let globalOpenUrl: ((url: string) => void) | null = null;

export function MarkdownContent({ text }: { text: string }) {
  const html = marked.parse(text) as string;
  return (
    <div
      className="chat-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function ToolCallBlock({ calls }: { calls: ToolCallLog[] }) {
  const [expanded, setExpanded] = useState(false);

  // Check if any call is web_search to show attribution
  const hasWebSearch = calls.some((c) => c.name === "web_search");

  return (
    <div className="tool-calls">
      <div className="tool-calls-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-calls-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="tool-calls-label">
          {calls.length} tool {calls.length === 1 ? "call" : "calls"}
        </span>
        <span className="tool-calls-names">
          {calls.map((c) => c.name).join(", ")}
        </span>
      </div>
      {expanded && (
        <div className="tool-calls-list">
          {calls.map((call, i) => (
            <div key={i} className="tool-call-item">
              <div className="tool-call-name">{call.name}</div>
              <div className="tool-call-args">
                <code>{call.arguments}</code>
              </div>
              <div className="tool-call-result">{call.result_snippet}</div>
            </div>
          ))}
        </div>
      )}
      {hasWebSearch && (
        <div className="tool-attribution">
          <a
            href="https://duckduckgo.com"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            Results from DuckDuckGo
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Renders text with @mentions highlighted in a distinct colour.
 * Splits on @word patterns and wraps matches in a styled span.
 */
function MentionHighlight({ text }: { text: string }) {
  const parts = text.split(/(@\w[\w.-]*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") ? (
          <span key={i} className="mention-highlight">{part}</span>
        ) : (
          part
        )
      )}
    </>
  );
}

export default function ChatPanel({ onClose, onOpenUrl, rootPath = "", style, onOpenAgentManager }: Props) {
  // Wire up global ref so MarkdownContent can open URLs
  useEffect(() => {
    globalOpenUrl = onOpenUrl;
    return () => { globalOpenUrl = null; };
  }, [onOpenUrl]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false); // guards against concurrent sendMessage calls
  const stopRequestedRef = useRef(false); // set to true when user clicks stop
  const unlistenRef = useRef<(() => void) | null>(null); // stored stream-token unlisten callback

  // ---- File @mention state ----
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const [agentRefs, setAgentRefs] = useState<AgentRef[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState<number>(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Tracks total context tokens sent across the conversation (persists after fileRefs are cleared). */
  const [accumulatedContextTokens, setAccumulatedContextTokens] = useState(0);

  /** Detect @mention patterns as the user types. */
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    const cursorPos = e.target.selectionStart;
    if (cursorPos === null) {
      setMentionQuery(null);
      setMentionIndex(-1);
      return;
    }

    const textBefore = value.substring(0, cursorPos);
    const atIdx = textBefore.lastIndexOf("@");

    if (atIdx !== -1) {
      const afterAt = textBefore.substring(atIdx + 1);
      // Valid mention: no whitespace between @ and cursor, and no nested @
      if (!/\s/.test(afterAt)) {
        setMentionQuery(afterAt);
        setMentionIndex(atIdx);
        return;
      }
    }

    // No active mention
    setMentionQuery(null);
    setMentionIndex(-1);
  }, []);

  /** Called when user selects a file from the autocomplete dropdown. */
  const handleFileSelect = useCallback((filePath: string, fileName: string) => {
    // Keep the @name visible in the input (replace the partial query with the full @name)
    if (mentionIndex !== -1 && mentionQuery !== null) {
      const before = input.substring(0, mentionIndex);
      const after = input.substring(mentionIndex + 1 + mentionQuery.length);
      setInput(before + "@" + fileName + after);
    }

    // Add to file refs (deduplicate by path)
    setFileRefs((prev) => (prev.some((r) => r.path === filePath) ? prev : [...prev, { path: filePath, name: fileName }]));

    // Close autocomplete
    setMentionQuery(null);
    setMentionIndex(-1);

    // Refocus the textarea
    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery]);

  /** Called when user selects an agent from the autocomplete dropdown. */
  const handleAgentSelect = useCallback((agent: AgentRef) => {
    // Keep the @name visible in the input (replace the partial query with the full @name)
    if (mentionIndex !== -1 && mentionQuery !== null) {
      const before = input.substring(0, mentionIndex);
      const after = input.substring(mentionIndex + 1 + mentionQuery.length);
      setInput(before + "@" + agent.name + after);
    }

    // Add to agent refs (deduplicate by path)
    setAgentRefs((prev) => (prev.some((r) => r.path === agent.path) ? prev : [...prev, agent]));

    // Close autocomplete
    setMentionQuery(null);
    setMentionIndex(-1);

    // Refocus the textarea
    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery]);

  const removeFileRef = useCallback((path: string) => {
    setFileRefs((prev) => prev.filter((r) => r.path !== path));
  }, []);

  const removeAgentRef = useCallback((path: string) => {
    setAgentRefs((prev) => prev.filter((r) => r.path !== path));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Single delegated click handler on the persistent container — catches all
  // link clicks from dangerouslySetInnerHTML content that React can't handle.
  useEffect(() => {
    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement;
      console.log("[nolock] click on:", target.tagName, target.textContent?.substring(0, 50));
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (anchor?.href && !anchor.href.startsWith("javascript:")) {
        console.log("[nolock] link found, opening:", anchor.href);
        e.preventDefault();
        e.stopPropagation();
        globalOpenUrl?.(anchor.href);
      }
    };

    // Use window-level capture to catch everything
    window.addEventListener("click", handleClick, true);
    return () => window.removeEventListener("click", handleClick, true);
  }, []);

  /** Maximum tokens allowed in context window — fetched from backend (/api/show for Ollama). */
  const [maxTokens, setMaxTokens] = useState<number>(() => {
    const stored = localStorage.getItem("nolock.maxContextTokens");
    return stored ? Number(stored) : 128_000;
  });

  // Fetch the model's actual context length from the backend on mount
  useEffect(() => {
    const fetchContextLength = async () => {
      const backend = localStorage.getItem("nolock.backend") || "ollama";
      const url = localStorage.getItem("nolock.url") || "http://localhost:11434";
      const chatModel = localStorage.getItem("nolock.chatModel") || "";
      if (!chatModel) return;

      try {
        const result = await invoke("get_model_info", {
          req: { backend, url, model: chatModel },
        });
        // Defensive: only update if the response has the expected shape
        if (result && typeof (result as { context_length: number }).context_length === "number") {
          const ctxLen = (result as { context_length: number }).context_length;
          setMaxTokens(ctxLen);
          localStorage.setItem("nolock.maxContextTokens", String(ctxLen));
        }
      } catch (e) {
        // Silently fall back to stored value or default
        console.error("[nolock] Failed to fetch model context length:", e);
      }
    };
    fetchContextLength();
  }, []);

  /** Compute total context size: accumulated (from prior sends) + pending (current chips). */
  const contextSize = accumulatedContextTokens
    + fileRefs.reduce((sum, ref) => sum + (ref._tokenCount || 0), 0)
    + agentRefs.length * 50; // rough estimate for agent system prompt tokens

  const clearAllRefs = useCallback(() => {
    setFileRefs([]);
    setAgentRefs([]);
    setAccumulatedContextTokens(0);
  }, []);

  /** Stop an in-progress generation — clean up the event listener and reset UI state. */
  const stopGeneration = useCallback(() => {
    stopRequestedRef.current = true;
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    sendingRef.current = false;
    setLoading(false);
  }, []);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading || sendingRef.current) return;
    sendingRef.current = true;

    // ---- /clear command ----
    if (trimmed === "/clear" || trimmed === "/clean") {
      setInput("");
      clearAllRefs();
      setMessages((prev) => [...prev, { role: "assistant", content: "_Context cleared._ All file references have been removed." }]);
      sendingRef.current = false;
      return;
    }

    // ---- Build display content (what the user sees in chat) ----
    // The @mentions are already embedded in the input text (kept on autocomplete select).
    // We just show the message as-is, with context badges below.
    const contextRefs: { type: "file" | "agent"; name: string }[] = [
      ...fileRefs.map((r) => ({ type: "file" as const, name: r.name })),
      ...agentRefs.map((r) => ({ type: "agent" as const, name: r.name })),
    ];
    const displayText = trimmed;

    // ---- Build API content (sent to the AI backend) ----
    let apiContent = trimmed;
    const refsWithSize: FileRef[] = [];

    // Collect file contexts
    const contextParts: string[] = [];
    if (fileRefs.length > 0) {
      for (const ref of fileRefs) {
        try {
          const fileContent: string = await invoke("read_file", { path: ref.path });
          const tokenCount = countTokens(fileContent);
          contextParts.push(`File: ${ref.path}\n\`\`\`\n${fileContent}\n\`\`\``);
          refsWithSize.push({ ...ref, _tokenCount: tokenCount });
        } catch (e) {
          console.error(`Failed to read referenced file ${ref.path}:`, e);
        }
      }
      if (refsWithSize.length > 0) {
        setFileRefs(refsWithSize);
      }
    }

    // Build system message from agent prompts
    const agentSystemMessages: { role: "system"; content: string }[] = [];
    for (const agent of agentRefs) {
      try {
        const data: any = await invoke("read_agent", { path: agent.path });
        if (data.prompt) {
          agentSystemMessages.push({ role: "system", content: data.prompt });
        }
      } catch (e) {
        console.error(`Failed to read agent prompt for ${agent.name}:`, e);
      }
    }

    // Append file context to the user message
    if (contextParts.length > 0) {
      apiContent = `Context:\n${contextParts.join("\n\n")}\n\n---\n${apiContent}`;
    }

    // Accumulate context tokens for the persistent indicator
    const sentTokens = refsWithSize.reduce((sum: number, r: FileRef) => sum + (r._tokenCount || 0), 0);
    const msgTokens = countTokens(apiContent);
    if (sentTokens > 0 || msgTokens > 0) {
      setAccumulatedContextTokens((prev) => prev + sentTokens + msgTokens);
    }

    const userMsg: Message = { role: "user", content: apiContent, displayContent: displayText, contextRefs };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setInput("");
    setFileRefs([]); // Clear pending file refs after sending
    setAgentRefs([]); // Clear pending agent refs after sending
    setLoading(true);

    let unlisten: (() => void) | null = null;
    try {
      const backend = localStorage.getItem("nolock.backend") || "ollama";
      const url = localStorage.getItem("nolock.url") || "http://localhost:11434";
      const chatModel = localStorage.getItem("nolock.chatModel") || "";

      if (!chatModel) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "No chat model configured. Open AI Integrations settings to set one." },
        ]);
        sendingRef.current = false;
        setLoading(false);
        return;
      }

      // Read API key from keychain (fallback: localStorage)
      const apiKey = (await getSecret("apiKey")) ?? localStorage.getItem("nolock.apiKey") ?? "";

      // Read enabled tools from localStorage
      const toolsRaw = localStorage.getItem("nolock.toolsEnabled") || "[]";
      const toolsEnabled: string[] = JSON.parse(toolsRaw);

      // Read per-tool configuration from keychain (fallback: localStorage)
      const toolConfigStored = await getSecret("toolConfig");
      const toolConfigRaw = toolConfigStored ?? localStorage.getItem("nolock.toolConfig") ?? "{}";
      const toolConfigs: Record<string, Record<string, string>> = JSON.parse(toolConfigRaw);

      // ---- Set up streaming event listener ----
      unlisten = await listen<{ token: string }>("stream-token", (event) => {
        // If the user clicked Stop, ignore all subsequent tokens
        if (stopRequestedRef.current) return;
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, content: last.content + event.payload.token };
          }
          return msgs;
        });
      });
      unlistenRef.current = unlisten;

      // Add a placeholder assistant message that streaming tokens will fill
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      // Prepend agent system messages before user messages
      const apiMessages = [
        ...agentSystemMessages,
        ...allMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const result: { content: string; tool_calls: ToolCallLog[] } = await invoke("ai_chat", {
        req: {
          backend,
          url,
          model: chatModel,
          messages: apiMessages,
          apiKey: apiKey || null,
          toolsEnabled,
          toolConfigs,
        },
      });

      // If the user clicked Stop while waiting for the full response, discard the result
      if (stopRequestedRef.current) {
        // unlisten is already cleaned up by stopGeneration; just skip processing
        return;
      }

      // Accumulate assistant response tokens
      const responseText = result.content || "";
      if (responseText) {
        const respTokens = countTokens(responseText);
        if (respTokens > 0) {
          setAccumulatedContextTokens((prev) => prev + respTokens);
        }
      }

      // Finalise the assistant message with the complete result
      setMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = {
            ...last,
            content: responseText || "(no response)",
            toolCalls: result.tool_calls?.length > 0 ? result.tool_calls : undefined,
          };
        }
        return msgs;
      });
    } catch (e: any) {
      // On error, replace the empty placeholder with the error message
      setMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.content === "") {
          msgs[msgs.length - 1] = { role: "assistant", content: `Error: ${e}` };
        } else {
          msgs.push({ role: "assistant", content: `Error: ${e}` });
        }
        return msgs;
      });
    } finally {
      if (unlisten) unlisten();
      sendingRef.current = false;
      setLoading(false);
    }
  }, [input, loading, messages, fileRefs, agentRefs, clearAllRefs]);

  return (
    <div className="chat-panel" style={style}>
      <div className="chat-header">
        <span>Agent Chat</span>
        <div className="chat-header-actions">
          {rootPath && onOpenAgentManager && (
            <button className="chat-header-btn" onClick={onOpenAgentManager} title="Manage AI Agents">
              <svg className="robot-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="4" x2="12" y2="7" />
                <circle cx="12" cy="3" r="1.5" fill="currentColor" />
                <rect x="3" y="7" width="18" height="13" rx="5" />
                <circle cx="8.5" cy="11.5" r="2" fill="currentColor" />
                <circle cx="15.5" cy="11.5" r="2" fill="currentColor" />
                <path d="M9 16 Q12 18.5 15 16" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          )}
          <button onClick={onClose}>&times;</button>
        </div>
      </div>
      <div className="chat-messages" ref={messagesContainerRef}>
        {messages.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>
            Ask anything about your code...<br />
            Use <strong>@agent-name</strong> to invoke an AI agent.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="role">{m.role}</div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <ToolCallBlock calls={m.toolCalls} />
            )}
            {m.role === "assistant" ? (
              <div className="assistant-content">
                {m.content ? (
                  <>
                    <MarkdownContent text={m.content} />
                    {i === messages.length - 1 && loading && (
                      <span className="streaming-cursor" />
                    )}
                  </>
                ) : loading && i === messages.length - 1 ? (
                  <span className="loading-dots" aria-label="Thinking">
                    <span>.</span><span>.</span><span>.</span>
                  </span>
                ) : null}
              </div>
            ) : (
              <>
                <div className="chat-plain">
                  <MentionHighlight text={m.displayContent || m.content} />
                </div>
                {m.contextRefs && m.contextRefs.length > 0 && (
                  <div className="context-badges">
                    {m.contextRefs.map((ref) => (
                      <span key={ref.name} className={`context-badge ${ref.type}`}>
                        {ref.type === "agent" ? (
                          <svg className="robot-icon-small" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="4" x2="12" y2="7" />
                            <circle cx="12" cy="3" r="1.5" fill="currentColor" />
                            <rect x="3" y="7" width="18" height="13" rx="5" />
                            <circle cx="8.5" cy="11.5" r="2" fill="currentColor" />
                            <circle cx="15.5" cy="11.5" r="2" fill="currentColor" />
                            <path d="M9 16 Q12 18.5 15 16" strokeWidth="1.5" fill="none" />
                          </svg>
                        ) : (
                          <svg className="file-icon-small" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        )}
                        {ref.name}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        {/* File ref chips */}
        {fileRefs.length > 0 && (
          <div className="file-ref-chips">
            <div className="file-ref-chips-list">
              {fileRefs.map((ref) => (
                <div key={ref.path} className="file-ref-chip">
                  <span className="file-ref-name">{ref.name}</span>
                  <span className="file-ref-remove" onClick={() => removeFileRef(ref.path)}>&times;</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agent ref chips */}
        {agentRefs.length > 0 && (
          <div className="file-ref-chips">
            <div className="file-ref-chips-list">
              {agentRefs.map((ref) => (
                <div key={ref.path} className="agent-ref-chip">
                  <span className="agent-ref-icon">
                    <svg className="robot-icon-small" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="4" x2="12" y2="7" />
                      <circle cx="12" cy="3" r="1.5" fill="currentColor" />
                      <rect x="3" y="7" width="18" height="13" rx="5" />
                      <circle cx="8.5" cy="11.5" r="2" fill="currentColor" />
                      <circle cx="15.5" cy="11.5" r="2" fill="currentColor" />
                      <path d="M9 16 Q12 18.5 15 16" strokeWidth="1.5" fill="none" />
                    </svg>
                  </span>
                  <span className="file-ref-name">@{ref.name}</span>
                  <span className="file-ref-remove" onClick={() => removeAgentRef(ref.path)}>&times;</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions bar (when chips are present) */}
        {(fileRefs.length > 0 || agentRefs.length > 0) && (
          <div className="file-ref-chips-actions" style={{ marginBottom: 6 }}>
            {loading && (
              <button className="stop-generation-btn" onClick={stopGeneration} title="Stop generation">
                &#x25A0;
              </button>
            )}
            {(() => {
              const total = contextSize;
              const circumference = 2 * Math.PI * 8;
              const progress = Math.min(total / maxTokens, 1);
              const pct = Math.round(progress * 100);
              const color = pct > 90 ? "#e06c75" : pct > 70 ? "#e5c07b" : "var(--accent)";
              return (
                <div className="context-indicator" title={`${total.toLocaleString()} tokens / ${maxTokens.toLocaleString()} tokens`}>
                  <svg width="16" height="16" viewBox="0 0 20 20">
                    <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" strokeWidth="2" />
                    <circle cx="10" cy="10" r="8" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${circumference}`} strokeDashoffset={`${circumference * (1 - progress)}`} transform="rotate(-90 10 10)" />
                  </svg>
                  <span className="context-indicator-text">{pct}%</span>
                </div>
              );
            })()}
            <button className="clear-context-btn" onClick={clearAllRefs} title="Clear all context">&times;</button>
          </div>
        )}

        {/* Persistent context indicator — shown when there are messages or accumulated context */}
        {fileRefs.length === 0 && agentRefs.length === 0 && (accumulatedContextTokens > 0 || messages.length > 0) && (
          <div className="context-persistent-bar">
            <div className="context-bar-actions">
              {/* Stop button — only visible while the model is generating */}
              {loading && (
                <button className="stop-generation-btn" onClick={stopGeneration} title="Stop generation">
                  &#x25A0;
                </button>
              )}
              {(() => {
                const circumference = 2 * Math.PI * 8;
                const progress = Math.min(accumulatedContextTokens / maxTokens, 1);
                const pct = Math.round(progress * 100);
                const color = pct > 90 ? "#e06c75" : pct > 70 ? "#e5c07b" : "var(--accent)";
                return (
                  <div className="context-indicator" title={`${accumulatedContextTokens.toLocaleString()} tokens / ${maxTokens.toLocaleString()} tokens`}>
                    <svg width="16" height="16" viewBox="0 0 20 20">
                      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" strokeWidth="2" />
                      <circle cx="10" cy="10" r="8" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${circumference}`} strokeDashoffset={`${circumference * (1 - progress)}`} transform="rotate(-90 10 10)" />
                    </svg>
                    <span className="context-indicator-text">{pct}%</span>
                  </div>
                );
              })()}
              <button className="clear-context-btn" onClick={clearAllRefs} title="Clear all context">&times;</button>
            </div>
          </div>
        )}
        {/* Inline autocomplete panel — appears between messages and input when @mention is active */}
        {mentionQuery !== null && rootPath && (
          <div className="chat-autocomplete-panel">
            <FileAutocomplete
              query={mentionQuery}
              rootPath={rootPath}
              onSelect={handleFileSelect}
              onSelectAgent={handleAgentSelect}
              onClose={() => {
                setMentionQuery(null);
                setMentionIndex(-1);
              }}
            />
          </div>
        )}

        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={2}
            placeholder="Type @ to reference a file or agent... Ask the AI..."
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (mentionQuery !== null) {
                // Autocomplete is open — prevent these keys from affecting the textarea
                if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab", "Escape"].includes(e.key)) {
                  e.preventDefault();
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
        </div>
        <button className="chat-send" onClick={sendMessage} disabled={loading}>
          {loading ? "Thinking..." : "Send"}
        </button>
      </div>
    </div>
  );
}
