// ---------------------------------------------------------------------------
// Sessions — project-local conversation persistence (`.sessions/` directory).
//
// Mirrors the Rust `SessionRecord` struct in `src-tauri/src/main.rs`. Besides
// metadata, a session file now carries a FULL audit log: every user prompt,
// every assistant response, every tool call (no exceptions), plus a per-request
// token-usage breakdown split by provider/model with an optional price/cost.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { countTokens } from "./tokenizer";
import { calcCost, getModelPrice, isLocalProvider } from "./pricing";

export type SessionStatus = "active" | "finished" | "archived";

/** A tool call logged inside a session message (a trimmed ToolCallLog shape,
 *  matching the Rust `ToolCallLog` JSON so session files round-trip). */
export interface SessionToolCall {
  name: string;
  arguments: string;
  result_snippet?: string;
  result_full?: string;
}

/** A single logged conversation entry persisted in a session file. */
export interface SessionLogMessage {
  role: "user" | "assistant" | "system";
  /** Full API content (may include injected context). */
  content: string;
  /** What the user actually typed (user messages only). */
  displayContent?: string;
  /** Unix timestamp (seconds). */
  createdAt?: number;
  /** Model that produced this message (assistant only). */
  model?: string;
  /** Estimated token count for this entry. */
  tokens?: number;
  /** Tool calls made on this assistant turn. */
  toolCalls?: SessionToolCall[];
}

/** Per-request / per-iteration token usage persisted in a session file. */
export interface SessionUsageEntry {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Price per 1M input tokens (USD), when available. */
  promptPricePerM?: number | null;
  /** Price per 1M output tokens (USD), when available. */
  completionPricePerM?: number | null;
  /** Computed cost (USD), when pricing is available. */
  cost?: number | null;
}

export interface SessionRecord {
  id: string;
  summary: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  toolCallCount: number;
  firstMessage: string;
  lastMessage: string;
  tokenUsage: number;
  contextWindow: number;
  /** Full conversation log — user prompts + assistant tool calls, no exceptions. */
  messages?: SessionLogMessage[];
  /** Per-request/per-iteration token usage split by provider + model. */
  usage?: SessionUsageEntry[];
  /** Computed session cost (USD) when pricing is known for the models used. */
  totalCost?: number | null;
}

/** Generate a unique, filesystem-safe session id. */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function listSessions(rootPath: string): Promise<SessionRecord[]> {
  if (!rootPath) return [];
  const result = await invoke<SessionRecord[]>("list_sessions", { rootPath });
  // Defensive: tolerate mocks/stubs returning a non-array.
  return Array.isArray(result) ? result : [];
}

export async function saveSession(rootPath: string, session: SessionRecord): Promise<void> {
  await invoke("save_session", { rootPath, session });
}

export async function deleteSession(rootPath: string, id: string): Promise<void> {
  await invoke("delete_session", { rootPath, id });
}

export async function archiveSession(rootPath: string, id: string, summary: string): Promise<void> {
  await invoke("archive_session", { rootPath, id, summary });
}

function truncate(text: string, max = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine;
}

