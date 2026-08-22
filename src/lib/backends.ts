// Shared model-provider (backend) definitions and helpers.

export type BackendRole = "planning" | "executor";

export interface BackendInfo {
  value: string;
  label: string;
  defaultUrl: string;
  /** Whether this backend requires an API key. */
  needsApiKey: boolean;
  /**
   * Role of this provider:
   * - "planning" — hosted/online providers (OpenRouter, OpenCode Zen, DigitalOcean)
   *   used as the main orchestrator model that plans, delegates, and synthesizes.
   * - "executor" — local providers (Ollama, llama.cpp) used as small, cheap task
   *   executors for sub-agents.
   */
  role: BackendRole;
}

export const BACKENDS: BackendInfo[] = [
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434", needsApiKey: false, role: "executor" },
  { value: "llamacpp", label: "llama.cpp", defaultUrl: "http://localhost:8080", needsApiKey: false, role: "executor" },
  { value: "openrouter", label: "OpenRouter", defaultUrl: "https://openrouter.ai/api/v1", needsApiKey: true, role: "planning" },
  { value: "opencode", label: "OpenCode Zen", defaultUrl: "https://opencode.ai/zen/v1", needsApiKey: true, role: "planning" },
  { value: "digitalocean", label: "DigitalOcean Inference Router", defaultUrl: "https://inference.do-ai.run/v1", needsApiKey: true, role: "planning" },
];

/** Whether a backend is a hosted/online "planning" provider (vs a local executor). */
export function isPlanningBackend(backend: string): boolean {
  return BACKENDS.find((b) => b.value === backend)?.role === "planning";
}

export function backendDefaultUrl(backend: string): string {
  return BACKENDS.find((b) => b.value === backend)?.defaultUrl || "http://localhost:11434";
}

/**
 * Resolve the server URL for a backend. The globally-selected backend may have a
 * user-customized URL (stored in `nolock.url`); every other backend falls back to
 * its known default URL.
 */
export function resolveBackendUrl(backend: string): string {
  const globalBackend = localStorage.getItem("nolock.backend") || "ollama";
  if (backend === globalBackend) {
    return localStorage.getItem("nolock.url") || backendDefaultUrl(backend);
  }
  return backendDefaultUrl(backend);
}

/** The backend used for chat requests (per-panel override falls back to the global backend). */
export function getChatBackend(): string {
  return localStorage.getItem("nolock.chatBackend") || localStorage.getItem("nolock.backend") || "ollama";
}

/**
 * Whether a backend is a hosted/cloud provider (OpenRouter, OpenCode Zen,
 * DigitalOcean Inference Router) as opposed to a local server (Ollama,
 * llama.cpp). Cloud providers have large context windows and should not be
 * subject to the small-local-model tool-result / max-token heuristics.
 */
export function isCloudBackend(backend: string): boolean {
  return backend !== "ollama" && backend !== "llamacpp";
}

/** The backend used for FITM completion requests. */
export function getFitmBackend(): string {
  return localStorage.getItem("nolock.fitmBackend") || localStorage.getItem("nolock.backend") || "ollama";
}

/**
 * Format a model id for display. A DigitalOcean inference router is stored as
 * `router:{name}` (the value sent to the API); display it in a friendlier
 * namespaced form: `digital-ocean:inference-router:{name}`.
 */
export function formatModelLabel(backend: string, model: string): string {
  if (backend === "digitalocean" && model.startsWith("router:")) {
    return `digital-ocean:inference-router:${model.slice("router:".length)}`;
  }
  return model;
}

/**
 * Whether the DigitalOcean Inference Router should be pinned to a single model
 * across the agent tool loop (the `X-Model-Affinity` header). Enabled by
 * default; the user can turn it off in the Model Providers panel.
 */
export function getDigitalOceanModelAffinity(): boolean {
  return localStorage.getItem("nolock.digitaloceanModelAffinity") !== "false";
}
