/**
 * Model fetching utilities for AI model providers.
 *
 * Fetches available models from provider APIs (OpenRouter, OpenCode Zen, Ollama, llama.cpp)
 * via the Rust backend (to avoid CORS restrictions in the webview).
 * Provides filtering by free models and zero-data-retention models (remote providers only).
 */

import { invoke } from "@tauri-apps/api/core";
import { cacheModelPrices, type ModelPrice } from "./pricing";

export interface ModelInfo {
  /** Unique model identifier used in API requests (e.g. "openai/gpt-4o") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Whether the model is free (all pricing fields are zero) */
  isFree: boolean;
  /** Whether the model endpoint has a zero data retention policy */
  zeroDataRetention: boolean;
  /** Pricing details (if available) */
  pricing?: {
    prompt: string;
    completion: string;
    request: string;
    image: string;
  };
}

/** Filter flags used when browsing models */
export interface ModelFilters {
  /** Show only models with zero cost */
  freeOnly: boolean;
  /** Show only models with zero data retention policy */
  zeroDataRetentionOnly: boolean;
}

/** Shape returned by the Rust `fetch_models` command */
interface RustModelListItem {
  id: string;
  name: string;
  is_free: boolean;
  zero_data_retention: boolean;
  /** Per-1M-token pricing (USD) when the provider reports it. */
  pricing?: { prompt: number; completion: number } | null;
}

/**
 * Fetches available models via the Rust backend (avoids CORS).
 *
 * Also populates the localStorage price cache so the session summary can
 * estimate costs for whichever model the user actually chats with.
 *
 * @param provider - The backend provider value ("openrouter" | "opencode" | …)
 * @param baseUrl  - Server URL
 * @param apiKey   - API key (required for OpenRouter)
 * @param filters  - Optional filters to apply server-side (if supported)
 */
export async function fetchModels(
  provider: string,
  baseUrl: string,
  apiKey?: string,
  filters?: ModelFilters,
): Promise<ModelInfo[]> {
  // DigitalOcean is intentionally excluded — its "models" are inference routers
  // selected via a dedicated dropdown, not a conventional model list.
  const supportedProviders = ["openrouter", "opencode", "ollama", "llamacpp"];
  if (!supportedProviders.includes(provider)) {
    return [];
  }

  const useZdr = filters?.zeroDataRetentionOnly ?? false;

  const items: RustModelListItem[] = await invoke("fetch_models", {
    req: {
      backend: provider,
      url: baseUrl,
      api_key: apiKey || null,
      zdr: useZdr,
    },
  });

  // Cache any provider-reported pricing for later cost estimation.
  const priceMap: Record<string, ModelPrice> = {};
  for (const m of items) {
    if (m.pricing && m.pricing.prompt >= 0 && m.pricing.completion >= 0) {
      priceMap[m.id] = { prompt: m.pricing.prompt, completion: m.pricing.completion };
    }
  }
  cacheModelPrices(priceMap);

  return items.map((m) => ({
    id: m.id,
    name: m.name,
    isFree: m.is_free,
    zeroDataRetention: m.zero_data_retention,
    ...(m.pricing
      ? {
          pricing: {
            prompt: String(m.pricing.prompt),
            completion: String(m.pricing.completion),
            request: "0",
            image: "0",
          },
        }
      : {}),
  }));
}

/**
 * Applies client-side filters to a list of models.
 * This is used as a secondary pass after the server-side fetch.
 *
 * @param models  - Raw model list from the API
 * @param filters - Filter criteria to apply
 * @returns       - Filtered model list
 */
export function applyFilters(
  models: ModelInfo[],
  filters: ModelFilters,
): ModelInfo[] {
  return models.filter((m) => {
    if (filters.freeOnly && !m.isFree) return false;
    if (filters.zeroDataRetentionOnly && !m.zeroDataRetention) return false;
    return true;
  });
}

/**
 * Returns the localStorage key for persisting model filter preferences.
 */
export function getFilterStorageKey(): string {
  return "nolock.modelFilters";
}

/**
 * Loads saved model filter preferences from localStorage.
 */
export function loadFilters(): ModelFilters {
  try {
    const raw = localStorage.getItem(getFilterStorageKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        freeOnly: Boolean(parsed.freeOnly),
        zeroDataRetentionOnly: Boolean(parsed.zeroDataRetentionOnly),
      };
    }
  } catch {
    // ignore parse errors
  }
  return { freeOnly: false, zeroDataRetentionOnly: false };
}

/**
 * Saves model filter preferences to localStorage.
 */
export function saveFilters(filters: ModelFilters): void {
  localStorage.setItem(getFilterStorageKey(), JSON.stringify(filters));
}
