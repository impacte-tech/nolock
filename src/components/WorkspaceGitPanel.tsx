import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FileStatus { path: string; oldPath?: string; staged: string; unstaged: string; untracked: boolean; conflict: boolean }
interface Status { repository: string; branch: string; files: FileStatus[] }
interface Diff { diff: string; truncated: boolean }
type Area = "staged" | "unstaged";
interface Props { rootPath: string; open: boolean; onToggle: () => void; style?: React.CSSProperties }

function BranchIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="4" cy="3" r="1.8"/><circle cx="4" cy="13" r="1.8"/><circle cx="12" cy="3" r="1.8"/><path d="M4 5v6m0-3c6 0 8-1 8-3"/></svg>;
}

export default function WorkspaceGitPanel({ rootPath, open, onToggle, style }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<{ path: string; area: Area } | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [refreshKey, refresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const selection = useRef(selected); selection.current = selected;
  useEffect(() => { setStatus(null); setSelected(null); setDiff(null); setError(""); }, [rootPath]);

  // Poll authoritative Git state, not inferred agent edits. Serial reads avoid overlap.
  useEffect(() => {
    if (!open || !rootPath) return;
    let cancelled = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (cancelled || busy || document.hidden) return;
      busy = true; setLoading(true);
      try {
        const next = await invoke<Status>("git_workspace_status", { rootPath });
        if (cancelled) return;
        if (!next || !Array.isArray(next.files)) throw new Error("Unable to read Git status.");
        setStatus(next); setError("");
        const pick = selection.current;
        if (pick) {
          const file = next.files.find((f) => f.path === pick.path);
          const exists = file && (pick.area === "staged" ? file.staged !== " " && !file.untracked : file.unstaged !== " " || file.untracked);
          if (!exists) { setSelected(null); setDiff(null); }
          else {
            try {
              const content = await invoke<Diff>("git_workspace_diff", { rootPath, ...pick });
              if (!cancelled && selection.current === pick) { setDiff(content); setDiffError(""); }
            } catch (e) { if (!cancelled && selection.current === pick) { setDiff(null); setDiffError(String(e)); } }
          }
        }
      } catch (e) { if (!cancelled) { setError(String(e)); setStatus(null); setDiff(null); } }
      finally { busy = false; if (!cancelled) setLoading(false); }
    };
    const poll = async () => { await read(); if (!cancelled) timer = setTimeout(poll, 3000); };
    void poll();
    const focus = () => { void read(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [rootPath, open, refreshKey, selected]);

  if (!open) return <aside className="workspace-git-rail"><button onClick={onToggle} title="Open workspace Git changes" aria-label="Open Git changes"><BranchIcon/><span>Git</span></button></aside>;
  const groups: { title: string; area: Area; files: FileStatus[] }[] = [
    { title: "Staged", area: "staged", files: status?.files.filter((f) => !f.untracked && f.staged !== " ") ?? [] },
    { title: "Changes", area: "unstaged", files: status?.files.filter((f) => f.untracked || f.unstaged !== " ") ?? [] },
  ];
  const lines = diff?.diff.split("\n") ?? [];
  return <aside className="workspace-git-panel" style={style} aria-label="Workspace Git changes">
    <header className="workspace-git-header"><BranchIcon/><strong>Git changes</strong><span className="workspace-git-count">{status?.files.length ?? ""}</span>
      <button onClick={() => refresh((n) => n + 1)} title="Refresh Git status" aria-label="Refresh Git status" disabled={loading}>↻</button>
      <button onClick={onToggle} title="Collapse Git panel" aria-label="Collapse Git panel">›</button>
    </header>
    {!rootPath ? <p className="workspace-git-empty">Open a folder to review its changes.</p> : error ? <p className="workspace-git-empty" role="status">{error}</p> : <>
      <div className="workspace-git-repo" title={status?.repository}><span>{status?.branch || "Reading repository…"}</span><small>Working tree · live</small></div>
      <div className="workspace-git-files">
        {status?.files.length === 0 && <p className="workspace-git-empty">Working tree clean</p>}
        {groups.filter((group) => group.files.length > 0).map((group) => <section key={group.area}>
          <h3>{group.title}<span>{group.files.length}</span></h3>
          {group.files.map((file) => <button key={file.path} className={`workspace-git-file ${selected?.path === file.path && selected.area === group.area ? "selected" : ""}`} onClick={() => { setDiff(null); setDiffError(""); setSelected({ path: file.path, area: group.area }); }} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            <span className={`workspace-git-badge ${file.conflict ? "conflict" : file.untracked ? "added" : ""}`}>{file.conflict ? "!" : file.untracked ? "U" : group.area === "staged" ? file.staged : file.unstaged}</span>
            <span className="workspace-git-path">{file.path}</span>{file.conflict && <small>Conflict</small>}
          </button>)}
        </section>)}
      </div>
      <div className="workspace-git-preview">
        {selected ? <><div className="workspace-git-diff-title" title={selected.path}>{selected.path}<small>{selected.area}</small></div>
          {diffError ? <p className="workspace-git-empty" role="status">{diffError}</p> : !diff ? <p className="workspace-git-empty">Loading diff…</p> : <>
            {!diff.diff.trim() ? <p className="workspace-git-empty">No text diff available.</p> : <pre className="workspace-git-diff" aria-label="File diff">{lines.slice(0, 5000).map((line, i) => <span key={i} className={`diff-line ${line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-added" : line.startsWith("-") && !line.startsWith("---") ? "diff-removed" : "diff-context"}`}>{line || " "}</span>)}</pre>}
            {(diff.truncated || lines.length > 5000) && <p className="workspace-git-empty">Preview truncated. Use Git locally to inspect the full diff.</p>}
          </>}
        </> : <p className="workspace-git-empty">Select a file to review its diff.</p>}
      </div>
    </>}
  </aside>;
}
