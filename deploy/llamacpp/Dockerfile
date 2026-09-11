# syntax=docker/dockerfile:1
# Pin the inference image to the version inspected in production. Model pulls
# add only a Python stdlib HTTP worker; the running model and cache stay intact.
FROM ghcr.io/ggml-org/llama.cpp:server@sha256:9116e6ed0f288247a9daaa610a3a30c061af2b1d6ee8c9acc0d402b65ec87c29
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/llamacpp/model_store.py /app/model_store.py
COPY deploy/llamacpp/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NOLOCK_MODEL_DIR=/models NOLOCK_MODEL_STORE_PORT=8081
EXPOSE 8080 8081
ENTRYPOINT ["/entrypoint.sh"]
