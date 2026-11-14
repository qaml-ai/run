import { serveFakeCamelfsd } from './fake-camelfsd.ts';
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

test("a host job survives a Worker restart, re-enters by id and charges once", { timeout: 120_000 }, async t => {
  const secret = "restart-test-host-secret-at-least-32-characters";
  const fixture = await startFixture({ entrypoint: fileURLToPath(new URL("./host-dispatch-worker.ts", import.meta.url)), vars: {
    JOB_HOST_ATTESTORS: "test", JOB_HOST_TEST_SECRET: secret, JOB_HOST_WAIT_SECONDS: "5", AGENT_WORKFLOW_TENANTS: "*",
  } });
  t.after(() => fixture.stop());
  const call = async (path: string, body: unknown) => {
    const response = await fetch(fixture.url + path, { method: "POST", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json() as Promise<any>;
  };
  const until = async (read: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail("timed out waiting for fake host");
  };
  let jobs = 0, started = false, registered = false;
  let socket: WebSocket;
  const connect = async () => {
    const enrolled = await call("/v1/internal/job-hosts/enroll", { attestation: { kind: "test", host: "restart-host", secret } });
    socket = new WebSocket(`${fixture.url.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=restart-host`);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    registered = false;
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.type === "registered") registered = true;
      if (message.type === "job") { jobs++; socket.send(JSON.stringify({ type: "started", id: message.id, at: Date.now() })); started = true; }
    });
    socket.send(JSON.stringify({ type: "auth", credential: enrolled.credential }));
    socket.send(JSON.stringify({ type: "hello", host: "restart-host", slots: 1, free: started ? 0 : 1, vcpus: 1, memoryMiB: 4096, version: "test" }));
    await until(() => registered);
  };
  t.after(() => socket?.close());
  await connect();
  const workflow = await call("/v1/workflows", { script: "return null;", budget: { usd: 1 } });
  const spec = { id: "restart-job", command: "true", timeoutSeconds: 60, outputs: [], payer: { tenant: "camelrun-proto-local", agent: workflow.id, kind: "workflow" } };
  // The original HTTP request dies with workerd. Recovery issues a new call with the same stable id.
  const original = call("/__test/host-job", spec).catch(() => undefined);
  await until(() => started);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await fixture.restart({}, true);
  await original;
  await connect();
  const empty = { data: "", size: 0, truncated: false };
  const result = { ok: true, exitCode: 0, timedOut: false, stdout: empty, stderr: empty, outputs: {}, missing: [], pids: "unenforced", timings: { startMs: 1, syncMs: 0, commandMs: 1200, collectMs: 0, totalMs: 1201 } };
  let acked = false;
  socket!.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.type === "ack" && message.id === spec.id) acked = true; });
  socket!.send(JSON.stringify({ type: "result", id: spec.id, result }));
  await until(() => acked); // Stored before anyone resumes waiting.
  const recovered = await call("/__test/host-job", spec);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  const replay = await call("/__test/host-job", spec);
  assert.equal(replay.ok, true); assert.equal(replay.costUsd, recovered.costUsd);
  const wireSpec = { command: "true", timeoutSeconds: 60, outputs: [], files: [], internet: false, limits: {} };
  assert.equal((await call("/__test/host-dispatch", { id: spec.id, spec: wireSpec })).ok, true);
  assert.equal(jobs, 1);
  // The finished charge is stored before the result returns; its receipt is written by a background settle (the
  // alarm retries one that is lost). Wait for the receipt, then check there is exactly one.
  const charges = async () => (await fixture.db.query("select message from pi_usage_receipts where session_id=$1 and message->'_workersAuxiliary'->>'kind'='computer'", [workflow.id])).rows;
  await until(async () => (await charges()).length > 0);
  assert.equal((await charges()).length, 1, JSON.stringify(await charges()));
});

test("repo job mounts its version without import and advances its own ref", { timeout: 300_000 }, async t => {
  const { serveFakeCamelfsd } = await import("./fake-camelfsd.ts");
  const token = "repo-job-fixture-token", secret = "repo-job-fixture-secret-at-least-32-characters";
  const api = await serveFakeCamelfsd(token); t.after(() => api.close());
  const fixture = await startFixture({ camelfsStub: true, entrypoint: fileURLToPath(new URL("./camelfs-worker.ts", import.meta.url)), vars: {
    JOB_HOST_ATTESTORS: "test", JOB_HOST_TEST_SECRET: secret, JOB_HOST_WAIT_SECONDS: "5", AGENT_WORKFLOW_TENANTS: "*",
    TEST_CAMELFS_URL: api.url, CAMELFS_API_TOKEN: token,
  } }); t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return await response.json() as any;
  };
  const workflow = await call("/v1/workflows", { script: "return null;", budget: { usd: 1 } });
  const repo = await call("/v1/repos", { name: "job source" });
  const repoId = repo.id ?? repo.repo?.id;
  assert.ok(repoId, JSON.stringify(repo));
  await call(`/v1/repos/${repoId}/commit`, { files: { "seed.txt": { text: "seed" } }, message: "init" });
  const head = (await call(`/v1/repos/${repoId}/refs`)).find((r: any) => r.name === "main");
  const enrolled = await call("/v1/internal/job-hosts/enroll", { attestation: { kind: "test", host: "repo-host", secret } });
  const socket = new WebSocket(`${fixture.url.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=repo-host`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const registered = Promise.withResolvers<void>(), checkpoint = Promise.withResolvers<Awaited<ReturnType<typeof api.checkpoint>>>(); let mounted: any;
  socket.addEventListener("message", async event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "registered") registered.resolve();
    if (message.type !== "job") return;
    mounted = message.spec;
    const c = await api.checkpoint(mounted.camelfs, message.id).catch(error => { checkpoint.reject(error); return null; });
    if (!c) return;
    checkpoint.resolve(c);
    const stream = { data: "", size: 0, truncated: false };
    socket.send(JSON.stringify({ type: "result", id: message.id, result: { ok: true, exitCode: 7, timedOut: false, stdout: stream, stderr: stream, outputs: {}, missing: [], pids: "enforced", timings: { startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 0 }, camelfs: c } }));
  });
  socket.send(JSON.stringify({ type: "auth", credential: enrolled.credential }));
  socket.send(JSON.stringify({ type: "hello", host: "repo-host", slots: 1, free: 1, vcpus: 1, memoryMiB: 4096, version: "test", features: ["camelfs"] }));
  await registered.promise;
  const [c, result] = await Promise.all([checkpoint.promise, call("/__test/camelfs-job", { id: "repo-integration", command: "true", timeoutSeconds: 30, commit: true, repo: { tenant: "camelrun-proto-local", repo: repoId, owner: "job:repo-integration" }, payer: { tenant: "camelrun-proto-local", agent: workflow.id, kind: "workflow" } })]);
  assert.equal(result.ok, true); assert.equal(result.exitCode, 7);
  assert.equal(result.camelfs.ref, "job/repo-integration"); assert.equal(result.camelfs.version, c.commit);
  assert.equal(mounted.camelfs.tree, head.tree); assert.ok(mounted.camelfs.fence);
  assert.equal(mounted.camelfs.parent, head.version);
  const stored = await fetch(`${api.url}/v1/lineages/${encodeURIComponent(mounted.camelfs.lineage)}/commits/${c.commit}`, { headers: { authorization: `Bearer ${token}` } });
  assert.ok(stored.ok);
  assert.deepEqual((await stored.json() as { parents: string[] }).parents, [head.version]);
  assert.deepEqual(mounted.files, []); assert.equal(mounted.sync, undefined);
});
