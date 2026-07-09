import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Marked } from "marked";
import FileAutocomplete, { type AgentRef } from "./FileAutocomplete";
import SkillAutocomplete from "./SkillAutocomplete";
import ToolAutocomplete from "./ToolAutocomplete";
import { countTokens } from "../lib/tokenizer";
import { getSecret } from "../lib/secrets";
import {
  saveRlhfFeedback,
  saveDpoFeedback,
  getModelContext,
  getModelConfigurations,
  readRlhfSettings,
  type RlhfData,
  type DpoEntry,
  type FeedbackType,
} from "../lib/rlhf";

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
  /** File, directory, agent, skill, and tool mentions referenced in this message (for context badges). */
  contextRefs?: { type: "file" | "directory" | "agent" | "skill" | "tool"; name: string }[];
  /** RLHF feedback: "good" (thumbs up), "bad" (thumbs down), or undefined (not rated). */
  feedback?: FeedbackType;
  /** User's correction text for a "bad" rating. */
  feedbackCorrection?: string;
  /** True while waiting for the user to type a correction after clicking thumbs down. */
  feedbackPending?: boolean;
  /** DPO mode: two alternative responses for pairwise comparison. */
  dpoResponses?: { responseA: string; responseB: string };
  /** DPO mode: which response was chosen ('A' or 'B'), or null if pending. */
  dpoChoice?: "A" | "B";
}

export interface FileRef {
  path: string;
  name: string;
  isDir?: boolean;
  /** Internal: token count of file content (populated after first read). */
  _tokenCount?: number;
}

export interface SkillRef {
  name: string;
  path: string;
}

export interface ToolRef {
  name: string;
  path: string;
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

const PROVIDER_META: Record<string, { label: string; url: string }> = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com" },
  brave: { label: "Brave Search", url: "https://brave.com/search/" },
};

