#!/usr/bin/env bash
# =============================================================================
# nolock — E2E pass-rate measurement harness
# =============================================================================
# Runs the full E2E agent-cascade suite multiple times and aggregates pass
# rates, so flaky tests (model nondeterminism) can be quantified and tracked.
#
# Usage:
#   ./e2e/measure.sh                 # 100 runs, sequential (batch=1, safe default)
#   ./e2e/measure.sh --runs 50       # 50 runs
#   ./e2e/measure.sh --batch 5       # 5 parallel batches (WARNING: see below)
#   ./e2e/measure.sh --single        # single pass (fast iteration)
#   ./e2e/measure.sh --test <name>   # only tests matching <name>
#   ./e2e/measure.sh --nocapture     # keep test output (single pass)
#
# IMPORTANT — parallel batches vs. local Ollama:
#   Each E2E pass loads the main (nemotron ~6.8GB) + router (lfm2.5 ~5.4GB) +
#   micro (qwen3.5) models. Running several passes in parallel exceeds VRAM on a
#   single GPU, so Ollama evicts models and drops connections, causing most tests
#   to FAIL with "error sending request for http://localhost:11434/api/chat".
#   The default is therefore SEQUENTIAL (batch=1), which is the only reliable
#   measurement on local hardware. Use --batch > 1 only if you have enough VRAM
#   (or multiple GPUs with Ollama configured to spread models) to hold N suites.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI="$ROOT/src-tauri"
SERVER="http://localhost:11434"

RUNS=100
BATCH=1
TEST_FILTER=""
TESTS_LIST=""
NOCAPTURE=""
SINGLE=0

# ---- arg parsing ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)     RUNS="$2"; shift 2 ;;
    --batch)    BATCH="$2"; shift 2 ;;
    --single)   SINGLE=1; shift ;;
    --nocapture) NOCAPTURE="--nocapture"; shift ;;
    --test)     TEST_FILTER="$2"; shift 2 ;;
    --tests)    TESTS_LIST="$2"; shift 2 ;;
    --help|-h)  sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

require_ollama() {
  curl -sf "$SERVER/api/tags" >/dev/null 2>&1 \
    || { echo "ERROR: Ollama is not running at $SERVER (start it first)." >&2; exit 1; }
}

build_once() {
  echo "[measure] building test harness ..."
  (cd "$TAURI" && cargo test --test agent_cascade --no-run >/dev/null 2>&1)
  (cd "$TAURI" && cargo build --bin nolock-cli >/dev/null 2>&1)
  echo "[measure] build done."
}

# Run the suite once into $1, printing per-test result lines + summary.
run_once() {
  local out="$1"
  local filter_args=()
  if [[ -n "$TESTS_LIST" ]]; then
    # Run a specific comma-separated list of tests together in one pass.
    # cargo test treats multiple positional filters as OR (substring match),
    # so passing each name runs exactly those tests.
    IFS=',' read -ra names <<< "$TESTS_LIST"
    for n in "${names[@]}"; do
      filter_args+=("$n")
    done
  elif [[ -n "$TEST_FILTER" ]]; then
    filter_args=("$TEST_FILTER")
  fi
  (cd "$TAURI" && cargo test --test agent_cascade -- --ignored $NOCAPTURE "${filter_args[@]}" >"$out" 2>&1)
}

# Unload every model from Ollama's VRAM so each pass starts from a clean slate.
# Ollama keeps loaded models resident (default keep_alive 5m) with their KV
# cache across the whole measurement; unloading between runs gives hermetic
# isolation per pass (no cross-run KV-cache / thermal state). This is cheap
# (one /api/generate keep_alive:0 call per model) compared to the ~20min/pass
# suite time, and avoids the catastrophic slowdown of unloading between every
# tool call within a test.
unload_models() {
  local models
  models=$(curl -sf "$SERVER/api/tags" | python3 -c "import json,sys; [print(m['name']) for m in json.load(sys.stdin)['models']]" 2>/dev/null)
  if [[ -z "$models" ]]; then
    return 0
  fi
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    curl -sf "$SERVER/api/generate" \
      -H "Content-Type: application/json" \
      -d "{\"model\": \"$m\", \"prompt\": \"\", \"keep_alive\": 0}" >/dev/null 2>&1 || true
  done <<< "$models"
}

