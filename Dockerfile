# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# nolock — Railway web deployment image (canonical copy at repo ROOT)
#
# This file lives at the repo root because Railway's Railpack builder
# auto-detects a `Dockerfile` at the root (it does NOT read `deploy/Dockerfile`
# unless the service builder is explicitly set to Dockerfile). Keep this file
# in sync with `deploy/Dockerfile` (the deploy-folder reference copy).
#
# Multi-stage build (build context = repository root):
#   1. web-build  — Vite production bundle of the SAME React frontend the
#                   Tauri desktop app uses, built with VITE_TARGET=web so the
#                   Tauri IPC/event/dialog modules are swapped for the browser
#                   shims in src/web/ (fetch + SSE instead of Tauri IPC).
#   2. rust-build — the nolock-server binary, compiled from the SAME Rust
#                   codebase as the desktop app (src-tauri/src/bin/nolock-server.rs
#                   includes ../main.rs verbatim). Tauri/wry compile-time deps
#                   are installed because the crate is shared with the desktop
#                   target; the server binary itself never opens a window.
#   3. runtime    — slim Debian with only what the server actually needs:
#                   openssl (reqwest), git (session diffs), python3 (notebook
#                   kernels), bash (PTY terminal).
# -----------------------------------------------------------------------------

# ---- Stage 1: web frontend -------------------------------------------------
FROM node:20-bookworm-slim AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
RUN npm run build:web

# ---- Stage 2: Rust backend (nolock-server) ---------------------------------
# Pin matches rust-toolchain.toml (MSRV of switchyard-libsy). If the tag is
# unavailable, use `rust:1-bookworm` — rustup auto-installs the pinned
# toolchain from the copied rust-toolchain.toml.
FROM rust:1.96.1-bookworm AS rust-build
WORKDIR /build
# Compile-time deps for the shared tauri/wry crate (the desktop target).
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libgtk-3-dev \
        libwebkit2gtk-4.1-dev \
        librsvg2-dev \
        libayatana-appindicator3-dev \
        build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY rust-toolchain.toml ./
# Dependency files first for Docker layer caching: dummy crate sources let
# cargo compile every dependency into this layer; the real sources below only
# recompile the nolock crate itself.
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
RUN mkdir -p src-tauri/src/bin dist \
    && echo 'fn main() {}' > src-tauri/src/main.rs \
    && echo 'fn main() {}' > src-tauri/src/bin/nolock-server.rs \
    && echo 'fn main() {}' > src-tauri/build.rs \
    && printf '<!DOCTYPE html><html></html>' > dist/index.html \
    && cargo build --release --manifest-path src-tauri/Cargo.toml --bin nolock-server || true
# Full sources (placeholder dist: generate_context! embeds frontendDist, but
# nolock-server serves the frontend from disk at runtime instead).
COPY src-tauri/build.rs src-tauri/tauri.conf.json src-tauri/
COPY src-tauri/capabilities src-tauri/capabilities
COPY src-tauri/icons src-tauri/icons
COPY src-tauri/src src-tauri/src
RUN touch src-tauri/src/main.rs src-tauri/build.rs \
    && cargo build --release --manifest-path src-tauri/Cargo.toml --bin nolock-server

# ---- Stage 3: runtime -------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        openssl \
        git \
        bash \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-build /build/src-tauri/target/release/nolock-server /app/nolock-server
COPY --from=web-build  /build/dist /app/public
# PIP_BREAK_SYSTEM_PACKAGES: let `pip install ipykernel` work in the in-app
# terminal (Debian's externally-managed-environment guard).
# Runs as root so a mounted Railway volume (/data) is writable without an
# entrypoint chown dance; the container is isolated either way.
ENV PORT=8080 \
    NOLOCK_WEB_DIST=/app/public \
    NOLOCK_DATA_DIR=/data/nolock \
    PIP_BREAK_SYSTEM_PACKAGES=1
EXPOSE 8080
# Railway injects $PORT; the server binds 0.0.0.0:$PORT and serves /health.
CMD ["/app/nolock-server"]
