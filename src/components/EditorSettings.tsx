import { useState, useEffect } from "react";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface LangConfig {
  enabled: boolean;
  ruffSelect: string;
  ruffIgnore: string;
}

interface EditorConfig {
  ts: LangConfig;
  py: LangConfig;
  rs: LangConfig;
}

const defaultConfig: EditorConfig = {
  ts: { enabled: true, ruffSelect: "", ruffIgnore: "" },
  py: { enabled: true, ruffSelect: "E,W,F,I", ruffIgnore: "" },
  rs: { enabled: true, ruffSelect: "", ruffIgnore: "" },
};

export default function EditorSettings({ visible, onClose }: Props) {
  const [config, setConfig] = useState<EditorConfig>(defaultConfig);

  useEffect(() => {
    if (!visible) return;
    setConfig({
      ts: {
        enabled: localStorage.getItem("nolock.linter.ts.enabled") !== "false",
        ruffSelect: "",
        ruffIgnore: "",
      },
      py: {
        enabled: localStorage.getItem("nolock.linter.py.enabled") !== "false",
        ruffSelect: localStorage.getItem("nolock.linter.py.ruffSelect") || "E,W,F,I",
        ruffIgnore: localStorage.getItem("nolock.linter.py.ruffIgnore") || "",
      },
      rs: {
        enabled: localStorage.getItem("nolock.linter.rs.enabled") !== "false",
        ruffSelect: "",
        ruffIgnore: "",
      },
    });
  }, [visible]);

  const save = () => {
    localStorage.setItem("nolock.linter.ts.enabled", config.ts.enabled ? "true" : "false");
    localStorage.setItem("nolock.linter.py.enabled", config.py.enabled ? "true" : "false");
    localStorage.setItem("nolock.linter.py.ruffSelect", config.py.ruffSelect);
    localStorage.setItem("nolock.linter.py.ruffIgnore", config.py.ruffIgnore);
    localStorage.setItem("nolock.linter.rs.enabled", config.rs.enabled ? "true" : "false");
    onClose();
  };

  const toggleLang = (lang: "ts" | "py" | "rs") => {
    setConfig((prev) => ({
      ...prev,
      [lang]: { ...prev[lang], enabled: !prev[lang].enabled },
    }));
  };

  const updatePy = (field: "ruffSelect" | "ruffIgnore", value: string) => {
    setConfig((prev) => ({
      ...prev,
      py: { ...prev.py, [field]: value },
    }));
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Editor Settings</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {/* ---- TypeScript / JavaScript ---- */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginBottom: 6,
            }}>
              TypeScript / JavaScript
            </div>
            <div style={{
              padding: "8px 10px",
              background: "var(--bg-secondary)",
              borderRadius: 6,
              border: "1px solid var(--border)",
            }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={config.ts.enabled}
                  onChange={() => toggleLang("ts")}
                  style={{ accentColor: "var(--accent)" }}
                />
                <div>
                  <div style={{ fontSize: 13, color: "var(--text-primary)" }}>ESLint</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    Requires a project-level <code>.eslintrc.*</code> file.
                    Configure rules in that file.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* ---- Python ---- */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginBottom: 6,
            }}>
              Python
            </div>
            <div style={{
              padding: "8px 10px",
              background: "var(--bg-secondary)",
              borderRadius: 6,
              border: "1px solid var(--border)",
            }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={config.py.enabled}
                  onChange={() => toggleLang("py")}
                  style={{ accentColor: "var(--accent)" }}
                />
                <div>
                  <div style={{ fontSize: 13, color: "var(--text-primary)" }}>Ruff</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    Fast Python linter written in Rust.
                  </div>
                </div>
              </label>

              {config.py.enabled && (
                <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  {/* Ruff select */}
                  <label style={{ fontSize: 11, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                    Select rules
                  </label>
                  <input
                    className="field-input"
                    value={config.py.ruffSelect}
                    onChange={(e) => updatePy("ruffSelect", e.target.value)}
                    placeholder="E,W,F,I"
                    style={{ fontSize: 12, padding: "6px 8px" }}
                  />
                  <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 4 }}>
                    Extra rule categories passed as <code>--extend-select</code>.
                    Common: <code>E</code> (pycodestyle), <code>W</code> (warnings), <code>F</code> (Pyflakes), <code>I</code> (isort).
                  </span>

                  {/* Ruff ignore */}
                  <label style={{ fontSize: 11, color: "var(--text-secondary)", display: "block", marginTop: 8, marginBottom: 4 }}>
                    Ignore rules
                  </label>
                  <input
                    className="field-input"
                    value={config.py.ruffIgnore}
                    onChange={(e) => updatePy("ruffIgnore", e.target.value)}
                    placeholder="e.g. E302,E501"
                    style={{ fontSize: 12, padding: "6px 8px" }}
                  />
                  <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 4 }}>
                    Comma-separated rule codes to suppress. Passed as <code>--ignore</code>.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ---- Rust ---- */}
          <div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              marginBottom: 6,
            }}>
              Rust
            </div>
            <div style={{
              padding: "8px 10px",
              background: "var(--bg-secondary)",
              borderRadius: 6,
              border: "1px solid var(--border)",
            }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={config.rs.enabled}
                  onChange={() => toggleLang("rs")}
                  style={{ accentColor: "var(--accent)" }}
                />
                <div>
                  <div style={{ fontSize: 13, color: "var(--text-primary)" }}>Clippy</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    Requires a <code>Cargo.toml</code> in a parent directory.
                    Configure rules in <code>clippy.toml</code> or <code>Cargo.toml</code>.
                  </div>
                </div>
              </label>
            </div>
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
