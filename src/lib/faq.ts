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
}

export interface FaqEntry {
  id: number;
  question: string;
  answer: string;
  frequency: number;
  lastAsked: number;
  updatedAt: number;
  similarity?: number;
  score?: number;
}

export interface FaqStats {
  count: number;
  dimension: number;
  model: string;
  dbPath: string;
}

export const FAQ_RANKING_OPTIONS: { value: FaqRanking; label: string }[] = [
  { value: "semantic", label: "Semantic (similarity)" },
  { value: "frequency", label: "Frequency (most-asked)" },
  { value: "hybrid", label: "Hybrid (blend)" },
];

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

const KEY_EMBEDDING_MODEL = "nolock.faqEmbeddingModel";
const KEY_RANKING = "nolock.faqRanking";
const KEY_TOP_K = "nolock.faqTopK";

export function defaultFaqConfig(): FaqLearningConfig {
  return { embeddingModel: DEFAULT_EMBEDDING_MODEL, ranking: "hybrid", topK: 3 };
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
    return { embeddingModel: embeddingModel.trim() || def.embeddingModel, ranking, topK };
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

/** Record a learned exchange (question → answer) in the semantic index. */
export async function faqUpsert(
  rootPath: string,
  question: string,
  answer: string,
  config: FaqLearningConfig = getFaqConfig(),
): Promise<FaqEntry> {
  const { backend, url, apiKey } = await faqAuth();
  return invoke<FaqEntry>("faq_upsert", {
    rootPath,
    backend,
    url,
    apiKey,
    question,
    answer,
    config,
  });
}

/** List every learned entry, most-asked first. */
export async function faqList(rootPath: string): Promise<FaqEntry[]> {
  if (!rootPath) return [];
  return invoke<FaqEntry[]>("faq_list", { rootPath });
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