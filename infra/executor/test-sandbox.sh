#!/usr/bin/env bash
# Runs tests/executor.test.ts against real per-execution gVisor sandboxes, in a
# privileged Linux container set up like an executor host: the pinned runsc, the
# sandbox helper and sudoers rule, an unprivileged agent-executor user, and the
# runtime image's filesystem as the sandbox root. Also probes what a sandbox can
# see and measures sandbox startup. Needs Docker (Docker Desktop works on an
# arm64 Mac) and internet access; installs nothing outside containers.
# Usage: infra/executor/test-sandbox.sh [image]
#   default image: built from the repository (run `npm run build:console` first)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
source "$here/versions.env"
[[ "$(docker info --format '{{.Architecture}}')" == aarch64 ]] || { echo "versions.env pins arm64 builds" >&2; exit 1; }

image=${1:-}
if [[ -z "$image" ]]; then
  image=agent-runtime:sandbox-test
  docker build -q -t "$image" "$repo" >/dev/null
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSLo "$work/gvisor.tar.bz2" "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/aarch64/gvisor.tar.bz2"
[[ "$(openssl dgst -sha512 -r "$work/gvisor.tar.bz2" | cut -d' ' -f1)" == "$GVISOR_SHA512" ]] || { echo "gVisor checksum mismatch" >&2; exit 1; }
container=$(docker create "$image")
docker export "$container" > "$work/rootfs.tar"
docker rm "$container" >/dev/null

docker run --rm -i --privileged -v "$work:/work:ro" -v "$repo:/repo:ro" node:22-bookworm bash -s${TRACE:+ -x} <<'SH'
set -euo pipefail
# cgroup v2: move every process out of the container's root cgroup so runsc can
# enable controllers for its sandboxes (systemd does this on a real host).
mkdir -p /sys/fs/cgroup/init
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
sed -e 's/ / +/g' -e 's/^/+/' /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control

apt-get update -qq >/dev/null && apt-get install -y -qq sudo >/dev/null
install -d /usr/local/lib/gvisor
tar -xjf /work/gvisor.tar.bz2 -C /usr/local/lib/gvisor --no-same-owner runsc gvisor-bin
install -D -m 755 /repo/infra/executor/sandbox.sh /usr/local/libexec/agent-executor/sandbox
install -m 440 /repo/infra/executor/agent-executor.sudoers /etc/sudoers.d/agent-executor
visudo -cf /etc/sudoers.d/agent-executor >/dev/null
useradd --system --no-create-home --shell /usr/sbin/nologin agent-executor
install -d -m 700 /opt/agent-executor/sandbox
install -d -m 755 /opt/agent-executor/sandbox/rootfs
tar -xf /work/rootfs.tar -C /opt/agent-executor/sandbox/rootfs
/usr/local/lib/gvisor/runsc --version | head -1
as_executor() { sudo -u agent-executor env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp "$@"; }

echo "== the executor's user can run the helper, and nothing else"
as_executor sudo -n /usr/local/libexec/agent-executor/sandbox gc 2>/dev/null && { echo "gc allowed" >&2; exit 1; }
as_executor sudo -n /usr/local/lib/gvisor/runsc list 2>/dev/null && { echo "runsc allowed" >&2; exit 1; }
as_executor sudo -n /usr/local/libexec/agent-executor/sandbox run ../../etc 2>/dev/null && { echo "bad id accepted" >&2; exit 1; }
as_executor ls /opt/agent-executor/sandbox 2>/dev/null && { echo "rootfs visible" >&2; exit 1; }
echo ok

