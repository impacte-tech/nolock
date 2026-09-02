import { useState, useEffect, useCallback } from "react";
import Select from "./Select";
import { BACKENDS } from "../lib/backends";
import {
  type SwitchyardConfig,
  type SwitchyardRoute,
  type SwitchyardTarget,
  type SwitchyardJudge,
  type RouteAlgorithm,
  ROUTE_PURPOSES,
  ROUTE_ALGORITHMS,
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

/** Panel-local route wrapper carrying a stable key so per-route editor state
 *  (e.g. the in-progress response-schema JSON text) survives list edits. */
type PanelRoute = SwitchyardRoute & { __key: string };

/** Same shape as `SwitchyardConfig` but with keyed routes for editor state. */
interface PanelConfig {
  enabled: boolean;
  routes: PanelRoute[];
}

let keySeq = 0;
const nextKey = () => `r${Date.now().toString(36)}_${keySeq++}`;

const withKeys = (routes: SwitchyardRoute[]): PanelRoute[] =>
  routes.map((r) => ({ ...r, __key: nextKey() }));
const stripKeys = (routes: PanelRoute[]): SwitchyardRoute[] =>
  routes.map(({ __key, ...r }) => r);

const DEFAULT_JUDGE: SwitchyardJudge = { backend: "openrouter", model: "" };

/** One-line explanation of what each algorithm does with the route's fields —
 *  the panel maps `.routers/switchyard.json` 1:1, so these mirror the Rust
 *  semantics in `src-tauri/src/switchyard.rs`. */
const ALGORITHM_HINTS: Record<RouteAlgorithm, string> = {
  passthrough: "Always uses the first target. No judge, weights or fallback needed.",
  random: "Picks a target per request — uniform, per-target weights, or cost-aware (inverse costPer1k) when no weights are set.",
  "llm-classifier": "A judge model scores the task and routes between exactly two tiers: efficient and capable (cheapest target in the tier wins).",
  custom: "A judge model returns a schema-constrained verdict (e.g. {\"route\": \"super\"}) whose selector field names one target id exactly, with a fallback. Best for N-tier routing (lightning / super / ultra).",
};

/** Tiny uppercase label above a target/judge field — a tighter variant of the
 *  section-level `.field-label` so compact rows stay guided without bloating
 *  the card. */
function TargetFieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "block",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        color: "var(--text-muted)",
        fontWeight: 600,
        marginBottom: 2,
      }}
    >
      {children}
    </span>
  );
}

/** Client-side mirror of the Rust `validate_switchyard_config` — surfaces the
 *  same errors inline before hitting the backend save. */
function validateConfig(routes: PanelRoute[]): string | null {
  for (const route of routes) {
    if (!route.name.trim()) return "Route name must not be empty.";
    if (route.targets.length === 0) {
      return `Route "${route.name}" has no targets.`;
    }
    const ids = new Set<string>();
    for (const t of route.targets) {
      if (!t.id.trim() || !t.model.trim()) {
        return `Route "${route.name}" has a target with an empty id or model.`;
      }
      if (ids.has(t.id)) {
        return `Route "${route.name}" has duplicate target id "${t.id}".`;
      }
      ids.add(t.id);
    }
    if (route.algorithm === "llm-classifier" && !route.judge) {
      return `Route "${route.name}" uses llm-classifier but has no judge model.`;
    }
    if (route.algorithm === "custom") {
      const judge = route.judge;
      if (!judge) return `Route "${route.name}" uses custom but has no judge model.`;
      if (!judge.prompt || !judge.prompt.trim()) {
        return `Route "${route.name}" uses custom but the judge has no prompt.`;
      }
      if (judge.responseSchema === undefined || judge.responseSchema === null) {
        return `Route "${route.name}" uses custom but the judge has no response schema.`;
      }
      if (!route.fallback) {
        return `Route "${route.name}" uses custom but has no fallback target.`;
      }
      if (!route.targets.some((t) => t.id === route.fallback)) {
        return `Route "${route.name}" fallback "${route.fallback}" must be one of the target ids.`;
      }
    }
  }
  return null;
}

