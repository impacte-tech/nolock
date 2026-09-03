// ---------------------------------------------------------------------------
// Pricing — per-model price cache (USD per 1M tokens) used to estimate session
// token expenses in the session summary UI.
//
// Prices are populated whenever the user browses models via `fetchModels`
// (OpenRouter returns per-model `pricing.prompt` / `pricing.completion`). The
// cache lives in localStorage so costs can still be computed on later launches
// without requiring a fresh model fetch.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  /** USD per 1M input tokens. */
  prompt: number;
  /** USD per 1M output tokens. */
  completion: number;
}

const PRICE_CACHE_KEY = "nolock.modelPrices";

/**
 * Providers that run models locally — per-token pricing does not apply, so
 * their cost must be reported as unavailable ("—"), never as a misleading $0
 * (a cached zero price or an absent one must not turn into "$0 est.").
 */
export function isLocalProvider(provider: string | null | undefined): boolean {
  const p = (provider ?? "").trim().toLowerCase();
  return p === "ollama" || p === "llamacpp" || p === "llama.cpp" || p === "local";
}

/** Read the persisted price cache. */
export function loadModelPrices(): Record<string, ModelPrice> {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ModelPrice>) : {};
  } catch {
    return {};
  }
}

/** Merge new prices into the cache (existing entries win on conflict). */
export function cacheModelPrices(prices: Record<string, ModelPrice>): void {
  if (!prices) return;
  const merged = { ...loadModelPrices(), ...prices };
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(merged));
  } catch {
    // Cache is best-effort — ignore quota/security errors.
  }
}

/** Look up the price for a model by its provider id (e.g. "openai/gpt-4o"). */
export function getModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  return loadModelPrices()[model] ?? null;
}

/**
 * Estimate the USD cost of a usage entry when a price is known for the model.
 * Returns null when pricing is unavailable (local models, unknown providers).
 */
export function calcCost(
  price: ModelPrice | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!price) return null;
  return (
    (promptTokens / 1_000_000) * price.prompt +
    (completionTokens / 1_000_000) * price.completion
  );
}

/** Format a USD cost for compact display in the session summary. */
export function formatCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.001) return `$${n.toFixed(5)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}