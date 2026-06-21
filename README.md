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

**nolock** is a desktop IDE that puts you in full control. It combines a full-featured code editor (powered by Monaco), a real terminal emulator, an AI agent chat panel, and a native web browser — all running locally with no telemetry, no accounts, and no lock-in.

Connect it to your preferred AI backend (Ollama, llama.cpp, OpenRouter, or OpenCode Zen) for inline code completions and agentic chat with tool-calling capabilities.

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
| **portable-pty** | A cross-platform PTY (pseudo-terminal) library for Rust that works on Linux, macOS, and Windows. | Spawns and manages real interactive shell sessions (bash, zsh, etc.) with proper terminal dimensions, resizing, and signal handling. |
| **wry** | A cross-platform webview rendering library used by Tauri. | On Linux, creates a native GTK-based webview overlay for the in-app browser panel (supporting sites that block iframes). |
| **GTK3 (gtk-rs)** | Rust bindings for the GTK 3 toolkit. | On Linux, manages a GtkOverlay + GtkFixed widget setup to position the native browser webview precisely within the application layout. |

### AI Backends

| Technology | What it is | How nolock uses it |
|---|---|---|
| **Ollama** | A local server for running large language models on your own machine with a simple REST API. | Supports both inline code completions (via `/api/generate` with Fill-In-The-Middle) and multi-turn chat (via `/api/chat`) with tool calling. |
| **llama.cpp** | A C/C++ implementation of LLM inference optimized for consumer hardware. | Supports code completions via its `/completion` endpoint with Fill-In-The-Middle support. |
| **OpenRouter** | A unified API gateway that provides access to dozens of AI models from multiple providers. | Supports chat completions and tool calling through the OpenAI-compatible `/chat/completions` endpoint. |
| **OpenCode Zen** | An open-source AI coding backend. | Supports code completions and chat via its `/api/generate` endpoint. |

---

## Features

- **Code Editor** — Full-featured Monaco editor with syntax highlighting for 100+ languages, bracket colorization, minimap, and word wrap.
- **AI Inline Completions** — Fill-In-The-Middle (FITM) code suggestions from your local AI backend, debounced and triggered on typing pauses.
- **Agent Chat** — Multi-turn conversational AI chat with file referencing (`@` mentions), tool calling (web fetch, file read, directory listing), and context token tracking.
- **Integrated Terminal** — Real PTY-based shell sessions with multiple tabs, resize support, and command history tracking.
- **Terminal Memory** — Automatically records commands, tracks frequency, and lets you organize commands into categories for quick recall.
- **File Explorer** — Tree-based file browser with directory expansion, refresh, and file-type color coding.
- **Native Browser Panel** — Embedded web browser using a native OS webview (not an iframe) — browse any site without leaving the app.
- **Resizable Panels** — All panels (explorer, editor, terminal, browser, chat) are fully resizable with drag handles.
- **Multi-Backend AI** — Switch between Ollama, llama.cpp, OpenRouter, and OpenCode Zen for completions and chat.
- **Privacy-First** — No telemetry, no accounts, no cloud dependency. Everything runs on your machine.

---

## Acknowledgements

nolock would not exist without the following open-source projects and communities:

- **[OpenCode Zen](https://opencode.ai)** — For providing an open AI coding backend and inspiring the vision of local-first AI development tools. This project was built primarily using the **Big Pickle** model (`opencode/big-pickle`) — a generous, free-tier AI provider that made autonomous development workflows possible without any API costs.

  > **Cost Tracker:** This project has incurred **$0.00 USD** in AI API costs to date. All development was powered entirely by OpenCode Zen's free Big Pickle model.
- **[OpenRouter](https://openrouter.ai)** — For building a unified API that makes dozens of AI models accessible from a single endpoint.
- **[Ollama](https://ollama.com)** — For making local LLM deployment as simple as a single command, enabling private and offline AI-powered development.
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — For the incredible engineering achievement of running state-of-the-art LLMs efficiently on consumer hardware.

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
   - **OpenCode Zen** — Runs locally at `http://localhost:11435`
3. Enter your model names and save.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open folder |
| `Ctrl+E` | Toggle file explorer |
| `Ctrl+T, T` | New terminal |
| `Ctrl+T, M` | Open terminal memory |
| `Ctrl+A, C` | Toggle agent chat |
| `Ctrl+A, I` | Open AI settings |
| `Ctrl+Shift+B` | Toggle browser panel |
| `Ctrl+Shift+I` | Direct AI settings |
| `Escape` | Close overlays |

---

<p align="center">
  <sub>Built with ❤️ for local-first, privacy-respecting development.</sub>
</p>
