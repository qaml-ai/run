#!/bin/bash
# Runs one code execution in its own gVisor sandbox. Installed root-owned as
# /usr/local/libexec/agent-executor/sandbox; the executor's user may run it
# through sudo and nothing else (agent-executor.sudoers). Only this script
# decides what a sandbox sees: the runtime image's filesystem read-only, a tmpfs
# /tmp, no network, no host mounts, cgroup limits. The executor chooses nothing
# but the sandbox's id. Stdin and stdout are the code child's protocol pipe, so
# nothing here may write to stdout.
#
# Usage: sandbox run <uuid>   one execution; SIGTERM kills and deletes the sandbox
#        sandbox kill <uuid>  kills it (the executor's user cannot signal sudo)
#        sandbox gc           removes every sandbox and bundle (at service start)
set -euo pipefail
umask 077

ROOTFS=/opt/agent-executor/sandbox/rootfs
STATE=/run/agent-executor
MEMORY_MB=512
HEAP_MB=256
CPU_PERCENT=100
PIDS=128
TMP_MB=64
RUNSC_FLAGS=
# Root-owned, non-secret host overrides of the values above.
if [[ -r /etc/agent-executor/sandbox.env ]]; then source /etc/agent-executor/sandbox.env; fi

# shellcheck disable=SC2086 # RUNSC_FLAGS is a list of flags.
runsc() { /usr/local/lib/gvisor/runsc --root="$STATE/runsc" $RUNSC_FLAGS "$@"; }

config() {
  cat <<JSON
{
  "ociVersion": "1.0.2",
  "process": {
    "user": { "uid": 1000, "gid": 1000 },
    "args": ["/usr/local/bin/node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--max-old-space-size=$HEAP_MB", "/app/src/executor/sandbox-child.ts"],
    "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "NODE_ENV=production"],
    "cwd": "/tmp",
    "noNewPrivileges": true,
    "capabilities": { "bounding": [], "effective": [], "inheritable": [], "permitted": [], "ambient": [] },
    "rlimits": [{ "type": "RLIMIT_NOFILE", "hard": 256, "soft": 256 }]
  },
  "root": { "path": "$ROOTFS", "readonly": true },
  "hostname": "sandbox",
  "mounts": [
    { "destination": "/proc", "type": "proc", "source": "proc" },
    { "destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=${TMP_MB}m"] }
  ],
  "linux": {
    "cgroupsPath": "/agent-executor/$1",
    "resources": {
      "memory": { "limit": $((MEMORY_MB * 1024 * 1024)), "swap": $((MEMORY_MB * 1024 * 1024)) },
      "cpu": { "quota": $((CPU_PERCENT * 1000)), "period": 100000 },
      "pids": { "limit": $PIDS }
    },
    "namespaces": [{ "type": "pid" }, { "type": "network" }, { "type": "ipc" }, { "type": "uts" }, { "type": "mount" }]
  }
}
JSON
}

uuid() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "sandbox: invalid id" >&2; exit 2; }; }

case "${1:-} $#" in
  "run 2")
    id=$2
    uuid "$id"
    bundle="$STATE/bundles/$id"
    mkdir -p "$STATE/bundles"
    mkdir "$bundle"
    pid=
    cleanup() {
      runsc kill "$id" KILL >/dev/null 2>&1 || true
      # Also covers a signal that arrives before the container exists.
      if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
      runsc delete --force "$id" >/dev/null 2>&1 || true
      rm -rf "$bundle"
    }
    trap cleanup EXIT
    trap 'exit 143' TERM INT HUP
    config "$id" > "$bundle/config.json"
    # In the background so a signal interrupts `wait` at once; stdin passed on explicitly.
    runsc --network=none --overlay2=none run --bundle "$bundle" "$id" <&0 &
    pid=$!
    wait "$pid"
    ;;
  "kill 2")
    uuid "$2"
    # Ends `run`, whose cleanup deletes the sandbox and its bundle.
    runsc kill "$2" KILL >/dev/null 2>&1 || true
    ;;
  "gc 1")
    mkdir -p "$STATE/runsc"
    for id in $(runsc list --quiet 2>/dev/null); do
      runsc kill "$id" KILL >/dev/null 2>&1 || true
      runsc delete --force "$id" >/dev/null 2>&1 || true
    done
    rm -rf "$STATE/bundles"
    ;;
  *) echo "usage: sandbox run|kill <uuid> | sandbox gc" >&2; exit 2 ;;
esac
