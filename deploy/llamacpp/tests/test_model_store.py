import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("model_store", Path(__file__).parents[1] / "model_store.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def metadata(name="model-Q4_K_M.gguf", data=b"GGUFtest"):
    return {"sha": "a" * 40, "siblings": [{"rfilename": name, "size": len(data), "lfs": {"sha256": hashlib.sha256(data).hexdigest()}}]}


def wait(store, job):
    deadline = time.time() + 5
    while time.time() < deadline:
        result = next(j for j in store.list() if j["id"] == job["id"])
        if result["status"] not in module.ACTIVE:
            return result
        time.sleep(0.01)
    raise AssertionError("Job did not finish")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = module.ModelStore(self.directory.name)

    def fake_hf(self, info=None, data=b"GGUFtest"):
        def open_hf(url):
            return io.BytesIO(json.dumps(info or metadata(data=data)).encode() if "/api/models/" in url else data)
        return patch.object(self.store, "open_hf", side_effect=open_hf)

    def test_identifiers(self):
        self.assertEqual(module.parse_model("https://huggingface.co/owner/repo/"), ("owner/repo", None))
        self.assertEqual(module.parse_model("hf.co/owner/repo:Q4_K_M"), ("owner/repo", "Q4_K_M"))
        for value in ["../repo", "owner/../../path", "https://example.com/repo", "owner/repo?token=x", "owner/repo/blob/main/file.gguf"]:
            with self.assertRaises(ValueError): module.parse_model(value)

    def test_single_file_and_safe_destination(self):
        with self.fake_hf():
            job = wait(self.store, self.store.start("owner/repo"))
        self.assertEqual(job["status"], "completed")
        self.assertEqual(Path(job["path"]).read_bytes(), b"GGUFtest")
        self.assertTrue(Path(job["path"]).is_relative_to(Path(self.directory.name)))
        self.assertEqual(job["completed"], job["total"])
        self.assertFalse(list(Path(self.directory.name).rglob("*.part")))

    def test_cached_model_does_not_download_again(self):
        with self.fake_hf() as hf:
            wait(self.store, self.store.start("owner/repo"))
            hf.reset_mock()
            job = wait(self.store, self.store.start("owner/repo"))
        self.assertEqual(job["status"], "completed")
        self.assertEqual(hf.call_count, 1)  # metadata only

    def test_bad_size_magic_and_checksum_never_publish_file(self):
        for data in [b"GGUF", b"HTMLtest", b"GGUFbad!"]:
            with self.subTest(data=data), self.fake_hf(info=metadata(), data=data):
                job = wait(self.store, self.store.start("owner/repo"))
                self.assertEqual(job["status"], "failed")
                self.assertIsNone(job["path"])
                self.assertFalse(list(Path(self.directory.name).rglob("*.gguf")))

    def test_rejects_ambiguous_variants_and_missing_shards(self):
        info = {"siblings": [{"rfilename": name, "size": 8} for name in ["model-Q8_0.gguf", "model-Q5_K_M.gguf"]]}
        with self.assertRaises(ValueError): module.select_files(info)
        self.assertEqual(module.select_files(info, "Q8_0")[0]["rfilename"], "model-Q8_0.gguf")
        with self.assertRaises(ValueError): module.select_files({"siblings": [{"rfilename": "model-00001-of-00002.gguf", "size": 8}]})
        for name in ["../model.gguf", "/model.gguf", "a/../../model.gguf"]:
            with self.assertRaises(ValueError): module.select_files({"siblings": [{"rfilename": name, "size": 8}]})

    def test_downloads_all_shards(self):
        info = metadata("nested/model-Q4_K_M-00001-of-00002.gguf")
        info["siblings"].append(dict(info["siblings"][0], rfilename="nested/model-Q4_K_M-00002-of-00002.gguf"))
        with self.fake_hf(info=info):
            job = wait(self.store, self.store.start("owner/repo", "nested/model-Q4_K_M-00002-of-00002.gguf"))
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["total"], 16)
        self.assertEqual(len(list(Path(self.directory.name).rglob("*.gguf"))), 2)
        self.assertTrue(job["path"].endswith("00001-of-00002.gguf"))

    def test_checks_disk_space_before_download(self):
        with self.fake_hf() as hf, patch.object(module.shutil, "disk_usage", return_value=type("Disk", (), {"free": 1})()):
            job = wait(self.store, self.store.start("owner/repo"))
        self.assertEqual(job["status"], "failed")
        self.assertIn("free space", job["message"])
        self.assertEqual(hf.call_count, 1)

    def test_cancellation_and_duplicate_guard(self):
        barrier = threading.Event()
        def delayed(_url):
            barrier.wait(2)
            return io.BytesIO(json.dumps(metadata()).encode())
        with patch.object(self.store, "open_hf", side_effect=delayed):
            job = self.store.start("owner/repo")
            with self.assertRaises(ValueError): self.store.start("owner/other")
            self.store.cancel(job["id"])
            barrier.set()
            result = wait(self.store, job)
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(list(Path(self.directory.name).rglob("*.gguf")))

    def test_persists_completed_and_marks_interrupted_after_restart(self):
        with self.fake_hf(): job = wait(self.store, self.store.start("owner/repo"))
        restored = module.ModelStore(self.directory.name)
        self.assertEqual(restored.list()[0]["path"], job["path"])
        job.update(status="downloading")
        (self.store.state_dir / (job["id"] + ".json")).write_text(json.dumps(job))
        restored = module.ModelStore(self.directory.name)
        self.assertEqual(restored.list()[0]["status"], "failed")
        self.assertIn("restart", restored.list()[0]["message"])

    def test_private_http_api_requires_authentication(self):
        server = module.StoreServer(("127.0.0.1", 0), self.store, "test-secret")
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}"
        with self.assertRaises(HTTPError) as error: urlopen(url + "/pulls")
        self.assertEqual(error.exception.code, 401)
        req = Request(url + "/pulls", headers={"Authorization": "Bearer test-secret"})
        with urlopen(req) as response: self.assertEqual(json.load(response), [])
        with urlopen(url + "/health") as response: self.assertEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
