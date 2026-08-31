<p align="center">
  <img src="src/assets/nolocklogo-white.svg" alt="nolock" width="400"/>
</p>

<h1 align="center">nolock</h1>

<p align="center">
  <strong>A privacy-first, AI-native development environment for your local machine.</strong>
</p>

<p align="center">
  <em>Code. Chat. Terminal. Browser. All in one window — no cloud required.</em>
</p>

<p align="center">
  nolock's opinionated feature set is crafted to preserve cognitive load and maintain engineers' full ownership of their codebase. It leverages AI assistance without fostering over-reliance on LLM outputs — designed especially for Computer Science, Software Engineering, and technically-focused students who want to stay firmly in the driver's seat while avoiding excessive automation.
</p>

---

## About

**nolock** is a desktop IDE that puts you in full control. It combines a full-featured code editor (powered by Monaco), a real terminal emulator, an AI agent chat panel, a native web browser, and a workspace-wide file search — all running locally with no telemetry, no accounts, and no lock-in.

Connect it to your preferred AI backend (Ollama, llama.cpp, OpenRouter, or OpenCode Zen) for inline code completions and agentic chat with tool-calling capabilities (web search, file read, directory listing).

---

## Open Source Technologies

nolock is built on the shoulders of many incredible open-source projects. Below is a breakdown of what each one does and how it's used.

### Frontend

| Technology | What it is | How nolock uses it |
|---|---|---|
| **React 18** | A declarative, component-based UI library for building interactive user interfaces. | Drives the entire user interface — file explorer, editor tabs, chat panel, settings modals, and status bar. |
| **TypeScript** | A typed superset of JavaScript that compiles to plain JavaScript. | All frontend code is written in TypeScript for better developer experience, type safety, and maintainability. |
| **Vite** | A fast build tool and development server with hot module replacement. | Serves the frontend during development and produces optimized production bundles. |
| **Monaco Editor** | The same code editor that powers VS Code — a browser-based code editor with syntax highlighting, IntelliSense, and multi-language support. | Provides the main code editing experience with file-type detection, bracket colorization, minimap, and inline AI completions. |
| **xterm.js** | A fully-featured terminal emulator implemented in JavaScript that runs in the browser. | Renders the integrated terminal panel with full VT100/xterm escape sequence support, themes, and cursor handling. |
| **marked** | A low-level Markdown compiler built for speed. | Renders AI assistant responses with rich formatting — code blocks, headings, lists, inline code, and links. |
| **js-tiktoken** | A JavaScript port of OpenAI's tiktoken tokenizer, using the cl100k_base encoding. | Counts tokens in file contents and chat messages to provide context window awareness in the AI chat panel. |
| **Vitest** | A blazing-fast unit test framework powered by Vite. | Runs the frontend test suite (components, utilities, and integration tests). |
| **@testing-library/react** | Lightweight utilities for testing React components in a user-centric way. | Provides DOM-based testing utilities for React component tests. |

### Backend (Rust)

| Technology | What it is | How nolock uses it |
|---|---|---|
| **Tauri 2** | A framework for building desktop applications with a web frontend and a Rust backend. | The core application framework — manages windows, system tray, native menus, IPC between frontend and backend, and application lifecycle. |
| **serde / serde_json** | A serialization/deserialization framework for Rust. | Handles all JSON serialization for IPC commands, AI API requests/responses, and configuration persistence. |
| **reqwest** | An ergonomic, batteries-included HTTP client for Rust. | Makes HTTP requests to AI backends (Ollama, llama.cpp, OpenRouter, OpenCode Zen) for chat completions, code completions, and model information. |
| **switchyard-libsy** | NVIDIA NeMo Switchyard's embeddable routing library — the "general routers" (random, passthrough, llm-classifier) that pick which model/backend serves a request. | Routes main-chat and sub-agent requests across models/providers at runtime. Policy is per-project `.routers/switchyard.json`; nolock keeps its own transport, libsy only decides the target. |
| **nemo-fabric-core** | NVIDIA NeMo Fabric's core config & runtime contracts for agents. | Validates every agent file in `.agents/` against the typed `AgentConfig` contract and normalizes agent-to-agent runs (see `src-tauri/src/fabric.rs`). |
| **portable-pty** | A cross-platform PTY (pseudo-terminal) library for Rust that works on Linux, macOS, and Windows. | Spawns and manages real interactive shell sessions (bash, zsh, etc.) with proper terminal dimensions, resizing, and signal handling. |
| **regex** | A Rust library for regular expression matching. | Powers workspace-wide file search with regex mode, case-insensitive matching, and batch find-and-replace across files. |
| **wry** | A cross-platform webview rendering library used by Tauri. | On Linux, creates a native GTK-based webview overlay for the in-app browser panel (supporting sites that block iframes). |
| **GTK3 (gtk-rs)** | Rust bindings for the GTK 3 toolkit. | On Linux, manages a GtkOverlay + GtkFixed widget setup to position the native browser webview precisely within the application layout. |

