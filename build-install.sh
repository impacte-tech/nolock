#!/usr/bin/env bash
# Build nolock via the Tauri CLI (embeds the frontend!), install it to
# ~/.local/bin and relaunch.
#
# IMPORTANT: always build through this script. A plain `cargo build
# --release` produces a DEV-MODE binary that loads http://localhost:1420
# instead of the embedded frontend — which shows a black window (or
# "Could not connect to localhost") when the Vite dev server is not running.
set -euo pipefail
cd "$(dirname "$0")"

npm run tauri build -- --bundles deb

# Stop the running instance first — copying over a running binary fails
# with "Text file busy". Wait until it is really gone before installing.
pkill -x nolock 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -x nolock >/dev/null 2>&1 || break
  sleep 0.5
done

cp src-tauri/target/release/nolock "$HOME/.local/bin/nolock"
setsid nohup "$HOME/.local/bin/nolock" > /tmp/nolock_app.log 2>&1 < /dev/null &
echo "nolock rebuilt, installed to ~/.local/bin and relaunched."
