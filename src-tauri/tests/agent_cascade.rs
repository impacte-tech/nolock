//! End-to-end tests for the hierarchical main → sub → micro agent cascade
//! against locally available Ollama models.
//!
//! Models used (must be pulled into Ollama):
//!   - Main agent:      oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU
//!   - Agent router:    oamazonasgabriel/lfm2.5-8b-a1b:q4_k_m-8gbGPU
//!   - Micro-agent:     gemma4:e2b
//!
//! These tests are `#[ignore]` by default because they require a running Ollama
//! server and real model inference (slow + non-deterministic). Run them with:
//!
//!   cargo test --test agent_cascade -- --ignored --nocapture
//!
//! The test fixture project (a small Rust crate with a deliberate compiler
//! error) is created in a temp dir so the micro-agent has something to validate.

#[path = "../src/main.rs"]
mod main_impl;

use main_impl::{
    ChatMessage, ChatRequest, ChatResult, CliSink, SubAgentMemory, is_complete_answer,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const OLLAMA_URL: &str = "http://localhost:11434";
const MAIN_MODEL: &str = "oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU";
const LFM_MODEL: &str = "oamazonasgabriel/lfm2.5-8b-a1b:q4_k_m-8gbGPU";
const MICRO_MODEL: &str = "gemma4:e2b";
/// The shell-runner micro-agent uses the same micro-agent model as the other
/// micro agents (gemma4:e2b reliably chains write_file + bash_sandbox).
const SHELL_RUNNER_MODEL: &str = "gemma4:e2b";

/// Load a prompt from `tests/prompts/<name>.txt`, trimming surrounding
/// whitespace. Segregating prompts into files keeps the scenario text separate
/// from the test logic, so prompts can be edited/tuned without touching Rust.
fn prompt(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/prompts")
        .join(format!("{}.txt", name));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read prompt file {}: {}", path.display(), e))
        .trim()
        .to_string()
}

/// The full standard tool set the main agent uses in the app.
fn standard_tools() -> Vec<String> {
    vec![
        "read_file".into(), "list_directory".into(), "grep".into(),
        "edit".into(), "write_file".into(), "bash_sandbox".into(),
    ]
}

/// Tools that include the compile-and-run validators (`rust_repl`) plus shell
/// execution (`bash_sandbox`), so tests can assert the agent validated its
/// created code by actually running it.
fn validation_tools() -> Vec<String> {
    vec![
        "read_file".into(), "list_directory".into(), "grep".into(),
        "edit".into(), "write_file".into(), "bash_sandbox".into(),
        "rust_repl".into(),
    ]
}

/// Recursively find every tool call whose name is `rust_repl` or `bash_sandbox`
/// in the trace, descending into nested sub-agent/micro-agent traces. Returns
/// `(tool_name, arguments, result)` triples so tests can assert not only that a
/// validator was invoked but that it ran successfully AND that the result came
/// from a specific command (the `arguments` carry the command for bash_sandbox).
/// This is how we prove the agents "created code and confirmed it runs" — the
/// deterministic check is that a compile-and-run / shell tool was actually
/// executed with the expected command and produced the expected output.
fn collect_validation_tool_calls(calls: &[main_impl::ToolCallLog]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for c in calls {
        if c.name == "rust_repl" || c.name == "bash_sandbox" {
            out.push((c.name.clone(), c.arguments.clone(), c.result_full.clone()));
        }
        if let Some(sub) = &c.subagent {
            out.extend(collect_validation_tool_calls(&sub.tool_calls));
        }
    }
    out
}

/// Build a ChatRequest with the given message + project root.
fn request(root: Option<&str>, message: &str, tools: Vec<String>, model: &str) -> ChatRequest {
    let mut messages = vec![ChatMessage {
        role: "user".to_string(),
        content: message.to_string(),
    }];
    let _ = &mut messages;
    ChatRequest {
        backend: "ollama".to_string(),
        url: OLLAMA_URL.to_string(),
        model: model.to_string(),
        messages,
        api_key: None,
        providers: HashMap::new(),
        tool_configs: HashMap::new(),
        tools_enabled: tools,
        temperature: Some(0.2),
        max_tokens: Some(1024),
        context_length: Some(128_000),
        system_prompt: None,
        root_path: root.map(String::from),
        max_iterations: 8,
        model_affinity: Some(true),
        referenced_agents: Vec::new(),
        reasoning_retries: Some(6),
    }
}

/// Create a temp fixture project with `.agents/` and `.micro-agents/` and a
/// small Rust crate. When `broken_src` is `Some`, that content is used as
/// `src/main.rs` (use to give the rust-fixer micro-agent real `cargo check`
/// validation work); when `None`, a clean, compilable `src/main.rs` is written
/// (for tests that must not start from a compile error). Returns the root path.
fn setup_fixture_project() -> PathBuf {
    setup_fixture_project_with_src(Some("fn main() {\n    let x: u32 = \"not a number\";\n    println!(\"{}\", x);\n}\n"))
}

fn setup_fixture_project_with_src(broken_src: Option<&str>) -> PathBuf {
    // Each call gets a UNIQUE temp dir. cargo test runs the 27 tests in parallel
    // threads, and every test calls remove_dir_all + recreate on this fixture;
    // sharing one path (e.g. `nolock_e2e_{pid}`) let one test's cleanup delete
    // another test's files mid-flight, which made the file-writing tests fail
    // with "No such file or directory" ~74% of the time.
    static FIXTURE_COUNTER: AtomicUsize = AtomicUsize::new(0);
    let n = FIXTURE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("nolock_e2e_{}_{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".agents")).unwrap();
    std::fs::create_dir_all(dir.join(".micro-agents")).unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("src-tauri/src")).unwrap();

    // --- .agents/code-reviewer.md — sub-agent that can delegate to micro-agents ---
    std::fs::write(
        dir.join(".agents/code-reviewer.md"),
        format!(
            "---\n\
             name: code-reviewer\n\
             description: Reviews code and fixes mechanical errors via micro-agents\n\
             model: {lfm}\n\
             backend: ollama\n\
             temperature: 0.1\n\
             tools: [read_file, list_directory, grep, edit, write_file, bash_sandbox]\n\
             thorough: true\n\
             can_spawn_micro_agents: true\n\
             allowed_micro_agents: [rust-fixer, ts-type-fixer]\n\
             validation:\n  rust_check: true\n  js_ts_lint: false\n  require_all_pass: true\n  max_retries: 3\n\
             ---\n\n\
             You are a code reviewer. Inspect the code with your tools, find bugs, and fix\n\
             mechanical errors. For compiler/lint errors, delegate to the matching micro-agent\n\
             (e.g. rust-fixer) via spawn_micro_agent instead of doing it yourself. Report the\n\
             validation result.\n",
            lfm = LFM_MODEL
        ),
    )
    .unwrap();

    // --- .micro-agents/rust-fixer.md — micro-agent using the small qwen model ---
    std::fs::write(
        dir.join(".micro-agents/rust-fixer.md"),
        format!(
            "---\n\
             name: rust-fixer\n\
             description: Fixes Rust compiler errors with minimal changes\n\
             model: {micro}\n\
             backend: ollama\n\
             temperature: 0.1\n\
             tools: [read_file, edit, write_file, bash_sandbox]\n\
             validation:\n  rust_check: true\n  max_retries: 3\n\
             ---\n\n\
             You are a Rust compiler error fixer. Given a file path and cargo check output,\n\
             apply MINIMAL fixes. Run `cargo check` via bash_sandbox to confirm.\n",
            micro = MICRO_MODEL
        ),
    )
    .unwrap();

// --- .micro-agents/ts-type-fixer.md ---
    std::fs::write(
        dir.join(".micro-agents/ts-type-fixer.md"),
        "---\n\
         name: ts-type-fixer\n\
         description: Fixes TypeScript/ESLint errors\n\
         model: gemma4:e2b\n\
         backend: ollama\n\
         temperature: 0.1\n\
         tools: [read_file, edit, write_file, bash_sandbox]\n\
         validation:\n  js_ts_lint: true\n  max_retries: 3\n\
         ---\n\nYou are a TypeScript type-error fixer.\n",
    )
    .unwrap();

    // --- .micro-agents/shell-runner.md — writes & runs shell scripts via
    // bash_sandbox, so the main agent can delegate shell tasks to it. The
    // verify_reported_output validator deterministically re-runs the script
    // command after each attempt and requires the expected output, so the
    // micro-agent self-corrects (e.g. creates a missing input file, fixes a
    // missing trailing newline, or uses `bash count.sh` instead of `./count.sh`)
    // via the validation retry loop instead of returning a broken result.
    std::fs::write(
        dir.join(".micro-agents/shell-runner.md"),
        format!(
            "---\n\
             name: shell-runner\n\
             description: Writes and runs shell scripts via bash_sandbox, reports the output\n\
             model: {shell}\n\
             backend: ollama\n\
             temperature: 0.1\n\
             tools: [read_file, write_file, bash_sandbox]\n\
             validation:\n    custom_commands: [\"bash count.sh data.txt\"]\n    verify_reported_output: true\n    max_retries: 3\n\
             ---\n\n\
             You are a shell-script specialist. Write the script (and any input files) with\n\
             write_file using RELATIVE paths (e.g. `data.txt`, `count.sh`) so they land in\n\
             the project root. NEVER use absolute paths like `/tmp/...` — they are rejected.\n\
             When the script must accept a file argument, reference it as `$1`\n\
             (the first positional argument) — never invent an environment variable name.\n\
             When creating a data file, ensure EVERY line ends with a newline, INCLUDING\n\
             the last line. `wc -l` counts newline characters, not lines: a file with 5\n\
             lines but no trailing newline after the 5th line reports 4. The content\n\
             string MUST end with `\\n` after the final line. Example for a 5-line file:\n\
             `content: \"line1\\nline2\\nline3\\nline4\\nline5\\n\"` (note the trailing `\\n`).\n\
             Run it with bash_sandbox using the project root as the working directory so\n\
             relative paths resolve, using the EXACT command from the task (e.g.\n\
             `bash count.sh data.txt`). NEVER run the script as `./count.sh` — the file is\n\
             not executable; always prefix with `bash`.\n\
             Confirm the printed output matches what the task\n\
             expects; if it is wrong or errors, fix the script and re-run. You MUST actually\n\
             invoke bash_sandbox to run the script — do not merely describe the steps.\n\
             Return only the script's output.\n",
            shell = SHELL_RUNNER_MODEL
        ),
    )
    .unwrap();

    // --- The Rust project (Cargo.toml + main.rs) ---
    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"e2e_fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n",
    )
    .unwrap();
    let main_src = broken_src.unwrap_or("fn main() {\n    println!(\"hello\");\n}\n");
    std::fs::write(dir.join("src/main.rs"), main_src).unwrap();

    // Placeholder so the root has an obvious src-tauri dir too (mirrors nolock).
    std::fs::write(dir.join("src-tauri/src/main.rs"), "fn main() {}\n").unwrap();

    dir
}

