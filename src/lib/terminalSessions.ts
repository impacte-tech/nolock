import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { newSessionId } from "./sessions";

const active = new Map<string, string>();
const subscribers = new Set<() => void>();
export function activeSessionId(root: string): string {
  if (!active.has(root)) active.set(root, newSessionId());
  return active.get(root)!;
}
export function setActiveSessionId(root: string, id: string): void {
  active.set(root, id);
  subscribers.forEach((fn) => fn());
}
export function useActiveSessionId(root: string): string {
  return useSyncExternalStore((fn) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; }, () => activeSessionId(root));
}
export interface TerminalSessionEvent {
  id: string;
  terminalId: string;
  label: string;
  kind: "opened" | "attached" | "input" | "output" | "exited" | "closed" | "recording-on" | "recording-off";
  createdAt: number;
  text?: string;
}
interface Batch { rootPath: string; sessionId: string; events: TerminalSessionEvent[] }
const batches = new Map<string, Batch>();
let timer: ReturnType<typeof setTimeout> | null = null;
let serial = Promise.resolve();
let sequence = 0;
export function trackTerminal(rootPath: string, sessionId: string, event: Omit<TerminalSessionEvent, "id" | "createdAt">): void {
  const key = JSON.stringify([rootPath, sessionId]);
  const batch = batches.get(key) ?? { rootPath, sessionId, events: [] };
  batch.events.push({ ...event, id: `${Date.now().toString(36)}-${++sequence}`, createdAt: Date.now() / 1000 });
  batches.set(key, batch);
  if (!timer) timer = setTimeout(() => { timer = null; void flushTerminalActivity(); }, 500);
}
export function flushTerminalActivity(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const pending = [...batches.values()]; batches.clear();
  serial = serial.then(async () => {
    for (const batch of pending) {
      try {
        await invoke("append_terminal_session_events", { ...batch });
        window.dispatchEvent(new CustomEvent("nolock:terminal-session-updated", { detail: batch.sessionId }));
      } catch {
        window.dispatchEvent(new CustomEvent("nolock:terminal-tracking-error", { detail: "Terminal activity could not be saved. The terminal is still running." }));
      }
    }
  });
  return serial;
}
export async function readTerminalActivity(rootPath: string, sessionId: string): Promise<TerminalSessionEvent[]> {
  const result = await invoke<TerminalSessionEvent[]>("read_terminal_session_events", { rootPath, sessionId });
  return Array.isArray(result) ? result : [];
}
/** Presentation only: transcripts are never turned into chat/model messages. */
export function terminalDisplayText(text: string): string {
  return text
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface TerminalLogEntry { id: string; terminalId: string; label: string; createdAt: number; text: string }
/** Group output chunks into readable blocks without inventing user/assistant roles. */
export function terminalLogEntries(events: TerminalSessionEvent[]): TerminalLogEntry[] {
  const entries: TerminalLogEntry[] = [];
  const current = new Map<string, TerminalLogEntry>();
  for (const event of events) {
    if (event.kind !== "output") { current.delete(event.terminalId); continue; }
    let entry = current.get(event.terminalId);
    if (!entry || event.createdAt - entry.createdAt > 30 || entry.text.length > 12000) {
      entry = { id: event.id, terminalId: event.terminalId, label: event.label, createdAt: event.createdAt, text: "" };
      entries.push(entry); current.set(event.terminalId, entry);
    }
    entry.text += event.text ?? "";
  }
  return entries.map(entry => ({ ...entry, text: terminalDisplayText(entry.text).trim() })).filter(entry => entry.text);
}
