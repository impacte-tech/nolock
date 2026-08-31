// Switchyard Router — per-project routing policy (`.routers/switchyard.json`).
//
// Mirrors the Rust serde schema in `src-tauri/src/switchyard.rs`. The file is
// versioned project config (like `.agents/`); credentials are never stored here
// — targets reference `(backend, model)` and the request-time `providers` map
// supplies url + api key.

import { invoke } from "@tauri-apps/api/core";

export type RoutePurpose = "chat" | "subagent" | "agent-select" | "fitm";
export type RouteAlgorithm = "passthrough" | "random" | "llm-classifier";

export interface SwitchyardTarget {
  id: string;
  label: string;
  backend: string;
  model: string;
  /** For `llm-classifier`: "efficient" | "capable". */
  tier?: string;
  /** For `random`: relative weight. */
  weight?: number;
  /** Cost in USD per 1K input tokens — used for cost-aware routing. */
  costPer1k?: number;
}

export interface SwitchyardJudge {
  backend: string;
  model: string;
  prompt?: string;
  /** Solve-probability threshold that routes a supported task to the efficient target. */
  baseThreshold?: number;
}

export interface SwitchyardRoute {
  name: string;
  purpose: RoutePurpose;
  algorithm: RouteAlgorithm;
  targets: SwitchyardTarget[];
  weights?: number[];
  judge?: SwitchyardJudge;
  fallback?: string;
}

export interface SwitchyardConfig {
  enabled: boolean;
  routes: SwitchyardRoute[];
}

export const ROUTE_PURPOSES: { value: RoutePurpose; label: string }[] = [
  { value: "chat", label: "Chat (main agent)" },
  { value: "subagent", label: "Sub-agent" },
  { value: "agent-select", label: "Agent selection" },
  { value: "fitm", label: "Inline completion (FITM)" },
];

export const ROUTE_ALGORITHMS: { value: RouteAlgorithm; label: string }[] = [
  { value: "passthrough", label: "Passthrough (always one target)" },
  { value: "random", label: "Random (weighted split)" },
  { value: "llm-classifier", label: "LLM classifier (judge picks efficient/capable)" },
];

export function emptyConfig(): SwitchyardConfig {
  return { enabled: false, routes: [] };
}

export function emptyRoute(): SwitchyardRoute {
  return {
    name: "",
    purpose: "chat",
    algorithm: "random",
    targets: [],
  };
}

export function emptyTarget(): SwitchyardTarget {
  return {
    id: `t${Date.now()}`,
    label: "",
    backend: "openrouter",
    model: "",
  };
}

export async function loadSwitchyardConfig(rootPath: string): Promise<SwitchyardConfig> {
  return invoke<SwitchyardConfig>("read_switchyard_config", { rootPath });
}

export async function saveSwitchyardConfig(
  rootPath: string,
  config: SwitchyardConfig,
): Promise<void> {
  await invoke("write_switchyard_config", { rootPath, config });
}

/** Derive the `weights` array for a random route from per-target weights. */
export function deriveWeights(route: SwitchyardRoute): number[] | undefined {
  if (route.algorithm !== "random") return undefined;
  const hasAny = route.targets.some((t) => t.weight !== undefined && t.weight !== null);
  if (!hasAny) return undefined;
  return route.targets.map((t) => t.weight ?? 1);
}

/** Build the config that should be persisted (normalizes derived fields). */
export function normalizeConfig(config: SwitchyardConfig): SwitchyardConfig {
  return {
    enabled: config.enabled,
    routes: config.routes.map((route) => {
      const weights = deriveWeights(route);
      const normalized: SwitchyardRoute = {
        name: route.name,
        purpose: route.purpose,
        algorithm: route.algorithm,
        targets: route.targets.map((t) => ({
          id: t.id,
          label: t.label,
          backend: t.backend,
          model: t.model,
          ...(t.tier ? { tier: t.tier } : {}),
          ...(t.weight !== undefined && t.weight !== null ? { weight: t.weight } : {}),
          ...(t.costPer1k !== undefined && t.costPer1k !== null ? { costPer1k: t.costPer1k } : {}),
        })),
        ...(weights ? { weights } : {}),
        ...(route.judge ? { judge: route.judge } : {}),
        ...(route.fallback ? { fallback: route.fallback } : {}),
      };
      return normalized;
    }),
  };
}