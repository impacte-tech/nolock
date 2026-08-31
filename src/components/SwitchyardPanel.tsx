import { useState, useEffect, useCallback } from "react";
import Select from "./Select";
import { BACKENDS } from "../lib/backends";
import {
  type SwitchyardConfig,
  type SwitchyardRoute,
  type SwitchyardTarget,
  ROUTE_PURPOSES,
  ROUTE_ALGORITHMS,
  emptyConfig,
  emptyRoute,
  emptyTarget,
  loadSwitchyardConfig,
  saveSwitchyardConfig,
  normalizeConfig,
} from "../lib/switchyard";

interface Props {
  visible: boolean;
  onClose: () => void;
  rootPath: string;
}

export default function SwitchyardPanel({ visible, onClose, rootPath }: Props) {
  const [config, setConfig] = useState<SwitchyardConfig>(emptyConfig());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!rootPath) {
      setConfig(emptyConfig());
      return;
    }
    setLoading(true);
    try {
      setConfig(await loadSwitchyardConfig(rootPath));
    } catch (e) {
      console.error("Failed to load switchyard config:", e);
      setError(String(e));
    }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setSaved(false);
    load();
  }, [visible, load]);

  const updateRoute = (index: number, patch: Partial<SwitchyardRoute>) => {
    setConfig((c) => ({
      ...c,
      routes: c.routes.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  };

  const updateTarget = (routeIndex: number, targetIndex: number, patch: Partial<SwitchyardTarget>) => {
    setConfig((c) => ({
      ...c,
      routes: c.routes.map((r, i) =>
        i === routeIndex
          ? { ...r, targets: r.targets.map((t, j) => (j === targetIndex ? { ...t, ...patch } : t)) }
          : r,
      ),
    }));
  };

  const addRoute = () => {
    setConfig((c) => ({ ...c, routes: [...c.routes, emptyRoute()] }));
  };

  const removeRoute = (index: number) => {
    setConfig((c) => ({ ...c, routes: c.routes.filter((_, i) => i !== index) }));
  };

  const addTarget = (routeIndex: number) => {
    setConfig((c) => ({
      ...c,
      routes: c.routes.map((r, i) =>
        i === routeIndex ? { ...r, targets: [...r.targets, emptyTarget()] } : r,
      ),
    }));
  };

  const removeTarget = (routeIndex: number, targetIndex: number) => {
    setConfig((c) => ({
      ...c,
      routes: c.routes.map((r, i) =>
        i === routeIndex ? { ...r, targets: r.targets.filter((_, j) => j !== targetIndex) } : r,
      ),
    }));
  };

  const save = async () => {
    if (!rootPath) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveSwitchyardConfig(rootPath, normalizeConfig(config));
      setSaved(true);
      window.dispatchEvent(new CustomEvent("nolock:settings-changed"));
    } catch (e) {
      console.error("Failed to save switchyard config:", e);
      setError(String(e));
    }
    setSaving(false);
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Switchyard Router</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {!rootPath ? (
            <p style={{ color: "var(--text-muted)" }}>
              Open a project folder to configure routing. The policy is stored in{" "}
              <code>.routers/switchyard.json</code> in the project root.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0 }}>
                Route requests across models/providers using NVIDIA NeMo Switchyard's
                general routers. Policy lives in <code>.routers/switchyard.json</code>{" "}
                (versioned project config). Credentials are never stored here — targets
                reuse your provider URLs and API keys.
              </p>

              <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
                />
                Enable Switchyard routing for this project
              </label>

              {config.routes.map((route, ri) => (
                <div
                  key={ri}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 12,
                    margin: "12px 0",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{route.name || "(unnamed route)"}</strong>
                    <button
                      className="agent-action-btn agent-action-btn-danger"
                      onClick={() => removeRoute(ri)}
                      title="Delete route"
                    >
                      Delete
                    </button>
                  </div>

                  <label className="field-label">Name</label>
                  <input
                    className="field-input"
                    style={{ width: "100%" }}
                    value={route.name}
                    onChange={(e) => updateRoute(ri, { name: e.target.value })}
                    placeholder="e.g. nemotron-family"
                  />

                  <label className="field-label">Purpose</label>
                  <Select
                    value={route.purpose}
                    onChange={(v) => updateRoute(ri, { purpose: v as SwitchyardRoute["purpose"] })}
                    options={ROUTE_PURPOSES.map((p) => ({ value: p.value, label: p.label }))}
                  />

                  <label className="field-label">Algorithm</label>
                  <Select
                    value={route.algorithm}
                    onChange={(v) => updateRoute(ri, { algorithm: v as SwitchyardRoute["algorithm"] })}
                    options={ROUTE_ALGORITHMS.map((a) => ({ value: a.value, label: a.label }))}
                  />

                  <label className="field-label">Targets</label>
                  {route.targets.map((target, ti) => (
                    <div
                      key={ti}
                      style={{
                        border: "1px dashed var(--border)",
                        borderRadius: 6,
                        padding: 8,
                        margin: "6px 0",
                      }}
                    >
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          className="field-input"
                          style={{ flex: 1 }}
                          value={target.label}
                          onChange={(e) => updateTarget(ri, ti, { label: e.target.value })}
                          placeholder="Label"
                        />
                        <button
                          className="agent-action-btn agent-action-btn-danger"
                          onClick={() => removeTarget(ri, ti)}
                          title="Remove target"
                        >
                          &times;
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <Select
                          value={target.backend}
                          onChange={(v) => updateTarget(ri, ti, { backend: v })}
                          options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
                        />
                        <input
                          className="field-input"
                          style={{ flex: 1 }}
                          value={target.model}
                          onChange={(e) => updateTarget(ri, ti, { model: e.target.value })}
                          placeholder="model id, e.g. nvidia/nemotron-ultra"
                        />
                      </div>
                      {route.algorithm === "llm-classifier" && (
                        <div style={{ marginTop: 6 }}>
                          <Select
                            value={target.tier || ""}
                            onChange={(v) => updateTarget(ri, ti, { tier: v || undefined })}
                            options={[
                              { value: "", label: "Tier: (none)" },
                              { value: "efficient", label: "Tier: efficient" },
                              { value: "capable", label: "Tier: capable" },
                            ]}
                          />
                        </div>
                      )}
                      {route.algorithm === "random" && (
                        <div style={{ marginTop: 6 }}>
                          <input
                            className="field-input"
                            type="number"
                            step="0.1"
                            min="0"
                            value={target.weight ?? ""}
                            onChange={(e) =>
                              updateTarget(ri, ti, {
                                weight: e.target.value === "" ? undefined : parseFloat(e.target.value),
                              })
                            }
                            placeholder="Weight (optional)"
                          />
                        </div>
                      )}
                      {route.algorithm === "llm-classifier" && (
                        <div style={{ marginTop: 6 }}>
                          <input
                            className="field-input"
                            type="number"
                            step="0.00001"
                            min="0"
                            value={target.costPer1k ?? ""}
                            onChange={(e) =>
                              updateTarget(ri, ti, {
                                costPer1k:
                                  e.target.value === "" ? undefined : parseFloat(e.target.value),
                              })
                            }
                            placeholder="Cost $/1K input (optional, for cost-aware routing)"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  <button className="agent-action-btn" onClick={() => addTarget(ri)}>
                    + Add target
                  </button>

                  {route.algorithm === "llm-classifier" && (
                    <div style={{ marginTop: 10 }}>
                      <label className="field-label">Judge model</label>
                      {(() => {
                        const judge = route.judge ?? { backend: "openrouter", model: "" };
                        return (
                          <>
                            <div style={{ display: "flex", gap: 6 }}>
                              <Select
                                value={judge.backend}
                                onChange={(v) => updateRoute(ri, { judge: { ...judge, backend: v } })}
                                options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
                              />
                              <input
                                className="field-input"
                                style={{ flex: 1 }}
                                value={judge.model}
                                onChange={(e) => updateRoute(ri, { judge: { ...judge, model: e.target.value } })}
                                placeholder="judge model id"
                              />
                            </div>
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              <input
                                className="field-input"
                                type="number"
                                step="0.05"
                                min="0"
                                max="1"
                                value={judge.baseThreshold ?? 0.5}
                                onChange={(e) =>
                                  updateRoute(ri, {
                                    judge: { ...judge, baseThreshold: parseFloat(e.target.value) },
                                  })
                                }
                                placeholder="Base threshold (default 0.5)"
                              />
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {route.targets.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <label className="field-label">Fallback target</label>
                      <Select
                        value={route.fallback || ""}
                        onChange={(v) => updateRoute(ri, { fallback: v || undefined })}
                        options={[
                          { value: "", label: "(none)" },
                          ...route.targets.map((t) => ({ value: t.id, label: t.label || t.id })),
                        ]}
                      />
                    </div>
                  )}
                </div>
              ))}

              <button className="agent-action-btn" onClick={addRoute}>
                + Add route
              </button>

              <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
                <button className="btn-primary" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button className="btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                {saved && (
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Saved to .routers/switchyard.json
                  </span>
                )}
              </div>
              {error && <div className="agent-error">{error}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}