import { useState, useEffect } from "react";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const LS_ENABLED = "nolock.rlhf.enabled";
const LS_ROOT = "nolock.rlhf.root";
const LS_GOOD = "nolock.rlhf.goodDir";
const LS_BAD = "nolock.rlhf.badDir";

const DEFAULTS = {
  enabled: true,
  root: ".rlhf",
  goodDir: "good",
  badDir: "bad",
};

export function readRlhfSettings() {
  return {
    enabled: localStorage.getItem(LS_ENABLED) !== "false",
    root: localStorage.getItem(LS_ROOT) || DEFAULTS.root,
    goodDir: localStorage.getItem(LS_GOOD) || DEFAULTS.goodDir,
    badDir: localStorage.getItem(LS_BAD) || DEFAULTS.badDir,
  };
}

export default function RlhfPanel({ visible, onClose }: Props) {
  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [root, setRoot] = useState(DEFAULTS.root);
  const [goodDir, setGoodDir] = useState(DEFAULTS.goodDir);
  const [badDir, setBadDir] = useState(DEFAULTS.badDir);

  useEffect(() => {
    if (!visible) return;
    const s = readRlhfSettings();
    setEnabled(s.enabled);
    setRoot(s.root);
    setGoodDir(s.goodDir);
    setBadDir(s.badDir);
  }, [visible]);

  const save = () => {
    localStorage.setItem(LS_ENABLED, String(enabled));
    localStorage.setItem(LS_ROOT, root.trim() || DEFAULTS.root);
    localStorage.setItem(LS_GOOD, goodDir.trim() || DEFAULTS.goodDir);
    localStorage.setItem(LS_BAD, badDir.trim() || DEFAULTS.badDir);
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Human Feedback (RLHF)</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Enable toggle */}
          <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Enable RLHF feedback collection
          </label>
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 16 }}>
            When enabled, thumbs up/down ratings are saved as JSON files for fine-tuning or analysis.
          </span>

          {/* Root folder */}
          <label className="field-label">Root feedback folder</label>
          <input
            className="field-input"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder={DEFAULTS.root}
            disabled={!enabled}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Directory name inside your project folder where feedback is stored. Default: <code>{DEFAULTS.root}</code>
          </span>

          {/* Good subdirectory */}
          <label className="field-label">Good feedback subdirectory</label>
          <input
            className="field-input"
            value={goodDir}
            onChange={(e) => setGoodDir(e.target.value)}
            placeholder={DEFAULTS.goodDir}
            disabled={!enabled}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Subdirectory for thumbs-up (good) examples. Default: <code>{DEFAULTS.goodDir}</code>
          </span>

          {/* Bad subdirectory */}
          <label className="field-label">Bad feedback subdirectory</label>
          <input
            className="field-input"
            value={badDir}
            onChange={(e) => setBadDir(e.target.value)}
            placeholder={DEFAULTS.badDir}
            disabled={!enabled}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Subdirectory for thumbs-down (bad) examples with user corrections. Default: <code>{DEFAULTS.badDir}</code>
          </span>

          {/* Preview path */}
          <div style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.04)", padding: "8px 10px", borderRadius: 4 }}>
            <span style={{ fontWeight: 600 }}>Example paths:</span>
            <br />
            &lt;project&gt;/{root}/{goodDir}/2026-06-26_143022_a3f8.json
            <br />
            &lt;project&gt;/{root}/{badDir}/2026-06-26_143022_b3f8.json
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
