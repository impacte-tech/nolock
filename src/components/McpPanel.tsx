import McpConnections from "./McpConnections";

export default function McpPanel({ visible, onClose, rootPath }: {
  visible: boolean; onClose: () => void; rootPath: string;
}) {
  if (!visible) return null;
  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-title" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><span id="mcp-title">MCP</span><button aria-label="Close MCP" onClick={onClose}>×</button></div>
      <div className="modal-body mcp-body">
        <div><h3>Tools for your coding agents</h3><p>Manage project connections once. Launch agents in any Nolock terminal with your normal environment, logins, files and network access.</p></div>
        {rootPath ? <McpConnections key={rootPath} rootPath={rootPath} /> : <p>Open a project to configure its MCP servers.</p>}
        <section><h4>Agent sessions</h4><p>Launch <code>codex</code>, <code>claude</code> or <code>opencode</code> normally. Each run is saved separately in the project’s session history with its terminal output and exit status.</p>
          <p>For another coding agent, use <code>nolock-agent run COMMAND [args...]</code>. It records the session; additional clients use their own MCP configuration format.</p>
          <p>Use <code>nolock-agent list</code> to list enabled project servers. Each agent’s MCP screen shows its live connection status.</p>
        </section>
      </div>
      <div className="mcp-footer">Changes apply when you restart an agent. Native agent histories and authentication stay in their usual locations.</div>
    </div>
  </div>;
}
