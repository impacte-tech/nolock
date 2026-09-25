import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Server { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; disabled?: boolean }
interface Config { mcpServers: Record<string, Server> }
const empty: Config = { mcpServers: {} };

export default function McpConnections({ rootPath }: { rootPath: string }) {
  const [config, setConfig] = useState<Config>(empty);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("http");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("[]");
  const [auth, setAuth] = useState("{}");
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void invoke<Config>("list_mcp_servers", { rootPath }).then((value) => {
      if (active.current) { setConfig(value); setLoaded(true); }
    }).catch(() => { if (active.current) setError("Could not load MCP settings. Check the settings file permissions and reopen this panel."); })
      .finally(() => { if (active.current) setLoading(false); });
    return () => { active.current = false; };
  }, [rootPath]);
  async function save(next: Config) {
    setBusy(true); setError(""); setNotice("");
    try {
      await invoke("save_mcp_servers", { rootPath, config: next });
      if (!active.current) return;
      setConfig(next); setEditing(null); setAuth("{}"); setAdvanced(false); setJson("");
      setNotice("Saved for this project. Restart running agents to apply changes; new launches pick them up automatically.");
    } catch (e) { if (active.current) setError(typeof e === "string" ? e : "Could not save MCP settings."); }
    finally { if (active.current) setBusy(false); }
  }
  function edit(serverName: string, server: Server = {}) {
    setAdvanced(false); setEditing(serverName); setName(serverName); setTransport(server.command ? "stdio" : "http");
    setEndpoint(server.command || server.url || ""); setArgs(JSON.stringify(server.args || []));
    setAuth(JSON.stringify(server.command ? server.env || {} : server.headers || {}, null, 2)); setError("");
  }
  function submit() {
    try {
      const variables: unknown = JSON.parse(auth);
      if (!variables || Array.isArray(variables) || typeof variables !== "object" || Object.values(variables).some(v => typeof v !== "string")) throw new Error("Use a JSON object with string values for authentication settings.");
      const argv: unknown = transport === "stdio" ? JSON.parse(args) : [];
      if (!Array.isArray(argv) || argv.some(v => typeof v !== "string")) throw new Error("Arguments must be a JSON array of strings.");
      const key = name.trim();
      if (editing === "" && config.mcpServers[key]) throw new Error("That server name already exists. Edit its existing connection.");
      const server: Server = transport === "stdio" ? { command: endpoint.trim(), args: argv, env: variables as Record<string, string> } : { url: endpoint.trim(), headers: variables as Record<string, string> };
      server.disabled = editing ? config.mcpServers[editing]?.disabled || false : false;
      void save({ mcpServers: { ...config.mcpServers, [key]: server } });
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid JSON."); }
  }
  return <section className="mcp-section mcp-connections" aria-label="Project MCP servers">
    <div className="mcp-section-heading"><h4>Project connections</h4><span>{loading ? "Loading…" : `${Object.keys(config.mcpServers).length} saved`}</span></div>
    <p>Connect once here to share a server with Codex, Claude Code and OpenCode in this project’s terminals.</p>
    {!loading && Object.keys(config.mcpServers).length === 0 && <p className="provider-help">No MCP servers yet. Add a connection to share it with your coding agents.</p>}
    <ul className="mcp-server-list">{Object.entries(config.mcpServers).map(([key, server]) => <li key={key}>
      <div><strong>{key}</strong><span>{server.url ? "Remote · HTTP" : "Local · stdio"} · {server.disabled ? "Disabled" : "Enabled for new agent launches"}</span></div>
      <div className="mcp-server-actions">
        <button className="btn-secondary" disabled={busy} onClick={() => edit(key, server)}>Edit {key}</button>
        <button className="btn-secondary" disabled={busy} onClick={() => void save({ mcpServers: { ...config.mcpServers, [key]: { ...server, disabled: !server.disabled } } })}>{server.disabled ? "Enable" : "Disable"} {key}</button>
        <button className="btn-secondary" disabled={busy} onClick={() => { const next = { ...config.mcpServers }; delete next[key]; void save({ mcpServers: next }); }}>Remove {key}</button>
      </div>
    </li>)}</ul>
    <div className="mcp-server-actions">
      <button className="btn-secondary" disabled={!loaded || busy} onClick={() => edit("")}>Add MCP server</button>
      <button className="btn-secondary" disabled={!loaded || busy} onClick={() => { setAdvanced(!advanced); setEditing(null); setJson(JSON.stringify(config, null, 2)); }}>Import / edit JSON</button>
    </div>
    {editing !== null && <fieldset className="mcp-form" disabled={busy}>
      <legend>{editing ? `Edit ${editing}` : "New connection"}</legend>
      <label>Server name<input value={name} disabled={!!editing} onChange={e => setName(e.target.value)} placeholder="project-docs" autoComplete="off" /></label>
      <label>Transport<select value={transport} onChange={e => { setTransport(e.target.value); setEndpoint(""); setAuth("{}"); }}><option value="http">HTTP / HTTPS (Streamable HTTP)</option><option value="stdio">Local command (stdio)</option></select></label>
      <label>{transport === "http" ? "Server URL" : "Executable"}<input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder={transport === "http" ? "https://example.com/mcp" : "npx"} autoComplete="off" /></label>
      {transport === "stdio" && <label>Arguments (JSON array)<input value={args} onChange={e => setArgs(e.target.value)} placeholder={'["-y", "your-mcp-package"]'} autoComplete="off" /></label>}
      <details><summary>{transport === "http" ? "Authentication headers" : "Environment variables"}</summary>
        <label>{transport === "http" ? "Headers (JSON object)" : "Environment (JSON object)"}<textarea value={auth} onChange={e => setAuth(e.target.value)} spellCheck={false} autoComplete="off" placeholder={transport === "http" ? '{"Authorization":"Bearer …"}' : '{"API_KEY":"…"}'} /></label>
        <p className="provider-help">Saved in your private Nolock MCP configuration file and passed to the agent’s MCP servers. You can also use the agent’s own authentication flow.</p>
      </details>
      <div className="mcp-server-actions"><button className="btn-primary" disabled={!name.trim() || !endpoint.trim()} onClick={submit}>Save connection</button><button className="btn-secondary" onClick={() => { setEditing(null); setAuth("{}"); }}>Cancel</button></div>
    </fieldset>}
    {advanced && <fieldset className="mcp-form" disabled={busy}><legend>Project MCP configuration</legend>
      <p>Paste a configuration with an <code>mcpServers</code> object. Each entry accepts command, args, env, url, headers and disabled. Saving replaces this project’s connections.</p>
      <label>Configuration JSON<textarea className="mcp-json" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} autoComplete="off" /></label>
      <p className="provider-help">This editor includes saved authentication values. Copy only into clients you trust; each client may require a different configuration format.</p>
      <div className="mcp-server-actions"><button className="btn-primary" onClick={() => { try { void save(JSON.parse(json)); } catch { setError("Invalid configuration JSON."); } }}>Save configuration</button><button className="btn-secondary" onClick={() => { setAdvanced(false); setJson(""); }}>Cancel</button></div>
    </fieldset>}
    <p className="provider-help">Enabled means configured, not connected. Check the agent’s MCP list after launch. Local servers, localhost endpoints and native authentication flows use your normal host access.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
