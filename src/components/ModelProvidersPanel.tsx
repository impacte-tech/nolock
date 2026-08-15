import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSecret, setSecret } from "../lib/secrets";
import { BACKENDS } from "../lib/backends";
import Select from "./Select";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface RouterItem {
  id: string;
  name: string;
  description: string;
}

export default function ModelProvidersPanel({ visible, onClose }: Props) {
  const [backend, setBackend] = useState("ollama");
  const [url, setUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const [routerName, setRouterName] = useState("");
  const [routers, setRouters] = useState<RouterItem[]>([]);
  const [loadingRouters, setLoadingRouters] = useState(false);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [routersLoaded, setRoutersLoaded] = useState(false);

  useEffect(() => {
    if (!visible) return;

    const currentBackend = localStorage.getItem("nolock.backend") || "ollama";
    const savedUrl = localStorage.getItem("nolock.url") || "";
    // Migration: older versions saved the DigitalOcean management-API URL
    // (api.digitalocean.com/v2/gen-ai), which is NOT the inference endpoint.
    // The inference API lives at inference.do-ai.run/v1 — correct it here.
    let loadedUrl = savedUrl;
    if (currentBackend === "digitalocean") {
      const doDefault = BACKENDS.find((b) => b.value === "digitalocean")?.defaultUrl;
      if (!savedUrl || savedUrl.includes("api.digitalocean.com")) {
        loadedUrl = doDefault || "https://inference.do-ai.run/v1";
        localStorage.setItem("nolock.url", loadedUrl);
      }
    }
    setBackend(currentBackend);
    setUrl(loadedUrl || "http://localhost:11434");
    setApiKey(localStorage.getItem(`nolock.apiKey.${currentBackend}`) || "");
    setRouterName(localStorage.getItem("nolock.routerName") || "");
    setRouters([]);
    setRouterError(null);
    setRoutersLoaded(false);

    // Upgrade from OS keychain if available
    (async () => {
      const storedApiKey = await getSecret(`apiKey.${currentBackend}`);
      if (storedApiKey != null) {
        setApiKey(storedApiKey);
      }
    })();
  }, [visible]);

  const selectBackend = (value: string) => {
    const found = BACKENDS.find((b) => b.value === value);
    if (found) {
      setBackend(value);
      setUrl(found.defaultUrl);
      // Load the new backend's API key
      setApiKey(localStorage.getItem(`nolock.apiKey.${value}`) || "");
      setRouters([]);
      setRouterError(null);
      setRoutersLoaded(false);
    }
  };

  /** Fetch the DigitalOcean inference routers in the authenticated account. */
  const loadRouters = async () => {
    if (!apiKey.trim()) {
      setRouterError("Enter your API key first, then load routers.");
      return;
    }
    setLoadingRouters(true);
    setRouterError(null);
    try {
      const result = await invoke<RouterItem[]>("fetch_digitalocean_routers", {
        req: { api_key: apiKey },
      });
      setRouters(result);
    } catch (err) {
      setRouterError(err instanceof Error ? err.message : String(err));
      setRouters([]);
    } finally {
      setLoadingRouters(false);
      setRoutersLoaded(true);
    }
  };

  /** Select a router — the router becomes the chat model (`router:{name}`).
   *  The FITM (completion) model is intentionally left untouched so the user can
   *  configure chat and inline completion independently. */
  const selectRouter = (name: string) => {
    setRouterName(name);
    const routerModel = name ? `router:${name}` : "";
    localStorage.setItem("nolock.routerName", name);
    if (name) {
      localStorage.setItem("nolock.chatModel", routerModel);
    }
  };

  const save = () => {
    localStorage.setItem("nolock.backend", backend);
    localStorage.setItem("nolock.url", url);
    setSecret(`apiKey.${backend}`, apiKey);
    localStorage.setItem("nolock.routerName", routerName);
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Model Providers</span>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Provider</label>
          <div className="backend-grid">
            {BACKENDS.map((b) => (
              <div
                key={b.value}
                className={`backend-card ${backend === b.value ? "active" : ""}`}
                onClick={() => selectBackend(b.value)}
              >
                <span className="backend-name">{b.label}</span>
                <span className="backend-url">{b.defaultUrl}</span>
              </div>
            ))}
          </div>

          <label className="field-label">Server URL</label>
          <input
            className="field-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:11434"
          />

          {(backend === "openrouter" || backend === "opencode" || backend === "digitalocean") && (
            <>
              <label className="field-label" htmlFor="mp-api-key">API Key</label>
              <input
                id="mp-api-key"
                className="field-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={backend === "openrouter" ? "sk-or-..." : backend === "digitalocean" ? "dop_v1_..." : "sk-oc-..."}
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {backend === "openrouter"
                  ? "Required for OpenRouter API."
                  : backend === "digitalocean"
                  ? "DigitalOcean personal access token (or model access key). Stored securely in your OS keychain."
                  : "Required for the remote OpenCode Zen API. Leave blank for local servers."}
              </span>
            </>
          )}

          {/* DigitalOcean Router Selection */}
          {backend === "digitalocean" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label className="field-label" style={{ margin: 0 }}>Inference Router</label>
                <button
                  className="btn-secondary"
                  onClick={loadRouters}
                  disabled={loadingRouters}
                  style={{ fontSize: 11, padding: "4px 10px" }}
                >
                  {loadingRouters ? "Loading…" : "Load routers"}
                </button>
              </div>

              {routerError && (
                <div style={{ fontSize: 11, color: "var(--text-error)", padding: "6px 0" }}>
                  {routerError}
                </div>
              )}

              {routers.length > 0 && (
                <Select
                  value={routerName}
                  onChange={selectRouter}
                  options={routers.map((router) => ({
                    value: router.id,
                    label: router.description
                      ? `${router.name} — ${router.description}`
                      : router.name,
                  }))}
                  placeholder="Select a router..."
                  style={{ marginTop: 6 }}
                />
              )}

              {routersLoaded && !routerError && routers.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--text-warning)", padding: "6px 0" }}>
                  No routers found in your account. Create one in the DigitalOcean control panel
                  (Inference → Inference Router), or check that your token has the{" "}
                  <code>genai:read</code> scope.
                </div>
              )}

              <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 4 }}>
                Selecting a router sets it as your chat and completion model (e.g.{" "}
                <code>router:my-router</code>). You can also type a specific model ID in the Chat
                Model / FITM Model panels.
              </span>
            </div>
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
