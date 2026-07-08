// ---------------------------------------------------------------------------
// FITM (Fill-In-The-Middle) utility functions for the Hybrid Pipeline.
//
// These pure functions handle three concerns:
//   1. Prompt construction  – wrap prefix/suffix in FIM tokens
//   2. Response extraction   – strip conversational content, extract code
//   3. Quality scoring       – reject completions that don't look like code
// ---------------------------------------------------------------------------

/**
 * FIM (Fill-In-The-Middle) special tokens used by many code models
 * (Qwen Coder, DeepSeek Coder, CodeLlama, StarCoder2, etc.).
 *
 * If the configured model doesn't support these, the model will likely
 * output them literally – but the extraction layer will clean that up.
 */
const FIM_PREFIX = "<|fim_prefix|>";
const FIM_SUFFIX = "<|fim_suffix|>";
const FIM_MIDDLE = "<|fim_middle|>";

/**
 * Wraps the prefix and suffix into a FIM-style prompt.
 *
 * When a suffix exists (code after cursor), we use the standard
 * FIM template so the model understands what comes before AND after
 * the cursor position.
 *
 * When no suffix exists, just return the raw prefix.
 */
export function buildAiPrompt(prefix: string, suffix: string | null): string {
  const trimmedPrefix = prefix.length > 4000 ? prefix.slice(-4000) : prefix;

  if (suffix && suffix.trim().length > 0) {
    return `${FIM_PREFIX}${trimmedPrefix}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`;
  }
  return trimmedPrefix;
}

/**
 * Common conversational preambles that models sometimes prepend to
 * code completions. We strip these from the start of the response.
 */