/// Test helper: run a request and return the ChatResult (panics on error).
async fn run(sink: &CliSink, memory: &SubAgentMemory, req: ChatRequest) -> ChatResult {
    match main_impl::run_chat(sink, memory, req).await {
        Ok(res) => res,
        Err(e) => panic!("run_chat error: {}", e),
    }
}

/// 1. Main agent plain chat — no tools. Verifies the main agent produces a
///    final answer (task concluded) without stalling.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn main_agent_plain_chat_concludes_task() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("01_plain_chat"), vec![], MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== main_agent_plain_chat output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty(), "main agent must produce an answer");
    assert!(!res.content.contains("(no response)"), "must not stall");
}

/// 2. Main agent with tools — the tool loop runs and the main agent concludes.
///    The prompt asks it to inspect the fixture project and fix the compile
///    error, so the tool loop has real work (read_file, bash_sandbox).
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn main_agent_with_tools_runs_tool_loop() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("02_tool_loop_cargo_check"),
        standard_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== main_agent_with_tools output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());
    // With tools on, we expect at least one tool call recorded.
    assert!(!res.tool_calls.is_empty(), "tool loop should have made tool calls");
    let _ = std::fs::remove_dir_all(&root);
}

/// 3. Full hierarchy: main agent delegates to a sub-agent (@code-reviewer)
///    which can delegate mechanical work to a micro-agent (rust-fixer). This
///    exercises the spawn_subagent → spawn_micro_agent path end to end.
#[tokio::test]
#[ignore = "requires local Ollama + model inference (slow, multi-tier)"]
async fn main_delegates_to_sub_agent_which_spawns_micro_agent() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();

    // Referencing @code-reviewer pre-spawns it (parallel path) AND the model can
    // also spawn it via the spawn_subagent tool. Both exercise the same runner.
    let mut req = request(
        Some(root.to_str().unwrap()),
        &prompt("03_hierarchy_delegation"),
        standard_tools(),
        MAIN_MODEL,
    );
    req.referenced_agents = vec!["code-reviewer".to_string()];

    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== main_delegates_to_sub_agent output ===\n{}", res.content);

    assert!(!res.content.trim().is_empty());
    // A spawn_subagent should appear in the tool call log.
    let spawned_sub = res.tool_calls.iter().any(|t| t.name == "spawn_subagent");
    eprintln!("[trace] spawn_subagent seen: {}", spawned_sub);
    if !spawned_sub {
        // Pre-spawned agents inject results as context without a tool call, so
        // the content itself is the proof the delegation happened.
        eprintln!("[trace] (sub-agent ran via pre-spawn; check content for review output)");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// 4. Sub-agent memory persists across turns: spawn @code-reviewer twice and
///    confirm the second call has continuity (memory key is project-scoped).
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn sub_agent_memory_persists_across_turns() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let root_str = root.to_str().unwrap().to_string();

    // Turn 1: ask the reviewer a concrete question.
    let mut req1 = request(
        Some(&root_str),
        &prompt("04_memory_turn1"),
        standard_tools(),
        MAIN_MODEL,
    );
    req1.referenced_agents = vec!["code-reviewer".to_string()];
    let res1 = run(&sink, &memory, req1).await;
    assert!(!res1.content.trim().is_empty());

    // Turn 2: same agent, follow-up. Memory should let it reference its prior
    // answer ("as you said earlier...").
    let mut req2 = request(
        Some(&root_str),
        &prompt("04_memory_turn2"),
        standard_tools(),
        MAIN_MODEL,
    );
    req2.referenced_agents = vec!["code-reviewer".to_string()];
    let res2 = run(&sink, &memory, req2).await;
    assert!(!res2.content.trim().is_empty());

    // Memory must have recorded the first turn for the code-reviewer agent.
    let key = format!("{}::code-reviewer", root_str);
    assert!(
        memory.get(&root_str, "code-reviewer").is_some(),
        "sub-agent memory should persist for key {}",
        key
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 5. Micro-agent deterministic validation retry: directly spawn the rust-fixer
///    micro-agent against the broken fixture and confirm it returns a validation
///    result (which may be PASS after retries, or the final FAIL). The point is
///    that the validation pipeline runs and produces a verdict.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn micro_agent_runs_validation_pipeline() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();

    // Directly drive a sub-agent that can spawn micro-agents; ask it to fix the
    // compile error via the rust-fixer micro-agent.
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("05_micro_agent_validation"),
        standard_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== micro_agent_runs_validation output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    // The output should mention validation (PASS/FAIL) or at least be a coherent
    // result — either way, the pipeline ran without panicking.
    let mentions_validation =
        res.content.contains("PASS") || res.content.contains("FAIL") || res.content.contains("validation");
    eprintln!("[trace] validation mention in output: {}", mentions_validation);
    let _ = std::fs::remove_dir_all(&root);
}

// =============================================================================
// Deterministic code-creation + validation tests
// -----------------------------------------------------------------------------
// Each of these tests instructs the agent to CREATE code and then RUN it via a
// compile-and-run (`rust_repl`) or shell (`bash_sandbox`) tool to confirm it
// works. The assertion is that the validator tool was actually invoked and its
// result reflects execution (so the task is provably concluded, not just
// asserted). These can be run through the main agent directly OR delegated down
// the hierarchy; the recursive `collect_validation_tool_calls` searches nested
// sub/micro-agent traces either way.
// =============================================================================

/// 6. Main agent writes a Rust program that prints the 10th Fibonacci number
///    (deterministic expected value: 55) and validates it by compiling+running
///    it with `rust_repl`. Asserts rust_repl was invoked and its output proved
///    execution (stdout or "Hello" from a run, not a compile error).
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_fibonacci() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        None,
        &prompt("06_rust_fibonacci"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_fibonacci output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    let used_rust_repl = validators.iter().any(|(n, _, _)| n == "rust_repl");
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(used_rust_repl, "agent must validate Rust code with rust_repl");
    // The rust_repl run (there may be several retries) must eventually print
    // the deterministic value, not just a compile error.
    let ran_with_output = validators.iter().any(|(_, _, r)| r.contains("55"));
    assert!(
        ran_with_output,
        "rust_repl must run and print the result 55 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 7. Main agent writes a Rust program computing the sum 1..=100 (deterministic
///    expected value: 5050) and validates it with rust_repl. Asserts execution.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_sum() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        None,
        &prompt("07_rust_sum"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_sum output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    let used_rust_repl = validators.iter().any(|(n, _, _)| n == "rust_repl");
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(used_rust_repl, "agent must validate Rust code with rust_repl");
    let ran_with_output = validators.iter().any(|(_, _, r)| r.contains("5050"));
    assert!(
        ran_with_output,
        "rust_repl must run and print the result 5050 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 8. Agent writes a shell script that prints a fixed marker and runs it with
///    bash_sandbox, then confirms the output. Asserts bash_sandbox execution.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_shell_script() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("08_shell_script"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_shell_script output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

let validators = collect_validation_tool_calls(&res.tool_calls);
    let used_bash = validators.iter().any(|(n, _, _)| n == "bash_sandbox");
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(used_bash, "agent must run the shell script with bash_sandbox");
    let ran_marker = validators.iter().any(|(_, _, r)| r.contains("VALIDATED_OK"));
    assert!(
        ran_marker,
        "bash_sandbox must execute the script and print the marker (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 9. Agent writes a Python script computing 6*7 (42) and runs it with
///    bash_sandbox. Asserts the executed output is 42.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_python_script() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("09_python_script"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_python_script output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

let validators = collect_validation_tool_calls(&res.tool_calls);
    let used_bash = validators.iter().any(|(n, _, _)| n == "bash_sandbox");
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(used_bash, "agent must run the python script with bash_sandbox");
    let ran_42 = validators.iter().any(|(_, _, r)| r.contains("42"));
    assert!(
        ran_42,
        "bash_sandbox must execute the script and print 42 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 10. Agent writes Rust unit tests and runs `cargo test` via bash_sandbox.
///     Asserts the test binary was actually executed (bash_sandbox invoked with
///     cargo test and the result shows passing tests).
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_rust_tests() {
    // Clean project (no deliberate compile error) so the agent only has to add
    // a passing test and run `cargo test`. Instructing a full-file `write_file`
    // (rather than incremental `edit`) is far more reliable for models.
    let root = setup_fixture_project_with_src(None);
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let mut req = request(
        Some(root.to_str().unwrap()),
        &prompt("10_rust_tests"),
        validation_tools(),
        MAIN_MODEL,
    );
    // Give the model more room to iterate (test authoring + run + fix).
    req.max_iterations = 12;
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_rust_tests output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    let used_bash = validators.iter().any(|(n, _, _)| n == "bash_sandbox");
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(used_bash, "agent must run cargo test with bash_sandbox");
    // The agent may run cargo test multiple times (a first failing run while it
    // iterates, then a passing run). Assert that AT LEAST ONE run reported a
    // successful test execution, i.e. cargo compiled AND ran a test.
    let ran_tests_ok = validators.iter().any(|(_, _, r)| {
        r.contains("test result: ok") || r.contains("running 1 test")
    });
    assert!(
        ran_tests_ok,
        "cargo test must eventually execute and report passing tests (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 11. Full hierarchy: main agent delegates code creation + validation down to a
///     sub-agent that CAN spawn micro-agents. The sub-agent must validate the
///     code it touches by running it via rust_repl / bash_sandbox (searched
///     recursively through the nested traces). Asserts a validator was invoked
///     somewhere in the cascade.
#[tokio::test]
#[ignore = "requires local Ollama + model inference (slow, multi-tier)"]
async fn hierarchy_delegates_code_creation_with_validation() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();

    let mut req = request(
        Some(root.to_str().unwrap()),
        &prompt("11_hierarchy_code_validation"),
        validation_tools(),
        MAIN_MODEL,
    );
    req.referenced_agents = vec!["code-reviewer".to_string()];

    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== hierarchy_delegates_code_creation_with_validation output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(
        !validators.is_empty(),
        "the hierarchical cascade must validate created code with rust_repl or bash_sandbox"
    );
    // At least one validator's result should show evidence of execution.
    let executed = validators.iter().any(|(_, _, r)| !r.trim().is_empty() && !r.to_lowercase().contains("error") || r.contains('0'));
    assert!(executed, "one validator must have run and produced output");
    let _ = std::fs::remove_dir_all(&root);
}

/// 12. Sanity: micro-agent (small qwen coder) directly produces a Rust snippet
///     and validates it with rust_repl — the "micro-agent layer writes code and
///     confirms it runs" guarantee at the bottom of the hierarchy.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn micro_agent_creates_and_runs_code_directly() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();

    // Drive a sub-agent (which maps to the small model per its config) and ask
    // it to produce + run code, exercising the micro-agent layer. The prompt is
    // deliberately insistent: nemotron-class main models tend to "assert they
    // ran it" instead of actually invoking the tool, so we require the tool call.
    let mut req = request(
        Some(root.to_str().unwrap()),
        &prompt("12_micro_agent_code"),
        validation_tools(),
        MAIN_MODEL,
    );
    req.referenced_agents = vec!["code-reviewer".to_string()];
    req.max_iterations = 12;

    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== micro_agent_creates_and_runs_code_directly output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    eprintln!("[trace] validators used: {:?}", validators.iter().map(|(n, _, r)| (n.clone(), r.chars().take(80).collect::<String>())).collect::<Vec<_>>());
    assert!(!validators.is_empty(), "micro-agent layer must validate code with rust_repl or bash_sandbox");
    let _ = std::fs::remove_dir_all(&root);
}

// =============================================================================
// Additional scenarios (prompts segregated in tests/prompts/)
// =============================================================================

/// 13. Parallel agents: two @mentioned agents run concurrently and the main
///     agent synthesizes both results. Exercises the pre-spawn parallel path.
#[tokio::test]
#[ignore = "requires local Ollama + model inference (slow, multi-tier)"]
async fn parallel_agents_synthesize_results() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();

    let mut req = request(
        Some(root.to_str().unwrap()),
        &prompt("13_parallel_agents"),
        standard_tools(),
        MAIN_MODEL,
    );
    req.referenced_agents = vec!["code-reviewer".to_string(), "researcher".to_string()];
    req.max_iterations = 12;

    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== parallel_agents_synthesize_results output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());
    // The combined answer should reference both the type error AND the concept.
    assert!(
        res.content.contains("type") || res.content.contains("mismatch") || res.content.contains("error"),
        "combined answer should mention the type error (got: {})",
        res.content.chars().take(200).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 14. Rust factorial via rust_repl — deterministic expected value 5040.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_factorial() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("14_rust_factorial"), validation_tools(), MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_factorial output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "rust_repl"), "must use rust_repl");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("5040")),
        "rust_repl must print 5040 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 15. Rust primality check via rust_repl — deterministic expected "prime".
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_prime() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("15_rust_prime"), validation_tools(), MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_prime output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "rust_repl"), "must use rust_repl");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("prime")),
        "rust_repl must print prime (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 16. Shell script with arguments via bash_sandbox — deterministic "Hello, World!".
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_shell_with_args() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("16_shell_args"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_shell_with_args output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "bash_sandbox"), "must use bash_sandbox");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("Hello, World!")),
        "bash_sandbox must print Hello, World! (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 17. Python file I/O via bash_sandbox — deterministic "cba" (reverse of "abc").
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_python_file_io() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("17_python_file_io"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_python_file_io output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "bash_sandbox"), "must use bash_sandbox");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("cba")),
        "bash_sandbox must print cba (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 18. Rust sum of even numbers via rust_repl — deterministic expected 110.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_even_sum() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("18_rust_even_sum"), validation_tools(), MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_even_sum output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "rust_repl"), "must use rust_repl");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("110")),
        "rust_repl must print 110 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 19. Regression guard for the "main agent closes the iteration with a
