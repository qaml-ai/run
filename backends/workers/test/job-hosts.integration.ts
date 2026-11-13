import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";
import { signGetCallerIdentity } from "../../../shared/job-host-attest.ts";
import { hostSecondRate } from "../src/jobs/host-pricing.ts";

const AGENT = fileURLToPath(new URL("../../../jobhost/agent.ts", import.meta.url));

// docs/design/job-hosts-plan.md, slices 2-4 in fake mode: a host enrolls (an attestation for a credential bound to the
// host id it proves), a workflow's job() goes to it (the host agent, dialing out over a WebSocket), runs in a fake VM
// (the guest agent as a local process), and comes back with its output, charged once under the hosts' provider. The
// AWS attestor runs against a fake STS that answers as STS does; a forged, replayed, expired or revoked host gets nothing.
test("a workflow's job runs on a job host in fake mode: placed, run, its output kept, charged once", { timeout: 300_000 }, async t => {
  const secret = "jobhost-fixture-secret-with-at-least-32-characters";
  // A fake STS: it answers GetCallerIdentity as STS does for an EC2 instance's role, and counts what it was sent.
  const stsCalls: { authorization?: string; audience?: string }[] = [];
  let stsDenies = 0;
  const sts = createServer((request, response) => {
    stsCalls.push({ authorization: request.headers.authorization, audience: request.headers["x-camelrun-job-host-audience"] as string });
    if (stsDenies > 0) { stsDenies--; response.writeHead(403, { "content-type": "text/xml" }); response.end("<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code></Error></ErrorResponse>"); return; }
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::123456789012:assumed-role/camelrun-job-host/i-0abc123def4567890</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
  });
  sts.listen(0, "127.0.0.1"); await once(sts, "listening");
  t.after(() => new Promise<void>(resolve => sts.close(() => resolve())));
  // Volume jobs without camelFS: their trees cross inline or by host-side sync, not as camelFS imports.
  const fixture = await startFixture({ camelfsStub: false, vars: {
    AGENT_WORKFLOW_TENANTS: "*", JOB_HOST_ATTESTORS: "test,aws", JOB_HOST_TEST_SECRET: secret, JOB_HOST_CREDENTIAL_SECONDS: "45",
    JOB_HOST_WAIT_SECONDS: "8", JOB_HOST_LOST_SECONDS: "20", JOB_HOST_SCALER_TOKEN: "scaler-token-for-the-fixture-at-least-32-characters",
    JOB_HOST_ROLE_ARNS: "test=arn:aws:iam::123456789012:role/camelrun-job-host", JOB_HOST_STS_TEST_URL: `http://127.0.0.1:${(sts.address() as { port: number }).port}/`,
    ADMIN_TENANTS: "camelrun-proto-local",
  } });
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

  // A host with a wrong test secret is refused: it never registers.
  let agentLog = "";
  const host = (name: string, secret: string) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", AGENT, "--fake", "--attestor", "test", "--runtime", fixture.url, "--name", name, "--slots", "2", "--disk-low", "0"],
      { env: { ...process.env, JOB_HOST_TEST_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { agentLog += chunk; });
    child.stderr.on("data", chunk => { agentLog += chunk; });
    t.after(() => { child.kill("SIGKILL"); });
    return child;
  };
  host("intruder", "not-the-secret-but-also-at-least-32-characters");
  const host1 = host("host-1", secret);
  const hosts = await until(async () => { const list = await call("/__test/job-hosts") as { name: string }[]; return list.some(entry => entry.name === "host-1") && list; }, "the host's registration");
  assert.deepEqual(hosts.map(entry => entry.name), ["host-1"], "only the host with the secret registers");

  // An API-started workflow: its tenant pays (#820), and its job goes to the host.
  const script = `return await job({ key: "build", command: 'cat src/a.txt; echo built > "$JOB_OUT/r.txt"; echo warn >&2', files: { "src/a.txt": "hello from the host" }, outputs: ["r.txt"], timeoutSeconds: 60 });`;
  const started = await call("/v1/workflows", { script, budget: { usd: 1 } });
  const done = await until(async () => { const value = await call(`/v1/workflows/${started.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the workflow");
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.result.exitCode, 0, JSON.stringify(done.result));
  for (const name of ["admitMs", "filesMs", "waitMs", "reserveMs", "dispatchMs", "hostMs", "meterMs"]) {
    assert.equal(typeof done.result.timings.steps[name], "number", name);
    assert.ok(Number.isInteger(done.result.timings.steps[name]) && done.result.timings.steps[name] >= 0, name);
  }
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
  // Priced as the VM the host booted: the job's shape (a default standard-1's 1 vCPU and 4 GiB) on the test pool.
  assert.equal(charged[0].message._workersAuxiliary.model, "test-1vcpu-4096mib", JSON.stringify(charged[0].message._workersAuxiliary));
  assert.ok(done.spent.usd > 0, JSON.stringify(done.spent));
  // The slot is given back, and the host is free again.
  assert.equal((await fixture.db.query("select 1 from computer_slots where machine like 'job:%' and expires_at > $1", [Date.now()])).rowCount, 0);
  const after = await call("/__test/job-hosts") as { name: string; free: number; slots: number }[];
  assert.equal(after[0]!.free, after[0]!.slots);

  // A tree past what crosses to a host inline (16 MiB): the job fails sync_failed, as a result, not a throw that would
  // leave the effect to fail again on every restart. The workflow ends, and the host is free again.
  // A tree past what crosses inline (16 MiB): the host fetches it itself (host-side sync), file by file, each checked,
  // with a token for this job's files only. A random file, so a corrupted or reordered piece would not hash the same.
  const big = await call("/v1/volumes", { name: "bigger-than-inline" });
  const payload = new Uint8Array(17 * 1024 * 1024);
  for (let offset = 0; offset < payload.length; offset += 65536) crypto.getRandomValues(payload.subarray(offset, offset + 65536));
  const upload = await fetch(`${fixture.url}/v1/volumes/${big.id}/files/data/big.bin`, { method: "PUT", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/octet-stream" }, body: payload });
  assert.ok(upload.ok, `upload: ${upload.status}`);
  const small = await fetch(`${fixture.url}/v1/volumes/${big.id}/files/notes.txt`, { method: "PUT", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "text/plain" }, body: "hi" });
  assert.ok(small.ok);
  const digest = createHash("sha256").update(payload).digest("hex");
  const synced = await call("/v1/workflows", { script: `return await job({ key: "big", at: ${JSON.stringify(big.id)}, command: "sha256sum data/big.bin | cut -c1-64; cat notes.txt", timeoutSeconds: 60 });`, budget: { usd: 1 } });
  const syncedEnd = await until(async () => { const value = await call(`/v1/workflows/${synced.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the host-side sync workflow");
  assert.equal(syncedEnd.status, "completed", JSON.stringify(syncedEnd));
  assert.equal(syncedEnd.result.exitCode, 0, JSON.stringify(syncedEnd.result));
  assert.equal(syncedEnd.result.stdout.tail, `${digest}\nhi`);
  // The token is the job's alone, and only while it runs: after it, its files are served to no one.
  assert.equal((await fetch(`${fixture.url}/v1/internal/job-hosts/sync/whatever/0`, { headers: { authorization: "Bearer guess" } })).status, 401);
  const free = await call("/__test/job-hosts") as { free: number; slots: number }[];
  assert.equal(free[0]!.free, free[0]!.slots);

  // The AWS attestor: a signed GetCallerIdentity for this runtime, sent to STS by the runtime; the host id is the one STS
  // says (the instance's), and the same signed request is accepted once.
  const enroll = (attestation: unknown) => fetch(`${fixture.url}/v1/internal/job-hosts/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attestation }) });
  const signed = signGetCallerIdentity({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example", sessionToken: "token" }, `camelrun-job-host:${fixture.url}`);
  // STS refusing it: refused, and its claim given back (a forged request leaves nothing), so the same request can be
  // tried again. The refusal says only that: why is in the log.
  stsDenies = 1;
  const denied = await enroll(signed);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Enrollment refused", code: "HOST_REFUSED" });
  stsCalls.length = 0;
  const aws = await enroll(signed);
  const awsBody = await aws.json() as { host: string; credential: string; expiresAt: number };
  assert.equal(aws.status, 200, JSON.stringify(awsBody));
  assert.equal(awsBody.host, "i-0abc123def4567890", "the host id is the one STS proved, not one the host named");
  assert.equal(stsCalls.length, 1);
  assert.equal(stsCalls[0]!.audience, `camelrun-job-host:${fixture.url}`);
  assert.equal((await enroll(signed)).status, 403, "the same signed request is not accepted twice");
  assert.equal(stsCalls.length, 1, "a replay never reaches STS");
  assert.equal((await enroll(signGetCallerIdentity({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s" }, "camelrun-job-host:https://another.example"))).status, 403, "one signed for another runtime is refused");
  assert.equal((await enroll({ ...signed, url: "https://evil.example/" })).status, 403, "the runtime sends nothing anywhere but STS");
  assert.equal((await fetch(`${fixture.url}/v1/internal/job-hosts/enroll`, { method: "POST", body: "x".repeat(17 * 1024) })).status, 413, "a body over 16 KiB is refused unread");
  // Without Content-Length (a streamed, chunked body), the cap holds as it is read.
  const chunked = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(1024).fill(120)); controller.close(); } });
  assert.equal((await fetch(`${fixture.url}/v1/internal/job-hosts/enroll`, { method: "POST", body: chunked, duplex: "half" } as RequestInit)).status, 413, "a chunked body over 16 KiB is refused as it is read");
  // A host keeps its two newest credentials: a third enrollment retires the first.
  const again = async () => (await (await enroll({ kind: "test", host: "spare-host", secret })).json() as { credential: string }).credential;
  const [first, second, third] = [await again(), await again(), await again()];

  // A credential is bound to its host: one host's credential does not connect as another, and a made-up one fails.
  const socketFor = async (name: string, credential: string) => {
    const socket = new WebSocket(`${fixture.url.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=${name}`);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener("close", event => resolve({ code: event.code, reason: event.reason })));
    const messages: string[] = [];
    socket.addEventListener("message", event => messages.push(String(event.data)));
    socket.send(JSON.stringify({ type: "auth", credential }));
    socket.send(JSON.stringify({ type: "hello", host: name, slots: 1, free: 0, vcpus: 1, memoryMiB: 512, version: "test" }));
    return { socket, closed, messages };
  };
  assert.equal((await (await socketFor("host-1", awsBody.credential)).closed).code, 1008, "an instance's credential is not host-1's");
  assert.equal((await (await socketFor("i-0abc123def4567890", `i-0abc123def4567890.${"x".repeat(43)}`)).closed).code, 1008, "a made-up credential is refused");
  assert.equal((await (await socketFor("spare-host", first)).closed).code, 1008, "a host's third credential retired its first");
  for (const credential of [second, third]) {
    const spare = await socketFor("spare-host", credential);
    await until(async () => spare.messages.some(message => message.includes('"registered"')), "a current credential connects");
    spare.socket.close();
  }
  // The right one registers, and its socket closes when the credential ends (45 s here).
  const probe = await socketFor("i-0abc123def4567890", awsBody.credential);
  await until(async () => probe.messages.some(message => message.includes('"registered"')), "the instance's registration");
  const expired = await Promise.race([probe.closed, new Promise<undefined>(resolve => setTimeout(resolve, 60_000))]);
  assert.deepEqual(expired, { code: 1008, reason: "Credential expired" });

  // Revoking a host: its socket closes, it is placed nothing, and it cannot enroll again until allowed. host-1 renews its
  // credential (every ~36 s here) and kept running its jobs through it; revoked, it is refused.
  const admin = (path: string, method: string) => fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal((await admin("/v1/job-hosts/host-1", "DELETE")).status, 200);
  const listed = await (await admin("/v1/job-hosts", "GET")).json() as { hosts: { name: string; revoked: number }[] };
  assert.equal(listed.hosts.find(entry => entry.name === "host-1")?.revoked, 1);
  assert.equal((await enroll({ kind: "test", host: "host-1", secret })).status, 403, "a revoked host cannot enroll");
  const refused = await call("/v1/workflows", { script: `return await job({ key: "after", command: "true", timeoutSeconds: 30 });`, budget: { usd: 1 } });
  const refusedEnd = await until(async () => { const value = await call(`/v1/workflows/${refused.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the workflow with no host");
  const refusedItem = ((await call(`/v1/workflows/${refused.id}/items`)).items as { key: string; reason?: string }[]).find(entry => entry.key === "after")!;
  assert.equal(refusedEnd.result, null);
  assert.match(refusedItem.reason ?? "", /^start_failed: No test job host/);
  const allowedAt = Date.now();
  assert.equal((await admin("/v1/job-hosts/host-1/allow", "POST")).status, 200);
  await until(async () => { const list = await call("/__test/job-hosts") as { name: string; revoked: number; seenAt: number; free: number; slots: number }[]; const entry = list.find(item => item.name === "host-1"); return entry && !entry.revoked && entry.seenAt > allowedAt && entry.free === entry.slots && entry.slots > 0 && entry; }, "host-1 back after it is allowed", 90_000);
  // Only an admin account revokes.
  assert.equal((await fetch(`${fixture.url}/v1/job-hosts/host-1`, { method: "DELETE" })).status === 200, false);

  // Waiting, and what the scaler reads: three jobs for host-1's two slots, so one waits its turn (counted as the test
  // pool's demand) and runs when a slot frees. The scaler's own token reads demand; nothing else does.
  const scaler = (path: string, method = "GET", token = "scaler-token-for-the-fixture-at-least-32-characters") =>
    fetch(`${fixture.url}/v1/internal/job-hosts/${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await scaler("demand", "GET", "wrong-token-but-also-at-least-32-characters-long")).status, 401);
  assert.equal((await fetch(`${fixture.url}/v1/internal/job-hosts/demand`)).status, 401);
  const queued = await call("/v1/workflows", { script: `return await parallel([1, 2, 3].map(n => () => job({ key: "q" + n, command: "sleep 3; echo q" + n, timeoutSeconds: 30 })));`, budget: { usd: 1 } });
  const seen = await until(async () => {
    const value = await (await scaler("demand")).json() as { pools: { test: { waiting: number; running: number; hosts: { host: string }[] } } };
    return value.pools.test.waiting >= 1 && value.pools.test.running === 2 && value;
  }, "a job waiting for a slot, counted as demand", 30_000);
  assert.ok(seen.pools.test.hosts.some(entry => entry.host === "host-1"));
  const queuedEnd = await until(async () => { const value = await call(`/v1/workflows/${queued.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the three jobs", 90_000);
  assert.equal(queuedEnd.status, "completed", JSON.stringify(queuedEnd));
  const idleNow = await (await scaler("demand")).json() as { pools: { test: { waiting: number; running: number; hosts: { host: string; idleSince: number | null }[] } } };
  assert.equal(idleNow.pools.test.waiting, 0);
  assert.ok(idleNow.pools.test.hosts.find(entry => entry.host === "host-1")?.idleSince, "an idle host says since when");
  // Drained, a host takes no new job: one waits its time out and fails, the host left alone.
  assert.equal((await scaler("host-1/drain", "POST")).status, 200);
  const drained = await call("/v1/workflows", { script: `return await job({ key: "drained", command: "true", timeoutSeconds: 30 });`, budget: { usd: 1 } });
  await until(async () => { const value = await call(`/v1/workflows/${drained.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the job with only a drained host", 60_000);
  const drainedItem = ((await call(`/v1/workflows/${drained.id}/items`)).items as { key: string; reason?: string }[]).find(entry => entry.key === "drained")!;
  assert.match(drainedItem.reason ?? "", /^start_failed: No test job host was free within 8 s/);
  // A drain is undone (the scaler, when jobs wait): host-1 takes jobs again. An unknown host is a 404.
  assert.equal((await scaler("i-00000000000000000/drain", "POST")).status, 404);
  assert.equal((await scaler("host-1/drain", "DELETE")).status, 200);
  const undrained = await (await scaler("demand")).json() as { pools: { test: { hosts: { host: string; draining: boolean; lastSeenAt: number }[] } } };
  const back = undrained.pools.test.hosts.find(entry => entry.host === "host-1")!;
  assert.equal(back.draining, false);
  assert.ok(back.lastSeenAt > Date.now() - 30_000);

  // A host that dies mid-job: the job ends container_failed once the host has been silent for 20 s, not at
  // its deadline, and is charged only for the time its VM ran until the host was last heard from.
  const doomed = await call("/v1/workflows", { script: `return await job({ key: "doomed", command: "sleep 300", timeoutSeconds: 600 });`, budget: { usd: 1 } });
  await until(async () => { const list = await call("/__test/job-hosts") as { name: string; free: number; slots: number }[]; const entry = list.find(item => item.name === "host-1"); return entry && entry.free < entry.slots; }, "the doomed job running");
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const killedAt = Date.now();
  host1.kill("SIGKILL");
  const doomedEnd = await until(async () => { const value = await call(`/v1/workflows/${doomed.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the job of a host that went away", 90_000);
  assert.ok(Date.now() - killedAt < 75_000, "ended long before its deadline");
  const doomedItem = ((await call(`/v1/workflows/${doomed.id}/items`)).items as { key: string; reason?: string }[]).find(entry => entry.key === "doomed")!;
  assert.match(doomedItem.reason ?? "", /^container_failed: The job host was lost/, JSON.stringify(doomedEnd));
  const doomedCharge = (await fixture.db.query("select message from pi_usage_receipts where session_id=$1 and message->'_workersAuxiliary'->>'kind'='computer'", [doomed.id])).rows;
  // Its VM ran about 3 s before the host died, and is charged until the host was last heard from (its started report or a
  // heartbeat since, at most 10 s apart): never the 20 s it took to call the host gone, nor its deadline.
  assert.ok(doomedCharge.length <= 1, JSON.stringify(doomedCharge));
  const seconds = Number(doomedCharge[0]?.message._workersAuxiliary.costUsd ?? 0) / hostSecondRate("test", { vcpus: 1, memoryMiB: 4096, diskMiB: 0 });
  assert.ok(seconds < 14, `charged ${seconds} s`);
});

test("camelFS volume jobs send cached trees and refuse a host without mount support", { timeout: 120_000 }, async t => {
  const tree = "b".repeat(40), token = "camelfs-fixture-only-token", secret = "camelfs-host-fixture-secret-at-least-32-characters";
  const payload = "snapshot bytes", hash = createHash("sha256").update(payload).digest("hex");
  let calls = 0, stored = false;
  const api = createServer(async (request, response) => {
    calls++;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === "PUT") {
      assert.equal(Buffer.concat(chunks).toString(), payload);
      assert.ok(request.url?.startsWith(`/v0/blobs/${hash}?lineage=`));
      stored = true; response.writeHead(201); response.end(); return;
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    // camelFS paths are relative (#904): the Volume's "/a.txt" arrives as "a.txt".
    assert.deepEqual(input.files, { "a.txt": { sha256: hash } });
    response.writeHead(stored ? 200 : 409, { "content-type": "application/json" });
    response.end(JSON.stringify(stored ? { tree } : { missing: [hash] }));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => new Promise<void>(resolve => api.close(() => resolve())));
  const fixture = await startFixture({ camelfsStub: true, entrypoint: fileURLToPath(new URL("./camelfs-worker.ts", import.meta.url)), vars: {
    JOB_HOST_ATTESTORS: "test", JOB_HOST_TEST_SECRET: secret, JOB_HOST_WAIT_SECONDS: "5", AGENT_WORKFLOW_TENANTS: "*",
    TEST_CAMELFS_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`, CAMELFS_API_TOKEN: token,
  } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? "GET" : "POST", headers: {
      authorization: `Bearer ${fixture.token}`, "content-type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status}`); return await response.json() as any;
  };
  const volume = await call("/v1/volumes", { name: "camelfs" });
  assert.ok((await fetch(`${fixture.url}/v1/volumes/${volume.id}/files/a.txt`, { method: "PUT", headers: { authorization: `Bearer ${fixture.token}` }, body: payload })).ok);
  const snapshot = await call(`/v1/volumes/${volume.id}/snapshots`, { name: "shared" });
  const workflow = await call("/v1/workflows", { script: "return null;", budget: { usd: 1 } });
  const enrolled = await call("/v1/internal/job-hosts/enroll", { attestation: { kind: "test", host: "camelfs-host", secret } });
  const socket = new WebSocket(`${fixture.url.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=camelfs-host`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const received: import("../../../shared/job-host-protocol.ts").WireJob[] = [];
  let registered = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "registered") registered++;
    if (message.type !== "job") return;
    received.push(message.spec);
    const stream = { data: "", size: 0, truncated: false };
    socket.send(JSON.stringify({ type: "result", id: message.id, result: { ok: true, exitCode: 0, timedOut: false,
      stdout: stream, stderr: stream, outputs: {}, missing: [], pids: "enforced",
      timings: { startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 0 },
      camelfs: { tree, warm: true, mountMs: 2, applyMs: 3, ...(message.spec.camelfs?.commit ? { commit: "c".repeat(40), root: "r" } : {}) },
    } }));
  });
  const waitRegistered = async (count: number) => {
    for (let i = 0; i < 200 && registered < count; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(registered, count);
  };
  const hello = { type: "hello", host: "camelfs-host", slots: 1, free: 1, vcpus: 1, memoryMiB: 4096, version: "test" };
  socket.send(JSON.stringify({ type: "auth", credential: enrolled.credential }));
  socket.send(JSON.stringify({ ...hello, features: ["camelfs"] })); await waitRegistered(1);
  const run = (id: string, commit = false) => call("/__test/camelfs-job", { id, ...(commit ? { commit: true } : {}), command: "true", timeoutSeconds: 30,
    volume: { tenant: "camelrun-proto-local", volume: volume.id, snapshot: snapshot.id },
    payer: { tenant: "camelrun-proto-local", agent: workflow.id, kind: "workflow" },
  });
  for (const id of ["camelfs-first", "camelfs-second"]) {
    const result = await run(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.camelfs, { tree, warm: true, mountMs: 2, applyMs: 3 });
    for (const name of ["admitMs", "filesMs", "hostMs", "importMs"]) assert.equal(typeof result.timings.steps[name], "number", name);
    assert.equal(result.timings.steps.importMs, result.timings.steps.filesMs);
    assert.equal(result.timings.steps.dispatchMs, undefined, "this fake host sends no started report");
    assert.equal(calls, 3);
  }
  assert.equal(received.length, 2);
  for (const spec of received) {
    assert.deepEqual(spec.camelfs, { lineage: `camelrun-proto-local:${volume.id}`, tree });
    assert.deepEqual(spec.files, []); assert.equal(spec.sync, undefined);
  }
  const committed = await run("camelfs-commit", true);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.deepEqual(committed.camelfs, { commit: "c".repeat(40), tree, root: "r", warm: true, mountMs: 2, applyMs: 3 });
  assert.deepEqual(received[2].camelfs, { lineage: `camelrun-proto-local:${volume.id}`, tree, commit: true });
  assert.equal(calls, 3, "a commit also uses the cached tree");
  socket.send(JSON.stringify(hello)); await waitRegistered(2);
  const refused = await run("camelfs-unsupported");
  assert.equal(refused.ok, false); assert.equal(refused.code, "start_failed");
  assert.equal(refused.message, "This job host cannot mount camelFS trees");
  for (const name of ["admitMs", "filesMs", "hostMs", "meterMs"]) assert.equal(typeof refused.timings.steps[name], "number", name);
  assert.equal(refused.timings.steps.importMs, refused.timings.steps.filesMs);
  assert.equal(received.length, 3); assert.equal(calls, 3);
});

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
  const charges = (await fixture.db.query("select message from pi_usage_receipts where session_id=$1 and message->'_workersAuxiliary'->>'kind'='computer'", [workflow.id])).rows;
  assert.equal(charges.length, 1, JSON.stringify(charges));
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
  const checkpoint = await fetch(`${api.url}/v1/lineages/${encodeURIComponent(repo.lineage ?? `camelrun-proto-local:${repoId}`)}/commits`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ parents: [head.version], changes: [], message: "job checkpoint", author: "job:repo-integration", trailers: {}, time: Math.floor(Date.now() / 1000) }) });
  assert.ok(checkpoint.ok, `${checkpoint.status} ${await checkpoint.clone().text()}`); const c = await checkpoint.json() as any;
  const enrolled = await call("/v1/internal/job-hosts/enroll", { attestation: { kind: "test", host: "repo-host", secret } });
  const socket = new WebSocket(`${fixture.url.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=repo-host`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const registered = Promise.withResolvers<void>(); let mounted: any;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "registered") registered.resolve();
    if (message.type !== "job") return;
    mounted = message.spec;
    const stream = { data: "", size: 0, truncated: false };
    socket.send(JSON.stringify({ type: "result", id: message.id, result: { ok: true, exitCode: 7, timedOut: false, stdout: stream, stderr: stream, outputs: {}, missing: [], pids: "enforced", timings: { startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 0 }, camelfs: { commit: c.commit, tree: c.tree, root: "a".repeat(64), warm: true, mountMs: 0, applyMs: 0 } } }));
  });
  socket.send(JSON.stringify({ type: "auth", credential: enrolled.credential }));
  socket.send(JSON.stringify({ type: "hello", host: "repo-host", slots: 1, free: 1, vcpus: 1, memoryMiB: 4096, version: "test", features: ["camelfs"] }));
  await registered.promise;
  const result = await call("/__test/camelfs-job", { id: "repo-integration", command: "true", timeoutSeconds: 30, commit: true, repo: { tenant: "camelrun-proto-local", repo: repoId, owner: "job:repo-integration" }, payer: { tenant: "camelrun-proto-local", agent: workflow.id, kind: "workflow" } });
  assert.equal(result.ok, true); assert.equal(result.exitCode, 7);
  assert.equal(result.camelfs.ref, "job/repo-integration"); assert.equal(result.camelfs.version, c.commit);
  assert.equal(mounted.camelfs.tree, head.tree); assert.ok(mounted.camelfs.fence);
  assert.deepEqual(mounted.files, []); assert.equal(mounted.sync, undefined);
});
