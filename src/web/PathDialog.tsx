import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "./core";
import type { OpenDialogOptions } from "./dialog";

interface Entry { name: string; path: string; is_dir: boolean }
function PathDialog({ options, finish }: { options?: OpenDialogOptions; finish: (path: string | null) => void }) {
  const initial = options?.defaultPath || "/";
  const [path, setPath] = useState(initial);
  const [directory, setDirectory] = useState(initial);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    invoke<Entry[]>("list_directory", { path: directory, showHidden: false }).then(items => {
      if (active) setEntries(items.filter(item => !options?.directory || item.is_dir));
    }).catch(() => { if (active) { setEntries([]); setError("Cannot browse this path. Enter an existing folder on the server."); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [directory, options?.directory]);
  const choose = async () => {
    if (!path.trim()) return;
    setLoading(true); setError("");
    try {
      if (options?.directory) await invoke("list_directory", { path: path.trim(), showHidden: false });
      finish(path.trim());
    } catch { setError("That folder could not be opened. Check the server path and permissions."); setLoading(false); }
  };
  return <dialog className="web-path-dialog" ref={dialog} onCancel={e => { e.preventDefault(); finish(null); }}>
    <form onSubmit={e => { e.preventDefault(); void choose(); }}>
      <header><h2>{options?.title || (options?.directory ? "Open folder" : "Open file")}</h2><button type="button" aria-label="Close file selector" onClick={() => finish(null)}>×</button></header>
      <label htmlFor="server-path">Path on the server</label>
      <div className="web-path-input"><input ref={input} id="server-path" value={path} onChange={e => setPath(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} /><button type="button" onClick={() => { setDirectory(path.trim() || "/"); setExpanded(true); }}>Browse</button></div>
      <button type="button" className="web-path-disclosure" aria-expanded={expanded} aria-controls="server-folder-list" onClick={() => setExpanded(v => !v)}>{expanded ? "▾" : "▸"} Browse folders</button>
      {expanded && <section id="server-folder-list" className="web-path-list" aria-label="Server folders">
        <div className="web-path-location"><button type="button" aria-label="Parent folder" disabled={directory === "/"} onClick={() => { const parent = directory.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/"; setDirectory(parent); setPath(parent); }}>↑</button><span>{directory}</span></div>
        {loading && <p role="status">Loading…</p>}
        {!loading && entries.map(entry => <button type="button" className="web-path-entry" key={entry.path} onClick={() => { setPath(entry.path); if (entry.is_dir) setDirectory(entry.path); }}><span aria-hidden="true">{entry.is_dir ? "▸" : "·"}</span>{entry.name}</button>)}
        {!loading && !error && entries.length === 0 && <p>No {options?.directory ? "subfolders" : "files"} here.</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={() => finish(null)}>Cancel</button><button type="submit" disabled={loading || !path.trim()}>Open {options?.directory ? "folder" : "file"}</button></footer>
    </form>
  </dialog>;
}

export function selectServerPath(options?: OpenDialogOptions): Promise<string | null> {
  return new Promise(resolve => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    let finished = false;
    const finish = (path: string | null) => {
      if (finished) return;
      finished = true;
      root.unmount(); host.remove(); resolve(path);
    };
    root.render(<PathDialog options={options} finish={finish} />);
  });
}
