"""Dummy-data launcher/session tests: no models, accounts or existing histories."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("nolock-agent.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class LauncherTests(unittest.TestCase):
    def test_native_configs_keep_host_auth_and_literal_arguments(self):
        servers = {"remote":{"url":"http://localhost:3000/mcp","headers":{"Authorization":"Bearer dummy-token"}},
                   "local":{"command":"example","env":{"TOKEN":"dummy-local"}}}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"NOLOCK_MCP_CONFIG":"/dummy/settings.json"}):
            for client, version in [("codex",None),("claude",None),("opencode","1.2.3"),("opencode","2.0.0")]:
                argv, env = launcher.launch_spec(client,["literal '$()' argument"],"/actual/"+client,servers,Path(tmp),version)
                self.assertNotIn("HOME",env)
                self.assertNotIn("CODEX_HOME",env)
                self.assertNotIn("CLAUDE_CONFIG_DIR",env)
                self.assertIn("literal '$()' argument",argv)
                self.assertNotIn("dummy-token",str(argv))
                if client == "codex":
                    native = tomllib.loads("\n".join(argv[i+1] for i,v in enumerate(argv) if v == "-c"))["mcp_servers"]
                    self.assertEqual(set(native), {"local","remote"})
                    self.assertEqual(native["remote"]["url"],"http://localhost:3000/mcp")
                elif client == "claude":
                    self.assertEqual(argv[-2],"--mcp-config")
                    self.assertEqual(set(json.loads(Path(argv[-1]).read_text())["mcpServers"]),{"local","remote"})
                else:
                    config = json.loads(Path(env["OPENCODE_CONFIG"]).read_text())
                    self.assertEqual(set(config["mcp"] if version.startswith("1") else config["mcp"]["servers"]),{"local","remote"})

    def test_configuration_changes_remove_disabled_servers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"mcp.json"
            path.write_text(json.dumps({"mcpServers":{"a":{"command":"tool"},"b":{"command":"other","disabled":True}}}))
            self.assertEqual(set(launcher.load_servers(path)),{"a"})
            path.write_text(json.dumps({"mcpServers":{}}))
            self.assertEqual(launcher.load_servers(path),{})

    def test_no_mcp_connections_leaves_agent_arguments_unchanged(self):
        argv,env=launcher.launch_spec("claude",["--model","local-model"],"/actual/claude",{},Path("/unused"))
        self.assertEqual(argv,["/actual/claude","--model","local-model"])
        self.assertEqual(env,{})

    def run_fixture(self, root, terminal, text, delay="0", code="0"):
        env=dict(os.environ,NOLOCK_PROJECT_ROOT=str(root),NOLOCK_TERMINAL_ID=terminal,NOLOCK_MCP_CONFIG=str(root/"empty.json"),ANTHROPIC_BASE_URL="http://localhost:11434")
        source="import os,time,sys; assert os.environ['ANTHROPIC_BASE_URL']=='http://localhost:11434'; time.sleep(float(sys.argv[1])); print(sys.argv[2]); sys.exit(int(sys.argv[3]))"
        return subprocess.Popen([sys.executable,launcher.__file__,"run",sys.executable,"-c",source,delay,text,code],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

    def test_concurrent_and_sequential_runs_are_separate_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            a=self.run_fixture(root,"term-a","FIRST_OUTPUT","0.2")
            b=self.run_fixture(root,"term-b","SECOND_OUTPUT","0.1","7")
            ao,ae=a.communicate(timeout=5); bo,be=b.communicate(timeout=5)
            self.assertEqual(a.returncode,0,ae)
            self.assertEqual(b.returncode,7,be)
            c=self.run_fixture(root,"term-a","THIRD_OUTPUT")
            c.communicate(timeout=5)
            records=[json.loads(p.read_text()) for p in (root/".sessions").glob("*.json")]
            self.assertEqual(len(records),3)
            self.assertEqual(len({r["id"] for r in records}),3)
            self.assertEqual(sorted(r["agent"]["exitCode"] for r in records),[0,0,7])
            for record in records:
                self.assertEqual(record["status"],"finished")
                events=[json.loads(s) for s in (root/".sessions"/(record["id"]+".terminals.jsonl")).read_text().splitlines()]
                outputs="".join(e.get("text","") for e in events)
                self.assertEqual(sum(word in outputs for word in ["FIRST_OUTPUT","SECOND_OUTPUT","THIRD_OUTPUT"]),1)
                self.assertEqual({e["terminalId"] for e in events},{record["agent"]["terminalId"]})
                self.assertEqual(events[-1]["kind"],"exited")

    def test_deleted_session_is_not_resurrected(self):
        with tempfile.TemporaryDirectory() as tmp:
            session=launcher.Session(tmp,"dummy")
            session.deleted.touch(); session.path.unlink(); session.journal_path.unlink()
            session.output(b"later output")
            session.finish(0)
            self.assertFalse(session.path.exists())
            self.assertFalse(session.journal_path.exists())

    def test_recording_limit_does_not_stop_agent(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(launcher,"MAX_JOURNAL",1024):
            session=launcher.Session(tmp,"dummy")
            session.output(b"x"*2048)
            session.finish(0)
            self.assertTrue(json.loads(session.path.read_text())["agent"]["transcriptTruncated"])
            self.assertLessEqual(session.journal_path.stat().st_size,1024)

    def test_split_utf8_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            session=launcher.Session(tmp,"dummy")
            value="olá 🌍".encode()
            for byte in value: session.output(bytes([byte]))
            session.finish(0)
            events=[json.loads(line) for line in session.journal_path.read_text().splitlines()]
            self.assertEqual("".join(e.get("text","") for e in events),"olá 🌍")

    def test_recording_failure_does_not_block_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".sessions").write_text("not a directory")
            child = self.run_fixture(root, "term", "STILL_RUNNING", code="7")
            output, error = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 7, error)
            self.assertIn(b"STILL_RUNNING", output)
            self.assertIn(b"without it", error)

    @unittest.skipUnless(os.name == "posix", "Unix interactive terminals")
    def test_interactive_input_resize_exit_and_recording(self):
        import pty, select, fcntl, termios, struct
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 31, 97, 0, 0))
            source = "import os; print('READY',os.get_terminal_size(),flush=True); value=input(); print('REPLY:'+value,flush=True)"
            env = dict(os.environ, NOLOCK_PROJECT_ROOT=str(root), NOLOCK_TERMINAL_ID="interactive", NOLOCK_MCP_CONFIG=str(root / "empty.json"))
            child = subprocess.Popen([sys.executable, launcher.__file__, "run", sys.executable, "-c", source], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
            os.close(slave)
            output = b""
            try:
                deadline = time.monotonic() + 8
                while b"READY" not in output and time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]: output += os.read(master, 16384)
                self.assertIn(b"columns=97, lines=31", output)
                os.write(master, b"hello terminal\n")
                while child.poll() is None and time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]:
                        try: output += os.read(master, 16384)
                        except OSError: break
                child.wait(timeout=3)
                self.assertEqual(child.returncode, 0, output)
                record = json.loads(next((root / ".sessions").glob("*.json")).read_text())
                journal = (root / ".sessions" / (record["id"] + ".terminals.jsonl")).read_text()
                self.assertIn("REPLY:hello terminal", journal)
                self.assertEqual(record["agent"]["exitCode"], 0)
            finally:
                os.close(master)
                if child.poll() is None: child.kill(); child.wait()

    @unittest.skipUnless(os.name == "posix", "Unix interactive terminals")
    def test_termination_reaches_interactive_agent_and_saves_exit(self):
        import pty, select, signal
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            master, slave = pty.openpty()
            env = dict(os.environ, NOLOCK_PROJECT_ROOT=str(root), NOLOCK_MCP_CONFIG=str(root / "empty.json"))
            child = subprocess.Popen([sys.executable, launcher.__file__, "run", sys.executable, "-c", "import time; print('READY',flush=True); time.sleep(60)"], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
            os.close(slave)
            try:
                output = b""
                deadline = time.monotonic() + 5
                while b"READY" not in output and time.monotonic() < deadline:
                    if select.select([master], [], [], .1)[0]: output += os.read(master, 16384)
                self.assertIn(b"READY", output)
                child.send_signal(signal.SIGTERM)
                child.wait(timeout=5)
                self.assertEqual(child.returncode, 143)
                record = json.loads(next((root / ".sessions").glob("*.json")).read_text())
                self.assertEqual(record["agent"]["exitCode"], -signal.SIGTERM)
                self.assertEqual(record["status"], "finished")
            finally:
                os.close(master)
                if child.poll() is None: child.kill(); child.wait()

    def test_native_stdio_env_and_stdout_are_not_recorded_as_agent_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); config=root/"mcp.json"
            config.write_text(json.dumps({"mcpServers":{"test":{"command":sys.executable,"args":["-c","import os,sys; assert os.environ['CUSTOM']=='value'; print(sys.stdin.readline().strip())"],"env":{"CUSTOM":"value"}}}}))
            result=subprocess.run([sys.executable,launcher.__file__,"server","test"],input="protocol-message\n",text=True,capture_output=True,env=dict(os.environ,NOLOCK_MCP_CONFIG=str(config),NOLOCK_PROJECT_ROOT=str(root)),timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,"protocol-message\n")
            self.assertFalse((root/".sessions").exists())

if __name__ == "__main__": unittest.main()
