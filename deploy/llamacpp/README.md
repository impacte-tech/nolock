# llama.cpp — isolated inference box for nolock (Railway)

A second, isolated Railway service in the **same project** that runs the
official llama.cpp server. nolock's web app connects to it as its **llama.cpp**
backend (native `/completion`, `/health`, `/v1/models` endpoints).

The **model is a configuration**: it is pulled from HuggingFace at startup and
swapped by changing Railway variables — no image rebuild needed.

> **Private only:** this service has **no public domain** — it is reachable
> only over Railway's private network (`http://<service>.railway.internal:PORT`),
> Wireguard-encrypted, never exposed to the internet. nolock reaches it via
> the reference variable `LLAMACPP_URL` (see below).

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Wraps `ghcr.io/ggml-org/llama.cpp:server` with a port-bridging entrypoint |
| `entrypoint.sh` | Maps Railway's `$PORT` → `LLAMA_ARG_PORT`; translates `HF_MODEL_REPO` aliases |
| `env.example` | Every model/server variable (copy into Railway) |
| `README.md` | This file |

## Adding the service (one-time)

1. **Add the service** to the project (Railway dashboard → **New → Service**,
   or via the API). The simplest reliable path is a **raw image service**:
   ```bash
   railway add --service llamacpp --image ghcr.io/ggml-org/llama.cpp:server
   ```
   (The `deploy/llamacpp/Dockerfile` also works — set it as the service's
   **Dockerfile path** — but the raw image avoids a build entirely.)
2. **Set the model variables** (service **Variables**), from `env.example`:
   ```bash
   railway variable set \
     "LLAMA_ARG_HF_REPO=Qwen/Qwen2.5-0.5B-Instruct-GGUF" \
     "LLAMA_ARG_CTX_SIZE=4096" \
     "LLAMA_ARG_N_PARALLEL=1" \
     "LLAMA_ARG_N_GPU_LAYERS=0" \
     "PORT=8080"
   ```
3. **Set the healthcheck** (service **Settings → Deploy**): path `/health`,
   timeout `300s` (the model download on first start can take a while).
4. **Do NOT generate a public domain** — the service stays internal-only.
   nolock reaches it at `http://llamacpp.railway.internal:8080`.

## Configuring the model

The model is **entirely** driven by these variables (llama.cpp pulls the GGUF
from HuggingFace on first start):

| Variable | Example | Notes |
| --- | --- | --- |
| `LLAMA_ARG_HF_REPO` | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` | Any GGUF repo on HF |
| `LLAMA_ARG_HF_FILE` | `qwen2.5-0.5b-instruct-q4_k_m.gguf` | Optional; auto-picks a quant if omitted |
| `LLAMA_ARG_CTX_SIZE` | `4096` | Context window (tokens) |
| `LLAMA_ARG_N_PARALLEL` | `1` | Parallel slots (each costs RAM) |
| `LLAMA_ARG_N_GPU_LAYERS` | `0` | `>0` only on a GPU instance |

Swap models by editing `LLAMA_ARG_HF_REPO` and redeploying — no code change.

> **RAM budget (Railway hobby ≈ 512MB–1GB):** a 0.5B Q4 model (~400MB) fits.
> For larger models (7B Q4 ≈ 4GB) you'll need a bigger plan or a GPU instance
> (then switch the Dockerfile base to `...:server-cuda` and set
> `LLAMA_ARG_N_GPU_LAYERS=99`).

## Pointing nolock at it

The nolock service already has a **reference variable** `LLAMACPP_URL` set to
`http://llamacpp.railway.internal:8080` (Railway resolves it automatically
over the private network). In the nolock web app:

1. **Model Providers** panel → add a **llama.cpp** provider.
2. **URL** = `http://llamacpp.railway.internal:8080`
   (or use the `LLAMACPP_URL` variable value).
3. **Model** =the GGUF filename (e.g. `qwen2.5-0.5b-instruct-q4_k_m.gguf`).
4.Save —the status bar should show the llama.cpp backend as healthy.

## Local test

```bash
docker build -t nolock-llamacpp -f deploy/llamacpp/Dockerfile .
docker run --rm -p 8080:8080 \
  -e LLAMA_ARG_HF_REPO=Qwen/Qwen2.5-0.5B-Instruct-GGUF \
  -e LLAMA_ARG_CTX_SIZE=4096 \
  nolock-llamacpp
# → http://127.0.0.1:8080/health  (llama.cpp downloads the model on first start)
```