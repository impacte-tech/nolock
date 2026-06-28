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
    "You are a code completion engine. Output ONLY valid code. No explanations, no markdown formatting, no conversational text. Complete the code at the cursor position and nothing else.",
  );
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(64);

  useEffect(() => {
    if (!visible) return;
    const oldModel = localStorage.getItem("nolock.model");
    setCompletionModel(localStorage.getItem("nolock.completionModel") || oldModel || "");
    setSystemPrompt(
      localStorage.getItem("nolock.fitmSystemPrompt") ||
      "You are a code completion engine. Output ONLY valid code. No explanations, no markdown formatting, no conversational text. Complete the code at the cursor position and nothing else.",
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