const CONVERSATIONAL_PREFIXES = [
  /^Here('s| is)\s+(the\s+)?(code|function|solution|example|implementation).*?(\n|$)/im,
  /^Sure[,!]?\s+(here|let|i('ll| can)).*?(\n|$)/im,
  /^Okay[,!]?\s+(here|let|i('ll| can)).*?(\n|$)/im,
  /^Let me\s+(provide|give|show|write|help).*?(\n|$)/im,
  /^I('ll| can| would)\s+(provide|give|show|write|help|create).*?(\n|$)/im,
  /^This\s+(code|function|solution|example|implementation|will).*?(\n|$)/im,
  /^The\s+(code|solution|function|following|best|simplest).*?(\n|$)/im,
  /^You\s+(can|should|need|could|would).*?(\n|$)/im,
  /^We\s+(can|should|need|could|would).*?(\n|$)/im,
  /^Below\s+is\s+(the\s+)?(code|function|solution|example).*?(\n|$)/im,
  /^Here('s| is)\s+a.*?(\n|$)/im,
];

/**
 * Extracts clean code from a model response by:
 * 1. Extracting content from the first markdown code block (if present)
 * 2. Stripping known conversational preambles
 * 3. Removing trailing prose after a blank line separator
 */
export function extractCodeFromResponse(text: string): string {
  if (!text) return "";

  let cleaned = text.trim();

  // --- Step 0: Strip FIM tokens that some models emit literally -----------
  // When a model doesn't properly understand FIM tokens, it may echo back the
  // control tokens (e.g. <|fim_middle|>, <|fim_prefix|>, <|fim_suffix|>) at the
  // start of its response. Strip any leading FIM tokens before further processing.
  cleaned = cleaned.replace(/^(<\|fim_prefix\|>|<\|fim_suffix\|>|<\|fim_middle\|>\s*)*/, "").trim();

  // --- Step 1: Extract from markdown code blocks ---------------------------
  // Match ```lang? optional newline, then content, then ```
  const codeBlockMatch = cleaned.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // --- Step 2: Strip known conversational preambles -----------------------
  for (const pattern of CONVERSATIONAL_PREFIXES) {
    const match = cleaned.match(pattern);
    if (match && match.index === 0) {
      cleaned = cleaned.slice(match[0].length).trim();
      break; // only strip the first matching preamble
    }
  }

  // --- Step 3: Strip trailing prose after a blank line --------------------
  // If the text contains code-like content followed by a blank line and then
  // natural-language sentences, keep only the code portion.
  const lines = cleaned.split("\n");
  let cutoff = lines.length;
  let inCodeRegion = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect entry into code-like content
    if (!inCodeRegion && /\S/.test(line)) {
      // Heuristic: lines starting with common code patterns
      if (
        /^\s*[{(\[;=<>+\-*/@\w]/.test(line) ||
        /^\s{2,}/.test(line) // indented = likely code
      ) {
        inCodeRegion = true;
      }
    }

    // Once we're in code, a blank line followed by prose signals the end
    if (inCodeRegion && line.trim() === "") {
      // Peek ahead: if next non-blank line looks like prose (capital letter
      // sentence or common prose keyword), cut here.
      const nextNonBlank = lines
        .slice(i + 1)
        .find((l) => l.trim().length > 0);
      if (
        nextNonBlank &&
        /^(This|The|Note|Explanation|Remember|It\b|Here|In summary|In conclusion|You can|We can)/i.test(
          nextNonBlank.trim(),
        )
      ) {
        cutoff = i;
        break;
      }
    }
  }

  if (cutoff < lines.length) {
    cleaned = lines.slice(0, cutoff).join("\n").trim();
  }

  return cleaned;
}

/**
 * Scores how "code-like" a text string is, on a scale of 0–100.
 *
 * A score >= 50 suggests the output is valid code.
 * A score < 30 suggests the output is mostly conversational prose.
 *
 * This is a heuristic — it can have false positives for unusual code
 * and false negatives for terse prose.
 */
export function scoreCodeQuality(text: string): number {
  if (!text || text.length < 2) return 0;

  let score = 50; // start neutral

  // ---- Penalties ---------------------------------------------------------

  // Markdown fences = almost certainly not raw code
  if (text.includes("```")) {
    score -= 25;
  }

  // Conversational starters at the very beginning
  if (
    /^(Here|Sure|Okay|Let|I'|I will|I can|You can|We can|The code|This code|Below is)/i.test(
      text,
    )
  ) {
    score -= 20;
  }

  // Multiple long words (5+ chars) = likely natural language
  const longWords = text.match(/\b[a-zA-Z]{5,}\b/g);
  if (longWords && longWords.length > 5) {
    score -= Math.min(20, longWords.length);
  }

  // Sentences ending with period — code rarely does this outside comments
  const sentenceEndings = text.match(/\.\s/g);
  if (sentenceEndings && sentenceEndings.length > 2) {
    score -= 10;
  }

  // ---- Rewards -----------------------------------------------------------

  // Contains common code symbols
  if (/[{(\[;=<>+\-*/]/.test(text)) {
    score += 15;
  }

  // Contains indentation (whitespace-prefixed lines)
  if (/^\s{2,}/m.test(text)) {
    score += 10;
  }

  // Starts with a common code declaration
  if (
    /^(\w+\s*[:\(]|function\s|def\s|class\s|import\s|const\s|let\s|var\s|pub\s|fn\s|int\s|float\s|char\s|export\s|interface\s|type\s|enum\s|struct\s|impl\s)/.test(
      text,
    )
  ) {
    score += 10;
  }

  // Contains comments
  if (/\/\/|# |\/\*|\*\/|<!--/.test(text)) {
    score += 5;
  }

  // Contains string literals
  if (/['"`]/.test(text)) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Truncates a code completion at a logical boundary:
 * - end of line (after a newline that follows a complete statement)
 * - after a semicolon, closing brace, or closing paren (if followed by newline)
 *
 * Keeps the completion under `maxChars` while preferring to end cleanly.
 */
export function truncateAtLogicalBoundary(
  text: string,
  maxChars: number = 256,
): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);

  // Try to find the last boundary within the truncated portion
  // Order matters: more "complete" boundaries are preferred.
  // Closing braces > closing parens > semicolons > blank lines > simple newlines
  const boundaries = [
    truncated.lastIndexOf("}\n"),
    truncated.lastIndexOf(")\n"),
    truncated.lastIndexOf(";\n"),
    truncated.lastIndexOf("\n\n"),
    truncated.lastIndexOf("\n"),
    truncated.lastIndexOf("}"),
    truncated.lastIndexOf(";"),
  ];

  for (const pos of boundaries) {
    if (pos > maxChars * 0.5) {
      // Only use boundaries past the halfway point.
      // Slice up to AND including the boundary character(s).
      // Then strip trailing spaces/tabs (but preserve a single trailing newline).
      return text.slice(0, pos + 1).replace(/[ \t]+$/, "");
    }
  }

  // No good boundary found — return the raw truncation
  return truncated.replace(/[ \t]+$/, "");
}

/**
 * Full FITM pipeline:
 *   1. Build the AI prompt with FIM tokens
 *   2. (called after response) Extract code from response
 *   3. (called after response) Score quality
 *   4. (called after response) Truncate at logical boundary
 *
 * Returns the final clean completion text, or empty string if rejected.
 */
export function processCompletionResponse(
  rawResponse: string,
  minScore: number = 30,
): string {
  if (!rawResponse) return "";

  const extracted = extractCodeFromResponse(rawResponse);
  if (!extracted) return "";

  const score = scoreCodeQuality(extracted);
  if (score < minScore) return "";

  const truncated = truncateAtLogicalBoundary(extracted);
  return truncated;
}
