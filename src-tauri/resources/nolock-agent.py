#!/usr/bin/env python3
"""Launch host coding agents with project MCPs and independent session journals."""
import codecs
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

CLIENTS = ("codex", "claude", "opencode")
MAX_JOURNAL = 8 * 1024 * 1024


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
            temporary = out.name
            json.dump(value, out)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def load_servers(path):
    if not path or not Path(path).exists():
        return {}
    data = Path(path).read_bytes()
    if len(data) > 65536:
        raise ValueError("MCP configuration too large")
    servers = json.loads(data)["mcpServers"]
    if not isinstance(servers, dict):
        raise ValueError("Invalid MCP configuration")
    return {name: value for name, value in servers.items() if not value.get("disabled", False)}


def resolve_executable(command):
    """Search the actual shell PATH, excluding only Nolock's shim directory."""
    bindir = Path(__file__).resolve().parent
    search = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep)
                             if Path(p or ".").resolve() != bindir)
    executable = shutil.which(command, path=search)
    if not executable or Path(executable).resolve() == Path(__file__).resolve():
        raise ValueError("Agent executable not found")
    return executable


def launch_spec(client, arguments, executable, servers, directory, version=None):
    """Native client config without changing host HOME, logins or preferences."""
    env = {}
    argv = [executable, *arguments]
    if not servers:
        return argv, env
    if client == "codex":
        argv = [executable]
        for name, server in servers.items():
            fields = {"enabled": True, "tool_timeout_sec": 95}
            if server.get("url"):
                fields["url"] = server["url"]
                for key, value in server.get("headers", {}).items():
                    variable = "NOLOCK_MCP_" + (name + ":" + key).encode().hex().upper()
                    env[variable] = value
                    fields["env_http_headers." + json.dumps(key)] = variable
            else:
                # Fetch server-specific env at exec time: no name collisions or
                # raw env values in argv, and changes apply to new MCP processes.
                fields.update(command=str(Path(__file__).with_name("nolock-agent")), args=["server", name])
                fields["env.NOLOCK_MCP_CONFIG"] = os.environ["NOLOCK_MCP_CONFIG"]
            for key, value in fields.items():
                argv += ["-c", "mcp_servers." + name + "." + key + "=" + json.dumps(value)]
        argv += arguments
    elif client == "claude":
        # MCP management subcommands don't accept the top-level --mcp-config.
        # Normal agent launches use the overlay; /mcp shows the effective list.
        if arguments and arguments[0] == "mcp":
            print("[Nolock] Use /mcp inside Claude to inspect project connections, or nolock-agent list.", file=sys.stderr)
            return argv, env
        native = {}
        for name, server in servers.items():
            if server.get("url"):
                headers = {}
                for key, value in server.get("headers", {}).items():
                    variable = "NOLOCK_MCP_" + (name + ":" + key).encode().hex().upper()
                    env[variable] = value
                    headers[key] = "${" + variable + "}"
                native[name] = {"type":"http", "url":server["url"], "headers":headers}
            else:
                native[name] = {"command":str(Path(__file__).with_name("nolock-agent")), "args":["server",name],
                                "env":{"NOLOCK_MCP_CONFIG":os.environ["NOLOCK_MCP_CONFIG"]}}
        config = directory / "claude-mcp.json"
        atomic_json(config, {"mcpServers":native})
        # Last: --mcp-config is variadic and would otherwise consume prompts.
        argv += ["--mcp-config", str(config)]
    elif client == "opencode":
        match = re.fullmatch(r"(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", (version or "").strip())
        if not match or int(match[1]) not in (1, 2):
            raise ValueError("Unsupported OpenCode config version")
        major = int(match[1])
        native = {}
        for name, server in servers.items():
            if server.get("url"):
                headers = {}
                for key, value in server.get("headers", {}).items():
                    variable = "NOLOCK_MCP_" + (name + ":" + key).encode().hex().upper()
                    env[variable] = value
                    headers[key] = "{env:" + variable + "}"
                entry = {"type":"remote", "url":server["url"], "headers":headers}
                if headers: entry["oauth"] = False
            else:
                entry = {"type":"local", "command":[str(Path(__file__).with_name("nolock-agent")), "server", name],
                         "environment":{"NOLOCK_MCP_CONFIG":os.environ["NOLOCK_MCP_CONFIG"]}}
            if major == 1: entry.update(enabled=True, timeout=95000)
            else: entry.update(codemode=False, timeout={"execution":95000})
            native[name] = entry
        config = {"mcp": native if major == 1 else {"servers":native}}
        # Both releases support OPENCODE_CONFIG; host settings/auth remain intact.
        overlay = directory / "opencode.json"
        atomic_json(overlay, config)
        env["OPENCODE_CONFIG"] = str(overlay)
        if major == 1: env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    return argv, env