# -----------------------------------------------------------------------------
# Single invocation (fast iteration)
# -----------------------------------------------------------------------------
if [[ "$SINGLE" -eq 1 ]]; then
  require_ollama
  build_once
  echo "[measure] single pass (filter='${TEST_FILTER:-all}')"
  run_once "$TAURI/target/measure_single.log"
  grep -E "^test .* \.\.\. (ok|FAILED)$|^test result:" "$TAURI/target/measure_single.log" || true
  echo "[measure] done."
  exit 0
fi

require_ollama
build_once

echo "[measure] running $RUNS passes in batches of $BATCH (filter='${TEST_FILTER:-all}')"
echo "[measure] started $(date '+%H:%M:%S')"

mkdir -p "$TAURI/target/measure"
rm -f "$TAURI"/target/measure/run_*.log

# -----------------------------------------------------------------------------
# Run the suite in parallel batches of $BATCH.
# -----------------------------------------------------------------------------
batch_start=0
while [[ $batch_start -lt $RUNS ]]; do
  batch_end=$(( batch_start + BATCH ))
  if [[ $batch_end -gt $RUNS ]]; then batch_end=$RUNS; fi

  pids=()
  for i in $(seq $batch_start $((batch_end - 1))); do
    run_once "$TAURI/target/measure/run_$i.log" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "$pid"
  done
  batch_start=$batch_end
  echo "[measure] completed $batch_start/$RUNS passes"
  # Hermetic isolation: unload all models from VRAM so the next pass starts
  # from a clean slate (no cross-run KV-cache / thermal state).
  unload_models
done

# -----------------------------------------------------------------------------
# Aggregate results.
# -----------------------------------------------------------------------------
declare -A TEST_COUNT
declare -A TEST_PASS

for i in $(seq 0 $((RUNS - 1))); do
  log="$TAURI/target/measure/run_$i.log"
  [[ -f "$log" ]] || continue
  while IFS= read -r line; do
    if [[ "$line" =~ ^test[[:space:]]+([^[:space:]]+)[[:space:]]+\.\.\.[[:space:]]+(ok|FAILED)$ ]]; then
      name="${BASH_REMATCH[1]}"
      status="${BASH_REMATCH[2]}"
      TEST_COUNT["$name"]=$(( ${TEST_COUNT["$name"]:-0} + 1 ))
      if [[ "$status" == "ok" ]]; then
        TEST_PASS["$name"]=$(( ${TEST_PASS["$name"]:-0} + 1 ))
      fi
    fi
  done < "$log"
done

echo ""
echo "================================================================"
echo " E2E PASS-RATE SUMMARY ($RUNS runs, batch=$BATCH)"
echo "================================================================"
printf "%-24s %8s %8s %9s\n" "TEST" "PASS" "RUNS" "RATE"
printf "%-24s %8s %8s %9s\n" "----" "----" "----" "----"
total_pass=0
total_runs=0
for name in "${!TEST_COUNT[@]}"; do
  runs="${TEST_COUNT[$name]}"
  pass="${TEST_PASS[$name]:-0}"
  total_runs=$(( total_runs + runs ))
  total_pass=$(( total_pass + pass ))
  rate=$(python3 -c "print(f'{$pass/$runs*100:.1f}%')")
  printf "%-22s %8d %8d %9s\n" "$name" "$pass" "$runs" "$rate"
done
echo "---------------------------------------------------------------"
if [[ $total_runs -gt 0 ]]; then
  overall=$(python3 -c "print(f'{$total_pass/$total_runs*100:.1f}%')")
  printf "%-22s %8d %8d %9s\n" "TOTAL" "$total_pass" "$total_runs" "$overall"
fi
echo "================================================================"
echo "[measure] finished $(date '+%H:%M:%S')"