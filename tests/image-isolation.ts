/**
 * Linux, Docker: boots the built image the way ECS runs it (as root, under an init) and
 * proves the js_exec sandbox processes are confined, from inside one of them:
 *   IMAGE=agent-runtime:ci DATABASE_URL=postgres://... node --experimental-strip-types tests/image-isolation.ts
 * DATABASE_URL is as the container sees it; the container shares the host network on
 * Linux and publishes its port elsewhere (use host.docker.internal there).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";

const image = process.env.IMAGE ?? "agent-runtime:ci";
const database = process.env.DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:5432/postgres";
const hostNetwork = process.platform === "linux";
const port = hostNetwork ? 8790 : 18790;
const url = `http://127.0.0.1:${port}`;
const token = "isolation-test-token-with-enough-characters";
const canary = `canary-${randomBytes(8).toString("hex")}`;
const name = `agent-isolation-${randomBytes(4).toString("hex")}`;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
const logs = () => { const out = spawnSync("docker", ["logs", name], { encoding: "utf8" }); return out.stdout + out.stderr; };

docker("run", "-d", "--init", "--name", name, ...(hostNetwork ? ["--network", "host"] : ["-p", `127.0.0.1:${port}:8790`]),
  "-e", `AGENT_RUNTIME_TOKEN=${token}`, "-e", `AGENT_DATABASE_URL=${database}`, "-e", "AGENT_HOSTING=inline",
  "-e", "AGENT_SANDBOX_TEST_HOOKS=1", "-e", `AGENT_ISOLATION_CANARY=${canary}`, image);
let failed = true;
try {
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    healthy = await fetch(`${url}/healthz`).then(response => response.ok, () => false);
    if (!healthy) await sleep(1000);
  }
  assert.ok(healthy, "The runtime never became healthy");
  const listening = logs().split("\n").map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(line => line?.type === "listening");
  assert.equal(listening?.sandbox?.mode, "isolated", "The boot log reports isolated mode");
  const runtimePid = Number(/runtime started \(pid (\d+), uid 1000\)/.exec(logs())![1]);
  const sandboxPids = () => [0, 1].map(index => Number([...logs().matchAll(new RegExp(`sandbox ${index} started \\(pid (\\d+), uid (\\d+)\\)`, "g"))].at(-1)![1]));
  console.log(`isolated mode: runtime pid ${runtimePid}, sandbox pids ${sandboxPids().join(", ")}`);

  // What the runtime's uid (the only one that can connect) sees when it asks a sandbox process to probe itself.
  const client = `
    const { connect } = require("node:net");
    const [path, params] = process.argv.slice(1);
    const socket = connect(path);
    const body = Buffer.from(JSON.stringify({ type: "request", id: "probe", method: "probe", params: JSON.parse(params) }));
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) { process.stdout.write(data.subarray(4, 4 + data.readUInt32BE(0))); socket.destroy(); }
    });`;
  for (const [index, pid] of sandboxPids().entries()) {
    const sibling = sandboxPids()[1 - index];
    const params = { pid: runtimePid, sibling, launcher: "/usr/local/bin/agent-launcher", paths: ["/data", `/proc/${runtimePid}/environ`, "/proc/1/environ", "/run/agent-sandbox", `/proc/${sibling}/environ`] };
    const reply = JSON.parse(docker("exec", "-u", "node", name, "node", "-e", client, `/run/agent-sandbox/${index}.sock`, JSON.stringify(params)));
    assert.equal(reply.error, undefined, reply.error);
    const probe = reply.result;
    assert.equal(probe.pid, pid);
    assert.equal(probe.uid, 1001 + index, "Runs as its own sandbox uid");
    assert.equal(probe.status.Groups, "", "No supplementary groups");
    assert.deepEqual(probe.env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", TMPDIR: "/nonexistent" }, "Empty environment");
    assert.equal(probe.status.NoNewPrivs, "1");
    assert.equal(probe.status.Seccomp, "2", "In seccomp filter mode");
    assert.equal(probe.status.CapEff, "0000000000000000");
    assert.equal(probe.tcp, "EPERM", "No TCP from Node");
    for (const [path, outcome] of Object.entries(probe.files)) assert.equal(outcome, "EACCES", `${path} is unreadable`);
    for (const [target, native] of Object.entries(probe.native as Record<string, Record<string, string>>)) {
      assert.deepEqual(native, {
        socket_inet: "EPERM", socket_unix: "EPERM", ptrace_attach: "EPERM", process_vm_readv: "EPERM",
        unshare_user: "EPERM", io_uring_setup: "EPERM", bpf: "EPERM", environ: "EACCES", mem: "EACCES",
      }, `native calls against the ${target} fail`);
    }
    assert.ok(!JSON.stringify(probe).includes(canary));
    console.log(`sandbox ${index}: uid ${probe.uid}, env ${Object.keys(probe.env).join("/")}, seccomp ${probe.status.Seccomp}, no_new_privs, ` +
      `TCP ${probe.tcp}, socket(AF_INET) ${probe.native.runtime.socket_inet}, ptrace ${probe.native.runtime.ptrace_attach}, ` +
      `process_vm_readv ${probe.native.runtime.process_vm_readv}, runtime environ ${probe.files[`/proc/${runtimePid}/environ`]}, /data ${probe.files["/data"]}`);
  }

  // js_exec end to end through the runtime, with a client tool call, and a sandbox process killed mid-execution.
  let kill = false;
  const runtime = new AgentRuntime({ url, apiKey: token, journalStore: memoryJournalStore() });
  const agent = await runtime.createAgent({
    name: "isolation", type: "isolation-test",
    tools: {
      lookup: tool({
        description: "Look up a value; kills the sandbox processes first when asked",
        input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
        execute: async ({ key }) => {
          if (kill) {
            docker("exec", name, "sh", "-c", `kill -9 ${sandboxPids().join(" ")}`);
            await sleep(500);
          }
          return key === "answer" ? "42" : null;
        },
      }),
    },
  });
  try {
    const executed = await agent.execute('const key: string = "answer"; return await tools.lookup({ key })');
    assert.deepEqual(executed.output, ["42"]);
    console.log("js_exec: ok through the sandbox processes, client tool included");
    const before = sandboxPids();
    kill = true;
    const outcome = await agent.execute('return await tools.lookup({ key: "answer" })').then(() => "completed", (error: Error) => error.message);
    assert.match(outcome, /Codemode sandbox process exited/, "An execution in flight when its sandbox process dies fails clearly");
    kill = false;
    for (let i = 0; i < 50 && sandboxPids().some(pid => before.includes(pid)); i++) await sleep(100);
    assert.ok(sandboxPids().every(pid => !before.includes(pid)), "The launcher restarted both sandbox processes");
    for (let i = 0; i < 4; i++) assert.deepEqual((await agent.execute('return await tools.lookup({ key: "answer" })')).output, ["42"]);
    console.log(`killed sandbox processes ${before.join(", ")}: the execution failed with "${outcome}"; restarted as ${sandboxPids().join(", ")} and serving`);
  } finally {
    await agent.destroy();
  }
  failed = false;
  console.log("image isolation test passed");
} finally {
  if (failed) console.error(logs());
  spawnSync("docker", ["rm", "-f", name]);
}
