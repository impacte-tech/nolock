# llama.cpp inference and model downloads on Railway

The `llamacpp` service runs the pinned llama.cpp inference image plus a small
Python standard-library model store. Both processes mount the **same `/models`
volume**. Inference stays on port 8080; model downloads use private port 8081.
The public nolock server proxies authenticated UI requests to the model store.
Railway credentials are never used by the application or sent to the browser.

## Model Providers → Pull a model

Select **llama.cpp** or **Ollama**, paste a Hugging Face GGUF repository identifier
such as `owner/model-GGUF:Q4_K_M`, and press **Pull**. A model-page URL also works.
The hint in the UI links to GGUF models and explains where to copy the identifier.

- **llama.cpp:** resolves a pinned Hugging Face revision, prefers Q4_K_M when
  available, or uses the optional exact GGUF filename. Ambiguous variants produce
  an actionable error. Split GGUFs are downloaded together. Files are stored at
  `/models/pulled/<owner>/<repo>/<revision>/<filename>`.
- **Ollama:** sends `hf.co/<owner>/<repo>[:quantization]` to the selected server's
  native `/api/pull` endpoint. Ollama writes into its own model storage, not the
  nolock web container. Mount `OLLAMA_MODELS` on a persistent volume.
- Progress, cancellation, failures, and reconnecting to an active pull are
  supported. Closing the panel does not stop the download.
- llama.cpp checks disk space, file size, GGUF magic, and the SHA-256 supplied by
  Hugging Face. Downloaded files are renamed from hidden `.part` files only after
  verification. Existing valid files from the same revision are reused.
- llama.cpp job history survives restarts; an interrupted job is marked failed,
  abandoned partial files are removed, and Pull retries it. Complete shards can
  be reused. Ollama resumes its cached layers when pulling again; nolock's Ollama
  progress history is in memory and resets if nolock restarts.
- These are **GGUF downloads**, not conversion of safetensors/PyTorch weights.
  Vision projector files are not selected automatically.

**Pull does not hot-swap the active llama.cpp model.** After a pull completes, its
absolute path is shown. To serve it with the current single-model server, set
`LLAMA_ARG_MODEL` to that path, remove `MODEL_HF` / `LLAMA_ARG_HF_REPO` /
`LLAMA_ARG_HF_FILE`, and restart llama.cpp. Ollama pulls are immediately available
in its model list; nolock refreshes model selectors when a pull completes.

## Railway rollout

Inspection on 2026-09-11 found the `harmonious-appreciation` project with:

- `nolock`: GitHub deployment from `impacte-tech/nolock`, branch `main`, no volume.
- `llamacpp`: raw `ghcr.io/ggml-org/llama.cpp:server` image with a `/models` volume
  (5 GB capacity), `LLAMA_CACHE=/models`, and `MODEL_HF=impacte/ullr:Q4_K_M`.
- No deployed Ollama service.

The raw llama.cpp image has no model-pull HTTP API. Its deployment must switch to
this wrapper to enable llama.cpp pulls from the UI:

1. Keep the existing llama.cpp service and `/models` volume. Do **not** create or
   move a volume. Preserve `MODEL_HF` and `LLAMA_CACHE` to reuse the active model.
2. Set the llama.cpp service's source to `impacte-tech/nolock`, branch `main`,
   with service root **`/deploy/llamacpp`**, Dockerfile path **`Dockerfile`**,
   start command **`/entrypoint.sh`**, healthcheck `/health`, and a 300-second
   healthcheck timeout. Use Railway service settings, not a new `railway.json`
   path (Railway no longer accepts new Config-as-Code settings). The repository
   intentionally has no root `railway.json`, which would override these settings. This replaces
   the old dashboard start command that directly ran `llama-server`.
3. Generate one random `NOLOCK_MODEL_PULL_TOKEN` and set the **same secret** on
   both services. Keep it out of Git, logs, browser settings, and URLs.
4. On `llamacpp`, set `NOLOCK_MODEL_DIR=/models` and
   `NOLOCK_MODEL_STORE_PORT=8081`. Keep `PORT=8080` for inference.
5. On `nolock`, set:
   ```text
   LLAMACPP_URL=http://llamacpp.railway.internal:8080
   LLAMACPP_MODEL_STORE_URL=http://llamacpp.railway.internal:8081
   ```
   Keep the existing `NOLOCK_WEB_TOKEN` enabled for the public UI.
6. Deploy llama.cpp, then nolock. This restarts the inference service once; future
   pulls run beside inference without restarting it. Keep both llama.cpp ports
   private—do not add a public domain or proxy for port 8081.
7. Open Model Providers, select llama.cpp, and pull a small GGUF to verify storage.
   Confirm `/health` on inference still responds and the completed path is under
   `/models/pulled/`.

`LLAMACPP_MODEL_STORE_URL` must be paired with `LLAMACPP_URL`. The Rust proxy only
uses its model-store secret when the requested provider URL matches that trusted
configuration. For gated/private HF repositories, set `HF_TOKEN` on `llamacpp`
and accept the repository's license using that Hugging Face account. For private
Ollama pulls, authorize the Ollama server's SSH key in the Hugging Face account.

## Desktop / other hosts

Ollama needs no extra service. Point Model Providers at a running Ollama server.
For llama.cpp, run the model store on the **inference host**, using the actual
model directory:

```sh
NOLOCK_MODEL_DIR=/path/to/models python3 deploy/llamacpp/model_store.py
```

It defaults to localhost:8081. If `LLAMACPP_MODEL_STORE_URL` is unset, nolock tries
port 8081 on the selected inference host without attaching a secret. For remote
or authenticated stores, configure both `LLAMACPP_URL` and
`LLAMACPP_MODEL_STORE_URL`, plus the shared `NOLOCK_MODEL_PULL_TOKEN`, in the
nolock process environment. Non-loopback model-store binds require a token.

## Validation

```sh
python3 -m unittest discover -s deploy/llamacpp/tests -v
cargo test --manifest-path src-tauri/Cargo.toml --bin nolock model_pulls::tests
npm test -- src/components/__tests__/ModelPullPanel.test.tsx

docker build -t nolock-llamacpp-pulls deploy/llamacpp
```

Upstream contracts: [Hugging Face GGUF/Ollama](https://huggingface.co/docs/hub/ollama),
[Ollama pull API](https://docs.ollama.com/api/pull), and
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
