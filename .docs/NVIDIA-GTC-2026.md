# NVIDIA Libraries in nolock

nolock embeds two NVIDIA NeMo libraries to power its agent system and model
routing. Both are used **behind the scenes** — they add typed contracts and
routing intelligence without changing how agents are written or how transport
works.

| Library | Version | Role | Source module |
|---|---|---|---|
| [`nemo-fabric-core`](https://github.com/NVIDIA/NeMoFabric) | `0.2.0` | Agent config + agent-to-agent flow validation | `src-tauri/src/fabric.rs` |
| [`switchyard-libsy`](https://github.com/NVIDIA-NeMo/Switchyard) | `0.2.0` | Model routing ("general routers") | `src-tauri/src/switchyard.rs` |
| `switchyard-protocol` | `0.2.0` | Wire types shared with libsy | `src-tauri/src/switchyard.rs` |

Both crates are declared in `src-tauri/Cargo.toml` and pinned to the same
`0.2.0` release.

---

## 1. nemo-fabric-core — Agent Validation

### What it does

`nemo-fabric-core` provides the *typed config and runtime contracts* for agents.
nolock plugs these contracts into its agent system **without changing how agents
are written or how flows run**:

1. **Config validation** — every agent file in `.agents/` (and any agent created
   through the UI, which writes the same folder) is cross-checked against
   nemo-fabric-core's typed `AgentConfig` contract. nolock's frontmatter is mapped
   onto the fabric contract and `serde`-validated with `deny_unknown_fields`
   semantics, so a bad agent file is rejected with a precise message instead of
   failing silently at runtime.
2. **Flow validation** — before the main agent gives a sub-agent a task and after
   it returns, the request/result are normalized into nemo-fabric-core's
   `AgentRunRequest` / `AgentRunResult` contracts and validated with
   `AgentRunResult::validate()`. Invariant violations (e.g. a failed run with no
   error, or a successful run carrying an error) are surfaced.

### Key functions (`src-tauri/src/fabric.rs`)

| Function | Purpose |
|---|---|
| `validate_agent_config(parsed, source)` | Map nolock's agent frontmatter onto `AgentConfig` and validate it. |
| `validate_agents_directory(root_path)` | Validate every `.agents/*.md` file in a project; returns a list of human-readable issues (empty = all valid). |
| `build_agent_run_request(task, root_path)` | Build a normalized `AgentRunRequest` for a sub-agent spawn. |
| `validate_subagent_run(...)` | Validate a sub-agent's `AgentRunResult` against the fabric contract. |

### How it's wired

- The `validate_agents` Tauri command calls `validate_agents_directory` and
  surfaces issues in the Agent Manager UI.
- `run_subagent` wraps each agent-to-agent run in the fabric request/result
  contracts so invariant violations are caught.

### Why it matters

Agent config mistakes (typos, unknown fields, missing required fields) become
**clear, immediate errors** instead of silent runtime failures. The typed
contract also keeps `.agents/` files consistent across the project.

---

## 2. switchyard-libsy — Model Switching Router

### What it does

`switchyard-libsy` provides the "general routers" that decide **which model /
backend serves a request**. nolock keeps its own Ollama/OpenAI streaming
transport (so the nemotron thinking/tool pipeline is untouched); libsy only
*picks the target*.

Routing policy lives in a per-project **`.routers/switchyard.json`** file (next
to `.agents/`), so routes are versioned project config. The file is deliberately
**secret-free**: targets reference `(backend, model)` only, and credentials keep
coming from the request's `providers` map / OS keychain at request time.

### Supported algorithms ("general routers")

| Algorithm | Behavior |
|---|---|
| `passthrough` | Always call one configured target. |
| `random` | Pick among N targets with uniform or weighted routing. With `costPer1k` set and no explicit `weights`, targets are weighted by inverse cost so cheaper models are picked more often (cost-aware). |
| `llm-classifier` | A judge model classifies each task and routes between an `efficient` and a `capable` target. The judge is served with the classifier's JSON schema enforced, so it returns a complete verdict. |

### Key functions (`src-tauri/src/switchyard.rs`)

| Function | Purpose |
|---|---|
| `read_switchyard_config(root_path)` | Load `.routers/switchyard.json` (defaults to disabled when absent). |
| `write_switchyard_config(root_path, config)` | Validate + persist the routing policy. |
| `validate_switchyard_config(config)` | Validate a route/target config before saving. |
| `resolve_route(...)` | Run the routing algorithm and return the selected target's `(backend, model, url, api_key)`. |
| `select_target_for_decision(...)` | Cost-aware target selection within a tier (cheapest in the chosen tier). |

### How it's wired

- `run_chat` (main agent) and `run_subagent` (sub-agents) call `resolve_route`
  before dispatching. When the project's config is enabled and a matching route
  exists, the request's `backend` / `model` / `url` / `api_key` are overridden
  with the routed target.
- The routed model is surfaced to the frontend via the `model-routed` event, so
  the UI shows which model actually served the response.
- **Fail-safe:** any config/parse/libsy error falls through to nolock's current
  provider resolution — routing never blocks a chat.

### Example `.routers/switchyard.json`

```jsonc
{
  "enabled": true,
  "routes": [
    {
      "name": "nemotron-capability",
      "purpose": "chat",              // chat | subagent | agent-select | fitm
      "algorithm": "llm-classifier",  // passthrough | random | llm-classifier
      "targets": [
        { "id": "lightning", "label": "Nemotron 3.5 Lightning", "backend": "openrouter", "model": "nvidia/nemotron-3.5-lightning", "tier": "efficient", "costPer1k": 0.00008 },
        { "id": "super",     "label": "Nemotron Super",         "backend": "openrouter", "model": "nvidia/nemotron-3-super-120b-a12b",  "tier": "capable",   "costPer1k": 0.000085 },
        { "id": "ultra",     "label": "Nemotron Ultra",         "backend": "openrouter", "model": "nvidia/nemotron-3-ultra-550b-a55b",  "tier": "capable",   "costPer1k": 0.0005 }
      ],
      "judge": { "backend": "openrouter", "model": "nvidia/nemotron-3.5-lightning", "baseThreshold": 0.5 }
    }
  ]
}
```

### Why it matters

Routing is decided **per request** rather than statically per agent. The
`llm-classifier` routes simple tasks to a cheap `efficient` model and harder
tasks to a `capable` model, and cost-aware selection picks the cheapest target
within the chosen tier — so you only pay for capability when the task needs it.

---

## Relationship between the two libraries

- **nemo-fabric-core** validates *what* an agent is and *how* agent runs flow
  (config + runtime contracts).
- **switchyard-libsy** decides *which model* serves a given request (routing).

They are independent: an agent can be validated by fabric and still be routed to
any model by switchyard. Together they give nolock a typed, validated agent
system with cost-aware, per-request model routing.