# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# nolock — llama.cpp inference service (isolated Railway box)
#
# Runs the official llama.cpp server image. The model is pulled from
# HuggingFace at startup and is fully configurable via Railway variables:
#
#   LLAMA_ARG_HF_REPO   — HF repo id, e.g. "Qwen/Qwen2.5-0.5B-Instruct-GGUF"
#   LLAMA_ARG_HF_FILE   — GGUF filename in the repo (optional; llama.cpp picks
#                         a sensible quant if omitted)
#   LLAMA_ARG_CTX_SIZE  — context window (tokens)
#   LLAMA_ARG_N_PARALLEL— parallel server slots
#   LLAMA_ARG_N_GPU_LAYERS — GPU layers (set >0 only on a GPU instance)
#
# llama-server reads LLAMA_ARG_* env vars directly, so no arg parsing is
# needed — the entrypoint only maps Railway's dynamic $PORT onto
# LLAMA_ARG_PORT (llama-server's default is 8080, Railway's is random).
#
# NOTE: Railway's Docker build context is the REPO ROOT, so COPY paths are
# repo-root-relative (same convention as deploy/Dockerfile).
# -----------------------------------------------------------------------------
FROM ghcr.io/ggml-org/llama.cpp:server

COPY deploy/llamacpp/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]