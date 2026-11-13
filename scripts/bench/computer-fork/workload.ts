// The project workspace every provider prepares once and then forks.
// qaml-ai/run is public: clone it, install the root and backends/workers
// dependencies (about 1.7 GB on disk). Each fork then runs a short build and
// test on its own branch. Scripts print KEY=value tokens the harness parses.

export const REPO = "https://github.com/qaml-ai/run.git";

const clock = `ms(){ echo $(( $(date +%s%N) / 1000000 )); }`;

/** Clone and install from scratch. `ws` is the workspace root (Cloudflare needs it under /workspace). */
export function prepare(ws: string) {
  return `set -eo pipefail; ${clock}
command -v node >/dev/null || { a=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/'); curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-$a.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1; echo node_installed=yes; }
mkdir -p ${ws} && cd ${ws}
t0=$(ms); [ -d run ] || git clone -q ${REPO} run; t1=$(ms)
cd run && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1; t2=$(ms)
cd backends/workers && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1; t3=$(ms)
echo "clone_ms=$((t1-t0)) root_ci_ms=$((t2-t1)) workers_ci_ms=$((t3-t2)) size_kb=$(du -sk ${ws} | cut -f1) files=$(find ${ws} | wc -l)"`;
}

/** Branch, mark, typecheck both packages and run one test file. */
export function build(ws: string, id: string, dir = "run") {
  return `set -o pipefail; ${clock}
cd ${ws}/${dir} || { echo "build_error=missing_workspace"; exit 3; }
git checkout -q -b fork-${id} 2>/dev/null || git checkout -q fork-${id}
echo ${id} > FORK_ID
t0=$(ms); ./node_modules/.bin/tsc -p tsconfig.json >/tmp/tsc-${id}.log 2>&1; e1=$?; t1=$(ms)
(cd backends/workers && ./node_modules/.bin/tsc -p tsconfig.json >/tmp/wtsc-${id}.log 2>&1); e2=$?; t2=$(ms)
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/config.test.ts >/tmp/test-${id}.log 2>&1; e3=$?; t3=$(ms)
echo "root_tsc_ms=$((t1-t0)) workers_tsc_ms=$((t2-t1)) test_ms=$((t3-t2)) build_ms=$((t3-t0)) exits=$e1,$e2,$e3"
[ "$e1$e2$e3" = 000 ]`;
}

/** What a machine holds: its marker, branch and whether installs are present. */
export function check(ws: string, dir = "run") {
  return `cd ${ws}/${dir} 2>/dev/null || { echo "fork_id=missing branch=missing node_modules=no"; exit 0; }
echo "fork_id=$(cat FORK_ID 2>/dev/null || echo none) branch=$(git branch --show-current) node_modules=$(test -f node_modules/typescript/package.json && test -f backends/workers/node_modules/.package-lock.json && echo yes || echo no) boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null | cut -c1-8)"`;
}

export function parse(text: string) {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([a-z][a-z0-9_]*)=([^\s]+)/g)) out[m[1]] = m[2];
  return out;
}

/** How the workspace is mounted: block device, overlay, FUSE, virtiofs, network. */
export function mounts(ws: string) {
  return `cd ${ws} 2>/dev/null || exit 0
echo "--- df -T ${ws}"; df -T ${ws} 2>&1 | tail -n +1
echo "--- findmnt"; (findmnt -T ${ws} -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || awk '{print $2, $1, $3, $4}' /proc/mounts | grep -E '^/ |${ws}')
echo "--- /proc/mounts (non-pseudo)"; grep -vE ' (proc|sysfs|cgroup2?|devpts|mqueue|securityfs|debugfs|tracefs|pstore|bpf|configfs|hugetlbfs|fusectl|binfmt_misc|autofs|devtmpfs|efivarfs) ' /proc/mounts | head -40
echo "--- lsblk"; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null | head -20
echo "--- kernel"; uname -r; nproc; free -m | head -2`;
}

