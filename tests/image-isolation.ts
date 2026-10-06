/**
 * Linux, Docker: boots the built image the way ECS runs it (as root, under an init) and proves the
 * processes agent-launcher confines (v8-exec for js_exec, parse jobs for files) are confined, from
 * inside them:
 *   IMAGE=agent-runtime:ci DATABASE_URL=postgres://... [AGENT_HOSTING=process] node --experimental-strip-types tests/image-isolation.ts
 * DATABASE_URL is as the container sees it; the container shares the host network on
 * Linux and publishes its port elsewhere (use host.docker.internal there).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";

const image = process.env.IMAGE ?? "agent-runtime:ci";
const database = process.env.DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:5432/postgres";
const hostNetwork = process.platform === "linux";
const port = hostNetwork ? 8790 : 18790;
const url = `http://127.0.0.1:${port}`;
const token = "isolation-test-token-with-enough-characters";
const canary = `canary-${randomBytes(8).toString("hex")}`;
const name = `agent-isolation-${randomBytes(4).toString("hex")}`;
/** The launcher's sandbox uids: 1001 + a process's slot, of 512. */
const SANDBOX_UIDS = [1001, 1001 + 512];

// The runtime reads its one tenant from a file mounted into the container; js_exec needs no model key.
const tenants = mkdtempSync(join(tmpdir(), "agent-isolation-"));
chmodSync(tenants, 0o755);
writeFileSync(join(tenants, "tenants.json"), JSON.stringify({ tenants: { isolation: { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: { anthropic: "unset" } } } }), { mode: 0o644 });

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
const logs = () => { const out = spawnSync("docker", ["logs", name], { encoding: "utf8" }); return out.stdout + out.stderr; };

