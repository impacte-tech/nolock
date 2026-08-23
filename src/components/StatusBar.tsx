import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getChatBackend, getFitmBackend, formatModelLabel } from "../lib/backends";

interface Props {
  showChat: boolean;
  onToggleChat: () => void;
}

interface BackendStatus {
  ok: boolean;
  name: string;
  completionModel: string;
  chatModel: string;
}

export default function StatusBar({ showChat, onToggleChat }: Props) {
  const [backend, setBackend] = useState<BackendStatus | null>(null);

  useEffect(() => {
    const check = async () => {
      const b = getChatBackend();
      const url = localStorage.getItem("nolock.url") || "http://localhost:11434";
      const chatBackend = getChatBackend();
      const fitmBackend = getFitmBackend();
      const completionModel = localStorage.getItem("nolock.completionModel") || "";
      const chatModel = localStorage.getItem("nolock.chatModel") || "";

      try {
        let ok = false;
        // Health-check by poking the backend with a trivial request using the configured model
        if (b === "ollama") {
          // Just check if ollama is reachable
          const resp = await fetch(`${url}/api/tags`);
          ok = resp.ok;
        } else if (b === "llamacpp") {
          const resp = await fetch(`${url}/health`);
          ok = resp.ok;
        } else {
          ok = true; // openrouter / opencode / digitalocean assumed OK
        }
        setBackend({
          ok,
          name: b,
          completionModel: formatModelLabel(fitmBackend, completionModel),
          chatModel: formatModelLabel(chatBackend, chatModel),
        });
      } catch {
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
      clearInterval(interval);
      window.removeEventListener("nolock:settings-changed", onSettingsChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <div className="statusbar">
      <div className="statusbar-left">
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
      </div>
      <div className="statusbar-right">
        <span className="status-item" style={{ cursor: "pointer" }} onClick={onToggleChat}>
          {showChat ? "Hide Chat" : "Chat"}
        </span>
      </div>
    </div>
  );
}
