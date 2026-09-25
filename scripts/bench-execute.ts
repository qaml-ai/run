// Server CPU per js_exec that calls one client tool, the way the SDKs drive it:
// POST /requests, SSE tool_call, claim, outcome, SSE response. The runtime runs in
// its own process (inline hosting, shared-file storage, a fresh database on the
// local Postgres), so the clients' CPU is not counted. Usage:
//   npm run bench:execute -- [--agents 32] [--execs 3000] [--warmup 500] [--cpus 1] [--profile <file.cpuprofile>]
// --profile records the server's main thread during the measured executions.
// Postgres statements are counted in the server, each one a round trip.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { AgentRuntime, memoryJournalStore, schema, tool, type AgentClient } from "../clients/typescript.ts";

const { values: args } = parseArgs({ options: {
  agents: { type: "string", default: "32" }, execs: { type: "string", default: "3000" }, warmup: { type: "string", default: "500" },
  profile: { type: "string" }, cpus: { type: "string" }, code: { type: "string", default: 'return await tools.echo({ value: "hello" })' },
} });
const agents = Number(args.agents), execs = Number(args.execs), warmup = Number(args.warmup);
const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres";
const token = "bench-operator-token-at-least-24-chars";

// A database of its own, dropped afterwards.
const admin = new pg.Client({ connectionString: databaseUrl });
await admin.connect();
const database = `bench_${randomBytes(6).toString("hex")}`;
await admin.query(`create database ${database}`);
const url = new URL(databaseUrl);
url.pathname = `/${database}`;
const root = await mkdtemp(join(tmpdir(), "agent-bench-"));
await writeFile(join(root, "tenants.json"), JSON.stringify({ tenants: { bench: { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: { anthropic: "unused-key" } } } }));

const port = await new Promise<number>(done => { const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); }); });
const profile = args.profile && resolve(args.profile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const node = [
  "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
  "--import", fileURLToPath(new URL("./bench-probe.ts", import.meta.url)), ...(process.env.BENCH_NODE_ARGS?.split(" ").filter(Boolean) ?? []),
  fileURLToPath(new URL("../src/server.ts", import.meta.url)),
];
const env: Record<string, string> = {
  PORT: String(port), AGENT_DATABASE_URL: url.toString(),
  AGENT_DATA_DIR: join(root, "data"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
  AGENT_MAX_AGENTS: String(agents * 2), AGENT_MAX_AGENTS_PER_TENANT: String(agents * 2),
  AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "bench-session-secret-with-32-characters!!",
};
// --cpus runs the runtime in a Linux container with that many CPUs, like a Fargate task,
// with the repository, the data directory and the profile's directory at the same paths.
const container = `agent-bench-${port}`;
const child = args.cpus
  ? spawn("docker", ["run", "--rm", "-i", "--name", container, `--cpus=${args.cpus}`, "-p", `127.0.0.1:${port}:${port}`,
    ...[repository, root, ...(profile ? [dirname(profile)] : [])].flatMap(path => ["-v", `${path}:${path}`]),
    ...Object.entries({ ...env, HOST: "0.0.0.0", AGENT_DATABASE_URL: env.AGENT_DATABASE_URL.replace(/@(127\.0\.0\.1|localhost)(?=[:/])/, "@host.docker.internal") }).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "node:22-bookworm", "node", ...node], { stdio: ["pipe", "pipe", "inherit"] })
  : spawn(process.execPath, node, { env: { PATH: process.env.PATH, HOME: root, HOST: "127.0.0.1", ...env }, stdio: ["pipe", "pipe", "inherit"] });
const probes: ((value: any) => void)[] = [];
const ready = Promise.withResolvers<void>();
let pending = "";
child.stdout!.setEncoding("utf8").on("data", chunk => {
  pending += chunk;
  for (let end; (end = pending.indexOf("\n")) !== -1; pending = pending.slice(end + 1)) {
    let line: any;
    try { line = JSON.parse(pending.slice(0, end)); } catch { if (process.env.BENCH_VERBOSE) console.error(pending.slice(0, end)); continue; }
    if (line.type === "listening") ready.resolve();
    if (line.type === "bench_probe") probes.shift()?.(line);
  }
});
child.once("exit", code => ready.reject(new Error(`The runtime exited: ${code}`)));
process.once("exit", () => { child.kill("SIGKILL"); if (args.cpus) spawnSync("docker", ["kill", container], { stdio: "ignore" }); });
await ready.promise;

const probe = (command = "probe"): Promise<any> => {
  const answer = new Promise(done => probes.push(done));
  child.stdin!.write(`${command}\n`);
  return answer;
};

const echo = tool({ description: "Echo", input: schema.Object({ value: schema.String() }), execute: ({ value }) => value });
const runtime = new AgentRuntime({ url: `http://127.0.0.1:${port}`, apiKey: token, journalStore: memoryJournalStore() });
const clients: AgentClient[] = await Promise.all(Array.from({ length: agents }, (_, index) => runtime.createAgent({ tools: { echo }, idempotencyKey: `bench-${index}` })));

/** `count` executions spread over the agents, each agent running one at a time as its runs are serialized anyway. */
async function drive(count: number) {
  let left = count;
  const latencies: number[] = [];
  await Promise.all(clients.map(async client => {
    while (left-- > 0) {
      const started = performance.now();
      const result = await client.execute(args.code!);
      if (result?.output?.[0] !== "hello") throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
      latencies.push(performance.now() - started);
    }
  }));
  return latencies.sort((a, b) => a - b);
}

try {
  await drive(warmup);
  if (profile) await probe("profile-start");
  const before = await probe();
  const started = performance.now();
  const latencies = await drive(execs);
  const seconds = (performance.now() - started) / 1000;
  const after = await probe();
  if (profile) await probe(`profile-stop ${profile}`);
  const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
  const statements = Object.entries(after.statements as Record<string, number>)
    .map(([kind, total]) => [kind, (total - (before.statements[kind] ?? 0)) / execs] as const)
    .filter(([, perExec]) => perExec >= 0.01).sort((a, b) => b[1] - a[1]);
  console.log(JSON.stringify({
    agents, execs,
    cpuMsPerExec: +(cpuMs / execs).toFixed(3),
    userMsPerExec: +((after.cpu.user - before.cpu.user) / 1000 / execs).toFixed(3),
    ...(after.mainThreadUs !== undefined ? { mainThreadMsPerExec: +((after.mainThreadUs - before.mainThreadUs) / 1000 / execs).toFixed(3) } : {}),
    ...(after.cgroupUs !== undefined ? { containerMsPerExec: +((after.cgroupUs - before.cgroupUs) / 1000 / execs).toFixed(3) } : {}),
    execsPerSecond: +(execs / seconds).toFixed(1),
    serverCpuPercent: +(cpuMs / 10 / seconds).toFixed(1),
    p50Ms: +latencies[Math.floor(latencies.length / 2)].toFixed(2), p99Ms: +latencies[Math.floor(latencies.length * 0.99)].toFixed(2),
    statementsPerExec: +statements.reduce((sum, [, perExec]) => sum + perExec, 0).toFixed(2),
    statements: Object.fromEntries(statements.map(([kind, perExec]) => [kind, +perExec.toFixed(2)])),
  }, null, 2));
} finally {
  await Promise.all(clients.map(client => client.close()));
  child.kill("SIGINT");
  await once(child, "exit");
  await admin.query(`drop database ${database} with (force)`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
