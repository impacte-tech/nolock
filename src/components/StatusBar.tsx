import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getChatBackend, getFimBackend, formatModelLabel, resolveBackendUrl } from "../lib/backends";
import { fetchModels } from "../lib/models";
import { type SwitchyardConfig } from "../lib/switchyard";
import { IS_WEB } from "../lib/webEnv";
import { clearToken } from "../web/auth";

interface Props {
  showChat: boolean;
  onToggleChat: () => void;
  rootPath: string;
}

interface BackendStatus {
  ok: boolean;
  name: string;
  completionModel: string;
  chatModel: string;
}

export default function StatusBar({ showChat, onToggleChat, rootPath }: Props) {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  // When the project's Switchyard router is enabled with a `chat` route, the
  // bottom bar shows "switchyard - on" + the route name instead of the raw
  // provider/model.
  const [switchyardRoute, setSwitchyardRoute] = useState<string | null>(null);

  useEffect(() => {
    // Guards against state updates after unmount/env teardown: `check` is
    // async (provider health probes can take seconds), and a late resolution
    // must not touch state once the effect has been cleaned up.
    let cancelled = false;
    const check = async () => {
      const b = getChatBackend();
      // Resolve the SAME URL the chat/FIM requests use (per-backend override →
      // global URL → default), not just the global `nolock.url` — on the web
      // deployment the llama.cpp URL lives in `nolock.url.llamacpp`.
      const url = resolveBackendUrl(b);
      const chatBackend = getChatBackend();
      const fitmBackend = getFimBackend();
      const completionModel = localStorage.getItem("nolock.completionModel") || "";
      const chatModel = localStorage.getItem("nolock.chatModel") || "";

      // Read the per-project Switchyard policy. When enabled with a `chat`
      // route, surface the route name instead of the provider/model.
      let activeRoute: string | null = null;
      if (rootPath) {
        try {
          const cfg = await invoke<SwitchyardConfig>("read_switchyard_config", { rootPath });
          if (cfg.enabled) {
            const chatRoute = cfg.routes.find((r) => r.purpose === "chat");
            if (chatRoute) activeRoute = chatRoute.name;
          }
        } catch {
          // Config unreadable — fall through to the normal provider display.
        }
      }
      if (cancelled) return;
      setSwitchyardRoute(activeRoute);

      try {
        let ok = false;
        if (IS_WEB && (b === "ollama" || b === "llamacpp")) {
          // On the web deployment the provider URL can be a private-network
          // address (e.g. Railway's `<service>.railway.internal`) that only
          // the nolock-server can reach — the browser cannot. Health-check
          // through the server (same path chat/completions actually use) so
          // the status reflects reality instead of a permanent false negative.
          try {
            await fetchModels(b, url);
            ok = true;
          } catch {
            ok = false;
          }
        } else if (b === "ollama") {
          // Just check if ollama is reachable
          const resp = await fetch(`${url}/api/tags`);
          ok = resp.ok;
        } else if (b === "llamacpp") {
          const resp = await fetch(`${url}/health`);
          ok = resp.ok;
        } else {
          ok = true; // openrouter / opencode / digitalocean assumed OK
        }
        if (cancelled) return;
        setBackend({
          ok,
          name: b,
          completionModel: formatModelLabel(fitmBackend, completionModel),
          chatModel: formatModelLabel(chatBackend, chatModel),
        });
      } catch {
        if (cancelled) return;
        setBackend({
          ok: false,
          name: b,
          completionModel: formatModelLabel(fitmBackend, completionModel),
          chatModel: formatModelLabel(chatBackend, chatModel),
        });
      }
    };
    check();
    const interval = setInterval(check, 30000);
    // Re-check immediately when the chat provider/model changes. The Chat Model
    // panel dispatches a custom event on save (the `storage` event doesn't fire
    // in the same window in Tauri), and we also listen for storage events for
    // cross-window changes. This keeps the bottom bar in sync with the main
    // chat model provider selection instead of showing a stale provider.
    const onSettingsChanged = () => check();
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === "nolock.chatBackend" ||
        e.key === "nolock.backend" ||
        e.key === "nolock.chatModel" ||
        e.key === "nolock.url" ||
        e.key === "nolock.completionModel"
      ) {
        check();
      }
    };
    window.addEventListener("nolock:settings-changed", onSettingsChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("nolock:settings-changed", onSettingsChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [rootPath]);

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {switchyardRoute ? (
          <>
            <span className="status-item status-ok">
              {"\u25CF"} switchyard - on
            </span>
            <span className="status-item">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              {switchyardRoute}
            </span>
          </>
        ) : (
          <>
            <span className={`status-item ${backend?.ok ? "status-ok" : "status-warn"}`}>
              {backend?.ok ? "\u25CF" : "\u25CB"} {backend?.name || "no backend"}
            </span>
            {backend?.completionModel && (
              <span className="status-item">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                {backend.completionModel}
              </span>
            )}
            {backend?.chatModel && (
              <span className="status-item">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                {backend.chatModel}
              </span>
            )}
          </>
        )}
      </div>
      <div className="statusbar-right">
        <span className="status-item" style={{ cursor: "pointer" }} onClick={onToggleChat}>
          {showChat ? "Hide Chat" : "Chat"}
        </span>
        {IS_WEB && (
          <span
            className="status-item"
            style={{ cursor: "pointer" }}
            onClick={() => {
              clearToken();
              window.location.reload();
            }}
            title="Sign out"
          >
            {"\uD83D\uDD12"} Sign out
          </span>
        )}
      </div>
    </div>
  );
}