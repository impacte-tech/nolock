import { useState, useEffect } from "react";
import ModelSelector from "./ModelSelector";
import Select from "./Select";
import { BACKENDS, resolveBackendUrl, getChatBackend, isCloudBackend } from "../lib/backends";

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
    // Chat uses its own provider (falls back to the global one).
    const chatBackend = getChatBackend();
    setBackend(chatBackend);
    setApiKey(localStorage.getItem(`nolock.apiKey.${chatBackend}`) || "");
    setShowThinking(localStorage.getItem("nolock.showThinking") === "true");
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
    onClose();
  };

  if (!visible) return null;

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

          {isCloudBackend(backend) ? (
            <>
              <label className="field-label">Cloud Max Tokens</label>
              <input
                className="field-input"
                type="number"
                min={1}
                step={64}
                value={cloudMaxTokens}
                onChange={(e) => setCloudMaxTokens(e.target.value)}
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
              <input
                className="field-input"
                type="number"
                min={64}
                max={1000000}
                step={64}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Math.max(64, parseInt(e.target.value, 10) || 2048))}
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
          <input
            className="field-input"
            type="number"
            min={1024}
            step={1024}
            value={contextLength}
            onChange={(e) => setContextLength(Math.max(1024, parseInt(e.target.value, 10) || 128_000))}
            style={{ width: 140 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Model context window size used to compute the context % meter.
            For Ollama this is auto-detected from the model; set it manually for cloud
            models (e.g. 65536, 128000, 200000).
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
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
