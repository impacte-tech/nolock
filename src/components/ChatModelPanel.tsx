import { useState, useEffect } from "react";

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function ChatModelPanel({ visible, onClose }: Props) {
  const [chatModel, setChatModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);

  useEffect(() => {
    if (!visible) return;
    const oldModel = localStorage.getItem("nolock.model");
    setChatModel(localStorage.getItem("nolock.chatModel") || oldModel || "");
    setSystemPrompt(localStorage.getItem("nolock.chatSystemPrompt") || "");
    const savedTemp = localStorage.getItem("nolock.chatTemperature");
    setTemperature(savedTemp ? parseFloat(savedTemp) : 0.7);
    const savedTokens = localStorage.getItem("nolock.chatMaxTokens");
    setMaxTokens(savedTokens ? parseInt(savedTokens, 10) : 2048);
  }, [visible]);

  const save = () => {
    localStorage.setItem("nolock.chatModel", chatModel);
    localStorage.setItem("nolock.chatSystemPrompt", systemPrompt);
    localStorage.setItem("nolock.chatTemperature", String(temperature));
    localStorage.setItem("nolock.chatMaxTokens", String(maxTokens));
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
          <label className="field-label">Chat Model</label>
          <input
            className="field-input"
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            placeholder="e.g. qwen3:8b"
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

          <label className="field-label">Max Tokens</label>
          <input
            className="field-input"
            type="number"
            min={64}
            max={32768}
            step={64}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Math.max(64, parseInt(e.target.value, 10) || 2048))}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block" }}>
            Maximum number of tokens in the model's response (64–32768).
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
