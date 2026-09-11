// ---------------------------------------------------------------------------
// ShortcutsScreen — the default landing page when no file is open.
// Desktop: shows keyboard shortcuts grouped by category.
// Web: the shortcuts screen is hidden (the feature itself still works — all
// chord shortcuts remain active); a minimal placeholder is shown instead.
// ---------------------------------------------------------------------------

import { IS_WEB } from "../lib/webEnv";

interface ShortcutEntry {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  items: ShortcutEntry[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "Ctrl+F, O", description: "Open folder" },
      { keys: "Ctrl+F, E", description: "Toggle file explorer" },
      { keys: "Ctrl+F, R", description: "Refresh explorer" },
      { keys: "Ctrl+F, S", description: "Search in files" },
      { keys: "Escape", description: "Close overlays" },
    ],
  },
  {
    title: "Terminal",
    items: [
      { keys: "Ctrl+T, O", description: "New terminal" },
      { keys: "Ctrl+T, M", description: "Open terminal memory" },
    ],
  },
  {
    title: "AI Integrations",
    items: [
      { keys: "Ctrl+A, O", description: "Toggle agent chat" },
      { keys: "Ctrl+A, P", description: "Model providers" },
      { keys: "Ctrl+A, M", description: "Chat model settings" },
      { keys: "Ctrl+A, F", description: "FIM model settings" },
      { keys: "Ctrl+A, T", description: "Agent tools" },
      { keys: "Ctrl+A, G", description: "Manage AI agents" },
      { keys: "Ctrl+A, K", description: "Manage skills" },
      { keys: "Ctrl+A, R", description: "Human feedback (RLHF)" },
      { keys: "Ctrl+A, I", description: "Open AI settings" },
    ],
  },
  {
    title: "Browser",
    items: [
      { keys: "Ctrl+B, O", description: "Toggle browser panel" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: "Ctrl+E, O", description: "Toggle file explorer" },
      { keys: "Ctrl+E, S", description: "Open editor settings (linter)" },
      { keys: "Ctrl+S / Cmd+S", description: "Save current file" },
    ],
  },
];

export default function ShortcutsScreen() {
  if (IS_WEB) {
    return (
      <div className="shortcuts-screen">
        <div className="shortcuts-web-placeholder">
          <p>Open a folder to start editing.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shortcuts-screen">
      <div className="shortcuts-grid">
        {GROUPS.map((group) => (
          <div key={group.title} className="shortcuts-group">
            <h2 className="shortcuts-group-title">{group.title}</h2>
            <div className="shortcuts-list">
              {group.items.map((item) => (
                <div key={item.keys} className="shortcuts-row">
                  <kbd className="shortcuts-keys">{item.keys}</kbd>
                  <span className="shortcuts-desc">{item.description}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
