#!/usr/bin/env bash
# =============================================================================
# nolock — E2E validation for the hierarchical main/sub/micro agent cascade
# =============================================================================
# Verifies the three-tier agent stack end to end against locally available
# Ollama models:
#   - Main agent    : nemotron-nano-9b-v2 (planning / orchestration)
#   - Agent router  : lfm2.5              (intent classification / routing)
#   - Micro-agent   : qwen3.5:0.8b        (mechanical fixes + validation)
#
# Run modes:
#   ./e2e/run.sh check            # verify Ollama + required models are present
#   ./e2e/run.sh models           # pull/ensure the required models are present
#   ./e2e/run.sh unit             # run the pure unit tests (no Ollama needed)
#   ./e2e/run.sh e2e [--nocapture]   # run the full E2E cascade (requires Ollama)
#   ./e2e/run.sh cli "<message>"  # smoke-test the headless CLI on a prompt
#   ./e2e/run.sh measure [args]   # measure E2E pass rate (see e2e/measure.sh)
#   ./e2e/run.sh all              # unit + e2e + cli smoke test
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI="$ROOT/src-tauri"
SERVER="http://localhost:11434"

MAIN_MODEL="oamazonasgabriel/nemotron-nano-9b-v2:q4-km-16gbGPU"
LFM_MODEL="lfm2.5:latest"
MICRO_MODEL="qwen3.5:0.8b"

require_ollama() {
  curl -sf "$SERVER/api/tags" >/dev/null 2>&1 \
    || { echo "ERROR: Ollama is not running at $SERVER (start it first)." >&2; exit 1; }
}

cmd_check() {
  require_ollama
  echo "Ollama reachable at $SERVER."
  local seen
  seen="$(curl -sf "$SERVER/api/tags" | python3 -c "import sys,json;print('\\n'.join(m['name'] for m in json.load(sys.stdin).get('models',[])))")"
  for m in "$MAIN_MODEL" "$LFM_MODEL" "$MICRO_MODEL"; do
    if grep -qxF "$m" <<<"$seen"; then
      echo "  [ok] $m"
    else
      echo "  [missing] $m  (pull with: ./e2e/run.sh models)"
    fi
  done
}

cmd_models() {
  require_ollama
  for m in "$MAIN_MODEL" "$LFM_MODEL" "$MICRO_MODEL"; do
    echo "Pulling $m ..."
    ollama pull "$m"
  done
  echo "All models ready."
}

cmd_unit() {
  (cd "$TAURI" && cargo test --bin nolock)
}

cmd_e2e() {
  require_ollama
  (cd "$TAURI" && cargo test --test agent_cascade -- --ignored --nocapture "$@")
}

cmd_cli() {
  local message="${1:-Hello from the CLI. Answer in one short sentence.}"
  require_ollama
  (cd "$TAURI" && cargo build --bin nolock-cli >/dev/null)
  echo "--- CLI invocation ---"
  (cd "$ROOT" && "$TAURI/target/debug/nolock-cli" \
      --url "$SERVER" \
      --model "$MAIN_MODEL" \
      --message "$message" \
      --temperature 0.3)
}

cmd_all() {
  cmd_unit
  cmd_e2e
  cmd_cli "${1:-}"
}

cmd_measure() {
  "$ROOT/e2e/measure.sh" "$@"
}

case "${1:-all}" in
  check)  cmd_check ;;
  models) cmd_models ;;
  unit)   cmd_unit ;;
  e2e)    shift; cmd_e2e "$@" ;;
  cli)    shift; cmd_cli "${1:-}" ;;
  measure) shift; cmd_measure "$@" ;;
  all)    shift; cmd_all "${1:-}" ;;
  *) echo "unknown command: $1"; exit 2 ;;
esac