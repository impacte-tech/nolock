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

Railway build settings are configured **per service**. There is no root
`railway.json`: that legacy file overrode the llama.cpp service's Dockerfile
with the web app's Dockerfile when both services used the same repository.
The web service uses repository root `/` and `deploy/Dockerfile`; llama.cpp uses
root `/deploy/llamacpp` and its own `Dockerfile`. Keep the root `Dockerfile` and
`deploy/Dockerfile` in sync as a web-build fallback.

## Deploy to Railway

1. Push this repository to GitHub (if it isn't already).
2. In Railway: **New Project → Deploy from GitHub repo** → pick `nolock`.
3. **Set the builder to the Dockerfile** (once): in the service's **Settings →
   Build**, set **Dockerfile path** to `deploy/Dockerfile`. (The committed root
   `Dockerfile` is a fallback if this is ever reset.)
4. Set the web service start command to `/app/nolock-server`, healthcheck path
   `/health`, and healthcheck timeout `120` seconds.
5. Set the public domain: **Settings → Networking → Generate Domain** (or add a
   custom domain). Railway routes HTTPS traffic to the container's `$PORT`.
6. Add a **volume** mounted at `/data` and set the variable
   `NOLOCK_DATA_DIR=/data/nolock` so secrets, RLHF logs and any opened
   project folders survive redeploys. Without the volume, all server-side
   state is lost on every redeploy.
7. (Recommended for public URLs) Set `NOLOCK_WEB_TOKEN=<random secret>`. The
   web app now shows a **login page** — paste the token there (or open
   `https://<domain>/?token=<secret>` to sign in automatically; the token is
   then remembered for that browser tab). The token is stored in the browser
   and sent as a `Bearer` header on every API call.

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

### Choose a listening interface

Set `NOLOCK_WEB_BIND` to the host IP address the server should listen on. It
accepts an IPv4 or IPv6 address (not a hostname or a port). The default is
`0.0.0.0`, preserving container deployments that need all IPv4 interfaces.
`PORT` sets the port independently and defaults to `8080`.

- Local access only: `NOLOCK_WEB_BIND=127.0.0.1`
- ZeroTier or another private network: use this host's IP on that network.
- IPv6 loopback: `NOLOCK_WEB_BIND=::1`

The example below uses the documentation-only address `192.0.2.10`.
Replace it with this host's actual ZeroTier address:

```bash
NOLOCK_WEB_BIND=192.0.2.10 PORT=8088 NOLOCK_WEB_DIST=../dist \
  ./target/release/nolock-server
```

Run this from `src-tauri/` after building. Set `NOLOCK_WEB_TOKEN` in the
server environment before starting it to require a login token. Binding to a
private interface does not replace authentication. The selected address must
already belong to the host; restart the server after changing the setting.
Other devices on the same network can open `http://192.0.2.10:8088` (substitute
your host's address). For IPv6 URLs, enclose the address in square brackets.

### Build and run

```bash
npm run build:web                                   # frontend → dist/
cargo build --release --bin nolock-server           # backend (in src-tauri/)
NOLOCK_WEB_DIST=../dist ./target/release/nolock-server
# → http://127.0.0.1:8080  (health: /health, API: /api/invoke/*, events: /api/events)
```

Hot-reload development: `cargo run --bin nolock-server` in one shell and
`npm run dev:web` in another (Vite proxies `/api` to `127.0.0.1:8080`).

## Model pulls from the UI

See [llama.cpp model-store deployment](llamacpp/README.md) to enable authenticated
GGUF pulls directly onto the inference service’s volume. Ollama uses its native
pull API; mount `OLLAMA_MODELS` on the Ollama service’s own persistent volume.
