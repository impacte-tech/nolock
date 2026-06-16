import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Marked } from "marked";

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
  toolCalls?: ToolCallLog[];
}

interface Props {
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  style?: React.CSSProperties;
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
    </div>
  );
}

export default function ChatPanel({ onClose, onOpenUrl, style }: Props) {
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

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: "user", content: input.trim() };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setInput("");
    setLoading(true);

    try {
      const backend = localStorage.getItem("nolock.backend") || "ollama";
      const url = localStorage.getItem("nolock.url") || "http://localhost:11434";
      const chatModel = localStorage.getItem("nolock.chatModel") || "";
      const apiKey = localStorage.getItem("nolock.apiKey") || "";

      if (!chatModel) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "No chat model configured. Open AI Integrations settings to set one." },
        ]);
        setLoading(false);
        return;
      }

      // Read enabled tools from localStorage
      const toolsRaw = localStorage.getItem("nolock.toolsEnabled") || "[]";
      const toolsEnabled: string[] = JSON.parse(toolsRaw);

      const result: { content: string; tool_calls: ToolCallLog[] } = await invoke("ai_chat", {
        req: {
          backend,
          url,
          model: chatModel,
          messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
          apiKey: apiKey || null,
          toolsEnabled,
        },
      });

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.content || "(no response)",
          toolCalls: result.tool_calls?.length > 0 ? result.tool_calls : undefined,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${e}` },
      ]);
    }
    setLoading(false);
  }, [input, loading, messages]);

  return (
    <div className="chat-panel" style={style}>
      <div className="chat-header">
        <span>Agent Chat</span>
        <button onClick={onClose}>&times;</button>
      </div>
      <div className="chat-messages" ref={messagesContainerRef}>
        {messages.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>
            Ask anything about your code...
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="role">{m.role}</div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <ToolCallBlock calls={m.toolCalls} />
            )}
            {m.role === "assistant" ? (
              <MarkdownContent text={m.content} />
            ) : (
              <div className="chat-plain">{m.content}</div>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-msg assistant">
            <div className="role">assistant</div>
            <div style={{ color: "var(--text-muted)" }}>thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <textarea
          className="chat-input"
          rows={2}
          placeholder="Ask the AI..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button className="chat-send" onClick={sendMessage} disabled={loading}>
          {loading ? "Thinking..." : "Send"}
        </button>
      </div>
    </div>
  );
}