/** A short, human-friendly summary derived from the first user message. */
export function summarizeMessages(messages: { role: string; content?: string; displayContent?: string }[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  return truncate(firstUser.displayContent || firstUser.content || "", 80);
}

/** A loose message shape used only to compute session metadata. */
export interface SessionMetaMessage {
  role: string;
  content?: string;
  displayContent?: string;
  toolCalls?: unknown[] | null;
  hookResult?: unknown;
  model?: string;
}

/** Serialize a raw tool call (either ChatPanel's or a plain object) to the
 *  minimal shape we persist in the session log. Uses snake_case field names to
 *  round-trip through the Rust `ToolCallLog` shape. */
function serializeToolCall(tc: any): SessionToolCall {
  return {
    name: typeof tc?.name === "string" ? tc.name : "",
    arguments: typeof tc?.arguments === "string" ? tc.arguments : "",
    result_snippet: typeof tc?.result_snippet === "string" ? tc.result_snippet : tc?.resultSnippet,
    result_full: typeof tc?.result_full === "string" ? tc.result_full : tc?.resultFull,
  };
}

/**
 * Build the full conversation audit log persisted in a session file — every
 * user prompt (both what the user typed and the expanded API content) and every
 * assistant turn including its tool calls. No messages are dropped.
 *
 * `baseStartSec` is the session's creation timestamp; message timestamps are
 * derived from it (`base + index`) so they stay stable across saves instead of
 * drifting as the conversation grows.
 */
export function buildSessionMessageLog(messages: SessionMetaMessage[], baseStartSec?: number): SessionLogMessage[] {
  const now = Math.floor(Date.now() / 1000);
  const base = baseStartSec ?? now;
  return messages.map((m, i) => {
    const content = m.content || "";
    const displayContent = m.displayContent ?? undefined;
    const role = (m.role === "user" || m.role === "assistant" || m.role === "system"
      ? m.role
      : "user") as SessionLogMessage["role"];
    // Keep hook-result noise out of the visible log but still persist it as a
    // system-style entry so nothing is lost.
    const toolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
      ? m.toolCalls.map(serializeToolCall)
      : undefined;
    return {
      role,
      content: content || (toolCalls?.length ? "[tool calls]" : ""),
      displayContent,
      createdAt: base + i,
      model: m.model,
      tokens: countTokens(displayContent || content),
      toolCalls,
    };
  });
}

/**
 * Compute the metadata persisted in a session record from the live message
 * list. This is intentionally metadata-only (no full message bodies).
 */
export function buildSessionMetadata(
  messages: SessionMetaMessage[],
  tokenUsage: number,
  contextWindow: number,
): Omit<SessionRecord, "id" | "summary" | "status" | "createdAt" | "updatedAt"> {
  const real = messages.filter((m) => !m.hookResult);
  const toolCallCount = real.reduce(
    (sum, m) => sum + (Array.isArray(m.toolCalls) ? (m.toolCalls as unknown[]).length : 0),
    0,
  );
  const first = real.find((m) => m.role === "user");
  const last = [...real].reverse()[0];
  return {
    messageCount: real.length,
    toolCallCount,
    firstMessage: truncate(first?.displayContent || first?.content || ""),
    lastMessage: truncate(last?.displayContent || last?.content || ""),
    tokenUsage,
    contextWindow,
  };
}

/**
 * Enrich backend-reported per-iteration usage with pricing and compute the
 * total session cost. Entries keep the provider/model split so the summary UI
 * can show exactly what each model cost.
 */
export function enrichUsage(usage: SessionUsageEntry[]): SessionUsageEntry[] {
  if (!Array.isArray(usage)) return [];
  return usage.map((u) => {
    // Local runtimes (Ollama, llama.cpp) have no per-token pricing at all —
    // report cost as unavailable ("—") even if a stale zero price was cached.
    if (isLocalProvider(u.provider)) {
      return { ...u, promptPricePerM: null, completionPricePerM: null, cost: null };
    }
    const price = getModelPrice(u.model) ?? (u.promptPricePerM != null ? { prompt: u.promptPricePerM, completion: u.completionPricePerM ?? 0 } : null);
    const cost = u.cost ?? calcCost(price, u.promptTokens, u.completionTokens);
    return {
      ...u,
      promptPricePerM: price?.prompt ?? u.promptPricePerM ?? null,
      completionPricePerM: price?.completion ?? u.completionPricePerM ?? null,
      cost: cost ?? null,
    };
  });
}

export interface SessionUsageSummary {
  /** Rows grouped by provider + model with summed tokens/cost. */
  rows: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number | null;
    promptPricePerM: number | null;
    completionPricePerM: number | null;
    /** Number of model requests (tool-loop iterations) behind this row. */
    requests: number;
  }[];
  totalTokens: number;
  /** Total cost, or null when no pricing is known for any model used. */
  totalCost: number | null;
  /** True when at least one model had no pricing — the total is then a lower
   *  bound rather than the full session cost. */
  partialCost: boolean;
}

/** Aggregate per-request usage entries into a per provider/model summary. */
export function summarizeUsage(usage: SessionUsageEntry[] | undefined): SessionUsageSummary {
  const entries = Array.isArray(usage) ? enrichUsage(usage) : [];
  const rows = new Map<string, SessionUsageSummary["rows"][number]>();
  let totalTokens = 0;
  let anyCost = false;
  let totalCost = 0;

  for (const u of entries) {
    totalTokens += u.totalTokens || u.promptTokens + u.completionTokens;
    const key = `${u.provider}\u0000${u.model}`;
    const existing = rows.get(key);
    if (existing) {
      existing.promptTokens += u.promptTokens;
      existing.completionTokens += u.completionTokens;
      existing.totalTokens += u.totalTokens || u.promptTokens + u.completionTokens;
      existing.requests += 1;
      // Prices may be discovered between requests (model list fetched later) —
      // keep the most informative values instead of the first entry's.
      existing.promptPricePerM = u.promptPricePerM ?? existing.promptPricePerM;
      existing.completionPricePerM = u.completionPricePerM ?? existing.completionPricePerM;
      if (u.cost != null) {
        existing.cost = (existing.cost ?? 0) + u.cost;
        anyCost = true;
        totalCost += u.cost;
      }
    } else {
      rows.set(key, {
        provider: u.provider,
        model: u.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens || u.promptTokens + u.completionTokens,
        cost: u.cost ?? null,
        promptPricePerM: u.promptPricePerM ?? null,
        completionPricePerM: u.completionPricePerM ?? null,
        requests: 1,
      });
      if (u.cost != null) {
        anyCost = true;
        totalCost += u.cost;
      }
    }
  }

  const values = [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    rows: values,
    totalTokens,
    totalCost: anyCost ? totalCost : null,
    partialCost: anyCost && values.some((r) => r.cost == null),
  };
}

/** Format a token count for compact display (e.g. "12.3K"). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format a unix timestamp (seconds) as a compact date/time. */
export function formatSessionTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}