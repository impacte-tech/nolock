// ---------------------------------------------------------------------------
// FAQ knowledge base — the "Learning" chat mode.
//
// Learning mode keeps the repository's `.faq/` directory as plain text that
// the chat model itself maintains: its system prompt instructs it to create
// the directory, track every question the user asks, and rewrite a ranked
// README so the most-asked questions rank first.
//
// On top of that plain-text layer, nolock also maintains a semantic vector
// index (SQLite + sqlite-vec in the Rust backend — see src-tauri/src/faq.rs).
// Each exchange is embedded and stored so future questions can be retrieved by
// similarity (plus frequency/hybrid re-ranking) and injected back into the
// conversation. This module exposes the config plumbing and the thin Tauri
// command wrappers for that index.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { getChatBackend, resolveBackendUrl } from "./backends";
import { getSecret } from "./secrets";

export const FAQ_DIR_NAME = ".faq";

/** Join a root path and file parts with "/" (Rust std::fs accepts "/" everywhere). */
export function joinRepoPath(rootPath: string, ...parts: string[]): string {
  return [rootPath.replace(/[\\/]+$/, ""), ...parts].join("/");
}

export function faqDir(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME);
}

export function faqJsonPath(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME, ".faq.json");
}

export function faqReadmePath(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME, "README.md");
}

/**
 * Read the FAQ README (if the chat model has created one). Best-effort: a
 * missing/uncreated `.faq/` simply returns "" — the Learning system prompt
 * directs the model to create and maintain it.
 */
