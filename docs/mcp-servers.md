# Project MCP connections and terminal agents

Open a project, then **MCP → Manage MCP servers**. Add local stdio commands or
remote HTTP(S) endpoints, including localhost. Connections are project-specific.
They are stored in `~/.config/nolock/mcp/mcp.project.<hash>.json` with mode 0600
on Unix. Headers and environment values are ordinary configuration in this file.
Previous keychain MCP settings migrate on first access; vault entries are not deleted.

New launches of `codex`, `claude`, and `opencode` in Nolock terminals receive enabled
connections through temporary native configuration overlays. Existing host settings,
model environment variables and native logins remain available. There is no broker,
private agent home or Nolock terminal sandbox. Local MCP commands run with the same
host permissions as the terminal.

## Configuration

Enter a command and a JSON array of literal arguments, or a remote URL with optional
headers. **Import / edit JSON** accepts:

```json
{
  "mcpServers": {
    "project-docs": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "disabled": false
    },
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "your-mcp-package"],
      "env": {},
      "disabled": false
    }
  }
}
```

Saving replaces the project's registry. Changes apply to subsequent agent launches;
running agents retain their configuration. Native connections configured separately
in an agent remain under that agent's control. Saving a connection does not verify
its handshake or authentication. Inspect `/mcp` inside Codex or Claude, or `/mcps`
in OpenCode 2. `nolock-agent list` shows Nolock's enabled project connections.
Claude's `mcp` management subcommands manage its native registry, not this overlay.

Automatic adapters support Codex, Claude Code and OpenCode 1/2. Other MCP clients
need their own configuration based on the exported JSON. An absolute executable
path, shell alias or function can bypass the launcher. Launchers require Unix and
Python 3 and are installed in `~/.config/nolock/terminal-runtime/bin`; normal zsh,
bash and fish startup places that directory first on PATH. Open new terminals
after upgrading Nolock. Agents started outside Nolock do not inherit these settings.

## Independent sessions

Each supported agent launch creates a separate `.sessions/agent_<id>.json` and
`.terminals.jsonl` output journal in the terminal's original project. Concurrent
runs and repeated runs in one terminal remain separate. For any other agent use:

```sh
nolock-agent run your-agent [args...]
```

This records the run; it does not automatically adapt an unknown client's MCP format.
**Terminal → Agent Sessions...** lists runs and displays terminal output, timestamps,
terminal identity and exit status. Native structured conversations, token costs and
resume state are not imported. Agent output is recorded automatically, limited to
8 MiB per run, and can include echoed input. A recording failure warns without
stopping the agent. Deleted recordings remain deleted while their agents finish.

## Checks

```sh
python3 -B src-tauri/resources/test_nolock_agent.py
cargo test --manifest-path src-tauri/Cargo.toml --bin nolock mcp_servers --offline
npm test -- src/components/__tests__/McpPanel.test.tsx src/components/__tests__/McpConnections.test.tsx src/components/__tests__/Terminal.test.tsx
```

## Token usage across agents

**Terminal → Agent Sessions... → Usage by agent and model** consolidates native
Codex, Claude Code and OpenCode usage for the open project and its subfolders,
including runs started outside Nolock. Use **Refresh usage** for updated totals.
The reader uses Codex JSONL histories (including archives), Claude project JSONL
histories and the OpenCode SQLite message store. It reads counters and model IDs;
it does not import conversation content or modify these stores. Standard
`CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_DATA_HOME` overrides inherited by Nolock
are supported; overrides set only inside individual terminals are not discovered.

Rows group agent, provider and model, with session counts, input, output, cache
read/write and reasoning tokens. Input includes cached tokens, and reasoning is
part of output; these breakdown columns must not be added again to the total.
Model switches create separate rows. Session counts across rows may overlap.
Repeated Codex snapshots and Claude message blocks are deduplicated. Codex child
histories with an ownership ordinal exclude inherited events; older forks without
that boundary display an accuracy warning. Agent-reported counters are not billing
records and no costs are inferred for external agents.

Missing usage is displayed as unavailable, rather than estimated from terminal
output. Native sessions are distinct from Nolock terminal recordings: resuming
one native conversation can span several recordings. No timestamp-based matching
is used. Other agents, older unsupported formats, deleted histories, and custom
history locations may not have usage available. Deleting a terminal recording
does not delete its native history or remove it from these totals.

Counter normalization follows the native formats: [Codex usage counters](https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs)
and [OpenCode stored usage](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts).
OpenCode stores visible output separately from reasoning, so Nolock combines them
for its inclusive output column.
