#!/bin/bash
# Run the private model store beside llama.cpp on the same mounted volume.
set -euo pipefail
export NOLOCK_MODEL_DIR="${NOLOCK_MODEL_DIR:-/models}"
export LLAMA_CACHE="${LLAMA_CACHE:-$NOLOCK_MODEL_DIR}"
export NOLOCK_MODEL_STORE_HOST="${NOLOCK_MODEL_STORE_HOST:-0.0.0.0}"
export LLAMA_ARG_PORT="${LLAMA_ARG_PORT:-${PORT:-8080}}"
export LLAMA_ARG_HOST="${LLAMA_ARG_HOST:-0.0.0.0}"
export LLAMA_ARG_THREADS="${LLAMA_ARG_THREADS:-4}"
export LLAMA_ARG_CTX_SIZE="${LLAMA_ARG_CTX_SIZE:-4096}"
# Preserve the live Railway MODEL_HF convention and existing cached model.
if [ -n "${MODEL_HF:-}" ] && [ -z "${LLAMA_ARG_HF_REPO:-}" ] && [ -z "${LLAMA_ARG_MODEL:-}" ]; then
  export LLAMA_ARG_HF_REPO="$MODEL_HF"
fi
mkdir -p "$NOLOCK_MODEL_DIR"
if [ -z "${NOLOCK_MODEL_PULL_TOKEN:-}" ]; then
  echo "NOLOCK_MODEL_PULL_TOKEN must be configured for the private model store." >&2
  exit 1
fi
python3 /app/model_store.py &
store_pid=$!
/app/llama-server "$@" &
llama_pid=$!
cleanup() {
  kill -TERM "$llama_pid" "$store_pid" 2>/dev/null || true
  wait "$llama_pid" "$store_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
# If either service dies, restart the container instead of leaving half alive.
set +e
wait -n "$store_pid" "$llama_pid"
status=$?
if [ "$status" -eq 0 ]; then status=1; fi
exit "$status"
