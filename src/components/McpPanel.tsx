import McpConnections from "./McpConnections";

export default function McpPanel({ visible, onClose, rootPath }: {
  visible: boolean; onClose: () => void; rootPath: string;
}) {
  if (!visible) return null;
  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-title" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><span id="mcp-title">MCP</span><button aria-label="Close MCP" onClick={onClose}>×</button></div>
      <div className="modal-body mcp-body">
        {rootPath ? <McpConnections key={rootPath} rootPath={rootPath} /> : <p>Open a project to configure its MCP servers.</p>}
        <details><summary>Using connections in a terminal</summary><p>Start Codex, Claude Code or OpenCode after saving. Check connection status in the agent’s MCP menu.</p><p>For other agents, use their own MCP setup.</p></details>
      </div>
      <div className="mcp-footer">Connections are saved for this project.</div>
    </div>
  </div>;
}