class UnrecordedSession:
    def output(self, data): pass
    def finish(self, code): pass


class Session:
    def __init__(self, root, agent):
        self.directory = Path(root) / ".sessions"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.id = "agent_" + uuid.uuid4().hex
        self.path = self.directory / (self.id + ".json")
        self.journal_path = self.directory / (self.id + ".terminals.jsonl")
        self.deleted = self.directory / (self.id + ".terminals.deleted")
        self.terminal = os.environ.get("NOLOCK_TERMINAL_ID", "external")
        self.agent = agent
        self.bytes = 0
        self.failed = False
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        now = int(time.time())
        self.record = {"id":self.id, "summary":agent + " · " + Path.cwd().name, "status":"active",
                       "createdAt":now, "updatedAt":now, "messageCount":0,"toolCallCount":0,
                       "firstMessage":"", "lastMessage":"", "tokenUsage":0,"contextWindow":0,
                       "agent":{"name":agent,"terminalId":self.terminal,"cwd":str(Path.cwd()),
                                "pid":os.getpid(),"exitCode":None,"transcriptTruncated":False}}
        atomic_json(self.path, self.record)
        self.event("opened")

    def event(self, kind, text=None):
        if self.failed or self.deleted.exists(): return
        event = {"id":uuid.uuid4().hex,"terminalId":self.terminal,"label":self.agent,
                 "kind":kind,"createdAt":time.time()}
        if text is not None: event["text"] = text
        data = (json.dumps(event) + "\n").encode()
        if self.bytes + len(data) > MAX_JOURNAL:
            self.record["agent"]["transcriptTruncated"] = True
            return
        try:
            fd = os.open(self.journal_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "ab") as out: out.write(data)
            self.bytes += len(data)
        except OSError:
            self.failed = True
            print("\r\n[Nolock] Session recording failed; the agent continues running.\r\n", file=sys.stderr)

    def output(self, data):
        text = self.decoder.decode(data)
        if text: self.event("output", text)

    def finish(self, code):
        tail = self.decoder.decode(b"", final=True)
        if tail: self.event("output", tail)
        self.event("exited")
        if self.deleted.exists(): return
        # Respect archival/deletion performed while this agent was running.
        try:
            current = json.loads(self.path.read_text())
            if current.get("status") == "archived": self.record["status"] = "archived"
        except (OSError, ValueError): pass
        if self.record["status"] != "archived": self.record["status"] = "finished"
        self.record["updatedAt"] = int(time.time())
        self.record["agent"].update(exitCode=code, recordingFailed=self.failed)
        atomic_json(self.path, self.record)