// Node is on every machine; fio is used too when present (or installable).
const IO_MJS = String.raw`
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const dir = process.argv[2], out = {}; fs.mkdirSync(dir, { recursive: true });
const now = () => performance.now(), file = path.join(dir, "big.bin"), SIZE = 512 << 20, BS = 1 << 20;
const buf = crypto.randomBytes(BS);
let t = now(), fd = fs.openSync(file, "w");
for (let o = 0; o < SIZE; o += BS) fs.writeSync(fd, buf, 0, BS, o);
fs.fsyncSync(fd); fs.closeSync(fd); out.seq_write_mbps = +(512 / ((now() - t) / 1000)).toFixed(1);
t = now(); fd = fs.openSync(file, "r"); const rb = Buffer.alloc(BS);
for (let o = 0; o < SIZE; o += BS) fs.readSync(fd, rb, 0, BS, o);
out.seq_read_cached_mbps = +(512 / ((now() - t) / 1000)).toFixed(1);
const small = Buffer.alloc(4096); t = now();
for (let i = 0; i < 20000; i++) fs.readSync(fd, small, 0, 4096, Math.floor(Math.random() * (SIZE / 4096)) * 4096);
out.rand_read_4k_cached_iops = Math.round(20000 / ((now() - t) / 1000)); fs.closeSync(fd);
fd = fs.openSync(file, "r+"); t = now();
for (let i = 0; i < 4000; i++) { fs.writeSync(fd, small, 0, 4096, Math.floor(Math.random() * (SIZE / 4096)) * 4096); if (i % 32 === 31) fs.fdatasyncSync(fd); }
fs.fdatasyncSync(fd); out.rand_write_4k_sync32_iops = Math.round(4000 / ((now() - t) / 1000)); fs.closeSync(fd); fs.rmSync(file);
const sd = path.join(dir, "small"); t = now();
for (let d = 0; d < 50; d++) { fs.mkdirSync(path.join(sd, String(d)), { recursive: true }); for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(sd, String(d), f + ".txt"), small); }
out.small_create_5k_ms = Math.round(now() - t); t = now();
for (let d = 0; d < 50; d++) for (let f = 0; f < 100; f++) fs.readFileSync(path.join(sd, String(d), f + ".txt"));
out.small_read_5k_ms = Math.round(now() - t); t = now(); fs.rmSync(sd, { recursive: true }); out.small_rm_5k_ms = Math.round(now() - t);
console.log(Object.entries(out).map(([k, v]) => k + "=" + v).join(" "));`;

/**
 * Disk speed inside the machine. First a cold read of the restored or installed
 * tree (the forked bytes themselves), then synthetic I/O in the workspace.
 */
export function io(ws: string) {
  return `${clock}; cd ${ws}/run || exit 3
(sync; echo 3 | sudo -n tee /proc/sys/vm/drop_caches >/dev/null 2>&1 || echo 3 > /proc/sys/vm/drop_caches) 2>/dev/null && echo dropped_caches=yes || echo dropped_caches=no
t0=$(ms); bytes=$(find node_modules backends/workers/node_modules .git -type f -print0 | xargs -0 cat | wc -c); t1=$(ms)
echo "tree_read_bytes=$bytes tree_read_ms=$((t1-t0)) tree_read_mbps=$(( bytes / 1048576 * 1000 / (t1-t0+1) ))"
t0=$(ms); n=$(find node_modules backends/workers/node_modules -type f | wc -l); t1=$(ms); echo "tree_stat_files=$n tree_stat_ms=$((t1-t0))"
cat > /tmp/io.mjs <<'IOEOF'
${IO_MJS}
IOEOF
node /tmp/io.mjs ${ws}/iotest; rm -rf ${ws}/iotest
command -v fio >/dev/null || (sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fio >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fio >/dev/null 2>&1) || true
if command -v fio >/dev/null; then mkdir -p ${ws}/fio; for j in "seqread read 1M" "seqwrite write 1M" "randread randread 4k" "randwrite randwrite 4k"; do set -- $j
  for d in 1 0; do r=$(fio --name=$1 --directory=${ws}/fio --rw=$2 --bs=$3 --size=512M --ioengine=libaio --iodepth=16 --direct=$d --runtime=8 --time_based --group_reporting --output-format=terse --terse-version=3 2>/dev/null) && break; done
  echo "$r" | awk -F';' -v n=$1 -v d=$d '{ if ($0=="") next; rbw=$7; riops=$8; wbw=$48; wiops=$49; printf "fio_%s_direct=%s fio_%s_mbps=%.1f fio_%s_iops=%d\\n", n, d, n, (rbw+wbw)/1024, n, riops+wiops }'
done; rm -rf ${ws}/fio; else echo fio=unavailable; fi`;
}

/** Real work on the large repo: git, warm and cold npm ci, the full typecheck and a test. */
export function realwork(ws: string) {
  return `${clock}; cd ${ws}/run || exit 3
t0=$(ms); git status --porcelain >/dev/null; t1=$(ms); git log --oneline | wc -l >/dev/null; t2=$(ms); echo "git_status_ms=$((t1-t0)) git_log_ms=$((t2-t1))"
t0=$(ms); npm ci --no-audit --no-fund --prefer-offline --loglevel=error >/dev/null 2>&1; e1=$?; t1=$(ms); echo "npm_ci_warm_ms=$((t1-t0)) npm_ci_warm_exit=$e1"
c=$(mktemp -d); t0=$(ms); npm ci --no-audit --no-fund --cache $c --loglevel=error >/dev/null 2>&1; e1=$?; t1=$(ms); rm -rf $c; echo "npm_ci_cold_ms=$((t1-t0)) npm_ci_cold_exit=$e1"
t0=$(ms); npm run typecheck >/tmp/typecheck.log 2>&1; e1=$?; t1=$(ms); echo "typecheck_ms=$((t1-t0)) typecheck_exit=$e1"
t0=$(ms); node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/config.test.ts >/dev/null 2>&1; e1=$?; t1=$(ms); echo "test_ms=$((t1-t0)) test_exit=$e1"`;
}
