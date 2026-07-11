/**
 * RLHF (Reinforcement Learning from Human Feedback) storage utilities.
 *
 * Stores user feedback in JSONL format, partitioned by model configuration.
 * All feedback is consolidated under a `dpoDir` parent folder for clarity.
 *
 * The JSONL schemas follow the dataset formats expected by Hugging Face TRL
 * (https://huggingface.co/docs/trl/v1.8.0) for DPO and KTO training.
 *
 * ## KTO format (thumbs up / thumbs down)
 *
 * Each entry is appended as one JSON line to:
 *   <root>/<dpoDir>/<goodDir>/<modelKey>/data.jsonl   (thumbs up, label: true)
 *   <root>/<dpoDir>/<badDir>/<modelKey>/data.jsonl    (thumbs down, label: false)
 *
 * JSONL line schema (KTO-compatible — see https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer):
 *   { "prompt": "...", "completion": "...", "label": true|false,
 *     "model_provider": "...", "model_name": "...",
 *     "model_configurations": { "temperature": ..., "max_tokens": ..., "system_prompt": "..." },
 *     "timestamp": "ISO 8601", "user_correction": "..." }
 *
 * ## DPO format (pairwise preference)
 *
 * Every Nth message, the user is asked to choose between two AI responses.
 * The chosen/rejected pair is appended as one JSON line to:
 *   <root>/<dpoDir>/<pairwiseDir>/<modelKey>/data.jsonl
 *
 * JSONL line schema (DPO-compatible — see https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer):
 *   { "prompt": "...", "chosen": "...", "rejected": "...",
 *     "model_provider": "...", "model_name": "...",
 *     "model_configurations": { ... },
 *     "timestamp": "ISO 8601" }
 *
 * ## localStorage settings
 *   nolock.rlhf.enabled       - "true" | "false" (default "true")
 *   nolock.rlhf.root          - root folder name (default ".rlhf")
 *   nolock.rlhf.dpoDir        - parent container for all feedback (default "dpo")
 *   nolock.rlhf.goodDir       - good subdirectory inside dpoDir (default "good")
 *   nolock.rlhf.badDir        - bad subdirectory inside dpoDir (default "bad")
 *   nolock.rlhf.pairwiseDir   - pairwise subdirectory inside dpoDir (default "pairwise")
 *   nolock.rlhf.dpoEnabled    - "true" | "false" (default "false")
 *   nolock.rlhf.dpoInterval   - number of messages between DPO prompts (default 10)
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelConfig {
  temperature: number;
  max_tokens: number;
  system_prompt: string;
}

/** Settings read from localStorage */
export interface RlhfSettings {
  enabled: boolean;
  root: string;
  /** Parent container directory for all feedback data (e.g. "dpo"). */
  dpoDir: string;
  /** Subdirectory inside dpoDir for good (thumbs-up) examples. */
  goodDir: string;
  /** Subdirectory inside dpoDir for bad (thumbs-down) examples. */
  badDir: string;
  /** Subdirectory inside dpoDir for DPO pairwise (chosen/rejected) examples. */
  pairwiseDir: string;
  dpoEnabled: boolean;
  dpoInterval: number;
}

/** Default directory name for the RLHF parent container. */
export const DEFAULT_DPO_DIR = "dpo";
/** Default subdirectory for pairwise preference data. */
export const DEFAULT_PAIRWISE_DIR = "pairwise";

/**
 * A KTO-format entry — maps one prompt+completion with a binary label.
 * Uses `completion` (not `response`) to match the TRL v1.8.0 KTO dataset format:
 * https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer#expected-dataset-type-and-format
 */
export interface KtoEntry {
  prompt: string;
  completion: string;
  label: boolean;
  model_provider: string;
  model_name: string;
  model_configurations: ModelConfig;
  timestamp: string;
  user_correction?: string;
}

/** A DPO-format entry — pairs a prompt with a chosen and a rejected response */
export interface DpoEntry {
  prompt: string;
  chosen: string;
  rejected: string;
  model_provider: string;
  model_name: string;
  model_configurations: ModelConfig;
  timestamp: string;
}

export type FeedbackType = "good" | "bad";

/**
 * @deprecated Use `KtoEntry` instead. Kept for backward compatibility.
 */