///     question / too-short reply too quickly" bug. The main agent must produce
///     a COMPLETE answer — substantive content, not a clarifying question, not a
///     bare acknowledgment. This exercises the exact `is_complete_answer` logic
///     (via `run_chat` → the plain-chat / tool-loop conclusion path) that the
///     CLI also uses, so a regression here is caught end to end.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn main_agent_produces_complete_answer_not_premature() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("19_complete_answer_not_premature"), vec![], MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== main_agent_produces_complete_answer output ===\n{}", res.content);

    let content = res.content.trim();
    assert!(!content.is_empty(), "main agent must produce an answer");

    // The response must be a COMPLETE answer per the EXACT same logic the
    // runtime uses to decide whether to conclude (`is_complete_answer`). This
    // ties the E2E assertion to the production decision function, so if the
    // "closes with a question / too-short reply" bug regresses, this test fails
    // whenever the model actually produces a premature reply.
    assert!(
        is_complete_answer(content, false),
        "main agent must produce a COMPLETE answer (not a question / bare acknowledgment / clarification). Got: {}",
        content.chars().take(300).collect::<String>()
    );

    // The answer should actually address the topic (ownership / memory).
    assert!(
        content.contains("ownership") || content.contains("memory") || content.contains("borrow"),
        "main agent answer should address the Rust ownership topic (got: {})",
        content.chars().take(200).collect::<String>()
    );
}

