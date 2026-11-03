import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db.ts";
import type { Outbound } from "../src/outbound.ts";
import { MICROVM_HOUR, microvmApi, microvmCost, microvmMachines, observe, type MicrovmApi } from "../src/computers/microvm.ts";

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`create table managed_computers (id text primary key, tenant text, machine text, provider text default 'lambda', created_at bigint, ended_at bigint, microvm jsonb);
    insert into managed_computers(id,tenant,created_at) values ('computer','tenant',1000000);`);
  const query = async (sql: string, params?: unknown[]) => { const r = await pg.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
  const db = { query, connect: async () => ({ query, release() {}, on() {}, off() {} }) } as unknown as Db;
  let now = 1000000, loseCreate = false, failResume = false, losePost = false, polls = 0, jobs = 0;
  const calls: { op: string; input: any }[] = [], requests: { path: string; options: any }[] = [];
  const vm = { microvmId: "vm1", state: "RUNNING", endpoint: "vm.example.com", startedAt: 1000 };
  const api: MicrovmApi = async (op, input) => {
    calls.push({ op, input });
    if (op === "RunMicrovm") { if (loseCreate) { loseCreate = false; throw new Error("lost response"); } return { ...vm }; }
    if (op === "GetMicrovm") return { ...vm };
    if (op === "TerminateMicrovm") { vm.state = "TERMINATED"; return {}; }
    if (op === "CreateMicrovmAuthToken") return { authToken: { "X-aws-proxy-auth": "test-only" } };
    throw new Error(`Unexpected API ${op}`);
  };
  const keys = new Set<string>();
  const outbound = { async fetch(url: string, options: any) {
    const path = new URL(url).pathname;
    requests.push({ path, options });
    if (failResume) { failResume = false; return new Response("", { status: 503 }); }
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/exec") {
      const body = JSON.parse(options.body);
      if (!keys.has(body.requestKey)) { keys.add(body.requestKey); jobs++; }
      if (losePost) { losePost = false; throw new Error("lost response"); }
      return Response.json({ running: true }, { status: 202 });
    }
    assert.match(url, /wait=25$/);
    now += 25000;
    if (++polls % 2) return Response.json({ running: true }, { status: 202 });
    return Response.json({ exitCode: 0, stdout: "done", stderr: "", truncated: false });
  } } as unknown as Outbound;
  const settings = { image: "arn:aws:lambda:us-west-2:123456789012:microvm-image:test", region: "us-west-2", idleSeconds: 300 };
  const make = () => microvmMachines({ db, outbound, settings, runtime: "test", api, now: () => now, sleep: async ms => { now += ms; } });
  return { pg, db, make, calls, requests, vm, settings, jobs: () => jobs, now: () => now, advance: (ms: number) => { now += ms; },
    loseCreate: () => { loseCreate = true; }, failResume: () => { failResume = true; }, losePost: () => { losePost = true; } };
}

test("launch retries retain the client token, image and fixed maximum duration across restarts", async () => {
  const f = await fixture();
  try {
    f.loseCreate();
    await assert.rejects(f.make().create("computer", "tenant", 86400));
    f.settings.image = "changed";
    const machines = f.make();
    assert.deepEqual(await machines.create("computer", "tenant", 60), { id: "vm1" });
    const launches = f.calls.filter(c => c.op === "RunMicrovm");
    assert.deepEqual(launches[0].input, launches[1].input);
    assert.equal(launches[1].input.clientToken, "computer");
    assert.equal(launches[1].input.maximumDurationInSeconds, 28800);
    assert.equal(launches[1].input.idlePolicy.autoResumeEnabled, true);
    assert.equal(launches[1].input.executionRoleArn, undefined);
    await machines.create("computer", "tenant", 60);
    assert.equal(f.calls.filter(c => c.op === "RunMicrovm").length, 2);
  } finally { await f.pg.close(); }
});

