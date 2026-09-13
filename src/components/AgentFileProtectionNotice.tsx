import { useEffect, useState } from "react";

export default function AgentFileProtectionNotice() {
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    const listener = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (typeof path === "string") setPaths(previous => [...new Set([...previous, path])]);
    };
    window.addEventListener("nolock:agent-file-blocked", listener);
    return () => window.removeEventListener("nolock:agent-file-blocked", listener);
  }, []);
  if (!paths.length) return null;
  return <aside role="status" className="provider-protection">
    <p>These files could not be included in AI context. Credential files and their aliases are excluded.</p>
    <ul>{paths.map(path => <li key={path}>{path}</li>)}</ul>
    <button type="button" onClick={() => setPaths([])}>Dismiss notice</button>
  </aside>;
}
