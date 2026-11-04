/** Paid, opt-in benchmark. Uses the production driver; never loads a model. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Outbound } from "../../src/outbound.ts";
import { microvmApi, microvmMachines, MICROVM_HOUR } from "../../src/computers/microvm.ts";
import type { Db } from "../../src/db.ts";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const dir = new URL("./", import.meta.url).pathname;
const file = process.argv[3] ?? `${dir}results.json`;
const mode = process.argv[2];
if (!["run", "node22", "typescript", "rust-repeats", "cleanup"].includes(mode)) throw new Error("Usage: run.ts run|node22|typescript|rust-repeats|cleanup [results.json] (creates paid AWS resources)");
if (mode !== "cleanup" && existsSync(file)) throw new Error("Evidence file exists; choose a new path or use cleanup. Never overwrite an ownership ledger.");
const region = "us-west-2", image = "arn:aws:lambda:us-west-2:904534089871:microvm-image:camelrun-computers";
const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
if (identity.Account !== "904534089871" || identity.Arn !== "arn:aws:iam::904534089871:user/macbook") throw new Error("Unexpected AWS identity");
const outbound = new Outbound();
const rawApi = microvmApi(region, outbound);
const data: any = mode === "cleanup" ? JSON.parse(readFileSync(file, "utf8")) : {
  startedAt: new Date().toISOString(), mode, image, imageVersion: "1.0", region, identity: identity.Arn,
  hourlyRate: MICROVM_HOUR, leaseSeconds: 3600, created: [], requests: [], steps: [], api: [],
};
mkdirSync(dir, { recursive: true });
const save = () => {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
async function list() {
  const items: any[] = []; let nextToken: string | undefined;
  do { const r = await rawApi("ListMicrovms", { maxResults: 50, ...(nextToken ? { nextToken } : {}) });
    items.push(...r.items); nextToken = r.nextToken;
  } while (nextToken);
  return items.map(({ microvmId, state, imageArn, imageVersion, startedAt }: any) =>
    ({ microvmId, state, imageArn, imageVersion, startedAt }));
}
const api = async (op: string, input: Record<string, any>, recovery = false) => {
  if (stopping && !recovery && (op === "RunMicrovm" || op === "SuspendMicrovm" || op === "ResumeMicrovm")) throw new Error("Benchmark is stopping");
  if (op === "RunMicrovm") {
    if (!input.clientToken?.startsWith("camelrun-bench-") || input.imageIdentifier !== image ||
        input.imageVersion !== "1.0" || input.maximumDurationInSeconds !== 3600 || input.executionRoleArn) throw new Error("Refusing an out-of-scope launch");
    data.requests ??= [];
    if (!data.requests.some((r: any) => r.clientToken === input.clientToken)) { data.requests.push(input); save(); }
  }
  if (["TerminateMicrovm", "SuspendMicrovm", "ResumeMicrovm"].includes(op) &&
      !data.created.some((v: any) => v.id === input.microvmIdentifier)) throw new Error("Refusing to mutate an unowned VM");
  const start = performance.now();
  const result = await rawApi(op, input);
  if (op === "RunMicrovm") {
    if (data.before.some((v: any) => v.microvmId === result.microvmId)) throw new Error("Launch returned a pre-existing VM");
    if (!data.created.some((v: any) => v.id === result.microvmId)) data.created.push({ id: result.microvmId, token: input.clientToken, startedAt: new Date().toISOString() });
  }
  // Never persist auth tokens, signed headers or proxy endpoints.
  data.api.push({ op, id: result.microvmId ?? input.microvmIdentifier, at: new Date().toISOString(), seconds: (performance.now() - start) / 1000, state: result.state });
  save(); return result;
};
let cleaning: Promise<void> | undefined;
async function performCleanup() {
  stopping = true;
  data.cleanupStartedAt = new Date().toISOString(); save();
  // Recover an accepted launch whose response was lost using its original idempotency token.
  for (const request of data.requests ?? []) {
    if (!data.created.some((v: any) => v.token === request.clientToken)) await api("RunMicrovm", request, true);
  }
  for (const vm of data.created) {
    try {
      await api("TerminateMicrovm", { microvmIdentifier: vm.id });
      for (let n = 0; n < 90; n++) {
        const state = await api("GetMicrovm", { microvmIdentifier: vm.id });
        if (state.state === "TERMINATED") { vm.terminatedAt = new Date().toISOString(); break; }
        await wait(1000);
      }
    } catch (e: any) { if (e.status === 404) vm.terminatedAt = new Date().toISOString(); else vm.cleanupError = String(e); }
  }
  data.after = await list();
  data.cleanupVerified = data.created.every((v: any) => !data.after.some((a: any) => a.microvmId === v.id && a.state !== "TERMINATED"));
  data.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ cleanupVerified: data.cleanupVerified, created: data.created, beforeCount: data.before?.length, afterCount: data.after.length }));
  if (!data.cleanupVerified) throw new Error("Cleanup incomplete: rerun cleanup with this evidence file");
}
const cleanup = () => cleaning ??= performCleanup();
if (mode === "cleanup") { await cleanup(); await outbound.dispatcher.close(); process.exit(0); }

// In-memory ownership/metering rows exercise the actual microvmMachines adapter without production DB access.
const pg = new PGlite();
await pg.exec("create table managed_computers (id text primary key, tenant text, machine text, provider text default 'lambda', created_at bigint, ended_at bigint, microvm jsonb)");
const query = async (sql: string, params?: unknown[]) => { const r = await pg.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
const db = { query, connect: async () => ({ query, release() {}, on() {}, off() {} }) } as unknown as Db;
const machines = microvmMachines({ db, outbound, api, runtime: "camelrun-bench", settings: { image, version: "1.0", region, idleSeconds: 300 } });
const sh = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function run(id: string, label: string, command: string, seconds = 1200, timed = true) {
  if (stopping) throw new Error("Benchmark is stopping");
  const prefix = `/root/bench-logs/${label}`;
  const wrapped = timed ? `mkdir -p /root/bench-logs; /usr/bin/time -f 'BENCH wall=%e user=%U sys=%S rss_kb=%M exit=%x' -o ${sh(prefix + '.time')} bash -lc ${sh(command)} >${sh(prefix + '.log')} 2>&1; rc=$?; cat ${sh(prefix + '.time')}; tail -n 24 ${sh(prefix + '.log')}; exit $rc` : command;
  const start = performance.now();
  const result = await machines.run(id, wrapped, seconds, randomUUID());
  const step = { label, id, command, at: new Date().toISOString(), clientSeconds: (performance.now() - start) / 1000, ...result };
  data.steps.push(step); save();
  console.log(JSON.stringify({ ...step, stdout: step.stdout.slice(-4000), stderr: step.stderr.slice(-1000) })); return step;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  stopping = true;
  console.error(`${signal}: terminating only benchmark-owned VMs`);
  void cleanup().then(() => process.exit(130), error => { console.error(String(error)); process.exit(1); });
});
try {
  data.before = await list(); save(); console.log(JSON.stringify({ before: data.before }));
  let primary = "";
  for (let i = 1; i <= (mode === "run" ? 3 : 1); i++) {
    const name = `camelrun-bench-${randomUUID()}`;
    await query("insert into managed_computers(id,tenant,created_at) values ($1,'benchmark',$2)", [name, Date.now()]);
    const start = performance.now(); const vm = await machines.create(name, "benchmark", 3600);
    const first = await run(vm.id, `first-exec-${i}`, "true", 60, false);
    data.created.at(-1).firstExecSeconds = (performance.now() - start) / 1000; save();
    if (i === 1) primary = vm.id;
    else await api("TerminateMicrovm", { microvmIdentifier: vm.id });
  }
  await run(primary, "system", "uname -m; nproc; free -m; df -h ~; node --version; npm --version; command -v gcc g++ make time; cat /proc/self/cgroup; cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max 2>/dev/null; cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null; true", 60, false);
  await run(primary, "prerequisites", "dnf install -y time gcc gcc-c++ make perl pkgconf-pkg-config xz", 600, false);
  await run(primary, "versions", "node --version; npm --version; gcc --version | head -1; /usr/bin/time --version | head -1", 60, false);
  if (mode === "rust-repeats") {
    for (let i = 2; i <= 3; i++) {
      await run(primary, `rust-install-${i}`, `curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | RUSTUP_HOME=/root/rust-${i} CARGO_HOME=/root/cargo-${i} sh -s -- -y --profile minimal --no-modify-path`);
    }
  } else {
  if (mode === "node22" || mode === "typescript") {
    await run(primary, "node22-install", "curl -fsSLo /tmp/node22.tar.xz https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-arm64.tar.xz && mkdir -p /opt/node22 && tar -xJf /tmp/node22.tar.xz -C /opt/node22 --strip-components=1 && mkdir -p /usr/local/bin && ln -sf /opt/node22/bin/node /opt/node22/bin/npm /opt/node22/bin/npx /usr/local/bin/");
    await run(primary, "node22-versions", "node --version; npm --version", 60, false);
  }
  if (mode !== "typescript") for (let i = 1; i <= 3; i++) {
    const root = `/root/bench-${i}`;
    await run(primary, `express-clone-${i}`, `mkdir -p ${root}; cd ${root}; git clone --depth 1 https://github.com/expressjs/express`);
    await run(primary, `express-install-${i}`, `cd ${root}/express; npm install --cache ${root}/npm-cache`);
    await run(primary, `express-test-${i}`, `cd ${root}/express; npm test`);
    await run(primary, `express-revision-${i}`, `git -C ${root}/express rev-parse HEAD`, 60, false);
  }
  if (mode === "run") {
  await run(primary, "rust-install", 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal');
  await run(primary, "rust-versions", "source /root/.cargo/env; rustc --version; cargo --version", 60, false);
  for (let i = 1; i <= 3; i++) {
    const root = `/root/bench-${i}`;
    await run(primary, `ripgrep-clone-${i}`, `cd ${root}; git clone --depth 1 https://github.com/BurntSushi/ripgrep`);
    await run(primary, `ripgrep-build-${i}`, `source /root/.cargo/env; cd ${root}/ripgrep; CARGO_HOME=${root}/cargo-cache cargo build --release`);
    await run(primary, `ripgrep-revision-${i}`, `git -C ${root}/ripgrep rev-parse HEAD; ${root}/ripgrep/target/release/rg --version; df -h ~; free -m`, 60, false);
  }
  await run(primary, "ripgrep-build-j4", "source /root/.cargo/env; cd /root/bench-1/ripgrep; nproc; CARGO_HOME=/root/bench-1/cargo-cache CARGO_TARGET_DIR=/root/ripgrep-target-j4 cargo build --release -j 4");
  await run(primary, "persistence-before", "setsid sleep 3600 </dev/null >/root/sleeper.log 2>&1 & echo $! >/root/sleeper.pid; sleep 0.1; cat /root/sleeper.pid; ps -p $(cat /root/sleeper.pid) -o pid,lstart,args; sha256sum /root/bench-1/ripgrep/target/release/rg; du -sb /root/bench-1/ripgrep; echo persistent >/root/bench-marker", 60, false);
  for (let i = 1; i <= 3; i++) {
    const start = performance.now(); await api("SuspendMicrovm", { microvmIdentifier: primary });
    for (let n = 0; n < 120; n++) { const v = await api("GetMicrovm", { microvmIdentifier: primary }); if (v.state === "SUSPENDED") break; if(n === 119) throw new Error("Suspend timeout"); await wait(250); }
    data.steps.push({ label: `suspend-${i}`, seconds: (performance.now() - start) / 1000 }); save();
    await run(primary, `resume-${i}`, "cat /root/bench-marker; ps -p $(cat /root/sleeper.pid) -o pid,lstart,args; sha256sum /root/bench-1/ripgrep/target/release/rg; /root/bench-1/ripgrep/target/release/rg --version; du -sb /root/bench-1/ripgrep", 60, false);
  }
  }
  if (mode === "typescript") await run(primary, "go-install", "curl -fsSLo /tmp/go127.tar.gz https://go.dev/dl/go1.27.3.linux-arm64.tar.gz && echo 'a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49  /tmp/go127.tar.gz' | sha256sum -c - && mkdir -p /opt/go127 && tar -C /opt/go127 -xzf /tmp/go127.tar.gz && ln -sf /opt/go127/go/bin/go /opt/go127/go/bin/gofmt /usr/local/bin/ && go version", 600);
  await run(primary, "typescript-clone", "cd /root; git clone --depth 1 https://github.com/microsoft/TypeScript");
  await run(primary, "typescript-install", "cd /root/TypeScript; npm ci");
  await run(primary, "typescript-build", "cd /root/TypeScript; npx hereby local");
  await run(primary, "typescript-diagnostics", "git -C /root/TypeScript rev-parse HEAD; free -m; df -h ~; du -sh /root/TypeScript; cat /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat 2>/dev/null; dmesg | tail -n 20; true", 60, false);
  const output = await run(primary, "output-limit", "python3 -c 'import sys; print(\"x\"*70000); print(\"y\"*70000,file=sys.stderr)'", 60, false);
  // Keep the evidence compact while retaining exact lengths and truncation flags.
  Object.assign(output, { stdoutBytes: Buffer.byteLength(output.stdout), stderrBytes: Buffer.byteLength(output.stderr), stdout: output.stdout.slice(0, 80), stderr: output.stderr.slice(0, 80) }); save();
  await run(primary, "final-resources", "nproc; free -m; df -h ~; du -sh /root/bench-* /root/.rustup /root/.cargo /root/ripgrep-target-j4 2>/dev/null", 60, false);
  }
} catch (error) { data.error = String(error); save(); console.error(data.error); process.exitCode = 1; }
finally { await cleanup(); await pg.close(); await outbound.dispatcher.close(); }