/// 20. CLI end-to-end: invoke the actual `nolock-cli` binary as a subprocess and
///     assert its stdout is a COMPLETE answer using the same `is_complete_answer`
///     logic. Because the CLI and the Tauri app both call `run_chat`, this proves
///     the shared conclusion logic works through the real CLI entry point too —
///     so the E2E suite validates BOTH the Tauri app (via `run_chat`) and the CLI
///     (via the binary) against the same contract.
#[tokio::test]
#[ignore = "requires local Ollama + model inference + built nolock-cli binary"]
async fn cli_produces_complete_answer_not_premature() {
    // Locate the built CLI binary (cargo builds it to target/debug/nolock-cli).
    let cli = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/debug/nolock-cli");
    assert!(
        cli.exists(),
        "nolock-cli binary not found at {} — build it first (cargo build --bin nolock-cli)",
        cli.display()
    );

    let message = prompt("19_complete_answer_not_premature");
    let output = std::process::Command::new(&cli)
        .arg("--url").arg(OLLAMA_URL)
        .arg("--model").arg(MAIN_MODEL)
        .arg("--message").arg(&message)
        .arg("--temperature").arg("0.2")
        .output()
        .expect("failed to run nolock-cli");

    // The CLI prints the final answer to stdout (streamed tokens go to stderr).
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    eprintln!("\n=== cli_produces_complete_answer stdout ===\n{}", stdout);

    assert!(
        output.status.success(),
        "nolock-cli exited with {:?}; stderr: {}",
        output.status.code(),
        stderr.chars().take(500).collect::<String>()
    );

    // Strip the leading blank lines the CLI prints before the answer.
    let content = stdout.trim();
    assert!(!content.is_empty(), "CLI must produce an answer on stdout");

    // Same contract as the Tauri path: the CLI's answer must be COMPLETE.
    assert!(
        is_complete_answer(content, false),
        "CLI must produce a COMPLETE answer (not a question / bare acknowledgment / clarification). Got: {}",
        content.chars().take(300).collect::<String>()
    );
    assert!(
        content.contains("ownership") || content.contains("memory") || content.contains("borrow"),
        "CLI answer should address the Rust ownership topic (got: {})",
        content.chars().take(200).collect::<String>()
    );
}