export async function readFaqReadme(rootPath: string): Promise<string> {
  if (!rootPath) return "";
  try {
    return await invoke<string>("read_file", { path: faqReadmePath(rootPath) });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Semantic index — config (Chat Model panel) + command wrappers
// ---------------------------------------------------------------------------

export type FaqRanking = "semantic" | "frequency" | "hybrid";

export interface FaqLearningConfig {
  /** Embedding model id on the configured chat backend (e.g. nomic-embed-text). */
  embeddingModel: string;
  /**
   * How retrieved entries are ordered:
   * - "semantic"  — cosine similarity with the current question.
   * - "frequency" — how often the question was asked (most-asked first).
   * - "hybrid"    — equal blend of both (default).
   */
  ranking: FaqRanking;
  /** How many past exchanges to inject into the conversation context. */
  topK: number;
  /**
   * Auto-category threshold (0.0–1.0): questions whose cosine similarity to a
   * category's most-asked representative is at least this are grouped into
   * that category. Default 0.85.
   */
  minSimilarity: number;
}

export interface FaqEntry {
  id: number;
  question: string;
  answer: string;
  frequency: number;
  lastAsked: number;
  updatedAt: number;
  categoryId?: number;
  /** Model that produced the answer (switchyard routing etc.). */
  model?: string;
  /** Provider/backend the answer came from. */
  backend?: string;
  similarity?: number;
  score?: number;
}

export interface FaqStats {
  count: number;
  dimension: number;
  model: string;
  dbPath: string;
  /** Last failed indexing attempt (embedding provider error), if any. */
  lastError?: string;
}

/** A category holding learned question → answer pairs. `isAuto` marks the
 * clusters the application creates automatically from the Top K config. */
export interface FaqCategory {
  id: number;
  name: string;
  isAuto: boolean;
  size: number;
  entries: FaqEntry[];
}

/** The full knowledge-base layout: categories + unassigned entries. */
export interface FaqCategoryList {
  categories: FaqCategory[];
  uncategorized: FaqEntry[];
}

export const FAQ_RANKING_OPTIONS: { value: FaqRanking; label: string }[] = [
  { value: "semantic", label: "Semantic (similarity)" },
  { value: "frequency", label: "Frequency (most-asked)" },
  { value: "hybrid", label: "Hybrid (blend)" },
];

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

const KEY_EMBEDDING_MODEL = "nolock.faqEmbeddingModel";
const KEY_RANKING = "nolock.faqRanking";
const KEY_TOP_K = "nolock.faqTopK";
const KEY_MIN_SIMILARITY = "nolock.faqMinSimilarity";

export function defaultFaqConfig(): FaqLearningConfig {
  return {
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    ranking: "hybrid",
    topK: 3,
    minSimilarity: DEFAULT_SIMILARITY_THRESHOLD,
  };
}

function isFaqRanking(value: unknown): value is FaqRanking {
  return value === "semantic" || value === "frequency" || value === "hybrid";
}

/** Read the learning-mode config from localStorage (safe when unavailable). */
export function getFaqConfig(): FaqLearningConfig {
  const def = defaultFaqConfig();
  try {
    const embeddingModel = localStorage.getItem(KEY_EMBEDDING_MODEL) || def.embeddingModel;
    const rankingRaw = localStorage.getItem(KEY_RANKING);
    const ranking = isFaqRanking(rankingRaw) ? rankingRaw : def.ranking;
    const topKRaw = parseInt(localStorage.getItem(KEY_TOP_K) || "", 10);
    const topK = Number.isFinite(topKRaw) && topKRaw >= 1 && topKRaw <= 50 ? topKRaw : def.topK;
    const minRaw = parseFloat(localStorage.getItem(KEY_MIN_SIMILARITY) || "");
    const minSimilarity =
      Number.isFinite(minRaw) && minRaw > 0 && minRaw <= 1 ? minRaw : def.minSimilarity;
    return {
      embeddingModel: embeddingModel.trim() || def.embeddingModel,
      ranking,
      topK,
      minSimilarity,
    };
  } catch {
    return def;
  }
}

/** Persist the learning-mode config (localStorage). */
export function setFaqConfig(cfg: FaqLearningConfig): void {
  try {
    localStorage.setItem(KEY_EMBEDDING_MODEL, cfg.embeddingModel.trim());
    localStorage.setItem(KEY_RANKING, cfg.ranking);
    localStorage.setItem(KEY_TOP_K, String(cfg.topK));
    localStorage.setItem(KEY_MIN_SIMILARITY, String(cfg.minSimilarity));
  } catch {
    // Non-fatal — the session still uses the in-memory config.
  }
}

/** Resolve the chat provider's auth the same way `ai_chat` does. */
async function faqAuth(): Promise<{ backend: string; url: string; apiKey: string }> {
  const backend = getChatBackend();
  const url = resolveBackendUrl(backend);
  const apiKey =
    (await getSecret(`apiKey.${backend}`)) ?? localStorage.getItem(`nolock.apiKey.${backend}`) ?? "";
  return { backend, url, apiKey };
}

/** Retrieve the most relevant learned exchanges for `query`. */
export async function faqSearch(
  rootPath: string,
  query: string,
  config: FaqLearningConfig = getFaqConfig(),
): Promise<FaqEntry[]> {
  if (!rootPath || !query.trim()) return [];
  const { backend, url, apiKey } = await faqAuth();
  return invoke<FaqEntry[]>("faq_search", {
    rootPath,
    backend,
    url,
    apiKey,
    query,
    config,
  });
}

/** Record a learned exchange (question → answer). `model`/`backend` record
 * which provider produced the answer (e.g. for switchyard-routed responses). */
export async function faqUpsert(
  rootPath: string,
  question: string,
  answer: string,
  model: string,
  backend: string,
  config: FaqLearningConfig = getFaqConfig(),
): Promise<FaqEntry> {
  const { backend: authBackend, url, apiKey } = await faqAuth();
  const effectiveBackend = backend || authBackend;
  return invoke<FaqEntry>("faq_upsert", {
    rootPath,
    backend: effectiveBackend,
    url,
    apiKey,
    question,
    answer,
    model,
    config,
  });
}

/** List every learned entry, most-asked first. */
export async function faqList(rootPath: string): Promise<FaqEntry[]> {
  if (!rootPath) return [];
  return invoke<FaqEntry[]>("faq_list", { rootPath });
}

/**
 * Load the knowledge base: categories + unassigned entries. Automatic
 * categories are reconciled here — uncategorized entries are clustered into
 * groups of at most `topK` similar questions, each group becoming an
 * auto-category (named after the most-asked question).
 */
export async function faqListCategories(
  rootPath: string,
  topK: number,
  minSimilarity: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<FaqCategoryList> {
  const k = Number.isFinite(topK) && topK >= 1 ? Math.min(topK, 50) : 3;
  const sim = Number.isFinite(minSimilarity) && minSimilarity > 0 && minSimilarity <= 1
    ? minSimilarity
    : DEFAULT_SIMILARITY_THRESHOLD;
  return invoke<FaqCategoryList>("faq_list_categories", { rootPath, topK: k, minSimilarity: sim });
}

/** Create a manual category. */
export async function faqCreateCategory(rootPath: string, name: string): Promise<FaqCategory> {
  return invoke<FaqCategory>("faq_create_category", { rootPath, name });
}

/** Rename a manual category (auto categories are managed from Top K). */
export async function faqRenameCategory(rootPath: string, id: number, name: string): Promise<void> {
  await invoke<void>("faq_rename_category", { rootPath, id, name });
}

/** Delete a category; its entries move back to Unassigned. */
export async function faqDeleteCategory(rootPath: string, id: number): Promise<void> {
  await invoke<void>("faq_delete_category", { rootPath, id });
}

/** Move an entry to a category (`null` = Unassigned). */
export async function faqSetEntryCategory(
  rootPath: string,
  entryId: number,
  categoryId: number | null,
): Promise<void> {
  await invoke<void>("faq_set_entry_category", { rootPath, entryId, categoryId });
}

/** Edit a question/answer pair (optionally moving it), re-embedding it. */
export async function faqUpdateEntry(
  rootPath: string,
  entryId: number,
  question: string,
  answer: string,
  categoryId: number | null,
  model: string,
  backend: string,
  config: FaqLearningConfig = getFaqConfig(),
): Promise<FaqEntry> {
  const { backend: authBackend, url, apiKey } = await faqAuth();
  const effectiveBackend = backend || authBackend;
  return invoke<FaqEntry>("faq_update_entry", {
    rootPath,
    backend: effectiveBackend,
    url,
    apiKey,
    id: entryId,
    question,
    answer,
    categoryId,
    model,
    config,
  });
}

/** Delete a question/answer pair by its id. */
export async function faqDeleteEntry(rootPath: string, entryId: number): Promise<void> {
  await invoke<void>("faq_delete_entry", { rootPath, id: entryId });
}

/** Remove a learned entry by its question text. */
export async function faqDelete(rootPath: string, question: string): Promise<void> {
  if (!rootPath || !question.trim()) return;
  await invoke<void>("faq_delete", { rootPath, question });
}

/** Store statistics (entry count, vector dimension, embedding model, path). */
export async function faqStats(rootPath: string): Promise<FaqStats> {
  return invoke<FaqStats>("faq_stats", { rootPath });
}