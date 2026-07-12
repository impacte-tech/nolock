import { useState, useEffect } from "react";
import { readRlhfSettings, DEFAULT_KTO_DIR, DEFAULT_DPO_DIR, type RlhfSettings } from "../lib/rlhf";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const LS_PREFIX = "nolock.rlhf.";
const LS_ENABLED = LS_PREFIX + "enabled";
const LS_ROOT = LS_PREFIX + "root";
const LS_KTO_DIR = LS_PREFIX + "ktoDir";
const LS_GOOD = LS_PREFIX + "goodDir";
const LS_BAD = LS_PREFIX + "badDir";
const LS_DPO_DIR = LS_PREFIX + "dpoDir";
const LS_DPO_ENABLED = LS_PREFIX + "dpoEnabled";
const LS_DPO_INTERVAL = LS_PREFIX + "dpoInterval";

const DEFAULTS: RlhfSettings = {
  enabled: true,
  root: ".rlhf",
  ktoDir: DEFAULT_KTO_DIR,
  goodDir: "good",
  badDir: "bad",
  dpoDir: DEFAULT_DPO_DIR,
  dpoEnabled: false,
  dpoInterval: 10,
};

export default function RlhfPanel({ visible, onClose }: Props) {
  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [root, setRoot] = useState(DEFAULTS.root);
  const [ktoDir, setKtoDir] = useState(DEFAULTS.ktoDir);
  const [goodDir, setGoodDir] = useState(DEFAULTS.goodDir);
  const [badDir, setBadDir] = useState(DEFAULTS.badDir);
  const [dpoDir, setDpoDir] = useState(DEFAULTS.dpoDir);
  const [dpoEnabled, setDpoEnabled] = useState(DEFAULTS.dpoEnabled);
  const [dpoInterval, setDpoInterval] = useState(DEFAULTS.dpoInterval);

  useEffect(() => {
    if (!visible) return;
    const s = readRlhfSettings();
    setEnabled(s.enabled);
    setRoot(s.root);
    setKtoDir(s.ktoDir);
    setGoodDir(s.goodDir);
    setBadDir(s.badDir);
    setDpoDir(s.dpoDir);
    setDpoEnabled(s.dpoEnabled);
    setDpoInterval(s.dpoInterval);
  }, [visible]);

  const save = () => {
    localStorage.setItem(LS_ENABLED, String(enabled));
    localStorage.setItem(LS_ROOT, root.trim() || DEFAULTS.root);
    localStorage.setItem(LS_KTO_DIR, ktoDir.trim() || DEFAULTS.ktoDir);
    localStorage.setItem(LS_GOOD, goodDir.trim() || DEFAULTS.goodDir);
    localStorage.setItem(LS_BAD, badDir.trim() || DEFAULTS.badDir);
    localStorage.setItem(LS_DPO_DIR, dpoDir.trim() || DEFAULTS.dpoDir);
    localStorage.setItem(LS_DPO_ENABLED, String(dpoEnabled));
    localStorage.setItem(LS_DPO_INTERVAL, String(Math.max(1, dpoInterval)));
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
          {/* ---- KTO (thumbs up/down) section ---- */}
          <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
            Thumbs-Up/Down Collection (KTO)
          </h3>

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
            When enabled, thumbs up/down ratings are appended as JSONL lines partitioned by model
            configuration, ready for KTO (Kahneman-Tversky Optimization) training.
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

          {/* KTO top-level directory */}
          <label className="field-label">KTO directory</label>
          <input
            className="field-input"
            value={ktoDir}
            onChange={(e) => setKtoDir(e.target.value)}
            placeholder={DEFAULTS.ktoDir}
            disabled={!enabled}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Top-level directory for KTO data inside <code>{root}</code>. Default: <code>{DEFAULTS.ktoDir}</code>
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
            Subdirectory for thumbs-up (good) examples inside <code>{ktoDir}</code>. Default: <code>{DEFAULTS.goodDir}</code>
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
            Subdirectory for thumbs-down (bad) examples inside <code>{ktoDir}</code>. Default: <code>{DEFAULTS.badDir}</code>
          </span>

          {/* ---- DPO (pairwise) section ---- */}
          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
          <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
            Pairwise Preference Collection (DPO)
          </h3>

          {/* DPO enable toggle */}
          <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={dpoEnabled}
              onChange={(e) => setDpoEnabled(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Enable DPO pairwise collection
          </label>
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 16 }}>
            When enabled, every N messages the AI generates two alternative responses. You pick which
            one is better — the pair is saved as a DPO training example.
          </span>

          {/* DPO interval */}
          <label className="field-label">DPO prompt interval (messages)</label>
          <input
            className="field-input"
            type="number"
            min={1}
            max={100}
            value={dpoInterval}
            onChange={(e) => setDpoInterval(Math.max(1, parseInt(e.target.value, 10) || 1))}
            disabled={!dpoEnabled}
            style={{ width: 80 }}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            After every this many messages, the AI will generate two responses for you to compare.
            Default: {DEFAULTS.dpoInterval}
          </span>

          {/* DPO directory */}
          <label className="field-label">DPO directory</label>
          <input
            className="field-input"
            value={dpoDir}
            onChange={(e) => setDpoDir(e.target.value)}
            placeholder={DEFAULTS.dpoDir}
            disabled={!dpoEnabled}
          />
          <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 12 }}>
            Top-level directory for DPO data inside <code>{root}</code>. Default: <code>{DEFAULTS.dpoDir}</code>
          </span>

          {/* Preview paths */}
          <div style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.04)", padding: "8px 10px", borderRadius: 4, marginTop: 8 }}>
            <span style={{ fontWeight: 600 }}>Example file structure:</span>
            <br />
            &lt;project&gt;/{root}/{ktoDir}/{goodDir}/<strong>ollama_qwen3_8b</strong>/data.jsonl
            <br />
            &lt;project&gt;/{root}/{ktoDir}/{badDir}/<strong>ollama_qwen3_8b</strong>/data.jsonl
            <br />
            &lt;project&gt;/{root}/{dpoDir}/<strong>ollama_qwen3_8b</strong>/data.jsonl
            <br />
            <span style={{ fontSize: 10, opacity: 0.7 }}>
              KTO and DPO data live in separate top-level directories, each partitioned by model configuration.
            </span>
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
