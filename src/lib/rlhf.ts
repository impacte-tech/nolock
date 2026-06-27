/**
 * RLHF (Reinforcement Learning from Human Feedback) storage utilities.
 *
 * Stores user feedback on AI chat responses as JSON files in a configurable
 * directory within the project root, partitioned by feedback type.
 *
 * Default directories:
 *   .rlhf/good/   ← thumbs up (good examples)
 *   .rlhf/bad/    ← thumbs down (bad examples with user corrections)
 *
 * Directories can be customized via localStorage settings:
 *   nolock.rlhf.enabled  - "true" | "false" (default "true")
 *   nolock.rlhf.root     - root folder name (default ".rlhf")
 *   nolock.rlhf.goodDir  - good subdirectory (default "good")
 *   nolock.rlhf.badDir   - bad subdirectory (default "bad")
 *
 * Each file is named with a timestamp and a random suffix to avoid collisions:
 *   YYYY-MM-DD_HHmmss_XXXX.json
 *
 * JSON schema for stored feedback:
 *
 * ```json
 * {
 *   "feedback_type": "good" | "bad",
 *   "model_provider": "ollama",
 *   "model_name": "qwen3:8b",
 *   "model_configurations": {
 *     "temperature": 0.7,
 *     "max_tokens": 2048,
 *     "system_prompt": "..."
 *   },
 *   "timestamp": "2026-06-26T14:30:22.123Z",
 *   "question": "User's question text",
 *   "answer": "AI's answer text",
 *   "user_correction": ""  // only populated for bad examples
 * }
 * ```
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RlhfData {
  feedback_type: "good" | "bad";
  model_provider: string;
  model_name: string;
  model_configurations: {
    temperature: number;
    max_tokens: number;
    system_prompt: string;
  };
  timestamp: string;
  question: string;
  answer: string;
  user_correction: string | "";
}

export type FeedbackType = "good" | "bad";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique filename for an RLHF entry using the current timestamp
 * and a short random suffix to prevent collisions.
 *
 * Format: `YYYY-MM-DD_HHmmss_XXXX.json`
 * Example: `2026-06-26_143022_a3f8.json`
 */
function generateFilename(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");

  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("-");

  const timePart = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");

  const rand = Math.random().toString(16).slice(2, 6);

  return `${datePart}_${timePart}_${rand}.json`;
}

/**
 * Read model configuration from localStorage.
 * These are the same keys used by ChatModelPanel.tsx and AISettings.tsx.
 */
export function getModelConfigurations(): {
  temperature: number;
  max_tokens: number;
  system_prompt: string;
} {
  const savedTemp = localStorage.getItem("nolock.chatTemperature");
  const savedTokens = localStorage.getItem("nolock.chatMaxTokens");
  const systemPrompt = localStorage.getItem("nolock.chatSystemPrompt") || "";

  return {
    temperature: savedTemp ? parseFloat(savedTemp) : 0.7,
    max_tokens: savedTokens ? parseInt(savedTokens, 10) : 2048,
    system_prompt: systemPrompt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the model context for RLHF storage by reading current settings from
 * localStorage. This captures what model/configuration was active when the
 * feedback was given.
 */
export function getModelContext(): {
  provider: string;
  model: string;
} {
  const backend = localStorage.getItem("nolock.backend") || "ollama";
  const chatModel = localStorage.getItem("nolock.chatModel") || "";
  return {
    provider: backend,
    model: chatModel,
  };
}

/**
 * Get a fallback directory for RLHF data when no project folder is open.
 * Uses the Tauri app local data directory (e.g. ~/.local/share/nolock/.rlhf/).
 */
async function getRlhfFallbackDir(): Promise<string> {
  try {
    const dir = await invoke<string>("get_rlhf_dir");
    return dir;
  } catch (e) {
    // Last-resort fallback if the Tauri command is unavailable (e.g. in tests)
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
 * Read RLHF directory settings from localStorage.
 * Falls back to defaults when settings are not present.
 */
export function readRlhfSettings(): {
  enabled: boolean;
  root: string;
  goodDir: string;
  badDir: string;
} {
  return {
    enabled: localStorage.getItem("nolock.rlhf.enabled") !== "false",
    root: localStorage.getItem("nolock.rlhf.root") || ".rlhf",
    goodDir: localStorage.getItem("nolock.rlhf.goodDir") || "good",
    badDir: localStorage.getItem("nolock.rlhf.badDir") || "bad",
  };
}

/**
 * Save an RLHF feedback entry to disk as a JSON file inside the configured
 * feedback directory (default `.rlhf/`).
 *
 * When a `rootPath` (project folder) is provided, data is saved to
 * `<rootPath>/<root>/<goodDir>/` or `<rootPath>/<root>/<badDir>/`.
 *
 * When `rootPath` is empty, data is saved to the application's local data
 * directory (e.g. `~/.local/share/nolock/.rlhf/` on Linux).
 *
 * If RLHF is disabled via settings, this function does nothing and returns
 * an empty string.
 *
 * @param rootPath  The project root path, or empty string to use fallback.
 * @param feedback  The feedback data to persist.
 * @returns         The path to the saved file, or empty string if disabled.
 */
export async function saveRlhfFeedback(
  rootPath: string,
  feedback: RlhfData,
): Promise<string> {
  const settings = readRlhfSettings();
  if (!settings.enabled) {
    console.log("[rlhf] RLHF is disabled, skipping save");
    return "";
  }

  const subDir = feedback.feedback_type === "good" ? settings.goodDir : settings.badDir;
  const fileName = generateFilename();

  // Resolve base directory: use project root if available, otherwise fallback
  let baseDir: string;
  if (rootPath) {
    baseDir = `${rootPath}/${settings.root}`;
  } else {
    baseDir = await getRlhfFallbackDir();
  }

  const filePath = `${baseDir}/${subDir}/${fileName}`;

  const jsonContent = JSON.stringify(feedback, null, 2);

  // Use `create_file` first to ensure the parent directory structure exists
  // (the Rust `create_file` command calls `create_dir_all` on the parent).
  // Then overwrite with the actual JSON content via `write_file`.
  try {
    await invoke("create_file", { path: filePath });
  } catch {
    // If create_file fails (e.g. path already exists), that's fine
  }

  // Step 2: Write the actual JSON content
  try {
    await invoke("write_file", { path: filePath, content: jsonContent });
  } catch (e) {
    throw new Error(`Failed to save RLHF feedback to ${filePath}: ${e}`);
  }

  return filePath;
}
