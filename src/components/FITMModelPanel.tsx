import { useState, useEffect } from "react";
import ModelSelector from "./ModelSelector";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const BACKEND_DEFAULTS: Record<string, { url: string }> = {
  ollama: { url: "http://localhost:11434" },
  llamacpp: { url: "http://localhost:8080" },
  openrouter: { url: "https://openrouter.ai/api/v1" },
  opencode: { url: "https://opencode.ai/zen/v1" },
};

export default function FITMModelPanel({ visible, onClose }: Props) {
  const [completionModel, setCompletionModel] = useState("");
  const [backend, setBackend] = useState("ollama");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
  );
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(64);

  useEffect(() => {
    if (!visible) return;
    const oldModel = localStorage.getItem("nolock.model");
    setCompletionModel(localStorage.getItem("nolock.completionModel") || oldModel || "");
    setSystemPrompt(
      localStorage.getItem("nolock.fitmSystemPrompt") ||
      "You are a code completion engine. Output ONLY the code that belongs at the cursor — nothing before and nothing after. Be concise: prefer minimal completions. No explanations, no markdown formatting, no conversational text. Never repeat existing code.",
    );
    const savedTemp = localStorage.getItem("nolock.fitmTemperature");
    setTemperature(savedTemp ? parseFloat(savedTemp) : 0.2);
    const savedTokens = localStorage.getItem("nolock.fitmMaxTokens");
    setMaxTokens(savedTokens ? parseInt(savedTokens, 10) : 64);
    setBackend(localStorage.getItem("nolock.backend") || "ollama");
    const currentBackend = localStorage.getItem("nolock.backend") || "ollama";
    setApiKey(localStorage.getItem(`nolock.apiKey.${currentBackend}`) || "");
  }, [visible]);

  const save = () => {
    localStorage.setItem("nolock.completionModel", completionModel);
    localStorage.setItem("nolock.model", completionModel); // legacy sync
    localStorage.setItem("nolock.fitmSystemPrompt", systemPrompt);
    localStorage.setItem("nolock.fitmTemperature", String(temperature));
    localStorage.setItem("nolock.fitmMaxTokens", String(maxTokens));
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>FITM Model</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <ModelSelector
            provider={backend}
            url={localStorage.getItem("nolock.url") || BACKEND_DEFAULTS[backend]?.url || "http://localhost:11434"}
            apiKey={apiKey}
            value={completionModel}
            onChange={setCompletionModel}
            placeholder="e.g. qwen2.5-coder:1.5b"
            label="Code Completion Model (FITM)"
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Smaller/faster model for inline code suggestions. Uses Fill-In-The-Middle (prefix+suffix).
          </span>
          <span style={{ fontSize: 10, color: "var(--text-warning)", display: "block", marginBottom: 12, padding: "6px 8px", background: "rgba(255, 200, 0, 0.08)", borderRadius: 4, lineHeight: 1.5 }}>
            FIM prompts are sent in <strong>raw mode</strong> (bypassing chat template). This is required for
            <strong> Qwen2.5-Coder</strong>, <strong>DeepSeek-Coder</strong>, <strong>CodeLlama</strong>, and
            other FIM-trained models. If the model does not understand FIM tokens
            (<code>&lt;|fim_prefix|&gt;...&lt;|fim_middle|&gt;</code>), it may return empty completions.
            Switch to a raw-prefix-only model or disable the system prompt to troubleshoot.
          </span>

          <label className="field-label">System Prompt</label>
          <textarea
            className="field-input"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a code completion engine..."
            rows={4}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12, minHeight: 80 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Instructs the model how to behave for inline completions.
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

          <label className="field-label">Max Tokens</label>
          <input
            className="field-input"
            type="number"
            min={16}
            max={4096}
            step={16}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Math.max(16, parseInt(e.target.value, 10) || 64))}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
            Maximum number of tokens in the completion (16–4096). Lower = faster suggestions.
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