def run_recorded(argv, env, session):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        import selectors
        child = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def forward(signum, frame):
            child.send_signal(signum)
        previous = {sig:signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ, sys.stdout.buffer)
                selector.register(child.stderr, selectors.EVENT_READ, sys.stderr.buffer)
                while selector.get_map():
                    for key, _ in selector.select():
                        data = os.read(key.fd, 16384)
                        if not data: selector.unregister(key.fileobj); continue
                        session.output(data)
                        key.data.write(data); key.data.flush()
            return child.wait()
        finally:
            for sig, handler in previous.items(): signal.signal(sig, handler)
            if child.poll() is None: child.terminate(); child.wait()
    import errno
    import fcntl
    import pty
    import select
    import termios
    import tty
    pid, master = pty.fork()
    if pid == 0:
        try: os.execvpe(argv[0], argv, env)
        except Exception: os._exit(127)
    saved = termios.tcgetattr(sys.stdin.fileno())
    def resize(signum=None, frame=None):
        try: fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(sys.stdin, termios.TIOCGWINSZ, b"\0" * 8))
        except OSError: pass
    def forward(signum, frame):
        try: os.killpg(pid, signum)
        except ProcessLookupError: pass
    previous = {sig:signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    previous[signal.SIGWINCH] = signal.signal(signal.SIGWINCH, resize)
    resize()
    try:
        tty.setraw(sys.stdin.fileno())
        inputs = [master, sys.stdin.fileno()]
        while master in inputs:
            ready, _, _ = select.select(inputs, [], [])
            for fd in ready:
                try: data = os.read(fd, 16384)
                except OSError as error:
                    if error.errno != errno.EIO: raise
                    data = b""
                if not data:
                    inputs.remove(fd)
                    if fd != master: forward(signal.SIGHUP, None)
                    continue
                if fd == master:
                    session.output(data)
                    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
                else:
                    view = memoryview(data)
                    while view: view = view[os.write(master, view):]
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status)
    finally:
        try:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved)
        finally:
            os.close(master)
            for sig, handler in previous.items(): signal.signal(sig, handler)
            # Closing the outer terminal must also end the nested PTY agent.
            try:
                if os.waitpid(pid, os.WNOHANG)[0] == 0:
                    forward(signal.SIGHUP, None)
                    for _ in range(20):
                        if os.waitpid(pid, os.WNOHANG)[0]: break
                        time.sleep(0.05)
                    else:
                        forward(signal.SIGKILL, None)
                        os.waitpid(pid, 0)
            except ChildProcessError:
                pass


def main(arguments):
    if not arguments:
        print("Usage: nolock-agent codex|claude|opencode [args...] | run COMMAND [args...] | list | server NAME", file=sys.stderr)
        return 2
    servers = load_servers(os.environ.get("NOLOCK_MCP_CONFIG"))
    if arguments == ["list"]:
        print(json.dumps({"servers":[{"name":k,"transport":"http" if v.get("url") else "stdio"} for k,v in servers.items()]}))
        return 0
    if arguments[0] == "server":
        server = servers[arguments[1]]
        if not server.get("command"): raise ValueError("Not a stdio server")
        env = dict(os.environ); env.update(server.get("env", {}))
        os.execvpe(server["command"], [server["command"], *server.get("args", [])], env)
    generic = arguments[0] == "run"
    if generic: arguments = arguments[1:]
    if not arguments: raise ValueError("Agent command required")
    client = arguments[0]
    if not generic and client not in CLIENTS: raise ValueError("Use run COMMAND for other agents")
    executable = resolve_executable(client)
    root = os.environ.get("NOLOCK_PROJECT_ROOT") or str(Path.cwd())
    try:
        session = Session(root, Path(client).name)
    except OSError:
        print("[Nolock] Cannot create session recording; the agent will run without it.", file=sys.stderr)
        session = UnrecordedSession()
    code = 1
    try:
        with tempfile.TemporaryDirectory(prefix="nolock-mcp-") as tmp:
            version = None
            if client == "opencode" and servers:
                version = subprocess.run([executable,"--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
            argv, extra = launch_spec(client, arguments[1:], executable, servers, Path(tmp), version)
            env = dict(os.environ); env.update(extra)
            code = run_recorded(argv, env, session)
    finally:
        try:
            session.finish(code)
        except OSError:
            print("[Nolock] Could not save final session status.", file=sys.stderr)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    invoked = Path(sys.argv[0]).name
    try:
        sys.exit(main(([invoked] if invoked in CLIENTS else []) + sys.argv[1:]))
    except Exception as error:
        print("[Nolock] Agent launch failed. Check the executable, MCP configuration and session-directory permissions. " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
