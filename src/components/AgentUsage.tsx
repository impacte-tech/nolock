import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UsageRow {
  agent: string; provider: string; model: string; sessions: number;
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number; reasoningTokens: number;
}
interface UsageReport { rows: UsageRow[]; sessions: number; sessionsWithoutUsage: number; warnings: string[] }
const number = (value: number) => value.toLocaleString();
export default function AgentUsage({ rootPath }: { rootPath: string }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    setReport(null); setError("");
    if (!rootPath) return;
    let active = true;
    setLoading(true);
    void invoke<UsageReport>("agent_usage", { rootPath }).then(result => {
      if (active) {
        if (!Array.isArray(result?.rows)) throw new Error("Usage data is unavailable.");
        setReport(result);
      }
    }).catch(() => { if (active) setError("Could not read native agent usage."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rootPath, generation]);
  if (!rootPath) return null;
  const agents = [...new Set(report?.rows.map(row => row.agent))];
  return <section className="agent-usage" aria-label="Usage by agent and model">
    <div className="mcp-section-heading"><h3>Usage by agent and model</h3><button className="btn-secondary" disabled={loading} onClick={() => setGeneration(v => v + 1)}>Refresh usage</button></div>
    <p>Native history for this project and its subfolders, including runs outside Nolock. Input includes cached tokens; cache and reasoning columns are subsets, not additional tokens. Counts reflect what each agent reports.</p>
    {loading && <p role="status">Reading native usage…</p>}
    {error && <p role="alert">{error}</p>}
    {report && <>
      <p>{number(report.sessions)} native sessions · {number(report.sessionsWithoutUsage)} without reported usage</p>
      {!report.rows.length && <p>No reported token usage found. Terminal recordings alone do not provide token counts.</p>}
      {agents.map(agent => {
        const rows = report.rows.filter(row => row.agent === agent);
        const total = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
        return <div key={agent}><h4>{agent} · {number(total)} tokens</h4>
          <div className="agent-usage-table"><table><thead><tr><th>Model / provider</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Reasoning</th><th>Total</th></tr></thead>
            <tbody>{rows.map(row => <tr key={`${row.provider}:${row.model}`}><th scope="row">{row.model}{row.provider && <small>{row.provider}</small>}</th><td>{number(row.sessions)}</td><td>{number(row.inputTokens)}</td><td>{number(row.outputTokens)}</td><td>{number(row.cachedInputTokens)}</td><td>{number(row.cacheWriteTokens)}</td><td>{number(row.reasoningTokens)}</td><td>{number(row.inputTokens + row.outputTokens)}</td></tr>)}</tbody>
          </table></div></div>;
      })}
      {report.warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}
    </>}
    <p>Model changes split usage into separate rows. A session can appear under multiple models. Native usage is not attributed to a terminal recording by timestamps. Other agents and custom history locations may be unavailable.</p>
  </section>;
}
