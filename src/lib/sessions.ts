// ---------------------------------------------------------------------------
// Sessions — project-local conversation persistence (`.sessions/` directory).
//
// Mirrors the Rust `SessionRecord` struct in `src-tauri/src/main.rs`. Only
// *metadata* is persisted — the full message history is intentionally NOT
// stored. The important summary fields are message count, tool-call count,
// first/last message text, and total token usage.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

export type SessionStatus = "active" | "finished" | "archived";

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
    (sum, m) => sum + (Array.isArray(m.toolCalls) ? m.toolCalls.length : 0),
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