test("exec auto-resumes, retries a lost POST idempotently, long-polls and caches only unexpired tokens", async () => {
  const f = await fixture();
  try {
    const machines = f.make();
    await machines.create("computer", "tenant", 7200);
    f.vm.state = "SUSPENDED";
    f.failResume(); f.losePost();
    const result = await machines.run("vm1", "sleep 50; echo done", 1800, "request");
    assert.equal(result.stdout, "done");
    assert.equal(f.jobs(), 1);
    assert.equal(f.calls.filter(c => c.op === "CreateMicrovmAuthToken").length, 1);
    assert.ok(f.requests.every(r => r.options.headers["X-aws-proxy-port"] === "8080"));
    assert.ok(f.requests.every(r => r.options.timeoutMs <= 35000));
    f.advance(3600000);
    await machines.run("vm1", "true", 60, "next");
    assert.equal(f.calls.filter(c => c.op === "CreateMicrovmAuthToken").length, 2);
  } finally { await f.pg.close(); }
});

test("durable observations charge running intervals and one write/read per observed suspension", () => {
  let o = observe(undefined, { state: "RUNNING", startedAt: 1000 }, 1000000);
  o = observe(o, { state: "SUSPENDING", startedAt: 1000 }, 1060000);
  o = observe(o, { state: "SUSPENDED", startedAt: 1000 }, 1090000);
  o = observe(o, { state: "RUNNING", startedAt: 1000 }, 1120000);
  o = observe(o, { state: "TERMINATED", startedAt: 1000, terminatedAt: 1150 }, 1180000);
  assert.equal(o.seconds, 90);
  assert.equal(o.suspendedSeconds, 60);
  assert.equal(o.suspends, 1);
  assert.equal(o.resumes, 1);
  assert.equal(microvmCost(o), 90 * MICROVM_HOUR / 3600 + 2 * (0.0038 + 0.00155 + 60 * 0.08 / 2592000));
  assert.deepEqual(observe(o, { state: "RUNNING", startedAt: 1000 }, 1100000), o);
});

test("listing filters by owned rows, preserves totals on restart and retains final charges", async () => {
  const f = await fixture();
  try {
    await f.make().create("computer", "tenant", 7200);
    f.advance(30000);
    const [first] = await f.make().list();
    assert.equal(first.seconds, 30);
    assert.equal((await f.make().list("other")).length, 0);
    f.advance(30000);
    const next = f.make();
    await next.remove("vm1");
    const [last] = await next.list();
    assert.equal(last.seconds, 60);
    assert.equal(last.ended, true);
    assert.ok(last.dollars > first.dollars);
  } finally { await f.pg.close(); }
});


test("the REST client signs the Lambda path and maps AWS refusal headers without exposing messages", async () => {
  const before = { ...process.env };
  // Test-only credentials never reach a network transport.
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
  try {
    const requests: { url: string; init: any }[] = [];
    let reject = false;
    const api = microvmApi("us-west-2", { async fetch(url: string, init: any) {
      requests.push({ url, init });
      return reject ? Response.json({ message: "private provider detail" }, { status: 400, headers: { "x-amzn-errortype": "ServiceQuotaExceededException" } }) : Response.json({ items: [] });
    } } as unknown as Outbound);
    await api("ListMicrovms", { imageIdentifier: "arn:aws:lambda:test", nextToken: "a+b" });
    const { url, init } = requests[0];
    assert.equal(new URL(url).pathname, "/2025-09-09/microvms");
    assert.equal(new URL(url).searchParams.get("nextToken"), "a+b");
    assert.match(init.secrets.authorization, /^AWS4-HMAC-SHA256 /);
    assert.match(init.secrets.authorization, /us-west-2\/lambda\/aws4_request/);
    assert.equal(init.headers.authorization, undefined);
    reject = true;
    await assert.rejects(api("RunMicrovm", { imageIdentifier: "image", clientToken: "key" }), (error: any) => error.refused?.code === "limit_reached" && !error.message.includes("private"));
  } finally {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AWS_SESSION_TOKEN"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});
