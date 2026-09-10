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
>
> **Important — the service builder must point at this Dockerfile.** Railway's
> Railpack builder only auto-detects a `Dockerfile` at the repo **root**; it
> does not read `deploy/Dockerfile` on its own. Two things make the deploy work:
>
> 1. The service's **Build Settings** must have **Dockerfile path** set to
>    `deploy/Dockerfile` (this is a service-level setting, set once in the
>    Railway dashboard or via the API — it is NOT stored in the repo).
> 2. A **root `Dockerfile`** (a copy of `deploy/Dockerfile`) is committed as a
>    safety net: if the service setting is ever reset, Railpack auto-detects
>    the root file and the build still works.
>
> Keep `Dockerfile` (root) and `deploy/Dockerfile` in sync — they are the same
> multi-stage build.

## Deploy to Railway

1. Push this repository to GitHub (if it isn't already).
2. In Railway: **New Project → Deploy from GitHub repo** → pick `nolock`.
3. **Set the builder to the Dockerfile** (once): in the service's **Settings →
   Build**, set **Dockerfile path** to `deploy/Dockerfile`. (The committed root
   `Dockerfile` is a fallback if this is ever reset.)
4. Set the public domain: **Settings → Networking → Generate Domain** (or add a
   custom domain). Railway routes HTTPS traffic to the container's `$PORT`.
5. (Recommended) Add a **volume** mounted at `/data` and set the variable
   `NOLOCK_DATA_DIR=/data/nolock` so secrets, RLHF logs and any opened
   project folders survive redeploys.
6. (Recommended for public URLs) Set `NOLOCK_WEB_TOKEN=<random secret>`. The
   web app now shows a **login page** — paste the token there (or open
   `https://<domain>/?token=<secret>` to pre-fill it). The token is stored in
   the browser and sent as a `Bearer` header on every API call.

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
