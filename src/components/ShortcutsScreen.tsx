// ---------------------------------------------------------------------------
// ShortcutsScreen — the default landing page when no file is open, showing
// keyboard shortcuts grouped by category.
// ---------------------------------------------------------------------------

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
      { keys: "Ctrl+T, T", description: "New terminal" },
      { keys: "Ctrl+T, M", description: "Open terminal memory" },
    ],
  },
  {
    title: "AI Integrations",
    items: [
      { keys: "Ctrl+A, C", description: "Toggle agent chat" },
      { keys: "Ctrl+A, I", description: "Open AI settings" },
      { keys: "Ctrl+Shift+I", description: "Direct AI settings" },
    ],
  },
  {
    title: "Browser",
    items: [
      { keys: "Ctrl+Shift+B", description: "Toggle browser panel" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: "Ctrl+S", description: "Save current file" },
    ],
  },
];

export default function ShortcutsScreen() {
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
