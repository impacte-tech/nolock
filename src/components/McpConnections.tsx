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
  const [args, setArgs] = useState("");
  const [auth, setAuth] = useState<[string, string][]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  const active = useRef(0);
  useEffect(() => {
    const generation = ++active.current;
    setLoading(true); setLoaded(false); setConfig(empty); setEditing(null); setAdvanced(false); setAuth([]); setError(""); setNotice(""); setBusy(false);
    void invoke<Config>("list_mcp_servers", { rootPath }).then((value) => {
      if (active.current === generation) { setConfig(value); setLoaded(true); }
    }).catch(() => { if (active.current === generation) setError("Could not load MCP settings. Check the settings file permissions and reopen this panel."); })
      .finally(() => { if (active.current === generation) setLoading(false); });
    return () => { ++active.current; };
  }, [rootPath]);
  async function save(next: Config) {
    const generation = active.current;
    setBusy(true); setError(""); setNotice("");
    try {
      await invoke("save_mcp_servers", { rootPath, config: next });
      if (active.current !== generation) return;
      setConfig(next); setEditing(null); setAuth([]); setAdvanced(false); setJson("");
      setNotice("Saved. Restart running agents to use this connection.");
    } catch (e) { if (active.current === generation) setError(typeof e === "string" ? e : "Could not save MCP settings."); }
    finally { if (active.current === generation) setBusy(false); }
  }
  function edit(serverName: string, server: Server = {}) {
    setAdvanced(false); setEditing(serverName); setName(serverName); setTransport(server.command ? "stdio" : "http");
    setEndpoint(server.command || server.url || ""); setArgs((server.args || []).join("\n"));
    setAuth(Object.entries(server.command ? server.env || {} : server.headers || {})); setError("");
  }
  function submit() {
    try {
      const variables: Record<string, string> = {};
      for (const [raw, value] of auth) {
        const key = raw.trim();
        if (!key) throw new Error("Give every optional setting a name, or remove its row.");
        if (Object.prototype.hasOwnProperty.call(variables, key)) throw new Error(`Duplicate setting: ${key}`);
        Object.defineProperty(variables, key, { value, enumerable: true, configurable: true, writable: true });
      }
      const argv = transport === "stdio" && args !== "" ? args.split("\n") : [];
      if (transport === "http") {
        let url: URL;
        try { url = new URL(endpoint.trim()); } catch { throw new Error("Enter a complete server URL, such as https://example.com/mcp."); }
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS server URL.");
      }
      const key = name.trim();
      if (editing === "" && config.mcpServers[key]) throw new Error("That server name already exists. Edit its existing connection.");
      const server: Server = transport === "stdio" ? { command: endpoint.trim(), args: argv, env: variables as Record<string, string> } : { url: endpoint.trim(), headers: variables as Record<string, string> };
      server.disabled = editing ? config.mcpServers[editing]?.disabled || false : false;
      void save({ mcpServers: { ...config.mcpServers, [key]: server } });
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid JSON."); }
  }
  return <section className="mcp-section mcp-connections" aria-label="Project MCP servers">
    <div className="mcp-section-heading"><h4>Project connections</h4><span>{loading ? "Loading…" : `${Object.keys(config.mcpServers).length} saved`}</span></div>
    <p>Connect tools to Codex, Claude Code and OpenCode for this project.</p>
    {!loading && Object.keys(config.mcpServers).length === 0 && <p className="provider-help">No connections yet. Add a server to get started.</p>}
    <ul className="mcp-server-list">{Object.entries(config.mcpServers).map(([key, server]) => <li key={key}>
      <div><strong>{key}</strong><span>{server.url ? "Remote · HTTP" : "Local · stdio"} · {server.disabled ? "Disabled" : "Enabled"}</span></div>
      <div className="mcp-server-actions">
        <button className="btn-secondary" disabled={busy} onClick={() => edit(key, server)}>Edit {key}</button>
        <button className="btn-secondary" disabled={busy} onClick={() => void save({ mcpServers: { ...config.mcpServers, [key]: { ...server, disabled: !server.disabled } } })}>{server.disabled ? "Enable" : "Disable"} {key}</button>
        <button className="btn-secondary" disabled={busy} onClick={() => { const next = { ...config.mcpServers }; delete next[key]; void save({ mcpServers: next }); }}>Remove {key}</button>
      </div>
    </li>)}</ul>
    <div className="mcp-server-actions">
      <button className="btn-secondary" disabled={!loaded || busy} onClick={() => edit("")}>Add MCP server</button>
      <button className="btn-secondary" disabled={!loaded || busy} onClick={() => { setAdvanced(!advanced); setEditing(null); setJson(JSON.stringify(config, null, 2)); }}>Advanced: import JSON</button>
    </div>
    {editing !== null && <fieldset className="mcp-form" disabled={busy}>
      <legend>{editing ? `Edit ${editing}` : "New connection"}</legend>
      <label>Server name<input value={name} disabled={!!editing} onChange={e => setName(e.target.value)} placeholder="project-docs" autoComplete="off" /></label>
      <label>Connection type<select value={transport} onChange={e => { setTransport(e.target.value); setEndpoint(""); setAuth([]); }}><option value="http">Remote server (URL)</option><option value="stdio">Local program</option></select></label>
      <label>{transport === "http" ? "Server URL" : "Command"}<input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder={transport === "http" ? "https://example.com/mcp" : "npx"} autoComplete="off" /></label>
      {transport === "stdio" && <label>Arguments (one per line)<textarea value={args} onChange={e => setArgs(e.target.value)} placeholder={"-y\n@your-org/mcp-server"} autoComplete="off" spellCheck={false} /></label>}
      <details><summary>{transport === "http" ? "Headers & authentication (optional)" : "Environment variables (optional)"}</summary>
        {auth.map(([key, value], index) => <div className="mcp-setting-row" key={index}>
          <label>Name<input aria-label={`Setting ${index + 1} name`} value={key} onChange={e => setAuth(auth.map((pair, i) => i === index ? [e.target.value, pair[1]] : pair))} placeholder={transport === "http" ? "Authorization" : "API_KEY"} autoComplete="off"/></label>
          <label>Value<input type="password" aria-label={`Setting ${index + 1} value`} value={value} onChange={e => setAuth(auth.map((pair, i) => i === index ? [pair[0], e.target.value] : pair))} placeholder={transport === "http" ? "Bearer …" : "Value"} autoComplete="off"/></label>
          <button type="button" className="btn-secondary" aria-label={`Remove setting ${index + 1}`} onClick={() => setAuth(auth.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className="btn-secondary" onClick={() => setAuth([...auth, ["", ""]])}>{transport === "http" ? "Add header" : "Add variable"}</button>
        <p className="provider-help">Stored in the local MCP configuration file.</p>
      </details>
      <div className="mcp-server-actions"><button className="btn-primary" disabled={!name.trim() || !endpoint.trim()} onClick={submit}>Save connection</button><button className="btn-secondary" onClick={() => { setEditing(null); setAuth([]); }}>Cancel</button></div>
    </fieldset>}
    {advanced && <fieldset className="mcp-form" disabled={busy}><legend>Project MCP configuration</legend>
      <p>Paste an <code>mcpServers</code> configuration. Saving replaces this project’s connections.</p>
      <label>Configuration JSON<textarea className="mcp-json" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} autoComplete="off" /></label>
      <p className="provider-help">Includes any saved headers and environment variables.</p>
      <div className="mcp-server-actions"><button className="btn-primary" onClick={() => { try { void save(JSON.parse(json)); } catch { setError("Invalid configuration JSON."); } }}>Save configuration</button><button className="btn-secondary" onClick={() => { setAdvanced(false); setJson(""); }}>Cancel</button></div>
    </fieldset>}
    <p className="provider-help">Check connection status in your agent after restarting it.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
