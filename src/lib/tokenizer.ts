// ---------------------------------------------------------------------------
// Tokenizer — wraps js-tiktoken for counting tokens in file and message text.
// Uses the cl100k_base encoding which covers GPT-4, GPT-3.5-turbo and many
// OpenAI-compatible models (including Ollama via API compatibility).
// ---------------------------------------------------------------------------

import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

// Singleton encoder — initialised once and reused across the app.
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = new Tiktoken(cl100k_base);
  }
  return encoder;
}

/**
 * Count the number of tokens in `text` using the cl100k_base encoding.
 *
 * This is a rough approximation for any model, but far more accurate than
 * using character counts (which vary wildly for code vs prose).
 *
 * The encoder is lazily initialised and cached as a singleton.
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  return enc.encode(text).length;
}