export function ToolCallBlock({ calls }: { calls: ToolCallLog[] }) {
  const [expanded, setExpanded] = useState(false);

  const hasWebSearch = calls.some((c) => c.name === "web_search");

  let providerLabel = "DuckDuckGo";
  let providerUrl = "https://duckduckgo.com";
  if (hasWebSearch) {
    try {
      const raw = localStorage.getItem("nolock.toolConfig");
      if (raw) {
        const config = JSON.parse(raw);
        const provider = config?.web_search?.provider;
        if (provider && PROVIDER_META[provider]) {
          providerLabel = PROVIDER_META[provider].label;
          providerUrl = PROVIDER_META[provider].url;
        }
      }
    } catch {}
  }

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
            href={providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            Results from {providerLabel}
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
  const parts = text.split(/(@[\w.\/-]+)/g);
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

/** DPO choice component — shows two AI responses side-by-side for pairwise comparison. */
export function DpoChoice({
  responseA,
  responseB,
  onChoose,
}: {
  responseA: string;
  responseB: string;
  onChoose: (choice: "A" | "B") => void;
}) {
  const [selected, setSelected] = useState<"A" | "B" | null>(null);

  const handleConfirm = () => {
    if (!selected) return;
    onChoose(selected);
  };

  const renderContent = (text: string) => {
    // Render markdown-like content inline (simplified)
    return <MarkdownContent text={text} />;
  };

  return (
    <div className="dpo-choice">
      <div className="dpo-choice-header">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        Which response is better? <span className="dpo-choice-sub">(you must choose one to continue)</span>
      </div>
      <div className="dpo-choice-responses">
        {/* Response A */}
        <div className={`dpo-choice-card ${selected === "A" ? "selected" : ""}`}>
          <div className="dpo-choice-card-header">
            <label className="dpo-radio-label">
              <input
                type="radio"
                name="dpo-choice"
                checked={selected === "A"}
                onChange={() => setSelected("A")}
              />
              <span className="dpo-radio-text">Response A</span>
            </label>
          </div>
          <div className="dpo-choice-card-content">
            {renderContent(responseA)}
          </div>
        </div>

        {/* Response B */}
        <div className={`dpo-choice-card ${selected === "B" ? "selected" : ""}`}>
          <div className="dpo-choice-card-header">
            <label className="dpo-radio-label">
              <input
                type="radio"
                name="dpo-choice"
                checked={selected === "B"}
                onChange={() => setSelected("B")}
              />
              <span className="dpo-radio-text">Response B</span>
            </label>
          </div>
          <div className="dpo-choice-card-content">
            {renderContent(responseB)}
          </div>
        </div>
      </div>
      <div className="dpo-choice-footer">
        <button
          className="dpo-confirm-btn"
          disabled={!selected}
          onClick={handleConfirm}
        >
          Confirm Choice
        </button>
      </div>
    </div>
  );
}

/** Inline correction input for thumbs-down feedback. */
function CorrectionInput({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    onSubmit(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="rlhf-correction-input-wrapper">
      <textarea
        ref={inputRef}
        className="rlhf-correction-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe what was wrong or how the answer could be improved..."
        rows={3}
      />
      <div className="rlhf-correction-actions">
        <button className="rlhf-cancel-btn" onClick={onCancel}>Cancel</button>
        <button
          className="rlhf-submit-btn"
          onClick={handleSubmit}
          disabled={!value.trim()}
        >
          Submit Feedback
        </button>
        <span className="rlhf-correction-hint">Ctrl+Enter to submit</span>
      </div>
    </div>
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

  // ---- Mention state (@ for files/agents, / for skills) ----
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const [agentRefs, setAgentRefs] = useState<AgentRef[]>([]);
  const [skillRefs, setSkillRefs] = useState<SkillRef[]>([]);
  const [toolRefs, setToolRefs] = useState<ToolRef[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState<number>(-1);
  const [mentionType, setMentionType] = useState<"file" | "skill" | "tool" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Tracks total context tokens sent across the conversation (persists after fileRefs are cleared). */
  const [accumulatedContextTokens, setAccumulatedContextTokens] = useState(0);

  /** Counter for DPO prompt interval — increments on each user message. */
  const messageCountRef = useRef(0);

  /** True while a DPO response is awaiting user choice — disables chat input. */
  const dpoPending = messages.some((m) => m.dpoResponses !== undefined);

  /** Detect @mention (files/agents) or /mention (skills) patterns as the user types. */
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    const cursorPos = e.target.selectionStart;
    if (cursorPos === null) {
      setMentionQuery(null);
      setMentionIndex(-1);
      setMentionType(null);
      return;
    }

    const textBefore = value.substring(0, cursorPos);

    // Check @ mention (files/agents) — trigger on @ followed by non-whitespace
    const atIdx = textBefore.lastIndexOf("@");
    if (atIdx !== -1) {
      const afterAt = textBefore.substring(atIdx + 1);
      if (!/\s/.test(afterAt)) {
        setMentionQuery(afterAt);
        setMentionIndex(atIdx);
        setMentionType("file");
        return;
      }
    }

    // Check / mention (skills) — trigger on / preceded by whitespace or at start,
    // followed by non-whitespace. This avoids matching file paths like "src/main.rs".
    const slashIdx = textBefore.lastIndexOf("/");
    if (slashIdx !== -1) {
      const beforeSlash = slashIdx === 0 ? " " : textBefore[slashIdx - 1];
      if (/\s/.test(beforeSlash)) {
        const afterSlash = textBefore.substring(slashIdx + 1);
        if (!/\s/.test(afterSlash)) {
          setMentionQuery(afterSlash);
          setMentionIndex(slashIdx);
          setMentionType("skill");
          return;
        }
      }
    }

    // Check # mention (custom tools) — trigger on # preceded by whitespace or at start,
    // followed by non-whitespace.
    const hashIdx = textBefore.lastIndexOf("#");
    if (hashIdx !== -1) {
      const beforeHash = hashIdx === 0 ? " " : textBefore[hashIdx - 1];
      if (/\s/.test(beforeHash)) {
        const afterHash = textBefore.substring(hashIdx + 1);
        if (!/\s/.test(afterHash)) {
          setMentionQuery(afterHash);
          setMentionIndex(hashIdx);
          setMentionType("tool");
          return;
        }
      }
    }

    // No active mention
    setMentionQuery(null);
    setMentionIndex(-1);
    setMentionType(null);
  }, []);

  /** Called when user selects a file or directory from the autocomplete dropdown. */
  const handleFileSelect = useCallback((filePath: string, fileName: string, isDir: boolean) => {
    // Compute a path relative to the project root for display
    const relativeName = rootPath
      ? filePath.replace(rootPath, "").replace(/^[\\/]+/, "") || fileName
      : fileName;

    // Keep the @name visible in the input (replace the partial query with the full @name)
    if (mentionIndex !== -1 && mentionQuery !== null) {
      const before = input.substring(0, mentionIndex);
      const after = input.substring(mentionIndex + 1 + mentionQuery.length);
      setInput(before + "@" + relativeName + after);
    }

    // Add to file refs (deduplicate by path)
    setFileRefs((prev) =>
      prev.some((r) => r.path === filePath)
        ? prev
        : [...prev, { path: filePath, name: relativeName, isDir }]
    );

    // Close autocomplete
    setMentionQuery(null);
    setMentionIndex(-1);
    setMentionType(null);

    // Refocus the textarea
    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery, rootPath]);

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
    setMentionType(null);

    // Refocus the textarea
    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery]);

  /** Called when user selects a tool from the # autocomplete dropdown. */
  const handleToolSelect = useCallback((toolPath: string, toolName: string) => {
    if (mentionIndex !== -1 && mentionQuery !== null) {
      const before = input.substring(0, mentionIndex);
      const after = input.substring(mentionIndex + 1 + mentionQuery.length);
      setInput(before + "#" + toolName + after);
    }

    setToolRefs((prev) => (prev.some((r) => r.path === toolPath) ? prev : [...prev, { path: toolPath, name: toolName }]));

    setMentionQuery(null);
    setMentionIndex(-1);
    setMentionType(null);

    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery]);

  /** Called when user selects a skill from the / autocomplete dropdown. */
  const handleSkillSelect = useCallback((skillPath: string, skillName: string) => {
    // Keep the /name visible in the input (replace the partial query with the full /name)
    if (mentionIndex !== -1 && mentionQuery !== null) {
      const before = input.substring(0, mentionIndex);
      const after = input.substring(mentionIndex + 1 + mentionQuery.length);
      setInput(before + "/" + skillName + after);
    }

    // Add to skill refs (deduplicate by path)
    setSkillRefs((prev) => (prev.some((r) => r.path === skillPath) ? prev : [...prev, { path: skillPath, name: skillName }]));

    // Close autocomplete
    setMentionQuery(null);
    setMentionIndex(-1);
    setMentionType(null);

    // Refocus the textarea
    textareaRef.current?.focus();
  }, [input, mentionIndex, mentionQuery]);

  const removeFileRef = useCallback((path: string) => {
    setFileRefs((prev) => prev.filter((r) => r.path !== path));
  }, []);

  const removeAgentRef = useCallback((path: string) => {
    setAgentRefs((prev) => prev.filter((r) => r.path !== path));
  }, []);

  const removeSkillRef = useCallback((path: string) => {
    setSkillRefs((prev) => prev.filter((r) => r.path !== path));
  }, []);

  const removeToolRef = useCallback((path: string) => {
    setToolRefs((prev) => prev.filter((r) => r.path !== path));
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
    + agentRefs.length * 50 // rough estimate for agent system prompt tokens
    + skillRefs.length * 100 // rough estimate for skill content tokens
    + toolRefs.length * 30; // rough estimate for tool directive tokens

  const clearAllRefs = useCallback(() => {
    setFileRefs([]);
    setAgentRefs([]);
    setSkillRefs([]);
    setToolRefs([]);
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

  /** Find the question (user message) that precedes an assistant message at a given index. */
  const findQuestionForAssistant = useCallback((assistantIndex: number): string => {
    // Walk backwards from the assistant message to find the preceding user message
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        // Prefer displayContent (what the user saw) over full API content
        return messages[i].displayContent || messages[i].content;
      }
    }
    return "(unknown question)";
  }, [messages]);
  /** Handle thumbs up — save as a good example immediately. */
  const handleThumbsUp = useCallback(async (msgIndex: number) => {
    const msg = messages[msgIndex];
    if (!msg || msg.role !== "assistant") return;

    const question = findQuestionForAssistant(msgIndex);
    const modelCtx = getModelContext();
    const configs = getModelConfigurations();

    const data: RlhfData = {
      feedback_type: "good",
      model_provider: modelCtx.provider,
      model_name: modelCtx.model,
      model_configurations: configs,
      timestamp: new Date().toISOString(),
      question,
      answer: msg.content,
      user_correction: "",
    };

    try {
      await saveRlhfFeedback(rootPath, data);
    } catch (e) {
      console.error("[rlhf] Failed to save good feedback:", e);
    }

    // Mark as rated thumbs up
    setMessages((prev) => {
      const msgs = [...prev];
      if (msgs[msgIndex]) {
        msgs[msgIndex] = { ...msgs[msgIndex], feedback: "good", feedbackPending: false };
      }
      return msgs;
    });
  }, [messages, rootPath, findQuestionForAssistant]);

  /** Handle thumbs down — open the correction input. */
  const handleThumbsDown = useCallback((msgIndex: number) => {
    setMessages((prev) => {
      const msgs = [...prev];
      if (msgs[msgIndex]) {
        msgs[msgIndex] = { ...msgs[msgIndex], feedbackPending: true };
      }
      return msgs;
    });
  }, []);

  /** Cancel a pending thumbs-down correction. */
  const cancelCorrection = useCallback((msgIndex: number) => {
    setMessages((prev) => {
      const msgs = [...prev];
      if (msgs[msgIndex]) {
        msgs[msgIndex] = { ...msgs[msgIndex], feedbackPending: false };
      }
      return msgs;
    });
  }, []);

  /** Submit a correction for a thumbs-down rating and save. */
  const submitCorrection = useCallback(async (msgIndex: number, correction: string) => {
    const msg = messages[msgIndex];
    if (!msg || msg.role !== "assistant") return;

    const question = findQuestionForAssistant(msgIndex);
    const modelCtx = getModelContext();
    const configs = getModelConfigurations();

    const data: RlhfData = {
      feedback_type: "bad",
      model_provider: modelCtx.provider,
      model_name: modelCtx.model,
      model_configurations: configs,
      timestamp: new Date().toISOString(),
      question,
      answer: msg.content,
      user_correction: correction.trim() || "(no correction provided)",
    };

    try {
      await saveRlhfFeedback(rootPath, data);
    } catch (e) {
      console.error("[rlhf] Failed to save bad feedback:", e);
    }

    // Mark as rated thumbs down with the correction
    setMessages((prev) => {
      const msgs = [...prev];
      if (msgs[msgIndex]) {
        msgs[msgIndex] = {
          ...msgs[msgIndex],
          feedback: "bad",
          feedbackPending: false,
          feedbackCorrection: correction.trim() || undefined,
        };
      }
      return msgs;
    });
  }, [messages, rootPath, findQuestionForAssistant]);

  /** Handle DPO choice — user picked one of two alternative responses. */
  const handleDpoChoose = useCallback(async (msgIndex: number, choice: "A" | "B") => {
    const msg = messages[msgIndex];
    if (!msg || !msg.dpoResponses) return;

    const { responseA, responseB } = msg.dpoResponses;
    const chosen = choice === "A" ? responseA : responseB;
    const rejected = choice === "A" ? responseB : responseA;
    const question = findQuestionForAssistant(msgIndex);
    const modelCtx = getModelContext();
    const configs = getModelConfigurations();

    // Update the message: show only the chosen response as content
    setMessages((prev) => {
      const msgs = [...prev];
      if (msgs[msgIndex]) {
        msgs[msgIndex] = {
          ...msgs[msgIndex],
          content: chosen,
          dpoChoice: choice,
          dpoResponses: undefined, // clear DPO mode
        };
      }
      return msgs;
    });

    // Save as DPO JSONL entry
    const dpoEntry: DpoEntry = {
      prompt: question,
      chosen,
      rejected,
      model_provider: modelCtx.provider,
      model_name: modelCtx.model,
      model_configurations: configs,
      timestamp: new Date().toISOString(),
    };

    try {
      await saveDpoFeedback(rootPath, dpoEntry);
      // Reset the counter so the next DPO triggers after dpoInterval messages from now
      messageCountRef.current = 0;
    } catch (e) {
      console.error("[rlhf] Failed to save DPO feedback:", e);
    }
  }, [messages, rootPath, findQuestionForAssistant]);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading || sendingRef.current) return;

    // Prevent sending while a DPO response choice is pending
    if (messages.some((m) => m.dpoResponses !== undefined)) return;

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
    // The @mentions and /mentions are already embedded in the input text (kept on autocomplete select).
    // We just show the message as-is, with context badges below.
    const contextRefs: { type: "file" | "directory" | "agent" | "skill" | "tool"; name: string }[] = [
      ...fileRefs.map((r) => ({ type: r.isDir ? ("directory" as const) : ("file" as const), name: r.name })),
      ...agentRefs.map((r) => ({ type: "agent" as const, name: r.name })),
      ...skillRefs.map((r) => ({ type: "skill" as const, name: r.name })),
      ...toolRefs.map((r) => ({ type: "tool" as const, name: r.name })),
    ];
    const displayText = trimmed;

    // ---- Build API content (sent to the AI backend) ----
    let apiContent = trimmed;
    const refsWithSize: FileRef[] = [];

    // Collect file contexts
    const contextParts: string[] = [];

    // Always include the working directory so the agent knows where it is
    if (rootPath) {
      contextParts.push(`Working directory: ${rootPath}`);
    }

    if (fileRefs.length > 0) {
      const expandedFilePaths = new Set<string>();
      for (const ref of fileRefs) {
        if (ref.isDir) {
          try {
            const files: string[] = await invoke("list_files_recursive", { path: ref.path });
            for (const filePath of files) {
              if (expandedFilePaths.has(filePath)) continue;
              expandedFilePaths.add(filePath);
              try {
                const fileContent: string = await invoke("read_file", { path: filePath });
                const tokenCount = countTokens(fileContent);
                contextParts.push(`File: ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``);
                refsWithSize.push({
                  path: filePath,
                  name: rootPath ? filePath.replace(rootPath, "").replace(/^[\\/]+/, "") || filePath : filePath,
                  _tokenCount: tokenCount,
                });
              } catch (e) {
                console.error(`Failed to read referenced file ${filePath}:`, e);
              }
            }
          } catch (e) {
            console.error(`Failed to list directory ${ref.path}:`, e);
          }
        } else {
          try {
            const fileContent: string = await invoke("read_file", { path: ref.path });
            const tokenCount = countTokens(fileContent);
            contextParts.push(`File: ${ref.path}\n\`\`\`\n${fileContent}\n\`\`\``);
            refsWithSize.push({ ...ref, _tokenCount: tokenCount });
          } catch (e) {
            console.error(`Failed to read referenced file ${ref.path}:`, e);
          }
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

    // Collect tool directives — tell the AI to use specific tools
    for (const tool of toolRefs) {
      contextParts.push(`The user explicitly requests that you use the tool "#${tool.name}" for this request. You MUST call this tool to fulfill the request.`);
    }

    // Collect skill contexts — read skill files, execute any embedded commands, include output
    for (const skill of skillRefs) {
      try {
        const result: { stdout: string; stderr: string; exit_code: number; content: string } =
          await invoke("run_skill_command", { rootPath, skillName: skill.name });
        const skillParts: string[] = [];
        skillParts.push(`Skill: ${skill.name}\n\`\`\`\n${result.content}\n\`\`\``);
        if (result.stdout) {
          skillParts.push(`Command output (stdout):\n\`\`\`\n${result.stdout}\n\`\`\``);
        }
        if (result.stderr) {
          skillParts.push(`Command stderr (exit code ${result.exit_code}):\n\`\`\`\n${result.stderr}\n\`\`\``);
        }
        contextParts.push(skillParts.join("\n\n"));
      } catch (e) {
        console.error(`Failed to process skill ${skill.name}:`, e);
        contextParts.push(`Skill: ${skill.name}\n(Error reading skill: ${e})`);
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
    setSkillRefs([]); // Clear pending skill refs after sending
    setToolRefs([]); // Clear pending tool refs after sending
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

      // Read per-backend API key from keychain (fallback: localStorage)
      const apiKey = (await getSecret(`apiKey.${backend}`)) ?? localStorage.getItem(`nolock.apiKey.${backend}`) ?? "";

      // Read enabled tools from localStorage
      const toolsRaw = localStorage.getItem("nolock.toolsEnabled") || "[]";
      const toolsEnabled: string[] = JSON.parse(toolsRaw);

      // Read per-tool configuration from localStorage (always the most current,
      // written synchronously by setSecret; keychain may hold stale data).
      const toolConfigRaw = localStorage.getItem("nolock.toolConfig") ?? "{}";
      const toolConfigs: Record<string, Record<string, string>> = JSON.parse(toolConfigRaw);

      // Read chat model parameters from localStorage
      const chatTemperature = localStorage.getItem("nolock.chatTemperature");
      const chatMaxTokens = localStorage.getItem("nolock.chatMaxTokens");
      const chatSystemPrompt = localStorage.getItem("nolock.chatSystemPrompt");

      // ---- Check DPO trigger ----
      const dpoSettings = readRlhfSettings();
      let dpoTriggered = false;
      if (dpoSettings.dpoEnabled) {
        messageCountRef.current += 1;
        dpoTriggered = messageCountRef.current % dpoSettings.dpoInterval === 0;
      }

      // Build common API messages
      const apiMessages = [
        ...agentSystemMessages,
        ...allMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      // Shared request base
      const reqBase = {
        backend,
        url,
        model: chatModel,
        messages: apiMessages,
        apiKey: apiKey || null,
        toolsEnabled,
        toolConfigs,
        temperature: chatTemperature ? parseFloat(chatTemperature) : undefined,
        maxTokens: chatMaxTokens ? parseInt(chatMaxTokens, 10) : undefined,
        systemPrompt: chatSystemPrompt || undefined,
        rootPath: rootPath || undefined,
        maxIterations: parseInt(localStorage.getItem("nolock.toolMaxIterations") || "10", 10),
      };

      if (dpoTriggered) {
        // ---- DPO mode: generate TWO responses without streaming ----
        let respA = "";
        let respB = "";

        try {
          // First call: normal parameters
          const resultA: { content: string } = await invoke("ai_chat", { req: reqBase });
          respA = resultA.content || "(no response)";

          // Second call: slightly higher temperature for diversity
          const baseTemp = chatTemperature ? parseFloat(chatTemperature) : 0.7;
          const altTemp = Math.min(1, baseTemp + 0.2);
          const resultB: { content: string } = await invoke("ai_chat", {
            req: { ...reqBase, temperature: altTemp },
          });
          respB = resultB.content || "(no response)";
        } catch (e: any) {
          // Fall back to a single error message
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `DPO generation failed: ${e}` },
          ]);
          sendingRef.current = false;
          setLoading(false);
          return;
        }

        // Add a DPO choice message (no placeholder was created, so push a new message)
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "",
            dpoResponses: { responseA: respA, responseB: respB },
          },
        ]);
      } else {
        // ---- Normal mode: stream a single response ----
        unlisten = await listen<{ token: string }>("stream-token", (event) => {
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

        const result: { content: string; tool_calls: ToolCallLog[] } = await invoke("ai_chat", {
          req: reqBase,
        });

        // If the user clicked Stop while waiting, discard
        if (stopRequestedRef.current) {
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
      }
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
            Use <strong>@agent-name</strong> to invoke an AI agent.<br />
            Use <strong>/skill-name</strong> to run a skill command.<br />
            Use <strong>#tool-name</strong> to force the AI to use a specific tool.

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
                {/* DPO choice component — show two responses side by side */}
                {m.dpoResponses ? (
                  <DpoChoice
                    responseA={m.dpoResponses.responseA}
                    responseB={m.dpoResponses.responseB}
                    onChoose={(choice) => handleDpoChoose(i, choice)}
                  />
                ) : m.content ? (
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

                {/* RLHF feedback buttons — shown after assistant messages are complete (not while streaming) */}
                {m.content && !(i === messages.length - 1 && loading) && m.role === "assistant" && (
                  <div className="rlhf-actions">
                    {m.feedback === "good" ? (
                      <span className="rlhf-badge rlhf-badge-saved" title="You marked this as helpful">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                          <polyline points="17 21 17 13 7 13 7 21" />
                          <polyline points="7 3 7 8 15 8" />
                        </svg>
                        Saved
                      </span>
                    ) : m.feedback === "bad" ? (
                      <span className="rlhf-badge rlhf-badge-saved" title="You marked this as needing improvement">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                          <polyline points="17 21 17 13 7 13 7 21" />
                          <polyline points="7 3 7 8 15 8" />
                        </svg>
                        Saved
                      </span>
                    ) : m.feedbackPending ? (
                      /* Correction input for thumbs down */
                      <div className="rlhf-correction-area">
                        <div className="rlhf-correction-header">
                          <span className="rlhf-correction-label">What could be improved? (optional but helpful)</span>
                        </div>
                        <CorrectionInput
                          onSubmit={(correction) => submitCorrection(i, correction)}
                          onCancel={() => cancelCorrection(i)}
                        />
                      </div>
                    ) : (
                      <>
                        <button
                          className="rlhf-btn rlhf-btn-up"
                          onClick={() => handleThumbsUp(i)}
                          title="Mark as helpful"
                          aria-label="Thumbs up"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M7 10v12" />
                            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
                          </svg>
                        </button>
                        <button
                          className="rlhf-btn rlhf-btn-down"
                          onClick={() => handleThumbsDown(i)}
                          title="Report as incorrect or unhelpful"
                          aria-label="Thumbs down"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 14V2" />
                            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                )}
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
                        ) : ref.type === "skill" ? (
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
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
        {/* File / directory ref chips */}
        {fileRefs.length > 0 && (
          <div className="file-ref-chips">
            <div className="file-ref-chips-list">
              {fileRefs.map((ref) => (
                <div key={ref.path} className={`file-ref-chip ${ref.isDir ? "directory-ref-chip" : ""}`}>
                  {ref.isDir && (
                    <span className="directory-ref-icon">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                  )}
                  <span className="file-ref-name">{ref.isDir ? ref.name : ref.name}</span>
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

        {/* Skill ref chips */}
        {skillRefs.length > 0 && (
          <div className="file-ref-chips">
            <div className="file-ref-chips-list">
              {skillRefs.map((ref) => (
                <div key={ref.path} className="skill-ref-chip">
                  <span className="skill-ref-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                  </span>
                  <span className="file-ref-name">/{ref.name}</span>
                  <span className="file-ref-remove" onClick={() => removeSkillRef(ref.path)}>&times;</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tool ref chips */}
        {toolRefs.length > 0 && (
          <div className="file-ref-chips">
            <div className="file-ref-chips-list">
              {toolRefs.map((ref) => (
                <div key={ref.path} className="tool-ref-chip">
                  <span className="tool-ref-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  </span>
                  <span className="file-ref-name">#{ref.name}</span>
                  <span className="tool-ref-remove" onClick={() => removeToolRef(ref.path)}>&times;</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions bar (when chips are present) */}
        {(fileRefs.length > 0 || agentRefs.length > 0 || skillRefs.length > 0 || toolRefs.length > 0) && (
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
        {fileRefs.length === 0 && agentRefs.length === 0 && skillRefs.length === 0 && toolRefs.length === 0 && (accumulatedContextTokens > 0 || messages.length > 0) && (
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
        {/* Inline autocomplete panel — appears between messages and input when @mention or /mention is active */}
        {mentionQuery !== null && rootPath && mentionType === "file" && (
          <div className="chat-autocomplete-panel">
            <FileAutocomplete
              query={mentionQuery}
              rootPath={rootPath}
              onSelect={handleFileSelect}
              onSelectAgent={handleAgentSelect}
              onClose={() => {
                setMentionQuery(null);
                setMentionIndex(-1);
                setMentionType(null);
              }}
            />
          </div>
        )}
        {mentionQuery !== null && rootPath && mentionType === "skill" && (
          <div className="chat-autocomplete-panel">
            <SkillAutocomplete
              query={mentionQuery}
              rootPath={rootPath}
              onSelect={handleSkillSelect}
              onClose={() => {
                setMentionQuery(null);
                setMentionIndex(-1);
                setMentionType(null);
              }}
            />
          </div>
        )}
        {mentionQuery !== null && rootPath && mentionType === "tool" && (
          <div className="chat-autocomplete-panel">
            <ToolAutocomplete
              query={mentionQuery}
              rootPath={rootPath}
              onSelect={handleToolSelect}
              onClose={() => {
                setMentionQuery(null);
                setMentionIndex(-1);
                setMentionType(null);
              }}
            />
          </div>
        )}

        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={2}
            placeholder={dpoPending ? "Please choose a response above to continue..." : "Type @ to reference a file or agent, / to run a skill, # to use a tool... Ask the AI..."}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (dpoPending) {
                e.preventDefault();
                return;
              }
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
            disabled={dpoPending}
          />
        </div>
        <button className="chat-send" onClick={sendMessage} disabled={loading || dpoPending}>
          {loading ? "Thinking..." : dpoPending ? "Choose response..." : "Send"}
        </button>
      </div>
    </div>
  );
}
