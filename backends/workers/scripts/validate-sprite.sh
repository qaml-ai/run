#!/usr/bin/env bash
# Run through the repo's leased scripts/sprite-test, one validation job per sprite.
# Report SIGSEGVs. Retry unit or integration files once for SIGSEGV-only failures backed by startup cores.
set -euo pipefail
mode=${1:?Expected unit, integration [I/N], compat, python, contract or checks}
cd "$(dirname "$0")/.."
workers=$PWD
repo=$(cd ../.. && pwd)
artifact="$HOME/runs/workers-agents-$mode-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$artifact"
# A SIGSEGV on a sprite (never seen in CI) is made diagnosable: cores go to ~/cores, and the kernel's lines, memory and
# load from the run are printed and kept with the artifact when a test process dies of one.
mkdir -p "$HOME/cores"; ulimit -c unlimited 2>/dev/null || true
# Keep the two newest cores only: each can be gigabytes.
{ ls -t "$HOME"/cores/core.* 2>/dev/null || true; } | tail -n +3 | xargs -r rm -f
sudo -n sysctl -q -w kernel.core_pattern="$HOME/cores/core.%e.%p.%t" 2>/dev/null || true
dmesg_from=$(dmesg 2>/dev/null | wc -l) || dmesg_from=0
run_start=$(date +%s)
declare -A core_triage=()

collect_cores() {
  local core mtime line node
  new_cores=()
  for core in "$HOME"/cores/core.node.*; do
    [[ -f $core ]] || continue
    mtime=$(stat -c %Y -- "$core") || return 1
    if (( mtime >= run_start )); then
      new_cores+=("$core")
    fi
  done
  command -v gdb >/dev/null || return 0
  node=$(command -v node) || return 1
  for core in "${new_cores[@]}"; do
    [[ ! -v 'core_triage[$core]' ]] || continue
    if line=$(LC_ALL=C gdb -q -batch -nx -iex 'set auto-load off' -c "$core" \
        -x "$workers/scripts/segv-triage.py" "$node" 2>&1) &&
        line=$(awk '/^SEGV_TRIAGE / { print }' <<< "$line") &&
        [[ $line == "SEGV_TRIAGE ${core##*/} class="* && $line != *$'\n'* ]]; then
      core_triage[$core]=$line
    else
      core_triage[$core]="SEGV_TRIAGE ${core##*/} class=unknown si_code=0 si_pid=0 core_pid=0 frame0=? startup=no"
    fi
  done
}

segv_report() {
  local core
  grep -rqs "signal: 'SIGSEGV'" "$artifact" || return 0
  collect_cores || true
  {
    echo "== SIGSEGV on $(hostname) ($(nproc) cpus, uptime $(cut -d' ' -f1 /proc/uptime)s): node $(node -v)"
    grep -rh -B8 "signal: 'SIGSEGV'" "$artifact" | grep -E "^not ok|location:" || true
    echo "== kernel since the run started"; dmesg 2>/dev/null | tail -n +"$((dmesg_from + 1))" | tail -50 || true
    echo "== memory"; free -m; echo "== load $(cat /proc/loadavg)"
    echo "== cores"; ls -la "$HOME/cores" 2>/dev/null | tail -5
    if ! command -v gdb >/dev/null; then
      echo "SEGV_TRIAGE skipped: gdb is unavailable"
    else
      for core in "${new_cores[@]}"; do
        printf '%s\n' "${core_triage[$core]:-}"
      done
    fi
  } | tee "$artifact/sigsegv.txt"
}