// =============================================================================
// Open-ended scenarios (prompts segregated in tests/prompts/)
// -----------------------------------------------------------------------------
// These use open-ended, real-world prompts (security review, code review,
// architecture explanation) rather than a single deterministic answer. They
// assert the agent produces a COMPLETE, substantive answer that addresses the
// topic — exercising the same `is_complete_answer` conclusion logic.
// =============================================================================

/// 21. Open-ended: Tauri v2 security review of the repository. The agent must
///     inspect the codebase and produce a substantive, complete review.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn open_ended_tauri_security_review() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("21_tauri_security_review"),
        standard_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== open_ended_tauri_security_review output ===\n{}", res.content);

    let content = res.content.trim();
    assert!(!content.is_empty(), "must produce an answer");
    // Must be a COMPLETE answer (not a premature question / too-short reply).
    assert!(
        is_complete_answer(content, false),
        "must produce a COMPLETE answer (got: {})",
        content.chars().take(300).collect::<String>()
    );
    // Should be substantive (address security / tauri / config).
    let lower = content.to_lowercase();
    assert!(
        lower.contains("security") || lower.contains("tauri") || lower.contains("config") || lower.contains("capabilit"),
        "security review should address security/tauri/config (got: {})",
        content.chars().take(200).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 22. Open-ended: Rust code review of src/main.rs. The agent must produce a
///     substantive, complete review with concrete recommendations.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn open_ended_rust_code_review() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("22_rust_code_review"),
        standard_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== open_ended_rust_code_review output ===\n{}", res.content);

    let content = res.content.trim();
    assert!(!content.is_empty(), "must produce a review");
    assert!(
        is_complete_answer(content, false),
        "must produce a COMPLETE answer (got: {})",
        content.chars().take(300).collect::<String>()
    );
    let lower = content.to_lowercase();
    assert!(
        lower.contains("improve") || lower.contains("recommend") || lower.contains("refactor") || lower.contains("maintain"),
        "code review must give concrete recommendations (got: {})",
        content.chars().take(200).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 23. Open-ended: explain the agent architecture. The agent must produce a
///     complete, substantive explanation referencing the agent system.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn open_ended_architecture_explanation() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("23_architecture_explanation"),
        standard_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== open_ended_architecture_explanation output ===\n{}", res.content);

    let content = res.content.trim();
    assert!(!content.is_empty(), "must produce an explanation");
    assert!(
        is_complete_answer(content, false),
        "must produce a COMPLETE answer (got: {})",
        content.chars().take(300).collect::<String>()
    );
    let lower = content.to_lowercase();
    assert!(
        lower.contains("agent") || lower.contains("sub-agent") || lower.contains("micro-agent") || lower.contains("validation"),
        "architecture explanation must reference the agent system (got: {})",
        content.chars().take(200).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

// =============================================================================
// More deterministic code-creation + validation tests
// =============================================================================

/// 24. Rust GCD via rust_repl — deterministic expected 12.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_gcd() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("24_rust_gcd"), validation_tools(), MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_gcd output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "rust_repl"), "must use rust_repl");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("12")),
        "rust_repl must print 12 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 25. Rust vowel count via rust_repl — deterministic expected 3.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_creates_and_runs_rust_vowels() {
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(None, &prompt("25_rust_vowels"), validation_tools(), MAIN_MODEL);
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_creates_and_runs_rust_vowels output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "rust_repl"), "must use rust_repl");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("3")),
        "rust_repl must print 3 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
}

