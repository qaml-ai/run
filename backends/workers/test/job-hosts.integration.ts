import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";
import { signGetCallerIdentity } from "../../../shared/job-host-attest.ts";

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
  const fixture = await startFixture({ vars: {
    AGENT_WORKFLOW_TENANTS: "*", JOB_HOST_ATTESTORS: "test,aws", JOB_HOST_TEST_SECRET: secret, JOB_HOST_CREDENTIAL_SECONDS: "45",
    JOB_HOST_ROLE_ARNS: "arn:aws:iam::123456789012:role/camelrun-job-host", JOB_HOST_STS_TEST_URL: `http://127.0.0.1:${(sts.address() as { port: number }).port}/`,
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
  host("host-1", secret);
  const hosts = await until(async () => { const list = await call("/__test/job-hosts") as { name: string }[]; return list.some(entry => entry.name === "host-1") && list; }, "the host's registration");
  assert.deepEqual(hosts.map(entry => entry.name), ["host-1"], "only the host with the secret registers");

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

  // A tree past what crosses to a host inline (16 MiB): the job fails sync_failed, as a result, not a throw that would
  // leave the effect to fail again on every restart. The workflow ends, and the host is free again.
  const big = await call("/v1/volumes", { name: "too-big-for-a-host" });
  const upload = await fetch(`${fixture.url}/v1/volumes/${big.id}/files/big.bin`, { method: "PUT", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/octet-stream" }, body: new Uint8Array(17 * 1024 * 1024) });
  assert.ok(upload.ok, `upload: ${upload.status}`);
  const oversize = await call("/v1/workflows", { script: `return await job({ key: "big", at: ${JSON.stringify(big.id)}, command: "true", timeoutSeconds: 30 });`, budget: { usd: 1 } });
  const ended = await until(async () => { const value = await call(`/v1/workflows/${oversize.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the oversize workflow");
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  assert.equal(ended.result, null);
  const item = ((await call(`/v1/workflows/${oversize.id}/items`)).items as { key: string; status: string; reason?: string }[]).find(entry => entry.key === "big")!;
  assert.equal(item.status, "failed");
  assert.match(item.reason ?? "", /^sync_failed: .*16 MiB/);
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
  // The right one registers, and its socket closes when the credential ends (30 s here).
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
  assert.match(refusedItem.reason ?? "", /^start_failed: No job host/);
  assert.equal((await admin("/v1/job-hosts/host-1/allow", "POST")).status, 200);
  await until(async () => { const list = await call("/__test/job-hosts") as { name: string; revoked: number; seenAt: number }[]; const entry = list.find(item => item.name === "host-1"); return entry && !entry.revoked && entry.seenAt > Date.now() - 20_000 && entry; }, "host-1 back after it is allowed", 90_000);
  // Only an admin account revokes.
  assert.equal((await fetch(`${fixture.url}/v1/job-hosts/host-1`, { method: "DELETE" })).status === 200, false);
});
