/**
 * Web shim for `@tauri-apps/api/event`.
 *
 * Build-time swap (see `vite.config.ts`): when the frontend is built with
 * `VITE_TARGET=web`, every `import { listen } from "@tauri-apps/api/event"`
 * resolves to this module instead. The desktop build keeps the real Tauri
 * event bus.
 *
 * Events arrive over a single shared Server-Sent Events connection
 * (`GET /api/events` on nolock-server). Every message is a JSON envelope
 * `{ event, payload }`; listeners are dispatched by event name, mirroring
 * Tauri's `listen` semantics (multiple listeners per event, unlisten cleanup).
 */

import { getToken } from "./auth";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

type Options = { target?: unknown };

let source: EventSource | null = null;
const listeners = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 1;

function sseUrl(): string {
  const token = getToken();
  return token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
}

function ensureSource(): EventSource {
  if (source) return source;
  source = new EventSource(sseUrl());
  source.onmessage = (msg) => {
    try {
      const { event, payload } = JSON.parse(msg.data) as {
        event: string;
        payload: unknown;
      };
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn({ event, id: nextId++, payload });
        } catch (e) {
          console.error(`[nolock-web] listener for "${event}" failed:`, e);
        }
      }
    } catch {
      // Malformed frame — ignore (keep-alives/comments never reach onmessage).
    }
  };
  // EventSource auto-reconnects on drop; nothing else to do.
  return source;
}

export async function listen<T>(
  event: string,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  ensureSource();
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const wrapped = handler as unknown as EventCallback<unknown>;
  set.add(wrapped);
  return () => {
    const current = listeners.get(event);
    if (!current) return;
    current.delete(wrapped);
    if (current.size === 0) listeners.delete(event);
  };
}
