import { useState, useEffect, useRef, useCallback } from "react";
import {
  type ModelInfo,
  type ModelFilters,
  fetchModels,
  applyFilters,
  loadFilters,
  saveFilters,
} from "../lib/models";

interface Props {
  /** The backend provider value ("openrouter" | "opencode" | "ollama" | "llamacpp") */
  provider: string;
  /** Server URL for the provider */
  url: string;
  /** API key (required for OpenRouter) */
  apiKey?: string;
  /** Current model value */
  value: string;
  /** Called when the user selects or types a model */
  onChange: (value: string) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Label shown above the input */
  label?: string;
}

/**
 * A filterable model selector component.
 *
 * For all supported providers (OpenRouter, OpenCode Zen, Ollama, llama.cpp), this component:
 * - Fetches available models from the provider API
 * - Displays a list of models the user can click to select
 *
 * For OpenRouter and OpenCode Zen, additional filter toggles are shown:
 * - "Free models only" and "Zero data retention only"
 *
 * For Ollama and llama.cpp, filters are hidden since all local models are free and private.
 */
export default function ModelSelector({
  provider,
  url,
  apiKey,
  value,
  onChange,
  placeholder = "e.g. qwen3.5:0.8b-mlx",
  label,
}: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [filteredModels, setFilteredModels] = useState<ModelInfo[]>([]);
  const [filters, setFilters] = useState<ModelFilters>({ freeOnly: false, zeroDataRetentionOnly: false });
  const [browseOpen, setBrowseOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const browseRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Whether model listing + filtering is supported for this provider
  const supportsListing = provider === "openrouter" || provider === "opencode" || provider === "ollama" || provider === "llamacpp";
  // Whether this provider supports pricing/privacy filters (only remote providers)
  const supportsFilters = provider === "openrouter" || provider === "opencode";

  // Load saved filter preferences on mount
  useEffect(() => {
    setFilters(loadFilters());
  }, []);

  // For providers without filters (Ollama, llama.cpp), skip fetching with filters
  const effectiveFilters = supportsFilters ? filters : { freeOnly: false, zeroDataRetentionOnly: false };

  // Fetch models when the user opens the browser, or when provider/url/apiKey change
  // (only for supported providers)
  const doFetch = useCallback(async () => {
    if (!supportsListing) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchModels(provider, url, apiKey, effectiveFilters);
      setModels(result);
      setFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch models");
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [provider, url, apiKey, effectiveFilters, supportsListing]);

  // Apply client-side filters whenever models or filters change.
  // For OpenRouter, the ZDR filter is applied server-side via the ?zdr=true param,
  // but the free filter is always client-side. For OpenCode Zen, both are client-side.
  useEffect(() => {
    if (!supportsListing) {
      setFilteredModels([]);
      return;
    }
    // Apply client-side filtering on top of whatever the API returned.
    // (OpenRouter already did ZDR server-side if requested, but we re-apply
    // client-side for consistency and for the free filter.)
    const filtered = applyFilters(models, filters);
    setFilteredModels(filtered);
  }, [models, filters, supportsListing]);

  // When the user opens the browse panel, fetch models if we haven't yet
  useEffect(() => {
    if (browseOpen && !fetched && !loading && supportsListing) {
      doFetch();
    }
  }, [browseOpen, fetched, loading, supportsListing, doFetch]);

  const handleFilterChange = (key: keyof ModelFilters) => {
    const updated = { ...filters, [key]: !filters[key] };
    setFilters(updated);
    saveFilters(updated);
    // Re-fetch for OpenRouter to apply ZDR server-side
    if (provider === "openrouter" && key === "zeroDataRetentionOnly") {
      setFetched(false); // force re-fetch on next browse open
    }
  };

  const handleSelectModel = (modelId: string) => {
    onChange(modelId);
    setBrowseOpen(false);
  };

  // Close browse panel when clicking outside (but not on the toggle button)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        browseRef.current && !browseRef.current.contains(e.target as Node) &&
        toggleRef.current && !toggleRef.current.contains(e.target as Node)
      ) {
        setBrowseOpen(false);
      }
    };
    if (browseOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [browseOpen]);

  return (
    <div className="model-selector">
      {(label || supportsListing) && (
        <div className="model-selector-header">
          {label && <label className="field-label">{label}</label>}
          {supportsListing && (
            <button
              ref={toggleRef}
              className="model-selector-toggle-btn"
              onClick={() => {
                setBrowseOpen((prev) => !prev);
                if (!browseOpen && !fetched) {
                  doFetch();
                }
              }}
              title="Browse and filter available models"
            >
              {browseOpen ? "Hide" : "Browse"} models
            </button>
          )}
        </div>
      )}

      <input
        className="field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />

      {/* Browse panel: filters + model list (only for supported providers) */}
      {supportsListing && browseOpen && (
        <div className="model-selector-browse" ref={browseRef}>
          {/* Server URL indicator */}
          <div className="model-selector-server-url">
            Server: <span className="model-selector-server-url-value">{url}</span>
          </div>

          {/* Filter toggles (only for providers with pricing/privacy data) */}
          {supportsFilters && (
            <div className="model-selector-filters">
              <label className="model-filter-toggle">
                <input
                  type="checkbox"
                  checked={filters.freeOnly}
                  onChange={() => handleFilterChange("freeOnly")}
                />
                <span>Free models only</span>
              </label>
              <label className="model-filter-toggle">
                <input
                  type="checkbox"
                  checked={filters.zeroDataRetentionOnly}
                  onChange={() => handleFilterChange("zeroDataRetentionOnly")}
                />
                <span>Zero data retention</span>
              </label>
            </div>
          )}

          {/* Model list */}
          <div className="model-selector-list">
            {loading && (
              <div className="model-selector-status">Loading models…</div>
            )}
            {error && (
              <div className="model-selector-status model-selector-error">
                {error}
                <button
                  className="model-selector-retry-btn"
                  onClick={() => {
                    setFetched(false);
                    doFetch();
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && filteredModels.length === 0 && fetched && (
              <div className="model-selector-status">
                {supportsFilters
                  ? "No models match the selected filters."
                  : "No models found. Is the server running?"}
              </div>
            )}
            {!loading &&
              filteredModels.slice(0, 200).map((m) => (
                <div
                  key={m.id}
                  className={`model-selector-item ${value === m.id ? "selected" : ""}`}
                  onClick={() => handleSelectModel(m.id)}
                  title={m.id !== m.name ? `${m.name}\n${m.id}` : m.id}
                >
                  <span className="model-selector-item-text">
                    <span className="model-selector-item-name">{m.name}</span>
                    {m.name !== m.id && (
                      <span className="model-selector-item-id">{m.id}</span>
                    )}
                  </span>
                  <span className="model-selector-item-badges">
                    {m.isFree && <span className="badge badge-free">Free</span>}
                    {m.zeroDataRetention && (
                      <span className="badge badge-zdr">ZDR</span>
                    )}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