export default function SwitchyardPanel({ visible, onClose, rootPath }: Props) {
  const [config, setConfig] = useState<PanelConfig>({ enabled: false, routes: [] });
  // In-progress response-schema JSON text per route key (custom algorithm).
  const [schemaText, setSchemaText] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!rootPath) {
      setConfig({ enabled: false, routes: [] });
      setSchemaText({});
      return;
    }
    setLoading(true);
    try {
      const loaded = await loadSwitchyardConfig(rootPath);
      const keyed = withKeys(loaded.routes);
      setConfig({ enabled: loaded.enabled, routes: keyed });
      // Seed the schema editors from the file so the panel maps the existing
      // JSON exactly (e.g. the working nemotron 3-tier custom route).
      const texts: Record<string, string> = {};
      for (const route of keyed) {
        if (route.judge?.responseSchema !== undefined && route.judge.responseSchema !== null) {
          texts[route.__key] = JSON.stringify(route.judge.responseSchema, null, 2);
        }
      }
      setSchemaText(texts);
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

  // NOTE: schemaText is keyed by the route's stable __key (not the list index)
  // so removing/adding routes can't misalign the editors.

  const updateRoute = (index: number, patch: Partial<PanelRoute>) => {
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
    setConfig((c) => ({ ...c, routes: [...c.routes, { ...emptyRoute(), __key: nextKey() }] }));
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

  /** Update the judge's response schema from the editor text. Valid JSON is
   *  written into the config immediately; invalid JSON stays in the textarea
   *  and is reported on save. */
  const updateSchemaText = (routeKey: string, index: number, text: string) => {
    setSchemaText((prev) => ({ ...prev, [routeKey]: text }));
    try {
      const parsed = JSON.parse(text);
      updateRoute(index, { judge: { ...(config.routes[index].judge ?? DEFAULT_JUDGE), responseSchema: parsed } });
    } catch {
      // Keep typing — validation happens on save.
    }
  };

  const save = async () => {
    if (!rootPath) return;
    // Re-sync any schema editors whose text is valid JSON (covers edits made
    // after the last keystroke parse) and reject invalid JSON up-front.
    const routes = config.routes.map((route, i) => {
      if (route.algorithm !== "custom") return route;
      const text = schemaText[route.__key];
      if (text === undefined) return route;
      try {
        return { ...route, judge: { ...(route.judge ?? DEFAULT_JUDGE), responseSchema: JSON.parse(text) } };
      } catch {
        return route;
      }
    });
    for (const route of config.routes) {
      if (route.algorithm !== "custom") continue;
      const text = schemaText[route.__key];
      if (text !== undefined && text.trim()) {
        try {
          JSON.parse(text);
        } catch {
          setError(`Route "${route.name}": judge response schema is not valid JSON.`);
          return;
        }
      }
    }
    const validationError = validateConfig(routes);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveSwitchyardConfig(
        rootPath,
        normalizeConfig({ enabled: config.enabled, routes: stripKeys(routes) }),
      );
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
                general routers. This panel edits <code>.routers/switchyard.json</code>{" "}
                field-by-field (versioned project config). Credentials are never stored
                here — targets reuse your provider URLs and API keys.
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
                  key={route.__key}
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
                    placeholder="e.g. nemotron-3-tier"
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
                    onChange={(v) => updateRoute(ri, { algorithm: v as RouteAlgorithm })}
                    options={ROUTE_ALGORITHMS.map((a) => ({ value: a.value, label: a.label }))}
                  />
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
                    {ALGORITHM_HINTS[route.algorithm]}
                  </p>

                  <label className="field-label">
                    Targets
                    {route.algorithm === "custom" && (
                      <span style={{ fontWeight: "normal", color: "var(--text-muted)" }}>
                        {" "}— the <code>id</code> is what the judge's verdict must return
                      </span>
                    )}
                  </label>
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
                      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
                        <div style={{ width: 120 }}>
                          <TargetFieldLabel>ID</TargetFieldLabel>
                          <input
                            className="field-input"
                            style={{ width: "100%" }}
                            value={target.id}
                            onChange={(e) => updateTarget(ri, ti, { id: e.target.value })}
                            placeholder="e.g. lightning"
                            title="Unique target id within the route — the router's decision (judge verdict or fallback) names this id"
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <TargetFieldLabel>Label</TargetFieldLabel>
                          <input
                            className="field-input"
                            style={{ width: "100%" }}
                            value={target.label}
                            onChange={(e) => updateTarget(ri, ti, { label: e.target.value })}
                            placeholder="Display name (shown in logs and dropdowns)"
                          />
                        </div>
                        <button
                          className="agent-action-btn agent-action-btn-danger"
                          onClick={() => removeTarget(ri, ti)}
                          title="Remove target"
                        >
                          &times;
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <div style={{ width: 140 }}>
                          <TargetFieldLabel>Backend</TargetFieldLabel>
                          <Select
                            value={target.backend}
                            onChange={(v) => updateTarget(ri, ti, { backend: v })}
                            options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <TargetFieldLabel>Model</TargetFieldLabel>
                          <input
                            className="field-input"
                            style={{ width: "100%" }}
                            value={target.model}
                            onChange={(e) => updateTarget(ri, ti, { model: e.target.value })}
                            placeholder="provider model id, e.g. nvidia/nemotron-ultra"
                          />
                        </div>
                      </div>
                      {route.algorithm === "llm-classifier" && (
                        <div style={{ marginTop: 6, width: 180 }}>
                          <TargetFieldLabel>Tier</TargetFieldLabel>
                          <Select
                            value={target.tier || ""}
                            onChange={(v) => updateTarget(ri, ti, { tier: v || undefined })}
                            options={[
                              { value: "", label: "(none)" },
                              { value: "efficient", label: "efficient" },
                              { value: "capable", label: "capable" },
                            ]}
                          />
                        </div>
                      )}
                      {route.algorithm === "random" && (
                        <div style={{ marginTop: 6, width: 180 }}>
                          <TargetFieldLabel>Weight</TargetFieldLabel>
                          <input
                            className="field-input"
                            style={{ width: "100%" }}
                            type="number"
                            step="0.1"
                            min="0"
                            value={target.weight ?? ""}
                            onChange={(e) =>
                              updateTarget(ri, ti, {
                                weight: e.target.value === "" ? undefined : parseFloat(e.target.value),
                              })
                            }
                            placeholder="optional (default 1)"
                            title="Relative routing weight — targets without a weight default to 1"
                          />
                        </div>
                      )}
                      {route.algorithm !== "passthrough" && (
                        <div style={{ marginTop: 6, width: 180 }}>
                          <TargetFieldLabel>Cost $/1K input</TargetFieldLabel>
                          <input
                            className="field-input"
                            style={{ width: "100%" }}
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
                            placeholder="optional"
                            title="USD per 1K input tokens — enables cost-aware routing (cheapest target in a tier / inverse-cost weights) and cost accounting"
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
                        const judge = route.judge ?? DEFAULT_JUDGE;
                        return (
                          <>
                            <div style={{ display: "flex", gap: 6 }}>
                              <div style={{ width: 140 }}>
                                <TargetFieldLabel>Backend</TargetFieldLabel>
                                <Select
                                  value={judge.backend}
                                  onChange={(v) => updateRoute(ri, { judge: { ...judge, backend: v } })}
                                  options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
                                />
                              </div>
                              <div style={{ flex: 1 }}>
                                <TargetFieldLabel>Model</TargetFieldLabel>
                                <input
                                  className="field-input"
                                  style={{ width: "100%" }}
                                  value={judge.model}
                                  onChange={(e) => updateRoute(ri, { judge: { ...judge, model: e.target.value } })}
                                  placeholder="judge model id"
                                />
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              <div style={{ width: 180 }}>
                                <TargetFieldLabel>Base threshold</TargetFieldLabel>
                                <input
                                  className="field-input"
                                  style={{ width: "100%" }}
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
                                  placeholder="0.5"
                                  title="Solve-probability threshold that routes a supported task to the efficient target (default 0.5)"
                                />
                              </div>
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <TargetFieldLabel>Prompt override</TargetFieldLabel>
                              <textarea
                                className="field-input"
                                style={{ width: "100%", minHeight: 60, fontFamily: "monospace", fontSize: 11 }}
                                value={judge.prompt ?? ""}
                                onChange={(e) => updateRoute(ri, { judge: { ...judge, prompt: e.target.value } })}
                                placeholder="Optional prompt override for the packaged capability classifier"
                              />
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {route.algorithm === "custom" && (
                    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                      <label className="field-label">Judge model</label>
                      {(() => {
                        const judge = route.judge ?? DEFAULT_JUDGE;
                        return (
                          <>
                            <div style={{ display: "flex", gap: 6 }}>
                              <div style={{ width: 140 }}>
                                <TargetFieldLabel>Backend</TargetFieldLabel>
                                <Select
                                  value={judge.backend}
                                  onChange={(v) => updateRoute(ri, { judge: { ...judge, backend: v } })}
                                  options={BACKENDS.map((b) => ({ value: b.value, label: b.label }))}
                                />
                              </div>
                              <div style={{ flex: 1 }}>
                                <TargetFieldLabel>Model</TargetFieldLabel>
                                <input
                                  className="field-input"
                                  style={{ width: "100%" }}
                                  value={judge.model}
                                  onChange={(e) => updateRoute(ri, { judge: { ...judge, model: e.target.value } })}
                                  placeholder="judge model id (e.g. a local nemotron nano)"
                                />
                              </div>
                            </div>
                            <label className="field-label" style={{ marginTop: 8 }}>
                              Judge prompt <span style={{ fontWeight: "normal", color: "var(--text-muted)" }}>(required — must ask for a JSON verdict)</span>
                            </label>
                            <textarea
                              className="field-input"
                              style={{ width: "100%", minHeight: 110, fontFamily: "monospace", fontSize: 11 }}
                              value={judge.prompt ?? ""}
                              onChange={(e) => updateRoute(ri, { judge: { ...judge, prompt: e.target.value } })}
                              placeholder={'You are a model router… Return a JSON verdict with "route": one of "lightning", "super", "ultra"…'}
                            />
                            <label className="field-label" style={{ marginTop: 8 }}>
                              Response schema <span style={{ fontWeight: "normal", color: "var(--text-muted)" }}>(required — inner JSON Schema, not the json_schema wrapper)</span>
                            </label>
                            <textarea
                              className="field-input"
                              style={{ width: "100%", minHeight: 110, fontFamily: "monospace", fontSize: 11 }}
                              value={schemaText[route.__key] ?? ""}
                              onChange={(e) => updateSchemaText(route.__key, ri, e.target.value)}
                              placeholder={'{\n  "type": "object",\n  "required": ["route"],\n  "properties": {\n    "route": { "type": "string", "enum": ["lightning", "super", "ultra"] }\n  }\n}'}
                            />
                            <div style={{ marginTop: 6 }}>
                              <TargetFieldLabel>Selector</TargetFieldLabel>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <input
                                  className="field-input"
                                  style={{ width: 140 }}
                                  value={judge.selector ?? ""}
                                  onChange={(e) => updateRoute(ri, { judge: { ...judge, selector: e.target.value } })}
                                  placeholder="/route"
                                  title="JSON Pointer to the verdict field that holds the selected target id (defaults to /route)"
                                />
                                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                  JSON Pointer to the verdict field naming the target id (default <code>/route</code>)
                                </span>
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {route.targets.length > 0 && route.algorithm !== "passthrough" && (
                    <div style={{ marginTop: 10 }}>
                      <label className="field-label">
                        Fallback target
                        {route.algorithm === "custom" && (
                          <span style={{ fontWeight: "normal", color: "var(--text-muted)" }}>
                            {" "}(required — used when the judge fails or returns an unknown id)
                          </span>
                        )}
                      </label>
                      <Select
                        value={route.fallback || ""}
                        onChange={(v) => updateRoute(ri, { fallback: v || undefined })}
                        options={[
                          { value: "", label: "(none)" },
                          ...route.targets.map((t) => ({ value: t.id, label: `${t.id}${t.label ? ` — ${t.label}` : ""}` })),
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