export interface RlhfData {
  feedback_type: FeedbackType;
  model_provider: string;
  model_name: string;
  model_configurations: ModelConfig;
  timestamp: string;
  question: string;
  answer: string;
  user_correction: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a provider+model pair for use as a filesystem directory name.
 * Replaces anything that isn't alphanumeric, underscore, or hyphen with '_'.
 */
function sanitiseModelKey(provider: string, model: string): string {
  const raw = `${provider}_${model}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build the JSONL path for a given feedback type and model.
 *
 * Produces: <baseDir>/<parentDir>/<subDir>/<modelKey>/data.jsonl
 *
 * @param baseDir   The feedback root directory (e.g. "/project/.rlhf")
 * @param parentDir The parent container (e.g. "dpo")
 * @param subDir    The feedback type subdirectory (e.g. "good", "bad", "pairwise")
 * @param provider  The AI model provider
 * @param model     The AI model name
 */
function jsonlPath(
  baseDir: string,
  parentDir: string,
  subDir: string,
  provider: string,
  model: string,
): string {
  const modelKey = sanitiseModelKey(provider, model);
  return `${baseDir}/${parentDir}/${subDir}/${modelKey}/data.jsonl`;
}

/**
 * Get a fallback directory for RLHF data when no project folder is open.
 * Uses the Tauri app local data directory (e.g. ~/.local/share/nolock/.rlhf/).
 */
async function getRlhfFallbackDir(): Promise<string> {
  try {
    return await invoke<string>("get_rlhf_dir");
  } catch (e) {
    console.warn("[rlhf] Failed to get fallback directory, using temp:", e);
    const tmpDir = "/tmp/nolock/rlhf";
    try {
      await invoke("create_file", { path: `${tmpDir}/.keep` });
    } catch {
      // Ignore
    }
    return tmpDir;
  }
}

/**
 * Read model configuration from localStorage.
 */
export function getModelConfigurations(): ModelConfig {
  const savedTemp = localStorage.getItem("nolock.chatTemperature");
  const savedTokens = localStorage.getItem("nolock.chatMaxTokens");
  const systemPrompt = localStorage.getItem("nolock.chatSystemPrompt") || "";
  return {
    temperature: savedTemp ? parseFloat(savedTemp) : 0.7,
    max_tokens: savedTokens ? parseInt(savedTokens, 10) : 2048,
    system_prompt: systemPrompt,
  };
}

/**
 * Build the model context by reading current settings from localStorage.
 */
export function getModelContext(): { provider: string; model: string } {
  const backend = localStorage.getItem("nolock.backend") || "ollama";
  const chatModel = localStorage.getItem("nolock.chatModel") || "";
  return { provider: backend, model: chatModel };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Read all RLHF settings (including DPO settings) from localStorage.
 */
export function readRlhfSettings(): RlhfSettings {
  const dpoIntervalRaw = localStorage.getItem("nolock.rlhf.dpoInterval");
  return {
    enabled: localStorage.getItem("nolock.rlhf.enabled") !== "false",
    root: localStorage.getItem("nolock.rlhf.root") || ".rlhf",
    dpoDir: localStorage.getItem("nolock.rlhf.dpoDir") || DEFAULT_DPO_DIR,
    goodDir: localStorage.getItem("nolock.rlhf.goodDir") || "good",
    badDir: localStorage.getItem("nolock.rlhf.badDir") || "bad",
    pairwiseDir: localStorage.getItem("nolock.rlhf.pairwiseDir") || DEFAULT_PAIRWISE_DIR,
    dpoEnabled: localStorage.getItem("nolock.rlhf.dpoEnabled") === "true",
    dpoInterval: dpoIntervalRaw ? parseInt(dpoIntervalRaw, 10) : 10,
  };
}

// ---------------------------------------------------------------------------
// KTO save (thumbs up / thumbs down)
// ---------------------------------------------------------------------------

/**
 * Append a KTO-format JSONL line to the appropriate model-partitioned file.
 *
 * @param rootPath  The project root path, or empty to use fallback dir.
 * @param entry     The KTO data to persist. `label: true` → good, `false` → bad.
 * @returns         The path to the JSONL file (or "" if disabled).
 */
export async function saveKtoFeedback(
  rootPath: string,
  entry: KtoEntry,
): Promise<string> {
  const settings = readRlhfSettings();
  if (!settings.enabled) {
    console.log("[rlhf] RLHF is disabled, skipping save");
    return "";
  }

  const subDir = entry.label ? settings.goodDir : settings.badDir;

  // Resolve base directory
  const baseDir = rootPath
    ? `${rootPath}/${settings.root}`
    : await getRlhfFallbackDir();

  const filePath = jsonlPath(baseDir, settings.dpoDir, subDir, entry.model_provider, entry.model_name);
  const jsonlLine = JSON.stringify(entry) + "\n";

  try {
    await invoke("append_to_file", { path: filePath, content: jsonlLine });
  } catch (e) {
    throw new Error(`Failed to save KTO feedback to ${filePath}: ${e}`);
  }

  return filePath;
}

// ---------------------------------------------------------------------------
// DPO save (pairwise preference)
// ---------------------------------------------------------------------------

/**
 * Append a DPO-format JSONL line to the dpo/<modelKey>/data.jsonl file.
 *
 * @param rootPath  The project root path, or empty to use fallback dir.
 * @param entry     The DPO data with prompt, chosen, and rejected responses.
 * @returns         The path to the JSONL file (or "" if disabled or DPO disabled).
 */
export async function saveDpoFeedback(
  rootPath: string,
  entry: DpoEntry,
): Promise<string> {
  const settings = readRlhfSettings();
  if (!settings.enabled || !settings.dpoEnabled) {
    console.log("[rlhf] DPO is disabled, skipping save");
    return "";
  }

  const baseDir = rootPath
    ? `${rootPath}/${settings.root}`
    : await getRlhfFallbackDir();

  const filePath = jsonlPath(baseDir, settings.dpoDir, settings.pairwiseDir, entry.model_provider, entry.model_name);
  const jsonlLine = JSON.stringify(entry) + "\n";

  try {
    await invoke("append_to_file", { path: filePath, content: jsonlLine });
  } catch (e) {
    throw new Error(`Failed to save DPO feedback to ${filePath}: ${e}`);
  }

  return filePath;
}

// ---------------------------------------------------------------------------
// Legacy helper (kept for backward compat, delegates to KTO)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `saveKtoFeedback` instead. This function wraps the old
 *             `RlhfData` interface into the new KTO JSONL format.
 */
export async function saveRlhfFeedback(
  rootPath: string,
  feedback: {
    feedback_type: FeedbackType;
    model_provider: string;
    model_name: string;
    model_configurations: ModelConfig;
    timestamp: string;
    question: string;
    answer: string;
    user_correction: string;
  },
): Promise<string> {
  return saveKtoFeedback(rootPath, {
    prompt: feedback.question,
    completion: feedback.answer,
    label: feedback.feedback_type === "good",
    model_provider: feedback.model_provider,
    model_name: feedback.model_name,
    model_configurations: feedback.model_configurations,
    timestamp: feedback.timestamp,
    user_correction: feedback.user_correction || undefined,
  });
}
