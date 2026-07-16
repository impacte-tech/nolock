/**
 * RLHF (Reinforcement Learning from Human Feedback) storage utilities.
 *
 * Stores user feedback in JSONL format, partitioned by model configuration.
 * KTO and DPO data live in separate top-level directories under the feedback root:
 *
 *   <root>/
 *     kto/
 *       good/<modelKey>/data.jsonl   (thumbs up, label: true)
 *       bad/<modelKey>/data.jsonl    (thumbs down, label: false)
 *     dpo/
 *       <modelKey>/data.jsonl        (chosen / rejected pairs)
 *
 * The JSONL schemas follow the dataset formats expected by Hugging Face TRL
 * (https://huggingface.co/docs/trl/v1.8.0) for DPO and KTO training.
 *
 * ## KTO format (thumbs up / thumbs down)
 *
 * JSONL line schema (KTO-compatible — see https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer):
 *   { "prompt": "...", "completion": "...", "label": true|false,
 *     "model_provider": "...", "model_name": "...",
 *     "model_configurations": { "temperature": ..., "max_tokens": ..., "system_prompt": "..." },
 *     "timestamp": "ISO 8601", "user_correction": "..." }
 *
 * The `completion` field may include tool calls in XML format when the model
 * used tools during generation:
 *   <tool_call><name><json args></tool_call>
 *   <tool_result><full result></tool_result>
 *
 * ## DPO format (pairwise preference)
 *
 * JSONL line schema (DPO-compatible — see https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer):
 *   { "prompt": "...", "chosen": "...", "rejected": "...",
 *     "model_provider": "...", "model_name": "...",
 *     "model_configurations": { ... },
 *     "timestamp": "ISO 8601" }
 *
 * The `chosen` and `rejected` fields may include tool calls in XML format.
 *
 * ## localStorage settings
 *   nolock.rlhf.enabled       - "true" | "false" (default "true")
 *   nolock.rlhf.root          - root folder name (default ".rlhf")
 *   nolock.rlhf.ktoDir        - top-level directory for KTO data (default "kto")
 *   nolock.rlhf.goodDir       - good subdirectory inside ktoDir (default "good")
 *   nolock.rlhf.badDir        - bad subdirectory inside ktoDir (default "bad")
 *   nolock.rlhf.dpoDir        - top-level directory for DPO data (default "dpo")
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
  /** Root feedback directory inside the project (default ".rlhf"). */
  root: string;
  /** Top-level directory for KTO data inside root (default "kto"). */
  ktoDir: string;
  /** Subdirectory inside ktoDir for good (thumbs-up) examples. */
  goodDir: string;
  /** Subdirectory inside ktoDir for bad (thumbs-down) examples. */
  badDir: string;
  /** Top-level directory for DPO data inside root (default "dpo"). */
  dpoDir: string;
  dpoEnabled: boolean;
  dpoInterval: number;
}

/** Default top-level directory for KTO (thumbs up/down) data. */
export const DEFAULT_KTO_DIR = "kto";
/** Default top-level directory for DPO (pairwise preference) data. */
export const DEFAULT_DPO_DIR = "dpo";

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

/** Tool call log entry from the backend — matches the Rust ToolCallLog struct. */
export interface ToolCallLog {
  name: string;
  arguments: string;
  result_snippet: string;
  result_full: string;
}

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
 * Produces: <baseDir>/<parentDir>/<subDir>/<modelKey>/data.jsonl   (when subDir is non-empty)
 *           <baseDir>/<parentDir>/<modelKey>/data.jsonl             (when subDir is empty)
 *
 * @param baseDir   The feedback root directory (e.g. "/project/.rlhf")
 * @param parentDir The parent container (e.g. "kto" or "dpo")
 * @param subDir    The feedback type subdirectory (e.g. "good", "bad"), or "" for DPO
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
  if (subDir) {
    return `${baseDir}/${parentDir}/${subDir}/${modelKey}/data.jsonl`;
  }
  return `${baseDir}/${parentDir}/${modelKey}/data.jsonl`;
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

/**
 * Serialize a list of tool calls into XML-tagged text for inclusion in
 * KTO/DPO training data. Format:
 *
 *   <tool_call>name{"arg":"val"}</tool_call>
 *   <tool_result>output</tool_result>
 *
 * This is parseable and works well with most training frameworks.
 */
export function serializeToolCalls(toolCalls: ToolCallLog[]): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  return toolCalls
    .map((tc) => {
      const args = tc.arguments || "{}";
      const result = tc.result_full || "";
      return `<tool_call>${tc.name}${args}</tool_call>\n<tool_result>${result}</tool_result>`;
    })
    .join("\n");
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
    ktoDir: localStorage.getItem("nolock.rlhf.ktoDir") || DEFAULT_KTO_DIR,
    goodDir: localStorage.getItem("nolock.rlhf.goodDir") || "good",
    badDir: localStorage.getItem("nolock.rlhf.badDir") || "bad",
    dpoDir: localStorage.getItem("nolock.rlhf.dpoDir") || DEFAULT_DPO_DIR,
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

  const filePath = jsonlPath(baseDir, settings.ktoDir, subDir, entry.model_provider, entry.model_name);
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

  const filePath = jsonlPath(baseDir, settings.dpoDir, "", entry.model_provider, entry.model_name);
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