docker("run", "-d", "--init", "--name", name, ...(hostNetwork ? ["--network", "host"] : ["-p", `127.0.0.1:${port}:8790`]),
  "-v", `${tenants}:/etc/agent-runtime:ro`, "-e", "AGENT_TENANTS_FILE=/etc/agent-runtime/tenants.json", "-e", `AGENT_SESSION_SECRET=${token}`, "-e", `AGENT_DATABASE_URL=${database}`, "-e", `AGENT_HOSTING=${process.env.AGENT_HOSTING ?? "inline"}`,
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
  console.log(`isolated mode: runtime pid ${runtimePid}`);

  /** The confined processes alive now (as root sees them): pid, program, uid and confinement. */
  const confined = (): Record<string, string>[] => JSON.parse(docker("exec", name, "node", "-e", `
    const fs = require("node:fs");
    const found = [];
    for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
      try {
        const status = Object.fromEntries(fs.readFileSync("/proc/" + pid + "/status", "utf8").split("\\n").map(line => line.split(":\\t")));
        if (Number(status.Uid.split("\\t")[0]) < ${SANDBOX_UIDS[0]}) continue;
        const limits = fs.readFileSync("/proc/" + pid + "/limits", "utf8").split("\\n").filter(line => /cpu time|processes|file size/i.test(line)).map(line => line.replace(/\\s+/g, " ").trim());
        found.push({ pid, program: fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0")[0], uid: status.Uid.split("\\t")[0], Seccomp: status.Seccomp, Seccomp_filters: status.Seccomp_filters, NoNewPrivs: status.NoNewPrivs, CapEff: status.CapEff, limits: limits.join("; "),
          environ: (() => { try { return fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch (error) { return error.code; } })() });
      } catch {}
    }
    process.stdout.write(JSON.stringify(found));`));

  // A parse job, asked by the runtime's uid (the only one that can connect) to report what it can reach.
  const probeClient = `
    const { connect } = require("node:net");
    const socket = connect("/run/agent-sandbox/parse.sock");
    const body = Buffer.from(JSON.stringify({ type: "request", id: "probe", method: "probe", params: JSON.parse(process.argv[1]) }));
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) { process.stdout.write(data.subarray(4, 4 + data.readUInt32BE(0))); socket.destroy(); }
    });`;
  const probe = (sibling: number, paths: string[] = []) => {
    const params = { pid: runtimePid, sibling, launcher: "/usr/local/bin/agent-launcher", paths: ["/data", `/proc/${runtimePid}/environ`, "/proc/1/environ", "/run/agent-sandbox", ...paths] };
    const reply = JSON.parse(docker("exec", "-u", "node", name, "node", "-e", probeClient, JSON.stringify(params)));
    assert.equal(reply.error, undefined, reply.error);
    return reply.result;
  };
  const DENIED = { socket_inet: "EPERM", socket_unix: "EPERM", ptrace_attach: "EPERM", process_vm_readv: "EPERM", unshare_user: "EPERM", io_uring_setup: "EPERM", bpf: "EPERM", environ: "EACCES", mem: "EACCES" };
  const checkParseJob = (found: any) => {
    assert.ok(found.uid >= SANDBOX_UIDS[0] && found.uid < SANDBOX_UIDS[1], `Runs as a sandbox uid: ${found.uid}`);
    assert.equal(found.status.Groups, "", "No supplementary groups");
    assert.deepEqual(found.env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", TMPDIR: "/nonexistent" }, "Empty environment");
    assert.equal(found.status.NoNewPrivs, "1");
    assert.equal(found.status.Seccomp, "2", "In seccomp filter mode");
    assert.equal(found.status.CapEff, "0000000000000000");
    assert.equal(found.tcp, "EPERM", "No TCP from Node");
    for (const [path, outcome] of Object.entries(found.files)) assert.equal(outcome, "EACCES", `${path} is unreadable`);
    for (const [target, native] of Object.entries(found.native as Record<string, Record<string, string>>)) assert.deepEqual(native, DENIED, `native calls against the ${target} fail`);
    assert.ok(!JSON.stringify(found).includes(canary));
  };

  const parseJob = probe(runtimePid);
  checkParseJob(parseJob);
  console.log(`parse job: uid ${parseJob.uid}, env ${Object.keys(parseJob.env).join("/")}, seccomp ${parseJob.status.Seccomp}, no_new_privs, ` +
    `TCP ${parseJob.tcp}, socket(AF_INET) ${parseJob.native.runtime.socket_inet}, ptrace ${parseJob.native.runtime.ptrace_attach}, ` +
    `process_vm_readv ${parseJob.native.runtime.process_vm_readv}, runtime environ ${parseJob.files[`/proc/${runtimePid}/environ`]}, /data ${parseJob.files["/data"]}`);

  // An image scaled down for a model request, decoded with sharp in a parse job: its bytes come back in frames.
  const fit = `
    const { connect } = require("node:net");
    const sharp = require("sharp");
    (async () => {
      const image = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#3366aa" } }).png().toBuffer();
      const socket = connect("/run/agent-sandbox/parse.sock");
      const send = message => { const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header, body])); };
      send({ type: "request", id: "inspect", method: "inspect", params: { size: image.length, text: false, fit: true } });
      send({ type: "data", data: image.toString("base64") });
      let data = Buffer.alloc(0);
      const parts = [];
      socket.on("data", chunk => {
        data = Buffer.concat([data, chunk]);
        while (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) {
          const message = JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)));
          data = data.subarray(4 + data.readUInt32BE(0));
          if (message.type === "data") { parts.push(Buffer.from(message.data, "base64")); continue; }
          const out = Buffer.concat(parts);
          process.stdout.write(JSON.stringify({ ...message, bytes: out.length, width: out.readUInt32BE(16), height: out.readUInt32BE(20) }));
          socket.destroy();
        }
      });
    })();`;
  const scale = () => {
    const fitted = JSON.parse(docker("exec", "-u", "node", name, "node", "-e", fit));
    assert.equal(fitted.error, undefined, fitted.error);
    assert.deepEqual([fitted.result.media, fitted.width, fitted.height], [{ kind: "image", mimeType: "image/png", width: 1568, height: 1176 }, 1568, 1176]);
    return fitted;
  };
  const fitted = scale();
  console.log(`parse job: scaled a 2400×1800 image to ${fitted.width}×${fitted.height} (${fitted.bytes} bytes) with sharp`);

  // js_exec end to end through the runtime, with a client tool call; then every confined process killed mid-execution.
  let kill = false;
  let seen: { processes: Record<string, string>[]; probe: any } | undefined;
  const runtime = new AgentRuntime({ url, apiKey: token });
  const agent = await runtime.createAgent({
    name: "isolation", type: "isolation-test",
    tools: {
      lookup: tool({
        description: "Look up a value; kills the confined processes first when asked",
        input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
        execute: async ({ key }) => {
          if (kill) {
            docker("exec", name, "sh", "-c", `kill -9 ${confined().map(entry => entry.pid).join(" ")}`);
            await sleep(500);
          } else if (!seen) {
            const processes = confined();
            // The one running this execution has its rlimits set (others were started ahead, and wait for theirs).
            const running = processes.find(entry => entry.program === "v8-exec" && entry.limits.includes("Max processes 0 0"));
            // What a parse job, another sandbox uid, can do to it: nothing.
            seen = { processes, probe: running ? probe(Number(running.pid), [`/proc/${running.pid}/mem`, `/proc/${running.pid}/environ`]) : undefined };
          }
          return key === "answer" ? "42" : null;
        },
      }),
    },
  });
  try {
    const executed = await agent.execute('const key: string = "answer"; return await tools.lookup({ key })');
    assert.deepEqual(executed.output, ["42"]);
    console.log("js_exec: ok through the launcher, client tool included");
    const v8 = seen!.processes.filter(entry => entry.program === "v8-exec");
    const running = v8.filter(entry => entry.limits.includes("Max processes 0 0"));
    assert.equal(running.length, 1, JSON.stringify(seen));
    assert.ok(v8.length >= 2, `The running one and those started ahead: ${JSON.stringify(v8)}`);
    const uids = seen!.processes.map(entry => entry.uid);
    assert.equal(new Set(uids).size, uids.length, `Every confined process has a uid of its own: ${uids}`);
    for (const child of v8) {
      assert.ok(Number(child.uid) >= SANDBOX_UIDS[0] && Number(child.uid) < SANDBOX_UIDS[1], `A sandbox uid: ${child.uid}`);
      assert.equal(child.Seccomp, "2", "In seccomp filter mode");
      assert.equal(child.NoNewPrivs, "1");
      assert.equal(child.CapEff, "0000000000000000");
      assert.ok(child.environ === "" || child.environ === "EACCES", `No environment to read: ${child.environ}`);
    }
    const [child] = running;
    const fromJob = seen!.probe;
    // A parse job has the container's filter (if any) and the launcher's; v8-exec its own allowlist on top.
    assert.equal(Number(child.Seccomp_filters), Number(fromJob.status.Seccomp_filters) + 1, "The launcher's filter, then its own allowlist");
    checkParseJob(fromJob);
    assert.notEqual(String(fromJob.uid), child.uid, "The parse job and the execution have different uids");
    assert.deepEqual([fromJob.files[`/proc/${child.pid}/mem`], fromJob.files[`/proc/${child.pid}/environ`]], ["EACCES", "EACCES"]);
    console.log(`v8-exec child: ${JSON.stringify(child)}; from a parse job (uid ${fromJob.uid}): ${JSON.stringify(fromJob.native.sibling)}`);

    kill = true;
    const before = confined().map(entry => entry.pid);
    const outcome = await agent.execute('return await tools.lookup({ key: "answer" })').then(() => "completed", (error: Error) => error.message);
    assert.match(outcome, /Codemode sandbox process exited/, "An execution in flight when its process dies fails clearly");
    kill = false;
    for (let i = 0; i < 4; i++) assert.deepEqual((await agent.execute('return await tools.lookup({ key: "answer" })')).output, ["42"]);
    scale();
    assert.ok(confined().every(entry => !before.includes(entry.pid)), "Those started ahead were replaced");
    console.log(`killed every confined process: the execution failed with "${outcome}"; js_exec and parsing still serve`);
  } finally {
    await agent.destroy();
  }
  failed = false;
  console.log("image isolation test passed");
} finally {
  if (failed) console.error(logs());
  spawnSync("docker", ["rm", "-f", name]);
}