run_suite() {
  local tap="$artifact/$mode.tap" status core failures kind file reason="" message
  local -a statuses failed_files=() segv_files=() core_names=() flags
  if "$@" 2>&1 | tee "$tap"; then
    return 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  status=${statuses[0]}
  (( status != 0 )) || status=${statuses[1]}
  grep -Fq "signal: 'SIGSEGV'" "$tap" || return "$status"

  # Only top-level records count. Read the signal from the file's own YAML diagnostics.
  failures=$(awk '
    function report() {
      if (failed) print (segv && closed ? "segv " : "failed ") file
      failed = yaml = segv = closed = 0
    }
    /^[^[:space:]]/ { report() }
    /^not ok [0-9]+ - / {
      failed = 1
      file = substr($0, index($0, " - ") + 3)
    }
    failed && !closed && /^  ---[[:space:]]*$/ { yaml = 1 }
    yaml && /^  signal: '\''SIGSEGV'\''[[:space:]]*$/ { segv = 1 }
    yaml && /^  \.\.\.[[:space:]]*$/ { yaml = 0; closed = 1 }
    END { report() }
  ' "$tap") || {
    echo "SEGV_RETRY skipped: could not read suite TAP"
    return "$status"
  }
  while IFS=' ' read -r kind file; do
    case $kind in
      failed) failed_files+=("$file") ;;
      segv) failed_files+=("$file"); segv_files+=("$file") ;;
    esac
  done <<< "$failures"

  if (( statuses[1] != 0 )); then
    reason="could not capture suite TAP"
  elif (( ${#segv_files[@]} == 0 || ${#segv_files[@]} != ${#failed_files[@]} )); then
    reason="failures were not all SIGSEGV test files"
  else
    for file in "${segv_files[@]}"; do
      if [[ $file != test/*.ts || ! -f $file ]]; then
        reason="failure was not a test file: $file"
        break
      fi
    done
    if [[ -z $reason ]]; then
      if ! command -v gdb >/dev/null; then
        reason="gdb is unavailable"
      elif ! collect_cores; then
        reason="could not inspect new Node cores"
      elif (( ${#new_cores[@]} < ${#segv_files[@]} )); then
        reason="fewer new Node cores than SIGSEGV test files"
      else
        for core in "${new_cores[@]}"; do
          if [[ ${core_triage[$core]} != "SEGV_TRIAGE ${core##*/} class=platform-startup "* ]]; then
            reason="${core##*/} did not classify as platform-startup"
            break
          fi
          core_names+=("${core##*/}")
        done
      fi
    fi
  fi
  if [[ -n $reason ]]; then
    echo "SEGV_RETRY skipped: $reason"
    return "$status"
  fi

  if [[ $mode == unit ]]; then
    flags=(--import ./test/sdk-deps.mjs --experimental-strip-types --test)
  else
    flags=(--import ./test/compat-register.mjs --experimental-strip-types --test --test-concurrency=1)
  fi
  message="${segv_files[*]} (platform-startup SI_TKILL; cores: ${core_names[*]})"
  if node "${flags[@]}" "${segv_files[@]}" 2>&1 | tee "$artifact/$mode-segv-retry.tap"; then
    echo "SEGV_RETRY passed: $message" | tee "$artifact/segv-retry.txt" || true
    return 0
  fi
  echo "SEGV_RETRY failed: $message" | tee "$artifact/segv-retry.txt" || true
  return "$status"
}

finish() {
  code=$?
  trap - EXIT
  segv_report || true
  cp measurements/compat*.tap measurements/compatibility.json measurements/python-compat.json "$artifact/" 2>/dev/null || true
  if [[ $mode == contract ]]; then
    cp "$repo"/backends/workers/measurements/parity-*.json "$repo"/backends/workers/measurements/parity-*.log "$artifact/" 2>/dev/null || true
  fi
  printf '%s\n' "$code" > "$artifact/exit"
  tar -czf "$artifact.tgz" -C "$artifact" .
  echo "SPRITE_ARTIFACT=$artifact.tgz"
  exit "$code"
}
trap finish EXIT
# scripts/sprite-test-core.sh installs every package-lock.json in the tree (this one included) before the command.
[[ -x node_modules/.bin/wrangler ]] || { echo "backends/workers/node_modules is not installed; run this through scripts/sprite-test" >&2; exit 1; }
if [[ $mode == integration || $mode == compat ]]; then
  # scripts/sprite-test sets Docker up on every pool sprite (docker_up in scripts/sprite-test-core.sh; README.md, "Docker on a sprite"), so the
  # native computer tests run here as on CI, which allows them no skip.
  if ! docker info >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
    echo "Docker with Buildx is not running on this sprite; run this through scripts/sprite-test, which sets it up." >&2
    exit 1
  fi
  export WORKERS_REQUIRE_DOCKER=1
fi
if [[ $mode == python || $mode == contract ]]; then
  if [[ ! -x "$HOME/.workers-python/bin/python3" ]]; then
    python3 -m venv "$HOME/.workers-python"
  fi
  "$HOME/.workers-python/bin/pip" install -q -r "$repo/clients/python/requirements.txt"
  export PATH="$HOME/.workers-python/bin:$PATH"
fi
case "$mode" in
  unit) run_suite npm test ;;
  integration) run_suite npm run test:integration ${2:+-- --test-shard="$2"} ;;
  compat) npm run test:compat 2>&1 | tee "$artifact/compatibility-run.log" ;;
  python) npm run test:python 2>&1 | tee "$artifact/python-compat.log" ;;
  contract)
    cd "$repo"
    CONTRACT_CONCURRENCY=${CONTRACT_CONCURRENCY:-4} npm run parity -- --area="${2:?Expected contract areas}" 2>&1 | tee "$artifact/contract.log"
    ;;
  checks)
    {
    npm run typecheck
    for file in scripts/reuse-*.mjs; do
      # The fs shim compares to origin/main, which git archive does not include.
      # Run that one sub-second check in the source checkout; the others use files.
      if [[ $file == scripts/reuse-fs-shim.mjs ]]; then continue; fi
      node "$file" --check
    done
    npm run build 2>&1 | tee "$artifact/build.log"
    if [[ -n ${2:-} ]]; then
      WORKERS_MEASURE_COMMIT="$2" node scripts/report.mjs
      cp ELEGANCE.md measurements/code-size.json "$artifact/"
    fi
    cd "$repo"
    npm run docs
    node --experimental-strip-types --test --test-name-pattern='^llms.txt' tests/docs.test.ts
    npm run openapi
    } 2>&1 | tee "$artifact/checks.log"
    ;;
  *) echo "Unknown validation: $mode" >&2; exit 2 ;;
esac
