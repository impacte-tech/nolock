// ---------------------------------------------------------------------------
// pykernel — persistent Python kernel for .ipynb notebooks
//
// Each notebook gets one kernel process: `<venv>/bin/python nolock_kernel.py
// <port>` spawned from the selected virtual environment. The kernel connects
// back to a loopback TCP listener and speaks a tiny length-prefixed JSON
// protocol (4-byte big-endian length + UTF-8 JSON per frame):
//
//   kernel → host : {"type":"hello","python":"3.11.4"}
//                   {"type":"stream","stream":"stdout|stderr","text":"..."}
//                   {"type":"result","status":"ok|error","exec_count":n,
//                    "outputs":[{"kind":"result|display","mime":...,"data":...}],
//                    "error":{"ename","evalue","traceback":[...]},"elapsed_ms":N}
//   host → kernel : {"type":"hello-ok"}
//                   {"type":"run","id":"<runId>","code":"...","timeout":null}
//
// The kernel executes cells in a persistent namespace (state survives across
// cells, like Colab), captures stdout/stderr (streamed live via Tauri events),
// evaluates the trailing expression (Jupyter-style result), auto-renders
// matplotlib figures / PIL images / _repr_html_ outputs, and survives
// interrupts (SIGINT → KeyboardInterrupt → error result).
//
// Using loopback TCP (instead of the child's stdout) means stray output from
// subprocesses spawned by user code can never corrupt the control protocol.
// ---------------------------------------------------------------------------

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// Embedded kernel bootstrap (Python)
//
// NOTE: the raw string delimiter r#"…"# is safe here because the Python source
// never contains the two-character sequence `"#`.
// ---------------------------------------------------------------------------

pub const KERNEL_PY: &str = r#"# nolock notebook kernel bootstrap.
#
# Executed by the host (Rust) as: python <this file> <port>
# Speaks a 4-byte big-endian length-prefixed JSON protocol over loopback TCP.
import ast
import base64
import builtins
import io
import json
import socket
import struct
import sys
import time
import traceback

PORT = int(sys.argv[1])
CELL_FILENAME = "<nolock-cell>"

sock = socket.create_connection(("127.0.0.1", PORT))
_sockfile = sock.makefile("rb")


def send(obj):
    payload = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack(">I", len(payload)) + payload)


def _recv_exact(n):
    chunks = b""
    while len(chunks) < n:
        chunk = _sockfile.read(n - len(chunks))
        if not chunk:
            # Host closed the connection — exit quietly.
            raise SystemExit(0)
        chunks += chunk
    return chunks


def read_frame():
    (length,) = struct.unpack(">I", _recv_exact(4))
    return json.loads(_recv_exact(length).decode("utf-8"))


send({"type": "hello", "python": "%d.%d.%d" % sys.version_info[:3]})


