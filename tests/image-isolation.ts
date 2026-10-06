/**
 * Linux, Docker: boots the built image the way ECS runs it (as root, under an init) and
 * proves the js_exec sandbox processes are confined, from inside one of them:
 *   IMAGE=agent-runtime:ci DATABASE_URL=postgres://... node --experimental-strip-types tests/image-isolation.ts
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

// The runtime reads its one tenant from a file mounted into the container; js_exec needs no model key.
const tenants = mkdtempSync(join(tmpdir(), "agent-isolation-"));
chmodSync(tenants, 0o755);
writeFileSync(join(tenants, "tenants.json"), JSON.stringify({ tenants: { isolation: { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: { anthropic: "unset" } } } }), { mode: 0o644 });

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
const logs = () => { const out = spawnSync("docker", ["logs", name], { encoding: "utf8" }); return out.stdout + out.stderr; };

docker("run", "-d", "--init", "--name", name, ...(hostNetwork ? ["--network", "host"] : ["-p", `127.0.0.1:${port}:8790`]),
  "-v", `${tenants}:/etc/agent-runtime:ro`, "-e", "AGENT_TENANTS_FILE=/etc/agent-runtime/tenants.json", "-e", `AGENT_SESSION_SECRET=${token}`, "-e", `AGENT_DATABASE_URL=${database}`, "-e", "AGENT_HOSTING=inline",
  "-e", "AGENT_SANDBOX_TEST_HOOKS=1", "-e", `AGENT_ISOLATION_CANARY=${canary}`,
  // Prototype (proto/v8-exec): AGENT_JS_EXEC=v8 runs the same checks with js_exec in v8-exec processes.
  ...(process.env.AGENT_JS_EXEC ? ["-e", `AGENT_JS_EXEC=${process.env.AGENT_JS_EXEC}`] : []), image);
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

  // An image scaled down for a model request, decoded with sharp inside a confined sandbox process: its bytes come back in frames.
  const fit = `
    const { connect } = require("node:net");
    const sharp = require("sharp");
    (async () => {
      const image = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#3366aa" } }).png().toBuffer();
      const socket = connect(process.argv[1]);
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
  for (const index of [0, 1]) {
    const fitted = JSON.parse(docker("exec", "-u", "node", name, "node", "-e", fit, `/run/agent-sandbox/${index}.sock`));
    assert.equal(fitted.error, undefined, fitted.error);
    assert.deepEqual([fitted.result.media, fitted.width, fitted.height], [{ kind: "image", mimeType: "image/png", width: 1568, height: 1176 }, 1568, 1176]);
    console.log(`sandbox ${index}: scaled a 2400×1800 image to ${fitted.width}×${fitted.height} (${fitted.bytes} bytes) with sharp`);
  }

  // js_exec end to end through the runtime, with a client tool call, and a sandbox process killed mid-execution.
  let kill = false;
  // With AGENT_JS_EXEC=v8: the v8-exec process running the execution, read while it waits on the tool.
  const v8Children: Record<string, string>[] = [];
  const childScan = `
    const fs = require("node:fs");
    const found = [];
    for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
      try {
        if (!fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").startsWith("/usr/local/bin/v8-exec")) continue;
        const status = Object.fromEntries(fs.readFileSync("/proc/" + pid + "/status", "utf8").split("\\n").map(line => line.split(":\\t")));
        const limits = fs.readFileSync("/proc/" + pid + "/limits", "utf8").split("\\n").filter(line => /cpu time|processes|file size/i.test(line)).map(line => line.replace(/\\s+/g, " ").trim());
        found.push({ pid, Uid: status.Uid, Seccomp: status.Seccomp, NoNewPrivs: status.NoNewPrivs, CapEff: status.CapEff, Threads: status.Threads, environ: (() => { try { return fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch (error) { return error.code; } })(), limits: limits.join("; ") });
      } catch {}
    }
    process.stdout.write(JSON.stringify(found.length ? found : fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name)).map(pid => { try { return { pid, cmd: fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\\0/g, " ") }; } catch { return { pid }; } })));`;
  const runtime = new AgentRuntime({ url, apiKey: token });
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
          } else if (process.env.AGENT_JS_EXEC === "v8") {
            const found = JSON.parse(docker("exec", name, "node", "-e", childScan));
            const [child] = found;
            // What its own sandbox process (the same uid) can do to it: nothing, it is not dumpable.
            const index = Number(String(child?.Uid).split("\t")[0]) - 1001;
            const params = { pid: Number(child?.pid), sibling: Number(child?.pid), launcher: "/usr/local/bin/agent-launcher", paths: [`/proc/${child?.pid}/mem`, `/proc/${child?.pid}/environ`] };
            const reply = child?.Uid ? JSON.parse(docker("exec", "-u", "node", name, "node", "-e", client, `/run/agent-sandbox/${index}.sock`, JSON.stringify(params))) : {};
            v8Children.push(...found.map((entry: object) => ({ ...entry, fromParent: JSON.stringify({ files: reply.result?.files, native: reply.result?.native?.runtime, error: reply.error }) })));
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
    if (process.env.AGENT_JS_EXEC === "v8") {
      assert.equal(v8Children.length, 1, JSON.stringify(v8Children));
      assert.ok(v8Children[0].Uid, JSON.stringify(v8Children));
      const [child] = v8Children;
      assert.match(child.Uid, /^100[12]\b/, "The v8-exec process runs as its sandbox process's uid");
      assert.equal(child.Seccomp, "2", "It inherits the seccomp filter");
      assert.equal(child.NoNewPrivs, "1");
      assert.equal(child.CapEff, "0000000000000000");
      assert.ok(child.environ === "" || child.environ === "EACCES", `No environment to read: ${child.environ}`);
      const fromParent = JSON.parse(child.fromParent);
      assert.deepEqual(fromParent.files, { [`/proc/${child.pid}/mem`]: "EACCES", [`/proc/${child.pid}/environ`]: "EACCES" }, child.fromParent);
      assert.deepEqual(fromParent.native, {
        socket_inet: "EPERM", socket_unix: "EPERM", ptrace_attach: "EPERM", process_vm_readv: "EPERM",
        unshare_user: "EPERM", io_uring_setup: "EPERM", bpf: "EPERM", environ: "EACCES", mem: "EACCES",
      }, child.fromParent);
      console.log(`v8-exec child: ${JSON.stringify(child)}`);
    }
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
