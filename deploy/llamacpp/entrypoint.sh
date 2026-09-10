#!/bin/bash
# llama.cpp server entrypoint for Railway.
#
# llama-server reads LLAMA_ARG_* env vars directly (LLAMA_ARG_HF_REPO,
# LLAMA_ARG_HF_FILE, LLAMA_ARG_CTX_SIZE, LLAMA_ARG_N_PARALLEL, ...). The only
# things we must bridge:
#   1. Port — Railway injects a random $PORT; llama-server defaults to 8080.
#   2. Model download — the GGUF is downloaded from HuggingFace ONCE into the
#      persistent volume (NOLOCK_MODEL_DIR, default /data/models) so redeploys
#      and restarts load it from disk instantly instead of re-downloading
#      (a 1.7GB download exceeds Railway's healthcheck window).
set -e

# --- 1. Port bridging --------------------------------------------------------
if [ -z "${LLAMA_ARG_PORT:-}" ] && [ -n "${PORT:-}" ]; then
  export LLAMA_ARG_PORT="$PORT"
fi

# --- 2. Model download (once, into the volume) ------------------------------
MODEL_DIR="${NOLOCK_MODEL_DIR:-/data/models}"
mkdir -p "$MODEL_DIR"

if [ -n "${LLAMA_ARG_HF_REPO:-}" ]; then
  # Determine the GGUF filename: explicit LLAMA_ARG_HF_FILE, else the repo's
  # default (llama.cpp picks a quant). We need a concrete filename to check
  # whether it's already downloaded.
  HF_FILE="${LLAMA_ARG_HF_FILE:-}"

  if [ -n "$HF_FILE" ]; then
    MODEL_PATH="$MODEL_DIR/$HF_FILE"
    if [ ! -f "$MODEL_PATH" ]; then
      echo "[llamacpp] downloading $LLAMA_ARG_HF_REPO/$HF_FILE → $MODEL_PATH (one-time)"
      # Use llama.cpp's own downloader (handles HF auth + resume) if present,
      # else plain curl.
      if command -v llama-gguf-split >/dev/null 2>&1; then
        :
      fi
      if command -v huggingface-cli >/dev/null 2>&1; then
        huggingface-cli download "$LLAMA_ARG_HF_REPO" "$HF_FILE" --local-dir "$MODEL_DIR" --local-dir-use-symlinks False
      else
        curl -L --fail --retry 3 -o "$MODEL_PATH" \
          "https://huggingface.co/$LLAMA_ARG_HF_REPO/resolve/main/$HF_FILE"
      fi
      echo "[llamacpp] download complete"
    else
      echo "[llamacpp] model already present at $MODEL_PATH (skipping download)"
    fi
    export LLAMA_ARG_MODEL="$MODEL_PATH"
    # Clear HF args so llama-server doesn't try to re-download.
    unset LLAMA_ARG_HF_REPO LLAMA_ARG_HF_FILE
  else
    echo "[llamacpp] no LLAMA_ARG_HF_FILE set — letting llama-server resolve the quant from HF"
  fi
fi

echo "[llamacpp] starting llama-server (model=${LLAMA_ARG_MODEL:-<auto>} port=${LLAMA_ARG_PORT:-8080})"

exec /app/llama-server "$@"