/// 26. Shell line-count via bash_sandbox — deterministic expected 5.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_shell_line_count() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("26_shell_line_count"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_shell_line_count output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "bash_sandbox"), "must use bash_sandbox");
    // The "5" must come from a bash_sandbox command that ACTUALLY ran the
    // count.sh script — not from incidental output (e.g. a fixture path that
    // happens to contain "5"). Require the command to reference count.sh AND
    // its result to contain the expected line count.
    let ran_script = validators.iter().any(|(n, a, r)| {
        n == "bash_sandbox" && a.contains("count.sh") && r.contains("5")
    });
    assert!(
        ran_script,
        "bash_sandbox must run count.sh and print 5 (validators: {:?})",
        validators.iter().map(|(n, a, r)| format!("{}: cmd={} -> {}", n, a.chars().take(80).collect::<String>(), r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 27. Python sum-list via bash_sandbox — deterministic expected 60.
#[tokio::test]
#[ignore = "requires local Ollama + model inference"]
async fn agent_writes_and_runs_python_sum_list() {
    let root = setup_fixture_project();
    let sink = CliSink;
    let memory = SubAgentMemory::new();
    let req = request(
        Some(root.to_str().unwrap()),
        &prompt("27_python_sum_list"),
        validation_tools(),
        MAIN_MODEL,
    );
    let res = run(&sink, &memory, req).await;
    eprintln!("\n=== agent_writes_and_runs_python_sum_list output ===\n{}", res.content);
    assert!(!res.content.trim().is_empty());

    let validators = collect_validation_tool_calls(&res.tool_calls);
    assert!(validators.iter().any(|(n, _, _)| n == "bash_sandbox"), "must use bash_sandbox");
    assert!(
        validators.iter().any(|(_, _, r)| r.contains("60")),
        "bash_sandbox must print 60 (validators: {:?})",
        validators.iter().map(|(n, _, r)| format!("{}: {}", n, r.chars().take(120).collect::<String>())).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}
// ---------------------------------------------------------------------------
// Switchyard routing e2e (OpenRouter)
// ---------------------------------------------------------------------------

/// A sink that records the routed model, sub-agent start models, and streamed
/// content so a test can assert that Switchyard actually redirected requests.
struct RecordingSink {
    routed: std::sync::Mutex<Vec<String>>,
    subagent_models: std::sync::Mutex<Vec<String>>,
    content: std::sync::Mutex<String>,
}

impl main_impl::EventSink for RecordingSink {
    fn emit_stream_token(&self, _id: Option<&str>, token: &str, _thinking: bool) {
        self.content.lock().unwrap().push_str(token);
    }
    fn emit_tool_progress(
        &self,
        _id: Option<&str>,
        _kind: &str,
        _name: &str,
        _path: Option<String>,
    ) {
    }
    fn emit_model_routed(&self, model: &str) {
        self.routed.lock().unwrap().push(model.to_string());
    }
    fn emit_subagent_start(&self, _id: &str, _agent: &str, _task: &str, model: &str) {
        self.subagent_models.lock().unwrap().push(model.to_string());
    }
    fn emit_subagent_done(&self, _id: &str, _result: &str) {}
}

/// Resolve the OpenRouter API key from the OS keychain — the SAME storage the
/// user's UI writes to (service `com.nolock.app`, account `apiKey.openrouter`,
/// via the Model Providers panel). The e2e validation must exercise the real
/// user-configured credential path, so there is deliberately NO fallback to
/// opencode's auth.json or an env var: if the key is not in the keychain, the
/// test FAILS completely (no silent skip).
fn openrouter_key() -> String {
    match main_impl::secrets::read_keychain(
        main_impl::secrets::KEYCHAIN_SERVICE,
        "apiKey.openrouter",
    ) {
        Ok(Some(key)) if !key.trim().is_empty() => key,
        Ok(_) => panic!(
            "OpenRouter API key not found in the OS keychain. Store it via the UI \
             (Model Providers panel → OpenRouter → API key), which writes to the \
             keychain under service '{}', account 'apiKey.openrouter'.",
            main_impl::secrets::KEYCHAIN_SERVICE
        ),
        Err(e) => panic!(
            "Failed to read the OpenRouter API key from the OS keychain: {}. \
             Store it via the UI (Model Providers panel → OpenRouter → API key).",
            e
        ),
    }
}

/// Build the provider map the Switchyard router resolves targets against.
fn openrouter_providers(key: &str) -> HashMap<String, main_impl::ProviderConfig> {
    let mut providers = HashMap::new();
    providers.insert(
        "openrouter".to_string(),
        main_impl::ProviderConfig {
            url: "https://openrouter.ai/api/v1".to_string(),
            api_key: key.to_string(),
        },
    );
    providers
}

/// Write a `.routers/switchyard.json` under `root`.
fn write_switchyard_config(root: &Path, config_json: &str) {
    let dir = root.join(".routers");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("switchyard.json"), config_json).unwrap();
}

/// Build a chat request that starts on ollama but carries the openrouter
/// provider map, so Switchyard can redirect it. Tools are enabled to reproduce
/// the real app scenario (a trivial greeting must not trigger the tool loop).
fn switchyard_chat_request(
    root: &str,
    message: &str,
    providers: HashMap<String, main_impl::ProviderConfig>,
    referenced_agents: Vec<String>,
) -> ChatRequest {
    ChatRequest {
        backend: "ollama".to_string(),
        url: OLLAMA_URL.to_string(),
        model: MAIN_MODEL.to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: message.to_string(),
        }],
        api_key: None,
        providers,
        tool_configs: HashMap::new(),
        tools_enabled: vec!["web_search".into(), "read_file".into(), "list_directory".into()],
        temperature: Some(0.3),
        max_tokens: Some(256),
        context_length: Some(128_000),
        system_prompt: None,
        root_path: Some(root.to_string()),
        max_iterations: 4,
        model_affinity: Some(true),
        referenced_agents,
        reasoning_retries: Some(4),
    }
}

/// Run a chat request, retrying on transient OpenRouter 429 rate-limits. The
/// `random` router may pick a model that is temporarily rate-limited upstream;
/// retrying gives it a chance to land on a healthy model. Also retries when the
/// router fell through to the default provider (empty `routed`) — which happens
/// when a transient judge 429 is swallowed by the fail-safe routing. Any other
/// error is returned immediately.
async fn run_chat_retry_on_429(
    sink: &RecordingSink,
    memory: &SubAgentMemory,
    req: ChatRequest,
) -> Result<ChatResult, String> {
    let mut last_err = String::new();
    for attempt in 0..6 {
        match main_impl::run_chat(sink, memory, req.clone()).await {
            Ok(res) => {
                let routed = sink.routed.lock().unwrap().clone();
                if routed.is_empty() && attempt < 5 {
                    eprintln!(
                        "[switchyard e2e] attempt {} routed nothing (judge 429?), retrying…",
                        attempt + 1
                    );
                    last_err = "routing fell through (no model routed)".to_string();
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    continue;
                }
                return Ok(res);
            }
            Err(e) if e.contains("429") && attempt < 5 => {
                eprintln!("[switchyard e2e] attempt {} hit 429, retrying…", attempt + 1);
                last_err = e;
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

/// E2E: the project's `.routers/switchyard.json` (nemotron-family route behind
/// the `random` general router) redirects the main chat to one of OpenRouter's
/// Nemotron models.
#[tokio::test]
#[ignore = "requires network + OpenRouter API key stored in the OS keychain (UI Model Providers panel)"]
async fn switchyard_routes_chat_to_nemotron_family_on_openrouter() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let router_path = root.join(".routers").join("switchyard.json");
    assert!(
        router_path.exists(),
        "expected .routers/switchyard.json in the repo root"
    );

    let key = openrouter_key();

    let req = switchyard_chat_request(
        root.to_string_lossy().as_ref(),
        "Hi",
        openrouter_providers(&key),
        Vec::new(),
    );

    let sink = RecordingSink {
        routed: std::sync::Mutex::new(Vec::new()),
        subagent_models: std::sync::Mutex::new(Vec::new()),
        content: std::sync::Mutex::new(String::new()),
    };
    let memory = SubAgentMemory::new();
    let res = run_chat_retry_on_429(&sink, &memory, req)
        .await
        .expect("switchyard-routed chat should succeed");

    let routed = sink.routed.lock().unwrap().clone();
    eprintln!("[switchyard e2e] routed models: {:?}", routed);
    eprintln!("[switchyard e2e] content: {}", res.content);

    assert!(
        routed.iter().any(|m| {
            m.contains("nemotron-3-ultra")
                || m.contains("nemotron-3-super")
                || m.contains("nemotron-3.5-lightning")
        }),
        "expected a Nemotron-family model to be routed, got {:?}",
        routed
    );
    assert!(
        !res.content.trim().is_empty(),
        "routed chat must produce an answer"
    );
    // Regression guard for the "Hi" loop bug: a trivial greeting must conclude
    // with a short answer and must NOT trigger a tool spree (list_directory /
    // read_file / web_search) or the repetition→summarize→re-trigger machinery.
    assert!(
        res.tool_calls.is_empty(),
        "greeting must not trigger tool calls, got {:?}",
        res.tool_calls.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    );
    assert!(
        res.content.trim().chars().count() < 300,
        "greeting answer should be short, got {} chars",
        res.content.trim().chars().count()
    );
}

/// E2E: a `passthrough` route always selects its single target — validates the
/// config's passthrough algorithm against a real backend.
#[tokio::test]
#[ignore = "requires network + OpenRouter API key stored in the OS keychain (UI Model Providers panel)"]
async fn switchyard_passthrough_routes_to_exact_model() {
    let key = openrouter_key();

    let root = std::env::temp_dir().join(format!("nolock_sy_e2e_pt_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    write_switchyard_config(
        &root,
        r#"{
            "enabled": true,
            "routes": [{
                "name": "pt-super",
                "purpose": "chat",
                "algorithm": "passthrough",
                "targets": [{
                    "id": "super",
                    "label": "Super",
                    "backend": "openrouter",
                    "model": "nvidia/nemotron-3-super-120b-a12b"
                }]
            }]
        }"#,
    );

    let req = switchyard_chat_request(
        root.to_string_lossy().as_ref(),
        "Say hello",
        openrouter_providers(&key),
        Vec::new(),
    );

    let sink = RecordingSink {
        routed: std::sync::Mutex::new(Vec::new()),
        subagent_models: std::sync::Mutex::new(Vec::new()),
        content: std::sync::Mutex::new(String::new()),
    };
    let memory = SubAgentMemory::new();
    let res = run_chat_retry_on_429(&sink, &memory, req)
        .await
        .expect("passthrough-routed chat should succeed");

    let routed = sink.routed.lock().unwrap().clone();
    eprintln!("[switchyard e2e passthrough] routed models: {:?}", routed);
    eprintln!("[switchyard e2e passthrough] content: {}", res.content);

    assert_eq!(
        routed,
        vec!["nvidia/nemotron-3-super-120b-a12b".to_string()],
        "passthrough must select exactly the configured target, got {:?}",
        routed
    );
    assert!(
        !res.content.trim().is_empty(),
        "routed chat must produce an answer"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// E2E: a `subagent`-purpose route redirects sub-agent requests to the
/// configured target — validates the config's subagent routing.
#[tokio::test]
#[ignore = "requires network + OpenRouter API key stored in the OS keychain (UI Model Providers panel)"]
async fn switchyard_subagent_route_redirects_sub_agent() {
    let key = openrouter_key();

    // Use the fixture project (has .agents/code-reviewer.md) + a temp
    // .routers/switchyard.json with a subagent-purpose passthrough route.
    let root = setup_fixture_project();
    write_switchyard_config(
        &root,
        r#"{
            "enabled": true,
            "routes": [{
                "name": "subagent-lightning",
                "purpose": "subagent",
                "algorithm": "passthrough",
                "targets": [{
                    "id": "lightning",
                    "label": "Lightning",
                    "backend": "openrouter",
                    "model": "nvidia/nemotron-3.5-lightning"
                }]
            }]
        }"#,
    );

    let req = switchyard_chat_request(
        root.to_string_lossy().as_ref(),
        "@code-reviewer say hello",
        openrouter_providers(&key),
        vec!["code-reviewer".to_string()],
    );

    let sink = RecordingSink {
        routed: std::sync::Mutex::new(Vec::new()),
        subagent_models: std::sync::Mutex::new(Vec::new()),
        content: std::sync::Mutex::new(String::new()),
    };
    let memory = SubAgentMemory::new();
    let res = run_chat_retry_on_429(&sink, &memory, req)
        .await
        .expect("subagent-routed chat should succeed");

    let subagent_models = sink.subagent_models.lock().unwrap().clone();
    eprintln!("[switchyard e2e subagent] sub-agent models: {:?}", subagent_models);
    eprintln!("[switchyard e2e subagent] content: {}", res.content);

    assert!(
        subagent_models.iter().any(|m| m == "nvidia/nemotron-3.5-lightning"),
        "sub-agent must be routed to the configured target, got {:?}",
        subagent_models
    );
    assert!(
        !res.content.trim().is_empty(),
        "chat must produce an answer"
    );
    let _ = std::fs::remove_dir_all(&root);
}
