import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

const AGENT = fileURLToPath(new URL("../../../jobhost/agent.ts", import.meta.url));

// docs/design/job-hosts-plan.md, slices 2-4 in fake mode: a workflow's job() goes to our own job host (the host agent,
// dialing out to the runtime over a WebSocket), runs in a fake VM (the guest agent as a local process), and comes back
// with its output, charged once to its payer under the hosts' provider.
test("a workflow's job runs on a job host in fake mode: placed, run, its output kept, charged once", { timeout: 300_000 }, async t => {
  const token = "jobhost-fixture-token-with-at-least-32-characters";
  const fixture = await startFixture({ vars: { AGENT_WORKFLOW_TENANTS: "*", JOB_HOST_TOKEN: token } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-3000)}`);
    return JSON.parse(text);
  };
  const until = async <T>(read: () => Promise<T | false | undefined>, what: string, ms = 120_000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error(`Timed out: ${what}\n${fixture.worker.logs().slice(-3000)}\n${agentLog}`);
  };

  // A host with a wrong token is refused: it never registers.
  let agentLog = "";
  const host = (name: string, secret: string) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", AGENT, "--fake", "--runtime", fixture.url, "--name", name, "--slots", "2", "--disk-low", "0"],
      { env: { ...process.env, JOB_HOST_TOKEN: secret }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { agentLog += chunk; });
    child.stderr.on("data", chunk => { agentLog += chunk; });
    t.after(() => { child.kill("SIGKILL"); });
    return child;
  };
  host("intruder", "not-the-token-but-also-at-least-32-characters");
  host("host-1", token);
  const hosts = await until(async () => { const list = await call("/__test/job-hosts") as { name: string }[]; return list.some(entry => entry.name === "host-1") && list; }, "the host's registration");
  assert.deepEqual(hosts.map(entry => entry.name), ["host-1"], "only the host with the token registers");

  // An API-started workflow: its tenant pays (#820), and its job goes to the host.
  const script = `return await job({ key: "build", command: 'cat src/a.txt; echo built > "$JOB_OUT/r.txt"; echo warn >&2', files: { "src/a.txt": "hello from the host" }, outputs: ["r.txt"], timeoutSeconds: 60 });`;
  const started = await call("/v1/workflows", { script, budget: { usd: 1 } });
  const done = await until(async () => { const value = await call(`/v1/workflows/${started.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the workflow");
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.result.exitCode, 0, JSON.stringify(done.result));
  assert.equal(done.result.stdout.tail, "hello from the host");
  assert.equal(done.result.stderr.tail, "warn\n");
  assert.equal(done.result.outputs["r.txt"].bytes, 6);
  // The output is a file in the workflow's volume.
  const output = await fetch(`${fixture.url}/v1/volumes/${done.result.volume}/files${done.result.outputs["r.txt"].path}`, { headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal(await output.text(), "built\n");

  // One charge, under the hosts' provider, for the workflow's tenant.
  const receipts = async () => (await fixture.db.query("select message from pi_usage_receipts where session_id=$1 and message->'_workersAuxiliary'->>'kind'='computer'", [started.id])).rows;
  await until(async () => (await receipts()).length > 0, "the job's charge");
  const charged = await receipts();
  assert.equal(charged.length, 1, JSON.stringify(charged));
  assert.equal(charged[0].message._workersAuxiliary.provider, "camelrun-hosts");
  assert.ok(done.spent.usd > 0, JSON.stringify(done.spent));
  // The slot is given back, and the host is free again.
  assert.equal((await fixture.db.query("select 1 from computer_slots where machine like 'job:%' and expires_at > $1", [Date.now()])).rowCount, 0);
  const after = await call("/__test/job-hosts") as { name: string; free: number; slots: number }[];
  assert.equal(after[0]!.free, after[0]!.slots);
});