### AI Backends

| Technology | What it is | How nolock uses it |
|---|---|---|
| **Ollama** | A local server for running large language models on your own machine with a simple REST API. | Supports both inline code completions (via `/api/generate` with Fill-In-The-Middle) and multi-turn chat (via `/api/chat`) with tool calling. |
| **llama.cpp** | A C/C++ implementation of LLM inference optimized for consumer hardware. | Supports code completions via its `/completion` endpoint with Fill-In-The-Middle support. |
| **OpenRouter** | A unified API gateway that provides access to dozens of AI models from multiple providers. | Supports chat completions and tool calling through the OpenAI-compatible `/chat/completions` endpoint. |
| **OpenCode Zen** | An AI inference service with some models offering a generous free tier. | Supports code completions and chat via its `/api/generate` endpoint. |

### Search & Data

| Technology | What it is | How nolock uses it |
|---|---|---|
| **DuckDuckGo Instant Answer API** | A free, no-API-key search API that returns topic summaries, definitions, and related topics as JSON. | Powers the `web_search` tool in Agent Chat — enables the AI to discover relevant URLs before fetching page content with `web_fetch`. No signup, no cost, privacy-respecting. |
| **Brave Search API** | A privacy-focused web search API that returns real web search results (titles, URLs, descriptions). | Optional alternative to DuckDuckGo for the `web_search` tool — provides full web search results with better coverage for technical queries. Requires a free API key from [Brave Search API](https://brave.com/search/api/). |

---

## Features

- **Code Editor** — Full-featured Monaco editor with syntax highlighting for 100+ languages, bracket colorization, minimap, word wrap, and **inline linting** (ESLint for TypeScript/JavaScript, Ruff for Python, Clippy for Rust) with configurable rules via <kbd>Ctrl+E, S</kbd>.
- **File Search & Replace** — Search across all workspace files with regex support, match-case toggles, debounced live results, grouped by file with inline match previews, and batch replace-all with confirmation.
- **AI Inline Completions** — Fill-In-The-Middle (FITM) code suggestions from your local AI backend, debounced and triggered on typing pauses.
- **Agent Chat** — Multi-turn conversational AI chat with file referencing (`@` mentions), tool calling (web search, web fetch, file read, directory listing, grep, edit, write_file), custom tools via `.tools/`, and context token tracking.
- **AI Agent Manager** — Create and manage specialized AI agents (e.g., code-reviewer, doc-writer) stored as `.md` files (Markdown with YAML frontmatter) in the `.agents/` directory with custom system prompts. Legacy `.json` format is still supported.
- **Hooks** — Project-local automation rules (`.hooks/`) that trigger AI agent runs on CLI commands (e.g. `git commit`), cron schedules, or manual `!hook-name` signals. Open via <kbd>Ctrl+A, H</kbd>.
- **Human Feedback (RLHF)** — Collect thumbs-up/thumbs-down (KTO) and pairwise preference (DPO) feedback on AI chat responses. KTO and DPO data live in separate top-level directories under `.rlhf/`, each partitioned by model configuration, ready for downstream RLHF training. Enable/disable via <kbd>Ctrl+A, R</kbd>.
- **Integrated Terminal** — Real PTY-based shell sessions with multiple tabs, resize support, and command history tracking.
- **Terminal Memory** — Automatically records commands, tracks frequency, and lets you organize commands into categories for quick recall.
- **File Explorer** — Tree-based file browser with directory expansion, refresh, file-type color coding, and file/directory CRUD operations (create, rename, delete, copy).
- **Native Browser Panel** — Embedded web browser using a native OS webview (not an iframe) — browse any site without leaving the app.
- **Resizable Panels** — All panels (explorer, editor, terminal, browser, chat) are fully resizable with drag handles.
- **Multi-Backend AI** — Switch between Ollama, llama.cpp, OpenRouter, and OpenCode Zen for completions and chat.
- **Switchyard Router** — Route requests across models/providers at runtime with NVIDIA NeMo Switchyard's embedded "general routers" (random, passthrough, llm-classifier). Per-project policy lives in `.routers/switchyard.json`; open via <kbd>Ctrl+A, Y</kbd>.
- **Privacy-First** — No telemetry, no accounts, no cloud dependency. Everything runs on your machine.

---

## Human Feedback (RLHF) — KTO & DPO

### The Problem

Large language models are typically fine-tuned on general internet text, not on *your* coding preferences. Out of the box, an AI assistant might be too verbose, too terse, too eager to generate boilerplate, or simply wrong in domain-specific ways. The most effective way to align a model to *your* standards is to show it what *you* consider good and bad — but collecting that feedback is usually the bottleneck.

nolock's RLHF system solves this by instrumenting the AI chat panel with two lightweight feedback mechanisms that integrate directly into your natural coding workflow. The collected data is stored in a structured, portable format that can be used to fine-tune any compatible model.

### Key Concepts

#### Reinforcement Learning from Human Feedback (RLHF)

RLHF is a family of techniques that use human preference data to align language model outputs with human values, style, and correctness. The core idea is simple: instead of trying to write a perfect system prompt that covers every edge case, you let the model generate responses and then tell it which ones are better. Over enough examples, the model learns to prefer the patterns you reward.

nolock's RLHF system collects training data in two complementary formats:

#### KTO — Kahneman-Tversky Optimization

KTO (named after psychologists Daniel Kahneman and Amos Tversky) is a **binary preference** method. For each AI response, you give a simple thumbs-up or thumbs-down:

- **Thumbs-up** → saved as a "good" example (label: `true`)
- **Thumbs-down** → saved as a "bad" example with an optional correction describing what was wrong (label: `false`)

KTO is lightweight and requires no extra AI calls — it piggybacks on your normal chat usage. Every rating you give becomes a training example. The optional correction text serves as a natural-language signal for what a better response would look like.

#### DPO — Direct Preference Optimization

DPO (Direct Preference Optimization) is a **pairwise preference** method that captures more nuanced judgements. Instead of rating a single response, you compare two alternative responses and pick the better one:

- **What happens**: Every N user messages (configurable in RLHF settings), the AI generates *two* responses instead of one. The second response uses a slightly higher temperature (+0.2) to produce meaningful diversity.
- **You choose**: A side-by-side comparison UI lets you pick which response is better (Response A or Response B). The pair (chosen + rejected) is saved as a DPO training example.
- **Why it matters**: Pairwise comparisons are statistically more reliable than absolute ratings. DPO also avoids the complexity of training a separate reward model (as used in traditional RLHF with PPO), making it practical for individual developers and small teams.

### Storage Format

All feedback is stored as **JSONL** (one JSON object per line) under the project's `.rlhf/` directory. **KTO and DPO data live in separate top-level directories** with independent structures, mirroring the formats expected by their respective training frameworks:

```
<project>/.rlhf/
  kto/                          ← Thumbs-up/down (KTO) data
    good/
      <provider>_<model>/data.jsonl    ← KTO desirable examples
    bad/
      <provider>_<model>/data.jsonl    ← KTO undesirable examples
  dpo/                          ← Pairwise preference (DPO) data
    <provider>_<model>/data.jsonl      ← DPO chosen/rejected pairs
```

Each model configuration gets its own subdirectory (e.g., `ollama_qwen3_8b`), making it easy to train on data from specific models. The JSONL schemas follow the standard formats expected by KTO and DPO training scripts:

**KTO entry:**
```json
{
  "prompt": "What is Rust?",
  "completion": "Rust is a systems language.",
  "label": true,
  "model_provider": "ollama",
  "model_name": "qwen3.5:0.8b-mlx",
  "model_configurations": { "temperature": 0.7, "max_tokens": 2048, "system_prompt": "" },
  "timestamp": "2026-06-26T12:00:00.000Z"
}
```

**DPO entry:**
```json
{
  "prompt": "What is Rust?",
  "chosen": "Rust is a systems language focused on safety.",
  "rejected": "Rust is a programming language.",
  "model_provider": "ollama",
  "model_name": "qwen3.5:0.8b-mlx",
  "model_configurations": { "temperature": 0.7, "max_tokens": 2048, "system_prompt": "" },
  "timestamp": "2026-06-26T12:00:00.000Z"
}
```

### Why This Matters for nolock

1. **Privacy-first, always**: All feedback data stays on your machine — in your project's `.rlhf/` directory. There is no telemetry, no cloud upload, and no third-party access. You own your preference data completely.

2. **No extra workflow burden**: Thumbs-up/down buttons appear naturally on every AI response. DPO prompts happen at configurable intervals. Feedback collection is woven into the chat experience, not a separate chore.

3. **Portable and framework-ready**: The JSONL format matches the [DPO](https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer#expected-dataset-type-and-format) and [KTO](https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer#expected-dataset-type-and-format) dataset schemas used by Hugging Face TRL (v1.8.0). Export your `.rlhf/` directory to TRL, Axolotl, or LLaMA Factory — no conversion needed.

4. **Model-configuration aware**: Because data is partitioned by provider + model (e.g., `ollama_qwen3_8b` vs `openrouter_gpt-4o`), you can train separate adapters for different models or analyze which backends produce the most preferred responses. KTO and DPO data are stored independently, so you can use each method on its own or combine them sequentially.

5. **Aligned with nolock's philosophy**: nolock is designed to keep you in the driver's seat. RLHF isn't about automating away your judgement — it's about amplifying it. The AI learns from *your* preferences, not from generic alignment data collected by a corporation.

### Getting Started

Press **`Ctrl+A, R`** to open the RLHF settings panel. There you can:

- Toggle feedback collection on/off
- Configure the root directory and category subdirectories
- Enable DPO pairwise mode and set the prompt interval
- Review the expected file structure for your settings

Every AI chat response will then show thumbs-up and thumbs-down buttons. If DPO is enabled, the system will automatically generate two responses at the configured interval for you to compare.

### Training with Your Data

The collected JSONL data is ready for fine-tuning with [Hugging Face TRL](https://huggingface.co/docs/trl/v1.8.0) (`trl==1.8.0`). See **[.rlhf/README.md](.rlhf/README.md)** for complete DPO and KTO training guides with example scripts.

---

## Hooks — Automated Agent Runs

### What Are Hooks?

Hooks are project-local YAML files in `.hooks/` that automatically invoke an AI agent run when a **trigger** fires. They let you automate repetitive agentic workflows without leaving the editor — for example, reviewing your code right after `git commit`, generating a daily standup summary, or running a custom routine whenever you type a particular command.

Hooks come in three trigger flavors:

| Trigger | When it fires |
|---|---|
| **Command** | After a CLI command whose leading words match a pattern — whether **you** run it in the terminal or the **AI agent** runs it via its `bash_sandbox` tool. |
| **Cron** | On a repeating schedule (5-field cron expression) while nolock is open. |
| **Manual** | When you type `!hook-name` in the chat panel, or press **Run now** in the Hooks panel. |

### Creating a Hook

Open the Hooks panel with **`Ctrl+A, H`** (AI Integrations → Hooks) and click **New Hook**. Give it a name, choose a trigger, optionally attach an agent/prompt/skills/tools, and save. The backend writes a `.hooks/<name>.yaml` file into your project.

```yaml
name: commit-review
description: Review what you are about to commit.
trigger:
  type: command        # command | cron
  command: git commit
  # type: cron
  # schedule: "0 9 * * 1-5"
agent:
  name: code-reviewer  # optional: reuse an existing agent's system prompt
  prompt: |            # optional: inline system prompt (takes precedence)
    You are a git-review hook...
  skills: [code-review]
  tools: [read_file, grep]
```

Field reference:

| Field | Description |
|---|---|
| `name` | Hook identifier (letters, numbers, `-`, `_`, `.`). Becomes the file name. |
| `description` | Optional human-readable description. |
| `trigger.type` | `command` or `cron`. |
| `trigger.command` | (command) Word-prefix pattern — `git commit` matches `git commit -m "x"`, not `git committed`. |
| `trigger.schedule` | (cron) 5-field cron: `minute hour day-of-month month day-of-week`. |
| `agent.name` | Optional existing agent from `.agents/` whose system prompt is reused. |
| `agent.prompt` | Optional inline system prompt; takes precedence over `agent.name`. |
| `agent.skills` | Skill names from `.skills/` to inject into the run context. |
| `agent.tools` | Explicit tool ids to enable. Empty = use your currently enabled tools. |

### How Hook Runs Work

- Runs execute through the **`ai_chat`** command using your configured chat model and backend. They are **non-streamed** — while a hook runs you'll see a live "hook run card" (spinner) in the chat panel, and the chat input is temporarily disabled.
- Hook runs and chat generations are **serialized**: a hook waits in the queue while a chat response is in flight, and chat is paused while a hook runs. This avoids collisions on the shared stream event.
- A finished run's output is appended to the chat thread as a **"Hook result"** message (showing the hook name, trigger reason, and the agent's output rendered as markdown). Failed runs appear as a **"Hook failed"** error block. These messages stay in the conversation and are sent back to the model as system context on later messages, so you can ask follow-up questions about what a hook produced.
- **Cron** hooks are checked every ~10 seconds while the app is open and fire **at most once per matching minute**. They do not run when nolock is closed.

### Tips

- Command triggers match **whole leading words**, so scope them deliberately: `git push` matches `git push origin main`, while a hook for `git` alone would fire on every git command.
- Use `!hook-name` in the chat panel to trigger any hook manually without opening the Hooks panel.

---

## Acknowledgements

nolock would not exist without the following open-source projects and communities:

- **[Hugging Face TRL](https://huggingface.co/docs/trl)** — The Transformer Reinforcement Learning library that provides state-of-the-art implementations of alignment methods (DPO, KTO, PPO, and more). nolock's RLHF dataset formats are designed to be directly compatible with TRL's [DPOTrainer](https://huggingface.co/docs/trl/v1.8.0/en/dpo_trainer) and [KTOTrainer](https://huggingface.co/docs/trl/v1.8.0/en/kto_trainer).
- **[OpenCode Zen](https://opencode.ai)** — For providing an AI inference service with a generous free tier that made autonomous development workflows possible without any API costs. This project was built primarily using the **Big Pickle** model (`opencode/big-pickle`).

  > **Cost Tracker:** This project has incurred **$0.00 USD** in AI API costs to date. All development was powered entirely by OpenCode Zen's free Big Pickle model.
- **[OpenRouter](https://openrouter.ai)** — For building a unified API that makes dozens of AI models accessible from a single endpoint.
- **[Ollama](https://ollama.com)** — For making local LLM deployment as simple as a single command, enabling private and offline AI-powered development.
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — For the incredible engineering achievement of running state-of-the-art LLMs efficiently on consumer hardware.
- **[DuckDuckGo](https://duckduckgo.com)** — For providing a free, no-API-key Instant Answer API that powers the `web_search` tool in Agent Chat. Results from DuckDuckGo.
- **[Brave Search](https://brave.com/search)** — For providing a privacy-focused web search API with real web search results, enabling the optional `web_search` tool backend for more comprehensive coverage.

And to all the open-source projects listed above — Monaco Editor, React, Tauri, xterm.js, and every other library that makes this possible. Thank you.

---

## Installation

### Prerequisites

Before installing nolock, ensure you have the following:

- **Node.js 18+** — [Download](https://nodejs.org/)
- **Rust toolchain** — [Install Rust](https://rustup.rs/)
- **Tauri system dependencies** — See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Build from Source

```bash
# Clone the repository
git clone https://github.com/your-username/nolock.git
cd nolock

# Install JavaScript dependencies
npm install

# Build and bundle the application
npm run tauri build
```

### Size Comparison

| Application | Package Type | Size | vs. nolock |
|---|---|---|---|
| **nolock** | `.deb` | **8.3 MB** | — |
| **VS Code** | `.deb` | ~100 MB | ~12× larger |
| **OpenCode Desktop** | `.deb` | ~107 MB | ~13× larger |
| **OpenCode CLI** | `.tar.gz` | ~49 MB | ~6× larger |

nolock is **significantly smaller** than comparable development tools. The `.deb` package is only **8.3 MB** — roughly the size of a single high-resolution photo — while the uncompressed binary is **21 MB**. This tiny footprint is achieved through a lean technology stack (Tauri + Rust + webview) that avoids bundling an entire browser runtime, unlike Electron-based editors.

### Ubuntu (Debian-based Linux)

After building, install the `.deb` package:

```bash
# Install the deb package
sudo dpkg -i src-tauri/target/release/bundle/deb/nolock_0.1.0_amd64.deb

# If there are missing dependencies, fix them:
sudo apt-get install -f
```

Or run the binary directly without installing:

```bash
./src-tauri/target/release/nolock
```

The application will be available in your app launcher as **nolock** after installation.

**Note:** On Linux, the native browser panel uses a GTK overlay widget for precise positioning. This works on all major Linux desktop environments (GNOME, KDE, XFCE, etc.).

### macOS

After building on a Mac, you have two options:

**Option A — Drag-and-drop DMG:**
```bash
# Open the DMG installer
open src-tauri/target/release/bundle/dmg/nolock_0.1.0_x64.dmg
# Then drag nolock into the Applications folder
```

**Option B — Direct .app bundle:**
```bash
# Copy the app bundle to Applications
cp -R src-tauri/target/release/bundle/macos/nolock.app /Applications/
```

Then open nolock from your Applications folder or Spotlight.

> **Note:** macOS builds require a Mac with Xcode installed. If you're on Linux but want a macOS build, you can use GitHub Actions with a macOS runner (see the CI workflow).

### Setting Up AI Backends

After installation, configure your preferred AI backend:

1. Open nolock and press **`Ctrl+A, I`** (or go to AI Integrations → Settings).
2. Select your backend:
   - **Ollama** — Default, runs locally at `http://localhost:11434`
   - **llama.cpp** — Runs locally at `http://localhost:8080`
   - **OpenRouter** — Requires an API key from [openrouter.ai](https://openrouter.ai)
   - **OpenCode Zen** — Remote at `https://opencode.ai/zen/v1`, some models available with a free tier
3. Enter your model names and save.

### Multi-Provider Model Configuration

nolock lets you run **multiple model providers side-by-side**, with a clear split
between the *planning* model and cheap *task-executor* models. Each provider is
configured independently (URL + API key), and each `@agent` can be sourced from a
**different provider/model** at chat time.

#### Planning vs Task Executor roles

| Role | Providers | Purpose |
|---|---|---|
| **Planning** (online) | OpenRouter, OpenCode Zen, DigitalOcean Inference Router | The main orchestrator model — plans, delegates to sub-agents, and synthesizes answers. Use a strong hosted model here. |
| **Task Executor** (local) | Ollama, llama.cpp | Small, cheap models that run focused sub-agent tasks and report back with a concise answer. Saves tokens on long agentic runs. |

- **Model Providers** panel (`Ctrl+A, P`) shows every provider with its role badge.
- **Chat Model** panel (`Ctrl+A, M`) labels the chat model as the *Planning provider*.

> **Recommended setup:** pick an online provider (OpenRouter / DigitalOcean) as the
> planning provider for the main chat model, and configure your `.agents/` files to run
> on local executor models (Ollama / llama.cpp). The planning model delegates focused
> tasks to these local sub-agents, so you only pay (in tokens or GPU) for the sub-agent's
> final answer — not its whole tool-call trace.

#### Per-agent provider at `@` trigger

Each agent file (`.agents/<name>.md`) can set its own `backend` and `model` in the
frontmatter. When you invoke `@agent-name` in chat, nolock runs the request on **that
agent's** provider/model instead of the main chat model:

```yaml
---
name: code-reviewer
description: Reviews code for bugs and security issues
model: oamazonasgabriel/lfm2.5-8b-a1b:q4_k_m-8gbGPU
backend: ollama            # ← runs on the local executor
temperature: 0.3
tools: read_file, list_directory, grep
---
```

When multiple `@agent` refs are present, nolock keeps the orchestration on the
**planning** (main chat) model and tells the model to spawn **each** referenced
agent via `spawn_subagent` — all spawns in a single response so they run in
**parallel**. Each spawned sub-agent uses the **agent's own** configured
`backend`/`model`/`tools` (so an agent can come from a different provider than
the planning model). The message also carries the agent prompts as context so
the orchestrator knows each agent's specialty.

> **Example parallel invocation** — two agents in one message run concurrently:
>
> ```text
> How do I write a recursive fib in Rust? @researcher search the web for
> example implementations while @code-reviewer evaluates the quality of the
> code in parallel.
> ```
>
> nolock resolves both `@` mentions, keeps the orchestrator on the planning
> model, and instructs it to emit `spawn_subagent` for `researcher` and
> `code-reviewer` in the same turn. Each sub-agent runs on its own provider,
> and both results are synthesized into one final answer.

#### How sub-agents pass context back to the main model

This is the heart of the token-saving design:

1. The **planning model** (main chat) decides a focused task matches a sub-agent's
   specialty and calls the `spawn_subagent` tool with `{ agent, task }`. When
   several agents are warranted, it emits all `spawn_subagent` calls in one turn
   so they run in parallel.
2. The sub-agent runs on **its own** configured provider/model with a **fresh, isolated
   tool loop** — it sees only the task + its own system prompt, *not* the whole main
   conversation. This is the token saving.
3. The sub-agent returns a **single final answer** (structured-output JSON from
   some models is unwrapped to the `final_answer` field). That answer is injected
   back into the main model's tool loop as the result of the `spawn_subagent` tool call.
4. The main model incorporates that answer into its own context and continues planning /
   synthesizing. The full sub-agent trace (tool calls + result) is returned to the
   frontend for an expandable inspection window in the conversation.

**Net effect:** the main model only ever pays for each sub-agent's *final answer*, not
its entire tool-call trace — a large saving on long agentic runs. Each provider's API
key is stored independently (OS keychain), so a sub-agent can route to a different
provider than the main model without leaking credentials.

#### Switchyard Router — runtime model routing

The **Switchyard Router** (open via *AI Integrations → Switchyard Router...* or
`Ctrl+A, Y`) lets you route requests across models/providers at runtime using NVIDIA
NeMo Switchyard's embedded "general routers". Unlike the static per-agent
`backend`/`model` frontmatter, routing is decided **per request** by the router
algorithm. nolock keeps its own transport (so the nemotron thinking/tool pipeline is
untouched); Switchyard only *picks the target*.

Policy is stored per-project in **`.routers/switchyard.json`** (versioned project
config, like `.agents/`). Targets reference `(backend, model)` only — credentials keep
coming from your provider URLs / OS keychain, so no secrets live in the file.

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

Supported algorithms ("general routers"):

| Algorithm | Behavior |
|---|---|
| `passthrough` | Always call one configured target. |
| `random` | Pick among N targets. With `costPer1k` set and no explicit `weights`, targets are weighted by inverse cost so cheaper models are picked more often (cost-aware). |
| `llm-classifier` | A judge model classifies each task and routes between an `efficient` and a `capable` target. The judge is served with the classifier's JSON schema enforced, so it returns a complete verdict. |

**Cost-aware routing.** Each target can carry a `costPer1k` (USD per 1K input tokens).
Two places it matters:
- `llm-classifier`: when the judge picks a tier, the **cheapest** target in that tier
  is selected — e.g. a `capable` tier holding both Super and Ultra prefers Super.
- `random`: with no explicit `weights`, targets are weighted by inverse cost, so the
  cheaper models are called more often.

Routing is **fail-safe**: if the config is missing, disabled, malformed, or the router
errors, nolock falls through to your normal provider resolution — a routing bug can
never block a chat. The repo ships a default `nemotron-capability` route: a
`llm-classifier` (judge = Nemotron 3.5 Lightning) that routes simple tasks to
Lightning (efficient) and harder tasks to the cheapest capable model (Super), with
Ultra as the costlier capable fallback.

##### E2E: routing against OpenRouter

The e2e harness validates the Switchyard route against a real OpenRouter key. The key
**must** be stored in the OS keychain — the same storage the UI writes to — and the
tests **fail completely** (no silent skip) if it's missing:

```bash
# 1. Store the key via the UI: Model Providers panel → OpenRouter → API key.
#    This writes to the OS keychain (service com.nolock.app, account apiKey.openrouter).
# 2. Run the validation:
./e2e/run.sh switchyard-e2e
```

This runs three tests against real OpenRouter:
- `switchyard_routes_chat_to_nemotron_family_on_openrouter` — the repo's `random`
  route picks a Nemotron-family model; a "Hi" greeting concludes without a tool spree.
- `switchyard_passthrough_routes_to_exact_model` — a `passthrough` route selects
  exactly the configured target.
- `switchyard_subagent_route_redirects_sub_agent` — a `subagent`-purpose route
  redirects sub-agent requests to the configured target.

The headless CLI can also read keys from the keychain with `--keychain` (keys
`apiKey.<backend>`), mirroring the GUI's `Model Providers` panel.

### Recommended Ollama Models

For the best experience with nolock, here are the recommended Ollama models for each AI feature:

| Feature | Recommended Model | Size | Notes |
|---|---|---|---|
| **Code Completions (FITM)** | `qwen2.5-coder:0.5b` | 0.5B params | Fast, lightweight fill-in-the-middle completions. Runs on CPU or low-end GPU. |
| **Agent Chat (Tool Calling)** | `qwen3.5:0.8b-mlx` | 0.8B params | Reliable tool-calling with strong reasoning. Good for web search, file read, directory listing, and multi-step agent tasks. |

**Installation:**

```bash
ollama pull qwen2.5-coder:0.5b
ollama pull qwen3.5:0.8b-mlx
```

Then in nolock's AI Settings (`Ctrl+A, I`):
- Set **Completion Model** to `qwen2.5-coder:0.5b`
- Set **Chat Model** to `qwen3.5:0.8b-mlx`

> **Note:** For agent chat with tool calling, the model must support the `tools` parameter in Ollama's `/api/chat` endpoint. The `qwen3.5:0.8b-mlx` model provides a good balance of capability and resource usage. Larger models will provide better results at the cost of higher resource usage.

### Micro-Agent Model Strategy

nolock's **micro-agents** are the bottom tier of the hierarchical agent cascade:
small, focused agents that do *mechanical* work (fixing a compiler error, writing a
test, fixing a lint issue) and then **prove** they finished by running a deterministic
validation (e.g. `cargo check`, `tsc --noEmit`, `ruff`, `go build`). They are defined
in the `.micro-agents/` folder and are spawned by sub-agents that have
`can_spawn_micro_agents: true`.

Because micro-agents are the highest-volume tier, they should run on the **smallest
model that can still call tools reliably** — this is where the token/GPU savings are
largest (mechanical work shifted off the 9B main model onto a sub-1B coder).

#### Recommended micro-agent model

| Micro-agent | Model | Why |
|---|---|---|
| `rust-fixer`, `ts-type-fixer`, `lint-fixer`, `python-fixer`, `go-fixer`, `test-writer`, `context-summarizer` | `gemma4:e2b` | Small, fast, reliable tool-calling; good enough for focused mechanical fixes + running the validation command. |

The default templates in `.micro-agents/*.md` are pre-configured to this model:

```yaml
---
name: rust-fixer
model: gemma4:e2b
backend: ollama
temperature: 0.1
tools: [read_file, edit, write_file, bash_sandbox]
validation:
  rust_check: true
  max_retries: 3
---
```

#### How the tiers split the work

| Tier | Model | Role |
|---|---|---|
| **Main agent** | `oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU` | Planning, orchestration, high-level reasoning |
| **Sub-agent** | `oamazonasgabriel/lfm2.5-8b-a1b:q4_k_m-8gbGPU` | Domain tasks, intent classification / routing |
| **Micro-agent** | `gemma4:e2b` | Mechanical fixes + deterministic validation |

#### Deterministic validation is the contract

A micro-agent is only considered "done" when its configured validation passes
(`cargo check`, `tsc`, `ruff`, etc.). If validation fails, the micro-agent retries
(up to `max_retries`). This is what makes the small-model tier *reliable*: even a
1B model can be trusted to conclude correctly because the result is verified by a
real build/lint/test command, not by the model's own claim.

> **Tip:** If you have a larger coder model available (e.g. `qwen2.5-coder:7b`), you
> can point individual micro-agents at it for harder tasks by editing the `model:` line
> in the relevant `.micro-agents/<name>.md` file. The validation contract is unchanged.

### Keyboard Shortcuts

#### Editor Settings (Ctrl+E chord)

| Shortcut | Action |
|---|---|
| `Ctrl+E, O` | Toggle file explorer |
| `Ctrl+E, S` | Open editor settings (linter configuration) |

#### File & Search (Ctrl+F chord)

| Shortcut | Action |
|---|---|
| `Ctrl+F, S` | Toggle file search |
| `Ctrl+F, O` | Open folder |
| `Ctrl+F, E` | Toggle file explorer |
| `Ctrl+F, R` | Refresh explorer |

Within the search panel (`Ctrl+F, S`):

| Key | Action |
|---|---|
| `Escape` | Close search panel |
| `Enter` | Trigger search immediately (bypasses debounce) |
| Click result line | Open file at that line |

#### Terminal (Ctrl+T chord)

| Shortcut | Action |
|---|---|
| `Ctrl+T, O` | New terminal |
| `Ctrl+T, M` | Open terminal memory overlay |

#### AI (Ctrl+A chord)

| Shortcut | Action |
|---|---|
| `Ctrl+A, O` | Toggle agent chat panel |
| `Ctrl+A, P` | Model providers |
| `Ctrl+A, M` | Chat model settings |
| `Ctrl+A, F` | FITM model settings |
| `Ctrl+A, T` | Agent tools |
| `Ctrl+A, G` | Manage AI agents |
| `Ctrl+A, K` | Manage skills |
| `Ctrl+A, R` | Human feedback (RLHF) |
| `Ctrl+A, H` | Manage hooks |
| `Ctrl+A, I` | Open AI settings |

#### Browser (Ctrl+B chord)

| Shortcut | Action |
|---|---|
| `Ctrl+B, O` | Toggle browser panel |

#### Direct Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open folder |
| `Ctrl+R` | Refresh explorer |
| `Ctrl+S / Cmd+S` | Save current file |
| `Escape` | Close overlays / panels |

---

<p align="center">
  <sub>Built with ❤️ for local-first, privacy-respecting development.</sub>
</p>
