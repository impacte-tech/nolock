#!/usr/bin/env python3
"""Private, volume-local Hugging Face GGUF downloader. Python standard library only."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request
import uuid

ACTIVE = {"queued", "resolving", "downloading"}
SHARD = re.compile(r"^(.*)-([0-9]{5})-of-([0-9]{5})\.gguf$", re.I)


def parse_model(value):
    value = value.strip()
    for prefix in ("https://huggingface.co/", "https://hf.co/", "huggingface.co/", "hf.co/"):
        if value.startswith(prefix):
            value = value[len(prefix):].rstrip("/")
            break
    match = re.fullmatch(r"([\w-]+/[\w.-]+)(?::([\w.-]+))?", value, flags=re.ASCII)
    if not match or ".." in value or len(value) > 300:
        raise ValueError("Use a Hugging Face identifier such as owner/model-GGUF, optionally followed by :Q4_K_M.")
    return match.group(1), match.group(2)


def select_files(metadata, selector=None):
    candidates = [f for f in metadata.get("siblings", [])
                  if f.get("rfilename", "").lower().endswith(".gguf")
                  and not Path(f["rfilename"]).name.lower().startswith("mmproj")]
    for f in candidates:
        name = f["rfilename"]
        if name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")) or "\\" in name:
            raise ValueError("Repository contains an unsafe filename.")
    if not candidates:
        raise ValueError("This repository has no GGUF model files. Choose a GGUF repository on Hugging Face.")
    if selector:
        exact = [f for f in candidates if f["rfilename"] == selector]
        if exact:
            group = SHARD.match(exact[0]["rfilename"])
            chosen = [f for f in candidates if SHARD.match(f["rfilename"]) and SHARD.match(f["rfilename"]).group(1) == group.group(1)] if group else exact
        else:
            pattern = re.compile(r"(?:^|[-_.])" + re.escape(selector) + r"(?:[-_.]|$)", re.I)
            chosen = [f for f in candidates if pattern.search(f["rfilename"])]
        if not chosen:
            raise ValueError(f"No GGUF matches {selector}. Use a quantization or exact GGUF filename from Files and versions.")
    else:
        preferred = [f for f in candidates if re.search(r"(?:^|[-_.])Q4_K_M(?:[-_.]|$)", f["rfilename"], re.I)]
        chosen = preferred or candidates
    groups = {SHARD.sub(r"\1", f["rfilename"]) for f in chosen}
    if len(groups) != 1:
        raise ValueError("Multiple GGUF variants found. Add :Q4_K_M (or another quantization) to the model identifier, or specify a GGUF filename.")
    chosen.sort(key=lambda f: f["rfilename"])
    shard = SHARD.match(chosen[0]["rfilename"])
    if shard and ([int(SHARD.match(f["rfilename"]).group(2)) for f in chosen] != list(range(1, int(shard.group(3)) + 1)) or any(SHARD.match(f["rfilename"]).group(3) != shard.group(3) for f in chosen)):
        raise ValueError("The selected GGUF is missing one or more shards.")
    for f in chosen:
        size = f.get("size") or f.get("lfs", {}).get("size")
        if not isinstance(size, int) or size < 4:
            raise ValueError("Hugging Face did not report a valid file size; download was not started.")
        f["size"] = size
    return chosen


class Cancelled(Exception):
    pass


class ModelStore:
    def __init__(self, root, hf_token=""):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_dir = self.root / ".nolock-pulls"
        self.state_dir.mkdir(mode=0o700, exist_ok=True)
        if not self.state_dir.resolve().is_relative_to(self.root):
            raise ValueError("Unsafe model-store state directory.")
        self.hf_token = hf_token
        self.lock = threading.RLock()
        self.jobs = {}
        self.cancellations = {}
        # Only delete this downloader's abandoned, hidden partial files.
        for partial in (self.root / "pulled").rglob(".*.part"):
            if re.search(r"\.[a-f0-9]{32}\.part$", partial.name) and partial.resolve().is_relative_to(self.root):
                partial.unlink(missing_ok=True)
        for path in self.state_dir.glob("*.json"):
            try:
                job = json.loads(path.read_text())
                if not re.fullmatch(r"[a-f0-9]{32}", job["id"]):
                    continue
                if job["status"] in ACTIVE:
                    job.update(status="failed", message="Download interrupted by a service restart. Pull again to retry.")
                self.jobs[job["id"]] = job
            except (ValueError, KeyError, OSError):
                continue

    def update(self, job, **fields):
        with self.lock:
            job.update(fields)
            temp = self.state_dir / (job["id"] + ".tmp")
            temp.write_text(json.dumps(job))
            temp.replace(self.state_dir / (job["id"] + ".json"))

    def list(self):
        with self.lock:
            return [dict(j) for j in sorted(self.jobs.values(), key=lambda j: j["created_at"], reverse=True)[:20]]

    def start(self, model, filename=""):
        repo, selector = parse_model(model)
        if filename:
            if len(filename) > 300 or ".." in filename or "\\" in filename or filename.startswith("/") or not filename.lower().endswith(".gguf"):
                raise ValueError("Enter a relative GGUF filename from the repository's Files and versions tab.")
            selector = filename
        with self.lock:
            if any(j["status"] in ACTIVE for j in self.jobs.values()):
                raise ValueError("A model is already being pulled. Wait for it to finish or cancel it first.")
            job = dict(id=uuid.uuid4().hex, model=model.strip(), backend="llamacpp", status="queued", message="Waiting to resolve GGUF files…", completed=0, total=0, created_at=int(time.time()), path=None, filename=filename or None)
            self.jobs[job["id"]] = job
            self.cancellations[job["id"]] = threading.Event()
            self.update(job)
            threading.Thread(target=self.run, args=(job, repo, selector), daemon=True).start()
            return dict(job)

    def cancel(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError("Download not found.")
            if self.jobs[job_id]["status"] in ACTIVE:
                self.cancellations[job_id].set()
                self.update(self.jobs[job_id], message="Cancelling…")
            return dict(self.jobs[job_id])

    def open_hf(self, url):
        headers = {"User-Agent": "nolock-model-store/1.0"}
        if self.hf_token:
            headers["Authorization"] = f"Bearer {self.hf_token}"
        # urllib forwards headers across redirects. HF redirects files to a CDN;
        # strip Authorization outside Hugging Face instead of leaking HF_TOKEN.
        from urllib.request import HTTPRedirectHandler, build_opener
        from urllib.parse import urlparse
        class Redirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, response_headers, newurl):
                if urlparse(newurl).scheme != "https":
                    raise ValueError("Refusing an insecure download redirect.")
                request = super().redirect_request(req, fp, code, msg, response_headers, newurl)
                if request and urlparse(newurl).hostname != "huggingface.co":
                    request.remove_header("Authorization")
                return request
        return build_opener(Redirect()).open(Request(url, headers=headers), timeout=30)

    def check_cancel(self, job):
        if self.cancellations[job["id"]].is_set():
            raise Cancelled()

    def run(self, job, repo, selector):
        partial = None
        try:
            self.update(job, status="resolving", message="Finding GGUF files on Hugging Face…")
            with self.open_hf(f"https://huggingface.co/api/models/{repo}/revision/main?blobs=true") as response:
                metadata = json.loads(response.read(16 * 1024 * 1024))
            files = select_files(metadata, selector)
            revision = metadata.get("sha", "")
            if not re.fullmatch(r"[a-fA-F0-9]{40,64}", revision):
                raise ValueError("Hugging Face did not provide a pinned model revision.")
            total = sum(f["size"] for f in files)
            # Reserve headroom for inference/cache activity and metadata writes.
            destinations = [self.root / "pulled" / repo / revision / f["rfilename"] for f in files]
            cached = []
            for f, destination in zip(files, destinations):
                self.check_cancel(job)
                if not destination.resolve().is_relative_to(self.root) or destination.is_symlink():
                    raise ValueError("Unsafe model destination.")
                valid = destination.is_file() and destination.stat().st_size == f["size"]
                if valid:
                    digest = hashlib.sha256()
                    with destination.open("rb") as source:
                        valid = source.read(4) == b"GGUF"
                        source.seek(0)
                        while chunk := source.read(1024 * 1024):
                            self.check_cancel(job)
                            digest.update(chunk)
                    expected = f.get("lfs", {}).get("sha256")
                    valid = valid and (not expected or digest.hexdigest() == expected)
                cached.append(valid)
            needed = sum(f["size"] for f, valid in zip(files, cached) if not valid)
            if needed and needed + 64 * 1024 * 1024 > shutil.disk_usage(self.root).free:
                raise ValueError(f"Not enough free space on the model volume ({needed / 1e9:.2f} GB required).")
            self.update(job, status="downloading", total=total, message="Downloading GGUF files…")
            completed = 0
            paths = []
            for f, destination, valid in zip(files, destinations, cached):
                self.check_cancel(job)
                if valid:
                    completed += f["size"]
                    paths.append(str(destination))
                    self.update(job, completed=completed, message=f"Already downloaded: {f['rfilename']}")
                    continue
                if not destination.parent.resolve().is_relative_to(self.root):
                    raise ValueError("Unsafe model destination.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.resolve().is_relative_to(self.root) or destination.is_symlink():
                    raise ValueError("Unsafe model destination.")
                # A hidden, job-specific file never appears as a usable GGUF.
                partial = destination.with_name("." + destination.name + "." + job["id"] + ".part")
                digest = hashlib.sha256()
                received = 0
                last_update = time.monotonic()
                url = f"https://huggingface.co/{repo}/resolve/{revision}/{quote(f['rfilename'], safe='/')}"
                with self.open_hf(url) as response, partial.open("xb") as output:
                    while True:
                        self.check_cancel(job)
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        if received == 0 and not chunk.startswith(b"GGUF"):
                            raise ValueError("Downloaded file is not a GGUF model.")
                        received += len(chunk)
                        if received > f["size"]:
                            raise ValueError("Download exceeded the reported file size.")
                        output.write(chunk)
                        digest.update(chunk)
                        if time.monotonic() - last_update > 0.5:
                            self.update(job, completed=completed + received, message=f"Downloading {f['rfilename']}")
                            last_update = time.monotonic()
                    output.flush()
                    os.fsync(output.fileno())
                if received != f["size"]:
                    raise ValueError("Download was incomplete. Pull again to retry.")
                expected = f.get("lfs", {}).get("sha256")
                if expected and digest.hexdigest() != expected:
                    raise ValueError("Downloaded model checksum does not match Hugging Face.")
                self.check_cancel(job)
                partial.replace(destination)
                partial = None
                paths.append(str(destination))
                completed += received
                self.update(job, completed=completed)
            self.update(job, status="completed", path=paths[0], message="Saved to the llama.cpp model volume. The active model has not changed.")
        except Cancelled:
            self.update(job, status="cancelled", message="Download cancelled. Pull again to retry.")
        except HTTPError as error:
            message = "Repository or file not found." if error.code == 404 else "Access denied. For gated/private models, configure HF_TOKEN on the llama.cpp service and accept the model license on Hugging Face." if error.code in (401, 403) else f"Hugging Face returned HTTP {error.code}. Pull again to retry."
            self.update(job, status="failed", message=message)
        except Exception as error:
            # Don't persist URLs or HTTP headers: signed CDN URLs may contain secrets.
            message = str(error) if isinstance(error, ValueError) else "Download failed (network or model-volume write error). Pull again to retry."
            self.update(job, status="failed", message=message)
        finally:
            if partial:
                try:
                    partial.unlink(missing_ok=True)
                except OSError:
                    pass
            with self.lock:
                self.cancellations.pop(job["id"], None)


class StoreServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, store, token):
        super().__init__(address, Handler)
        self.store, self.token = store, token


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authenticated(self):
        if self.server.token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            self.reply(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok"})
        elif self.authenticated():
            if self.path == "/pulls":
                self.reply(200, self.server.store.list())
            else:
                self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authenticated():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                self.reply(413, {"error": "Invalid request size"})
                return
            body = json.loads(self.rfile.read(length))
            if self.path == "/pulls":
                if not isinstance(body.get("model"), str) or not isinstance(body.get("filename", ""), str):
                    raise ValueError("Invalid model or filename.")
                self.reply(202, self.server.store.start(body["model"], body.get("filename", "")))
            elif re.fullmatch(r"/pulls/[a-f0-9]{32}/cancel", self.path):
                self.reply(200, self.server.store.cancel(self.path.split("/")[2]))
            else:
                self.reply(404, {"error": "Not found"})
        except (ValueError, TypeError, AttributeError) as error:
            # Return validation messages without echoing arbitrary request bodies.
            self.reply(400, {"error": str(error) if isinstance(error, ValueError) else "Invalid request."})


if __name__ == "__main__":
    host = os.environ.get("NOLOCK_MODEL_STORE_HOST", "127.0.0.1")
    token = os.environ.get("NOLOCK_MODEL_PULL_TOKEN", "")
    if host not in ("127.0.0.1", "::1", "localhost") and not token:
        raise SystemExit("NOLOCK_MODEL_PULL_TOKEN is required for a network-accessible model store.")
    StoreServer((host, int(os.environ.get("NOLOCK_MODEL_STORE_PORT", "8081"))),
                ModelStore(os.environ.get("NOLOCK_MODEL_DIR", "/models"), os.environ.get("HF_TOKEN", "")), token).serve_forever()