echo "== what a sandbox sees (the helper's config, with a probe in place of the code child)"
sed 's#"/app/src/executor/sandbox-child.ts"#"-e", "const fs = require(\\"fs\\"), os = require(\\"os\\"); const r = {}; try { fs.writeFileSync(\\"/data/x\\", \\"x\\"); r.rootWritable = true; } catch (e) { r.rootWritable = e.code; } fs.writeFileSync(\\"/tmp/x\\", \\"x\\"); r.tmpWritable = true; r.uid = process.getuid(); r.env = Object.keys(process.env).sort(); r.interfaces = Object.keys(os.networkInterfaces()); r.capEff = fs.readFileSync(\\"/proc/self/status\\", \\"utf8\\").split(\\"CapEff:\\")[1].trim().slice(0, 16); r.processes = fs.readdirSync(\\"/proc\\").filter(n => !isNaN(n)).length; r.hostPaths = [\\"/opt/agent-executor\\", \\"/usr/local/lib/gvisor\\", \\"/repo\\", \\"/work\\"].filter(p => fs.existsSync(p)); require(\\"net\\").connect(443, \\"1.1.1.1\\").on(\\"error\\", e => { r.network = e.code; console.log(JSON.stringify(r)); }).on(\\"connect\\", () => { r.network = \\"connected\\"; console.log(JSON.stringify(r)); process.exit(); });"#' \
  /usr/local/libexec/agent-executor/sandbox > /usr/local/libexec/agent-executor/probe
chmod 755 /usr/local/libexec/agent-executor/probe
probe=$(/usr/local/libexec/agent-executor/probe run 00000000-0000-4000-8000-000000000000 </dev/null)
echo "$probe"
node -e '
const r = JSON.parse(process.argv[1]);
const expect = (ok, what) => { if (!ok) { console.error("FAIL: " + what); process.exit(1); } };
expect(r.rootWritable === "EROFS", "read-only root (/data belongs to the sandbox user)");
expect(r.tmpWritable, "writable /tmp");
expect(r.uid === 1000, "unprivileged uid");
expect(JSON.stringify(r.env) === JSON.stringify(["HOME", "NODE_ENV", "PATH", "TMPDIR"]), "fixed environment");
expect(JSON.stringify(r.interfaces) === JSON.stringify(["lo"]), "loopback only");
expect(/^0+$/.test(r.capEff), "no capabilities");
expect(r.processes <= 2, "own pid namespace");
expect(r.hostPaths.length === 0, "no host paths");
expect(r.network !== "connected", "no network");
console.log("ok");
' "$probe"

echo "== sandbox startup, as the executor's user (launch to first result of \`return 1\`)"
as_executor node --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e '
import { processLauncher, runscLauncher } from "/repo/src/executor/sandbox.ts";
let launcher = runscLauncher();
const once = async () => {
  const started = performance.now();
  const sandbox = await launcher.launch();
  await sandbox.rpc.request("execute", { code: "return 1", tools: [], timeoutMs: 10000, maxOutputCharacters: 100 });
  const ready = performance.now() - started;
  sandbox.kill();
  await sandbox.closed;
  return { ready, total: performance.now() - started };
};
const stats = (runs, key) => { const v = runs.map(r => r[key]).sort((a, b) => a - b); return `p50 ${v[Math.floor(v.length / 2)].toFixed(0)}ms, p90 ${v[Math.floor(v.length * 0.9)].toFixed(0)}ms`; };
await once();
const serial = [];
for (let i = 0; i < 20; i++) serial.push(await once());
console.log(`serial x20: to result ${stats(serial, "ready")}; including teardown ${stats(serial, "total")}`);
const parallel = await Promise.all(Array.from({ length: 8 }, once));
console.log(`8 at once: to result ${stats(parallel, "ready")}; including teardown ${stats(parallel, "total")}`);
launcher = processLauncher();
const plain = [];
for (let i = 0; i < 20; i++) plain.push(await once());
console.log(`baseline, the same child without gVisor, serial x20: to result ${stats(plain, "ready")}`);
'

echo "== tests/executor.test.ts with AGENT_EXECUTOR_SANDBOX=runsc"
( cd /repo && as_executor AGENT_EXECUTOR_SANDBOX=runsc node --experimental-strip-types --test --test-timeout=120000 tests/executor.test.ts ) 2>&1 | grep -E '^(not )?ok|^# (pass|fail)'

echo "== nothing left behind"
left=$(/usr/local/lib/gvisor/runsc --root=/run/agent-executor/runsc list --quiet; ls /run/agent-executor/bundles)
[[ -z "$left" ]] || { echo "left behind: $left" >&2; exit 1; }
echo ok
SH
