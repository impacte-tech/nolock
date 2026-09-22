import { useState, useEffect } from "react";
import ModelSelector from "./ModelSelector";
import Select from "./Select";
import NumberField, { parseInt10 } from "./NumberField";
import { BACKENDS, resolveBackendUrl, getChatBackend, isCloudBackend } from "../lib/backends";
import {
  type ChatMode,
  CHAT_MODES,
  getChatMode,
  setChatModeStored,
} from "../lib/chatModes";
import {
  getFaqConfig,
  setFaqConfig,
  FAQ_RANKING_OPTIONS,
  DEFAULT_EMBEDDING_MODEL,
  type FaqLearningConfig,
  type FaqRanking,
} from "../lib/faq";

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function ChatModelPanel({ visible, onClose }: Props) {
  const [chatModel, setChatModel] = useState("");
  const [backend, setBackend] = useState("ollama");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(8192);
  // Cloud max tokens — empty string means "unlimited" (omit the field so the
  // provider's own default applies). Only used for cloud backends.
  const [cloudMaxTokens, setCloudMaxTokens] = useState("");
  // Context window used for the context % meter denominator.
  const [contextLength, setContextLength] = useState(128_000);
  const [showThinking, setShowThinking] = useState(false);
  // Reasoning-only retries — how many times nolock re-prompt after a thinking
  // model finishes with only reasoning and no answer / tool call.
  const [reasoningRetries, setReasoningRetries] = useState(8);
  // Chat mode (Building / Planning / Learning) — the behavior of the main
  // chat agent. Kept at the far bottom of the panel, right after the Chat
  // Model settings.
  const [chatMode, setChatMode] = useState<ChatMode>(() => getChatMode());
  // Learning-mode retrieval config (embedding model, ranking, topK). Only
  // surfaced when Chat Mode = Learning.
  const [faqConfig, setFaqConfigState] = useState<FaqLearningConfig>(() => getFaqConfig());

  useEffect(() => {
    if (!visible) return;
    const oldModel = localStorage.getItem("nolock.model");
    setChatModel(localStorage.getItem("nolock.chatModel") || oldModel || "");
    setSystemPrompt(localStorage.getItem("nolock.chatSystemPrompt") || "");
    const savedTemp = localStorage.getItem("nolock.chatTemperature");
    setTemperature(savedTemp ? parseFloat(savedTemp) : 0.7);
    const savedTokens = localStorage.getItem("nolock.chatMaxTokens");
    setMaxTokens(savedTokens ? parseInt(savedTokens, 10) : 8192);
    setCloudMaxTokens(localStorage.getItem("nolock.chatCloudMaxTokens") || "");
    const savedCtx = localStorage.getItem("nolock.contextLength");
    setContextLength(savedCtx ? parseInt(savedCtx, 10) : 128_000);
    const savedRetries = localStorage.getItem("nolock.reasoningRetries");
    setReasoningRetries(savedRetries ? parseInt(savedRetries, 10) : 8);
    // Chat uses its own provider (falls back to the global one).
    const chatBackend = getChatBackend();
    setBackend(chatBackend);
    setApiKey(localStorage.getItem(`nolock.apiKey.${chatBackend}`) || "");
    setShowThinking(localStorage.getItem("nolock.showThinking") === "true");
    setChatMode(getChatMode());
    setFaqConfigState(getFaqConfig());
  }, [visible]);

  const selectBackend = (value: string) => {
    setBackend(value);
    setApiKey(localStorage.getItem(`nolock.apiKey.${value}`) || "");
  };

  const save = () => {
    localStorage.setItem("nolock.chatBackend", backend);
    localStorage.setItem("nolock.chatModel", chatModel);
    localStorage.setItem("nolock.chatSystemPrompt", systemPrompt);
    localStorage.setItem("nolock.chatTemperature", String(temperature));
    localStorage.setItem("nolock.chatMaxTokens", String(maxTokens));
    localStorage.setItem("nolock.chatCloudMaxTokens", cloudMaxTokens);
    localStorage.setItem("nolock.contextLength", String(contextLength));
    localStorage.setItem("nolock.showThinking", String(showThinking));
    localStorage.setItem("nolock.reasoningRetries", String(reasoningRetries));
    setChatModeStored(chatMode);
    setFaqConfig(faqConfig);
    // Notify the bottom bar / any status readers that the chat provider/model
    // changed (a custom event; the `storage` event doesn't fire in the same
    // window in Tauri).
    window.dispatchEvent(new CustomEvent("nolock:settings-changed"));
    onClose();
  };

  if (!visible) return null;

  const isCloud = isCloudBackend(backend);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Chat Model</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Provider</label>
          <Select
            value={backend}
            onChange={selectBackend}
            options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            This is the <strong>Planning provider</strong> — the main orchestrator model that
            plans, delegates to sub-agents, and synthesizes. Use an online provider (OpenRouter,
            DigitalOcean) here for the best planning quality, and local models as task executors.
          </span>

          <ModelSelector
            provider={backend}
            url={resolveBackendUrl(backend)}
            apiKey={apiKey}
            value={chatModel}
            onChange={setChatModel}
            placeholder="e.g. qwen3.5:0.8b-mlx"
            label="Chat Model"
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Larger model for the Agent Chat panel. Uses multi-turn conversations.
          </span>

          <label className="field-label">System Prompt (default)</label>
          <textarea
            className="field-input"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful AI assistant..."
            rows={4}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12, minHeight: 80 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Default system prompt applied to all chat conversations. Can be overridden per-agent.
          </span>

          <label className="field-label">
            Temperature: {temperature.toFixed(1)}
          </label>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", marginBottom: 12 }}>
            <span>Precise (0.0)</span>
            <span>Creative (2.0)</span>
          </div>

          {isCloud ? (
            <>
              <label className="field-label">Cloud Max Tokens</label>
              <NumberField
                value={cloudMaxTokens}
                onChange={(n) => setCloudMaxTokens(n == null ? "" : String(n))}
                min={1}
                step={64}
                placeholder="256000 (default)"
                style={{ width: 120 }}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
                Maximum output tokens for cloud providers. Leave empty for the{" "}
                <strong>default (256000)</strong> — large enough for long agentic tool-loop
                runs on models with big context windows. For DigitalOcean this maps to{" "}
                <code>max_completion_tokens</code>, scoped across the whole tool loop.
              </span>
            </>
          ) : (
            <>
              <label className="field-label">Max Tokens</label>
              <NumberField
                value={maxTokens}
                onChange={(n) => setMaxTokens(n ?? 2048)}
                min={64}
                max={1000000}
                step={64}
                emptyValue={2048}
                parse={parseInt10}
                style={{ width: 120 }}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
                Maximum number of tokens in the model's response (64–1000000).
                When Agent Tools are enabled and this is left unset, the backend defaults to 256000.
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 4, fontStyle: "italic" }}>
                Thinking models (Qwen3, DeepSeek-R1, etc.) consume tokens for hidden reasoning.
                Leave this unset when using tools so the backend uses its large default, otherwise the response may be cut off.
              </span>
            </>
          )}

          <label className="field-label">Context Window</label>
          <NumberField
            value={contextLength}
            onChange={(n) => setContextLength(n ?? 128_000)}
            min={1024}
            step={1024}
            emptyValue={128_000}
            parse={parseInt10}
            style={{ width: 140 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Model context window size used to compute the context % meter.
            For Ollama this is auto-detected from the model; set it manually for cloud
            models (e.g. 65536, 128000, 200000).
          </span>

          <label className="field-label">Reasoning-Only Retries</label>
          <NumberField
            value={reasoningRetries}
            onChange={(n) => setReasoningRetries(n ?? 8)}
            min={1}
            max={20}
            step={1}
            emptyValue={8}
            parse={parseInt10}
            style={{ width: 90 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            How many times nolock re-prompts when a thinking model (nemotron, Qwen3, DeepSeek-R1)
            finishes a turn with <strong>only reasoning</strong> and no visible answer or tool call.
            Higher values give stuck models more chances to produce an answer (and are applied to
            both the agent tool loop and plain chat). Default <strong>8</strong>.
          </span>

          <label className="field-label" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Show Thinking
          </label>
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Display the model's reasoning trace while it generates a response. Only supported by thinking-capable models (Qwen3, DeepSeek-R1, etc.). Thinking tokens are shown transiently and not saved to the conversation.
          </span>

          {/* ================= Chat Mode (far bottom) ================= */}
          <label className="field-label">Chat Mode</label>
          <Select
            value={chatMode}
            onChange={(v) => setChatMode(v as ChatMode)}
            options={CHAT_MODES.map((m) => ({ value: m.id, label: m.label }))}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
            {CHAT_MODES.find((m) => m.id === chatMode)?.description}
          </span>
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            In <strong>Learning</strong> mode the assistant teaches you about the project and
            maintains a plain-text <code>.faq/</code> directory at the repository root — it
            creates it, tracks every question you ask and rewrites a ranked README
            (most-asked first) as the conversation goes. Every exchange is also indexed
            in a local SQLite + sqlite-vec vector store so past questions can be retrieved
            semantically on later turns.
          </span>

          {/* ============ Learning-mode retrieval config ============ */}
          {chatMode === "learning" && (
            <>
              <label className="field-label">Embedding Model</label>
              <ModelSelector
                provider={backend}
                url={resolveBackendUrl(backend)}
                apiKey={apiKey}
                value={faqConfig.embeddingModel}
                onChange={(v) => setFaqConfigState({ ...faqConfig, embeddingModel: v })}
                placeholder={DEFAULT_EMBEDDING_MODEL}
                label="Embedding Model"
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
                Model used to embed learned exchanges and queries for semantic retrieval.
                Must be an embedding-capable model on the selected provider
                (e.g. <code>nomic-embed-text</code> on Ollama). Default{" "}
                <strong>{DEFAULT_EMBEDDING_MODEL}</strong>.
              </span>

              <label className="field-label">Ranking</label>
              <Select
                value={faqConfig.ranking}
                onChange={(v) => setFaqConfigState({ ...faqConfig, ranking: v as FaqRanking })}
                options={FAQ_RANKING_OPTIONS}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
                How retrieved past exchanges are ordered before being injected into
                the conversation: semantic (cosine similarity), frequency (most-asked),
                or a hybrid blend of both.
              </span>

              <label className="field-label">Top K (retrieved exchanges)</label>
              <NumberField
                value={faqConfig.topK}
                onChange={(n) => setFaqConfigState({ ...faqConfig, topK: n ?? 3 })}
                min={1}
                max={10}
                step={1}
                emptyValue={3}
                parse={parseInt10}
                style={{ width: 90 }}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
                How many matching question → answer pairs are injected into the chat
                context on each turn in Learning mode.
              </span>

              <label className="field-label">
                Category similarity threshold: {faqConfig.minSimilarity.toFixed(2)}
              </label>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.01"
                value={faqConfig.minSimilarity}
                onChange={(e) => setFaqConfigState({ ...faqConfig, minSimilarity: parseFloat(e.target.value) })}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                <span>Looser (0.50)</span>
                <span>Stricter (1.00)</span>
              </div>
              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
                Minimum cosine similarity for a question to join a category's auto-group.
                Questions at or above this threshold (compared with the category's most-asked
                question) land in the same category; anything below starts a new one.
                Higher values group fewer, more similar questions.
              </span>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}