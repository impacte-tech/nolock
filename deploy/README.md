# nolock — Railway web deployment

Everything required to deploy nolock to Railway as a **web app** lives in this
folder. The deployed app is the **same codebase** as the Tauri v2 desktop app:

- **Frontend** — the same React source (`src/`), built once with
  `VITE_TARGET=web` so the Tauri IPC/event/dialog modules are swapped for the
  browser shims in `src/web/` (HTTP `fetch` + Server-Sent Events instead of
  Tauri IPC). No frontend code is duplicated or forked.
- **Backend** — the same Rust crate (`src-tauri/`). `nolock-server`
  (`src-tauri/src/bin/nolock-server.rs`) includes `../main.rs` verbatim (the
  same pattern the headless CLI uses) and exposes the exact same command
  surface over `POST /api/invoke/<command>` + `GET /api/events` (SSE).

## Folder contents

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage image: Vite web build → Rust `nolock-server` build → slim runtime |
| `Dockerfile.dockerignore` | BuildKit per-Dockerfile ignore (keeps the build context small) |
| `env.example` | Every environment variable the server understands |
| `README.md` | This file |

> **Why is `railway.json` at the repo root?** Railway only reads
> `railway.json` / `railway.toml` from the service root directory, and the
> Docker build context must be the repo root (the Dockerfile builds
> `src/` + `src-tauri/`). The root file is a thin pointer:
> `{ "build": { "builder": "DOCKERFILE", "dockerfilePath": "deploy/Dockerfile" } }`.
> All actual configuration lives here in `deploy/`.

## Deploy to Railway

1. Push this repository to GitHub (if it isn't already).
2. In Railway: **New Project → Deploy from GitHub repo** → pick `nolock`.
   Railway detects `railway.json` and builds `deploy/Dockerfile`.
3. Set the public domain: **Settings → Networking → Generate Domain** (or add a
   custom domain). Railway routes HTTPS traffic to the container's `$PORT`.
4. (Recommended) Add a **volume** mounted at `/data` and set the variable
   `NOLOCK_DATA_DIR=/data/nolock` so secrets, RLHF logs and any opened
   project folders survive redeploys.
5. (Recommended for public URLs) Set `NOLOCK_WEB_TOKEN=<random secret>` and
   open the app as `https://<domain>/?token=<that secret>` — the frontend
   shims pick the token up from the URL and use it for every API call.

First build takes a while (full Rust release build of the tauri crate stack);
subsequent builds reuse Docker layers (dependency cache) and are much faster.

## Using the web app

- **Open a project**: the folder dialog falls back to a prompt for a
  **server-side** path. With a volume mounted at `/data`, clone or copy a
  project there (e.g. via the built-in terminal: `git clone … /data/myproject`)
  and open `/data/myproject`.
- **Chat / agents / sessions / git diffs / search / linter / hooks / tools /
  skills / switchyard** — fully functional, identical to desktop.
- **Terminal** — real PTY in the container (bash).
- **Notebooks** — work if `python3` + `ipykernel` are available; create envs
  from the Notebook panel (they land in the project's `.venvs/`).
- **Secrets** — stored in a 0600 file under `NOLOCK_DATA_DIR` instead of the
  OS keychain (no keyring service in a container). The frontend's localStorage
  dual-write still works exactly as on desktop.
- **Browser panel** — desktop-only (native webview); it reports a friendly
  error on the web. The web app already runs in a browser.

## Local dry run

```bash
npm run build:web                                   # frontend → dist/
cargo build --release --bin nolock-server           # backend (in src-tauri/)
NOLOCK_WEB_DIST=../dist ./target/release/nolock-server
# → http://127.0.0.1:8080  (health: /health, API: /api/invoke/*, events: /api/events)
```

Hot-reload development: `cargo run --bin nolock-server` in one shell and
`npm run dev:web` in another (Vite proxies `/api` to `127.0.0.1:8080`).