class _Stream(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that streams writes to the host."""

    def __init__(self, name):
        self.name = name

    def writable(self):
        return True

    def write(self, s):
        if s:
            send({"type": "stream", "stream": self.name, "text": s})
        return len(s)

    def flush(self):
        pass


def _no_input(prompt=""):
    raise RuntimeError(
        "input() is not available in nolock notebook cells - "
        "pass values directly or use the integrated terminal"
    )


builtins.input = _no_input

_Namespace = {"__name__": "__main__", "__builtins__": builtins}
_exec_count = [0]


def _fig_png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _mime_bundle(obj):
    """Build a mimebundle for a cell result, mirroring Jupyter display hooks."""
    bundle = {}
    try:  # matplotlib figure
        import matplotlib.figure

        if isinstance(obj, matplotlib.figure.Figure):
            bundle["image/png"] = _fig_png(obj)
            return bundle
    except Exception:
        pass
    try:  # PIL image
        from PIL import Image as _Image

        if isinstance(obj, _Image.Image):
            buf = io.BytesIO()
            obj.save(buf, format="PNG")
            bundle["image/png"] = base64.b64encode(buf.getvalue()).decode("ascii")
            return bundle
    except Exception:
        pass
    for attr, mime in (
        ("_repr_html_", "text/html"),
        ("_repr_markdown_", "text/markdown"),
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_json_", "application/json"),
        ("_repr_latex_", "text/latex"),
    ):
        method = getattr(obj, attr, None)
        if callable(method):
            try:
                rendered = method()
                if isinstance(rendered, str) and rendered:
                    bundle[mime] = rendered
            except Exception:
                pass
    bundle["text/plain"] = repr(obj)
    return bundle


def _flush_pyplot_figs(out):
    """Auto-display open pyplot figures (inline backend behaviour), then close."""
    try:
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        for num in list(plt.get_fignums()):
            fig = plt.figure(num)
            try:
                out.append({"kind": "display", "mime": "image/png", "data": _fig_png(fig)})
            finally:
                plt.close(fig)
    except Exception:
        pass


def _format_error(etype, evalue, tb):
    # Drop bootstrap frames above the user cell so tracebacks look native.
    while tb is not None and tb.tb_frame.f_code.co_filename != CELL_FILENAME:
        tb = tb.tb_next
    text = "".join(traceback.format_exception(etype, evalue, tb))
    return [line for line in text.rstrip("\n").split("\n") if line != ""]


def run_code(code):
    t0 = time.time()
    out = []
    status = "ok"
    err = None
    stdout, stderr = _Stream("stdout"), _Stream("stderr")
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout, stderr
    _exec_count[0] += 1
    count = _exec_count[0]
    try:
        try:
            tree = ast.parse(code, mode="exec")
            last_ast = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last_ast = ast.Expression(tree.body.pop().value)
        except SyntaxError as e:
            status = "error"
            err = {
                "ename": "SyntaxError",
                "evalue": "%s (line %s)" % (e.msg, e.lineno),
                "traceback": [
                    '  File "%s", line %s' % (CELL_FILENAME, e.lineno),
                    "    " + (e.text or "").rstrip(),
                    "SyntaxError: " + str(e.msg),
                ],
            }
        if status == "ok":
            try:
                if tree.body:
                    exec(compile(tree, CELL_FILENAME, "exec"), _Namespace)
                if last_ast is not None:
                    value = eval(compile(last_ast, CELL_FILENAME, "eval"), _Namespace)
                    if value is not None:
                        for mime, data in _mime_bundle(value).items():
                            out.append({"kind": "result", "mime": mime, "data": data})
                _flush_pyplot_figs(out)
            except KeyboardInterrupt:
                status = "error"
                err = {
                    "ename": "KeyboardInterrupt",
                    "evalue": "interrupted by user",
                    "traceback": ["KeyboardInterrupt"],
                }
            except SystemExit as e:
                status = "error"
                err = {
                    "ename": "SystemExit",
                    "evalue": str(e.code),
                    "traceback": ["SystemExit: " + str(e.code)],
                }
            except BaseException as e:
                status = "error"
                err = {
                    "ename": type(e).__name__,
                    "evalue": str(e),
                    "traceback": _format_error(type(e), e, e.__traceback__),
                }
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return {
        "type": "result",
        "status": status,
        "exec_count": count,
        "outputs": out,
        "error": err,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


def main():
    while True:
        try:
            msg = read_frame()
        except KeyboardInterrupt:
            # SIGINT while idle — ignore and keep serving.
            continue
        mtype = msg.get("type")
        if mtype == "ping":
            send({"type": "pong"})
        elif mtype == "run":
            try:
                result = run_code(msg.get("code", ""))
            except BaseException as e:  # absolute safety net — never die silently
                result = {
                    "type": "result",
                    "status": "error",
                    "exec_count": _exec_count[0],
                    "outputs": [],
                    "error": {
                        "ename": type(e).__name__,
                        "evalue": str(e),
                        "traceback": [type(e).__name__ + ": " + str(e)],
                    },
                    "elapsed_ms": 0,
                }
            send(result)


main()
"#;

// ---------------------------------------------------------------------------
// Protocol framing
// ---------------------------------------------------------------------------

/// Maximum accepted frame size (64 MiB) — guards against corrupted streams.
const MAX_FRAME: usize = 64 * 1024 * 1024;

fn write_frame<W: Write>(writer: &mut W, value: &serde_json::Value) -> std::io::Result<()> {
    let payload =
        serde_json::to_vec(value).map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

fn read_frame<R: Read>(reader: &mut R) -> std::io::Result<serde_json::Value> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            format!("kernel frame too large: {} bytes", len),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct KernelState {
    pub instances: Mutex<HashMap<String, KernelInstance>>,
}

pub struct KernelInstance {
    pub child: Child,
    pub conn: Arc<Mutex<TcpStream>>,
    pub python_path: String,
    pub cwd: String,
}

impl KernelInstance {
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelStreamEvent {
    kernel_id: String,
    run_id: String,
    kind: String, // "stdout" | "stderr"
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelDiedEvent {
    kernel_id: String,
    pid: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelOutput {
    pub kind: String, // "result" | "display"
    pub mime: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelError {
    pub ename: String,
    pub evalue: String,
    pub traceback: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub status: String, // "ok" | "error" | "timeout"
    pub exec_count: Option<u64>,
    pub stdout: String,
    pub stderr: String,
    pub outputs: Vec<KernelOutput>,
    pub error: Option<KernelError>,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo {
    pub pid: u32,
    pub python_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub python_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Kernel bootstrap script management
// ---------------------------------------------------------------------------

fn kernel_script_path() -> std::path::PathBuf {
    std::env::temp_dir().join("nolock_kernel.py")
}

/// Write the embedded kernel bootstrap to the temp directory (idempotent).
fn ensure_kernel_script() -> Result<std::path::PathBuf, String> {
    let path = kernel_script_path();
    std::fs::write(&path, KERNEL_PY)
        .map_err(|e| format!("Failed to write kernel script: {}", e))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Core kernel spawn + handshake (shared by the Tauri command and tests)
// ---------------------------------------------------------------------------

pub struct KernelProc {
    pub child: Child,
    pub stream: TcpStream,
    pub python_version: String,
}

/// Spawn `<python> <kernel.py> <port>` and complete the hello handshake.
pub fn spawn_kernel(python_path: &str, cwd: &str) -> Result<KernelProc, String> {
    let script = ensure_kernel_script()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind kernel port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let mut child = Command::new(python_path)
        .arg(&script)
        .arg(port.to_string())
        .current_dir(cwd)
        .env("MPLBACKEND", "Agg") // headless matplotlib; figures render via savefig
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("PYTHONSTARTUP")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python kernel ({}): {}", python_path, e))?;

    // Accept the kernel's connection with a deadline.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    return Err("Kernel did not connect within 20s".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Kernel accept failed: {}", e));
            }
        }
    };

    // Handshake: hello → hello-ok
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| e.to_string())?;

    let hello = read_frame(&mut stream).map_err(|e| {
        let _ = child.kill();
        format!("Kernel handshake failed: {}", e)
    })?;
    if hello.get("type").and_then(|v| v.as_str()) != Some("hello") {
        let _ = child.kill();
        return Err("Kernel handshake failed: unexpected message".to_string());
    }
    let python_version = hello
        .get("python")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    write_frame(&mut stream, &json!({"type": "hello-ok"}))
        .map_err(|e| format!("Kernel handshake failed: {}", e))?;
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
    stream.set_write_timeout(None).map_err(|e| e.to_string())?;

    Ok(KernelProc {
        child,
        stream,
        python_version,
    })
}

// ---------------------------------------------------------------------------
// Core run loop (shared by the Tauri command and tests)
// ---------------------------------------------------------------------------

/// Send one cell to the kernel and collect its result, forwarding stream
/// chunks to `on_event` as they arrive. The full stdout/stderr text of the run
/// is accumulated into the returned `RunResult` so the final notebook output
/// never depends on event delivery order.
pub fn run_on_conn(
    conn: &mut TcpStream,
    run_id: &str,
    code: &str,
    timeout_secs: Option<u64>,
    mut on_event: impl FnMut(&str, &str),
) -> Result<RunResult, String> {
    let request = json!({"type": "run", "id": run_id, "code": code, "timeout": timeout_secs});
    write_frame(conn, &request).map_err(|e| format!("Failed to send code to kernel: {}", e))?;

    match timeout_secs {
        Some(secs) => conn
            .set_read_timeout(Some(Duration::from_secs(secs)))
            .map_err(|e| e.to_string())?,
        None => conn.set_read_timeout(None).map_err(|e| e.to_string())?,
    }

    let mut stdout = String::new();
    let mut stderr = String::new();

    loop {
        match read_frame(conn) {
            Ok(msg) => match msg.get("type").and_then(|v| v.as_str()) {
                Some("stream") => {
                    let kind = msg
                        .get("stream")
                        .and_then(|v| v.as_str())
                        .unwrap_or("stdout");
                    let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    match kind {
                        "stdout" => stdout.push_str(text),
                        _ => stderr.push_str(text),
                    }
                    on_event(kind, text);
                }
                Some("result") => {
                    conn.set_read_timeout(None).ok();
                    let mut result = parse_run_result(msg);
                    result.stdout = std::mem::take(&mut stdout);
                    result.stderr = std::mem::take(&mut stderr);
                    return Ok(result);
                }
                _ => {} // ignore stray pong / hello-ok frames
            },
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {
                return Ok(RunResult {
                    status: "timeout".to_string(),
                    exec_count: None,
                    stdout: std::mem::take(&mut stdout),
                    stderr: std::mem::take(&mut stderr),
                    outputs: Vec::new(),
                    error: Some(KernelError {
                        ename: "Timeout".to_string(),
                        evalue: format!(
                            "Cell execution timed out after {}s — the kernel was stopped",
                            timeout_secs.unwrap_or(0)
                        ),
                        traceback: Vec::new(),
                    }),
                    elapsed_ms: 0,
                });
            }
            Err(e) => return Err(format!("Kernel connection lost: {}", e)),
        }
    }
}

fn parse_run_result(msg: serde_json::Value) -> RunResult {
    let outputs = msg
        .get("outputs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    Some(KernelOutput {
                        kind: o.get("kind")?.as_str()?.to_string(),
                        mime: o
                            .get("mime")
                            .and_then(|v| v.as_str())
                            .unwrap_or("text/plain")
                            .to_string(),
                        data: o
                            .get("data")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let error = msg
        .get("error")
        .and_then(|v| v.as_object())
        .map(|e| KernelError {
            ename: e
                .get("ename")
                .and_then(|v| v.as_str())
                .unwrap_or("Error")
                .to_string(),
            evalue: e
                .get("evalue")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            traceback: e
                .get("traceback")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
        });
    RunResult {
        status: msg
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("ok")
            .to_string(),
        exec_count: msg.get("exec_count").and_then(|v| v.as_u64()),
        stdout: String::new(),
        stderr: String::new(),
        outputs,
        error,
        elapsed_ms: msg.get("elapsed_ms").and_then(|v| v.as_u64()).unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Interrupt support
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn send_sigint(pid: u32) -> Result<(), String> {
    // SAFETY: kill() with SIGINT only signals the kernel process; it cannot
    // corrupt memory. EINTR/EPERM are surfaced as errors.
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) };
    if rc != 0 {
        Err("Failed to send SIGINT to kernel".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn send_sigint(_pid: u32) -> Result<(), String> {
    Err("Interrupt is not supported on this platform".to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn kernel_start(
    app: AppHandle,
    kernel_id: String,
    python_path: String,
    cwd: String,
) -> Result<KernelInfo, String> {
    let state = app.state::<KernelState>();

    println!(
        "[pykernel] starting kernel '{}' python={} cwd={}",
        kernel_id, python_path, cwd
    );

    // Stop any existing kernel with the same id (restart semantics).
    {
        let mut instances = state.instances.lock().unwrap();
        if let Some(mut old) = instances.remove(&kernel_id) {
            println!("[pykernel] killing previous instance of '{}'", kernel_id);
            old.kill();
        }
    }

    let spawned = spawn_kernel(&python_path, &cwd);
    let mut proc = match spawned {
        Ok(p) => {
            println!(
                "[pykernel] kernel '{}' handshake ok — pid={} python={}",
                kernel_id,
                p.child.id(),
                p.python_version
            );
            p
        }
        Err(e) => {
            eprintln!("[pykernel] kernel '{}' START FAILED: {}", kernel_id, e);
            return Err(e);
        }
    };
    let pid = proc.child.id();

    // Drain the kernel's stderr so it can never block on a full pipe, and
    // detect process death (EOF) → "kernel-died" event. The kernel itself
    // never writes protocol data to stderr, so this is purely diagnostic.
    if let Some(mut stderr_pipe) = proc.child.stderr.take() {
        let app2 = app.clone();
        let kid = kernel_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match stderr_pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {} // kernel-internal noise; intentionally discarded
                }
            }
            let _ = app2.emit(
                "kernel-died",
                KernelDiedEvent {
                    kernel_id: kid,
                    pid,
                },
            );
        });
    }

    let info = KernelInfo {
        pid,
        python_version: proc.python_version,
    };

    state.instances.lock().unwrap().insert(
        kernel_id,
        KernelInstance {
            child: proc.child,
            conn: Arc::new(Mutex::new(proc.stream)),
            python_path,
            cwd,
        },
    );

    Ok(info)
}

#[tauri::command]
pub fn kernel_run(
    app: AppHandle,
    kernel_id: String,
    run_id: String,
    code: String,
    timeout_secs: Option<u64>,
) -> Result<RunResult, String> {
    let state = app.state::<KernelState>();
    let conn = {
        let instances = state.instances.lock().unwrap();
        instances
            .get(&kernel_id)
            .ok_or_else(|| "Kernel is not running — connect first".to_string())?
            .conn
            .clone()
    };
    let mut conn = conn.lock().map_err(|_| "Kernel connection poisoned")?;

    println!(
        "[pykernel] run in '{}' ({} bytes of code)",
        kernel_id,
        code.len()
    );

    let app2 = app.clone();
    let kid = kernel_id.clone();
    let rid = run_id.clone();
    let result = run_on_conn(
        &mut conn,
        &run_id,
        &code,
        timeout_secs,
        move |kind, text| {
            let _ = app2.emit(
                "kernel-output",
                KernelStreamEvent {
                    kernel_id: kid.clone(),
                    run_id: rid.clone(),
                    kind: kind.to_string(),
                    text: text.to_string(),
                },
            );
        },
    );
    match &result {
        Ok(r) => println!(
            "[pykernel] run in '{}' finished: status={} outputs={} stdout={}B stderr={}B {}ms",
            kernel_id,
            r.status,
            r.outputs.len(),
            r.stdout.len(),
            r.stderr.len(),
            r.elapsed_ms
        ),
        Err(e) => eprintln!("[pykernel] run in '{}' FAILED: {}", kernel_id, e),
    }
    result
}

#[tauri::command]
pub fn kernel_interrupt(app: AppHandle, kernel_id: String) -> Result<(), String> {
    let state = app.state::<KernelState>();
    let pid = {
        let instances = state.instances.lock().unwrap();
        instances.get(&kernel_id).map(|i| i.child.id())
    };
    match pid {
        Some(pid) => {
            println!("[pykernel] SIGINT → kernel '{}' (pid {})", kernel_id, pid);
            send_sigint(pid)
        }
        None => Err("Kernel is not running".to_string()),
    }
}

#[tauri::command]
pub fn kernel_stop(app: AppHandle, kernel_id: String) -> Result<(), String> {
    println!("[pykernel] stopping kernel '{}'", kernel_id);
    let state = app.state::<KernelState>();
    let mut instances = state.instances.lock().unwrap();
    if let Some(mut inst) = instances.remove(&kernel_id) {
        inst.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn kernel_status(app: AppHandle, kernel_id: String) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let mut instances = state.instances.lock().unwrap();
    match instances.get_mut(&kernel_id) {
        Some(inst) => {
            let running = matches!(inst.child.try_wait(), Ok(None));
            Ok(KernelStatus {
                running,
                pid: Some(inst.child.id()),
                python_path: Some(inst.python_path.clone()),
            })
        }
        None => Ok(KernelStatus {
            running: false,
            pid: None,
            python_path: None,
        }),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_frame_roundtrip() {
        let mut buf = Vec::new();
        let value = json!({"type": "run", "id": "abc", "code": "print(1)\n\"é\""});
        write_frame(&mut buf, &value).unwrap();
        let mut cursor = Cursor::new(buf);
        let read_back = read_frame(&mut cursor).unwrap();
        assert_eq!(read_back, value);
    }

    #[test]
    fn test_read_frame_rejects_oversized() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME as u32 + 1).to_be_bytes());
        let mut cursor = Cursor::new(buf);
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn test_read_frame_eof() {
        let mut cursor = Cursor::new(vec![0u8; 2]);
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
    }

    #[test]
    fn test_parse_run_result_ok() {
        let msg = json!({
            "type": "result",
            "status": "ok",
            "exec_count": 3,
            "outputs": [
                {"kind": "result", "mime": "text/plain", "data": "42"},
                {"kind": "display", "mime": "image/png", "data": "aGk="}
            ],
            "error": null,
            "elapsed_ms": 7
        });
        let result = parse_run_result(msg);
        assert_eq!(result.status, "ok");
        assert_eq!(result.exec_count, Some(3));
        assert_eq!(result.outputs.len(), 2);
        assert_eq!(result.outputs[0].mime, "text/plain");
        assert_eq!(result.outputs[1].kind, "display");
        assert!(result.error.is_none());
        assert_eq!(result.elapsed_ms, 7);
    }

    #[test]
    fn test_parse_run_result_error() {
        let msg = json!({
            "type": "result",
            "status": "error",
            "exec_count": 1,
            "outputs": [],
            "error": {"ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": ["Traceback", "ZeroDivisionError: division by zero"]},
            "elapsed_ms": 2
        });
        let result = parse_run_result(msg);
        assert_eq!(result.status, "error");
        let err = result.error.unwrap();
        assert_eq!(err.ename, "ZeroDivisionError");
        assert_eq!(err.traceback.len(), 2);
    }

    // ---- End-to-end kernel test (requires a system python3) ----------------

    fn find_system_python() -> Option<String> {
        for candidate in ["python3", "python"] {
            let ok = Command::new(candidate)
                .arg("-c")
                .arg("import sys; print(sys.executable)")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ok {
                return Some(candidate.to_string());
            }
        }
        None
    }

    #[test]
    fn test_kernel_exec_roundtrip() {
        let Some(python) = find_system_python() else {
            eprintln!("skipping: no system python found");
            return;
        };
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let mut proc = spawn_kernel(&python, &cwd).expect("kernel spawn failed");

        // 1. stdout + persistent state + trailing expression result
        let mut events: Vec<(String, String)> = Vec::new();
        let result = run_on_conn(
            &mut proc.stream,
            "r1",
            "x = 1 + 1\nprint('hi')\nx",
            None,
            |k, t| events.push((k.to_string(), t.to_string())),
        )
        .expect("run failed");
        assert_eq!(result.status, "ok");
        assert_eq!(result.stdout, "hi\n");
        assert_eq!(result.exec_count, Some(1));
        let text = result
            .outputs
            .iter()
            .find(|o| o.mime == "text/plain")
            .expect("no text/plain result");
        assert_eq!(text.data, "2");
        assert!(events.iter().any(|(k, t)| k == "stdout" && t == "hi"));

        // 2. state persists across cells
        let result =
            run_on_conn(&mut proc.stream, "r2", "x * 10", None, |_, _| {}).expect("run 2 failed");
        assert_eq!(result.status, "ok");
        assert_eq!(result.outputs[0].data, "20");

        // 3. errors are reported, kernel survives
        let result =
            run_on_conn(&mut proc.stream, "r3", "1 / 0", None, |_, _| {}).expect("run 3 failed");
        assert_eq!(result.status, "error");
        let err = result.error.unwrap();
        assert_eq!(err.ename, "ZeroDivisionError");
        assert!(!err.traceback.is_empty());

        // 4. syntax errors are reported
        let result =
            run_on_conn(&mut proc.stream, "r4", "def (:", None, |_, _| {}).expect("run 4 failed");
        assert_eq!(result.status, "error");
        assert_eq!(result.error.unwrap().ename, "SyntaxError");

        // 5. stderr capture
        let result = run_on_conn(
            &mut proc.stream,
            "r5",
            "import sys\nsys.stderr.write('oops')",
            None,
            |_, _| {},
        )
        .expect("run 5 failed");
        assert_eq!(result.status, "ok");
        assert_eq!(result.stderr, "oops");

        // 6. kernel still alive after errors
        let result =
            run_on_conn(&mut proc.stream, "r6", "40 + 2", None, |_, _| {}).expect("run 6 failed");
        assert_eq!(result.status, "ok");
        assert_eq!(result.outputs[0].data, "42");

        let _ = proc.child.kill();
    }
}
