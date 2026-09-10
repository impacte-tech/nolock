#!/bin/bash
# llama.cpp server entrypoint for Railway.
#
# llama-server reads LLAMA_ARG_* env vars directly (LLAMA_ARG_HF_REPO,
# LLAMA_ARG_HF_FILE, LLAMA_ARG_CTX_SIZE, LLAMA_ARG_N_PARALLEL, ...). The only
# thing we must bridge is the port: Railway injects a random $PORT, while
# llama-server defaults to 8080. Map $PORT -> LLAMA_ARG_PORT unless the user
# pinned one explicitly.
set -e

if [ -z "${LLAMA_ARG_PORT:-}" ] && [ -n "${PORT:-}" ]; then
  export LLAMA_ARG_PORT="$PORT"
fi

# llama.cpp can pull the model straight from HuggingFace via --hf-repo. If the
# user set HF_MODEL_REPO (friendlier alias), translate it to LLAMA_ARG_HF_REPO.
if [ -z "${LLAMA_ARG_HF_REPO:-}" ] && [ -n "${HF_MODEL_REPO:-}" ]; then
  export LLAMA_ARG_HF_REPO="$HF_MODEL_REPO"
fi
if [ -z "${LLAMA_ARG_HF_FILE:-}" ] && [ -n "${HF_MODEL_FILE:-}" ]; then
  export LLAMA_ARG_HF_FILE="$HF_MODEL_FILE"
fi

echo "[llamacpp] starting llama-server (repo=${LLAMA_ARG_HF_REPO:-<local model>} file=${LLAMA_ARG_HF_FILE:-auto} port=${LLAMA_ARG_PORT:-8080})"

exec /app/llama-server "$@"