import { test } from "node:test";
import assert from "node:assert/strict";
import { Computers } from "../src/computers/service.ts";
import { boatMachines } from "../src/computers/managed.ts";
import { HttpError } from "../src/http.ts";
import { micros } from "../src/pricing.ts";
import { HOUR, cost, fixture, pass, fund, USER } from "./computers-fixture.ts";

test("stop reads the last of the cost, then deletes the machine, and charges nothing after", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const { machine } = await f.row();
  f.advance(45_000);
  await f.stop();
  assert.equal(await f.spent(), cost(45_000));
  assert.deepEqual(f.state.removed, [machine]);
  assert.ok((await f.row()).ended_at);
  f.advance(HOUR);
  await pass(f);
  assert.equal(await f.spent(), cost(45_000));
  f.done();
});

test("a machine past its TTL ends by itself: its row ends at the next pass, and the time since the last charge is not charged", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect("payg", "a", { leaseSeconds: 300 });
  await f.start();
  f.advance(240_000);
  await pass(f);
  assert.equal(await f.spent(), cost(240_000));
  f.advance(120_000);
  await pass(f);
  assert.equal(await f.spent(), cost(240_000), "the last minute of a machine that is gone can't be read");
  assert.ok((await f.row()).ended_at);
  assert.deepEqual(f.state.removed, [], "nothing to delete");
  assert.deepEqual(await f.holds(), []);
  const user = await f.endUsers.get("payg", "u", ["work"]);
  assert.equal(user.balance, micros(1) - cost(240_000));
  await f.start("payg", "a", "again");
  assert.equal((await f.row()).ended_at, null);
  f.done();
});

test("internal accounts still obey operator blocks and the managed-computer switch", async () => {
  const f = await fixture({ billing: "none", purchased: false, balance: 0 });
  try {
    await f.connect();
    await f.service.managed.stopTenant("payg", "ops", true);
    await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 403 && /turned off/.test(error.message));
    await f.service.managed.unblockTenant("payg");
    await assert.rejects(f.start("payg", "a", "disabled", f.make(false)), (error: unknown) => error instanceof HttpError && error.status === 403 && /not available/.test(error.message));
    assert.equal(f.state.creates, 0);
  } finally { f.done(); }
});

test("a lost answer is the same machine: the next start finds it by its key, or the next pass by its label, and nothing is charged twice", async () => {
  const f = await fixture();
  await f.connect();
  f.state.loseAnswer = true;
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 502 && /Call computer_start again/.test(error.message));
  const row = await f.row();
  assert.deepEqual([row.machine, row.ended_at], [null, null]);
  assert.equal(f.machines.size, 1);
  await f.start("payg", "a", "retry");
  assert.equal(f.machines.size, 1, "the same key: no second machine");
  assert.equal((await f.row()).id, row.id);
  assert.equal((await f.row()).machine, [...f.machines.values()][0].id);
  f.done();

  const g = await fixture();
  await g.connect();
  g.state.loseAnswer = true;
  await assert.rejects(g.start());
  g.advance(60_000);
  await pass(g);
  assert.equal((await g.row()).machine, [...g.machines.values()][0].id, "adopted from the listing");
  assert.equal(await g.spent(), cost(60_000));
  g.done();

  const h = await fixture();
  await h.connect();
  h.state.loseAnswer = true;
  await assert.rejects(h.start());
  h.machines.clear();
  h.advance(5 * 60_000);
  await pass(h);
  assert.equal((await h.row()).ended_at, null, "may still be coming");
  h.advance(6 * 60_000);
  await pass(h);
  assert.ok((await h.row()).ended_at);
  h.done();
});

test("two starts at once make one machine", async () => {
  const f = await fixture();
  await f.connect();
  await Promise.all([f.start("payg", "a", "one"), f.start("payg", "a", "two"), f.start("payg", "a", "three")]);
  assert.equal(f.machines.size, 1);
  assert.equal((await f.rows()).length, 1);
  f.done();
});

test("a listing that fails changes nothing, and a machine with no row is only said: not deleted", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.state.listFails = true;
  f.advance(HOUR);
  await f.service.sweep();
  assert.equal((await f.row()).ended_at, null);
  assert.ok(f.logged.some(line => line.type === "computer_pass_failed"));
  f.state.listFails = false;
  f.machines.set("cmp_other", { id: "bx_other", tenant: "payg", createdAt: f.now() - 20 * 60_000, since: "2026-10-01T00:00:00.000Z", ttlUntil: f.now() + HOUR, files: new Map() });
  await pass(f);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_leak").map(line => [line.computer, line.machine]), [["cmp_other", "bx_other"]]);
  assert.deepEqual(f.state.removed, []);
  f.done();
});

test("Boat's refusals are read by code, a stored one's retry time from where Boat puts it", async () => {
  const answer = (status: number, body: unknown) => ({ fetch: async () => Response.json(body, { status }) }) as any;
  const f = await fixture();
  await f.connect();
  const refusal = async (status: number, body: unknown) => {
    const boat = boatMachines("k", answer(status, body), "r");
    return boat.create("cmp", "t", 60).then(() => assert.fail("should refuse"), error => (error as any).refused);
  };
  assert.deepEqual(await refusal(503, { code: "out_of_capacity" }), { code: "out_of_capacity" });
  assert.deepEqual(await refusal(429, { error: { code: "limit_reached" } }), { code: "limit_reached" });
  const limited = await refusal(429, { code: "rate_limited", error: { code: "rate_limited", details: { nextStartAt: new Date(Date.now() + 8000).toISOString() } } });
  assert.ok(limited.retryAfterMs > 5000 && limited.retryAfterMs <= 8000);
  assert.deepEqual(await refusal(401, {}), { code: "http_401" });
  assert.equal(await refusal(500, {}), undefined, "what it may have made isn't known");
  assert.equal(await refusal(503, { code: "something_new" }), undefined);
  f.done();
});

test("out_of_capacity is tried again briefly and logged each time; if it lasts, a clear error, nothing charged, the hold back, and the next start works", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect();
  const OUT = { code: "out_of_capacity" };
  f.state.refusals.push(OUT, OUT);
  await f.start();
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.equal((await f.row()).ended_at, null);
  await f.stop();

  f.waits.length = 0;
  f.state.refusals.push(OUT, OUT, OUT);
  await assert.rejects(f.start("payg", "a", "lasting"), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "COMPUTER_UNAVAILABLE" && error.details?.reason === "out_of_capacity" && /no machines free right now. Nothing was created or charged/.test(error.message));
  assert.ok((await f.row()).ended_at);
  assert.equal(Number((await f.row()).charged_micros), 0);
  assert.deepEqual(await f.holds(), []);
  assert.equal(f.logged.filter(line => line.type === "computer_unavailable" && line.code === "out_of_capacity").length, 5);
  await f.start("payg", "a", "next");
  assert.equal((await f.row()).ended_at, null);
  f.done();
});

test("rate_limited waits when Boat says it is soon and says when otherwise; limit_reached and billing_required don't wait", async () => {
  const f = await fixture();
  await f.connect();
  f.state.refusals.push({ code: "rate_limited", retryAfterMs: 8000 });
  await f.start("payg", "a", "soon");
  assert.deepEqual(f.waits, [8000]);
  await f.stop();
  f.state.refusals.push({ code: "rate_limited", retryAfterMs: 90_000 });
  await assert.rejects(f.start("payg", "a", "later"), (error: unknown) => error instanceof HttpError && error.status === 429 && /in about 90 seconds/.test(error.message));
  f.state.refusals.push({ code: "limit_reached" });
  await assert.rejects(f.start("payg", "a", "full"), (error: unknown) => error instanceof HttpError && error.status === 503 && /Too many computers are running/.test(error.message));
  f.state.refusals.push({ code: "billing_required" });
  await assert.rejects(f.start("payg", "a", "wallet"), (error: unknown) => error instanceof HttpError && error.status === 503 && /operator/.test(error.message));
  assert.deepEqual(f.waits, [8000]);
  f.done();
});

test("the flag off stops every running managed computer at the next pass, charging up to then; a provider connection keeps running", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.service.create("rich", { agent: "c", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start("rich", "c", "byo");
  f.advance(60_000);
  const off = f.make(false);
  await off.sweep();
  assert.ok((await f.row()).ended_at);
  assert.equal(await f.spent(), cost(60_000));
  assert.equal((await f.db.query("select state from computer_leases where agent='c'")).rows[0].state, "active");
  assert.equal(f.logged.filter(line => line.type === "computer_kill_stop").length, 1);
  f.done();
});

test("the operator's stop gets every computer of an account, however many; with block no new one starts until lifted", async () => {
  const agents = Array.from({ length: 250 }, (_, i) => `agent-${i}`);
  const f = await fixture({ extraAgents: agents });
  for (const agent of agents) await f.connect("payg", agent);
  await f.connect("rich", "c");
  await f.db.query(`insert into managed_computers(id,tenant,agent,connection,platform,machine,deadline,created_at)
    select 'cmp_' || agent, 'payg', agent, id, true, 'bx_' || agent, $1::bigint, $2::bigint from computer_connections where tenant='payg'`, [f.now() + HOUR, f.now()]);
  await f.start("rich", "c", "start-c");
  const result = await f.service.managed.stopTenant("payg", "ops", true);
  assert.deepEqual(result, { stopped: 250, failed: 0, blocked: true });
  assert.equal((await f.db.query("select count(*)::int as n from managed_computers where tenant='payg' and ended_at is null")).rows[0].n, 0);
  assert.equal((await f.row("c")).ended_at, null);
  await assert.rejects(f.start("payg", "agent-0", "blocked"), (error: unknown) => error instanceof HttpError && error.status === 403 && /turned off for this account/.test(error.message));
  assert.equal(f.logged.filter(line => line.type === "computer_tenant_stopped").at(-1).by, "ops");
  assert.deepEqual(await f.service.managed.unblockTenant("payg"), { blocked: false });
  await f.start("payg", "agent-0", "after");
  f.done();
});

test("a failed delete: stop says so and can be retried, stop-all counts it and doesn't loop on it", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.state.removeFails = true;
  await assert.rejects(f.stop(), (error: unknown) => error instanceof HttpError && error.status === 502);
  assert.equal((await f.row()).ended_at, null);
  assert.deepEqual(await f.service.managed.stopTenant("payg", "ops", false), { stopped: 0, failed: 1, blocked: false });
  f.state.removeFails = false;
  await f.service.call("payg", "a", "computer_stop", {}, "stop-again");
  assert.ok((await f.row()).ended_at);
  f.done();
});

test("a listing with a page that fails or falls short is no listing: nothing ends, even past 200 machines", async () => {
  const agents = Array.from({ length: 250 }, (_, i) => `agent-${i}`);
  const box = (i: number) => ({ id: `bx_${i}`, state: "idle", createdAt: "2026-10-31T00:00:00Z", labels: { computer: `cmp_agent-${i}`, tenant: "payg" }, cost: { since: "2026-10-01T00:00:00Z", seconds: 10, dollars: 0.0001 } });
  const whole = Array.from({ length: 250 }, (_, i) => box(i));
  let second: () => Response = () => new Response("", { status: 500 });
  const f = await fixture({ extraAgents: agents, outbound: { fetch: async (url: string) => {
    const cursor = new URL(url).searchParams.get("cursor");
    return cursor ? second() : Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true, nextCursor: "page-2" } });
  } } });
  for (const agent of agents) await f.connect("payg", agent);
  await f.db.query(`insert into managed_computers(id,tenant,agent,connection,platform,machine,deadline,created_at)
    select 'cmp_' || agent, 'payg', agent, id, true, 'bx_' || agent, $1::bigint, $2::bigint from computer_connections where tenant='payg'`, [f.now() + HOUR, f.now()]);
  f.advance(10 * 60_000);
  const open = async () => Number((await f.db.query("select count(*)::int as n from managed_computers where ended_at is null")).rows[0].n);

  const broken: (() => Response)[] = [
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 429 }),
    () => { throw new Error("connection lost"); },
    () => Response.json({ sandboxes: whole.slice(200) }), // no pageInfo
    () => Response.json({ pageInfo: { hasMore: false } }), // no machines at all
    () => Response.json({ sandboxes: whole.slice(200, 210), pageInfo: { hasMore: true, nextCursor: "page-3" } }), // short, with more to come
    () => Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true } }), // more, but no way to it
    () => Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true, nextCursor: "page-2" } }), // the same page again
    () => Response.json({ sandboxes: whole.slice(200).map(({ cost: _cost, ...rest }) => rest), pageInfo: { hasMore: false } }), // no costs
  ];
  for (const answer of broken) {
    second = answer;
    await assert.rejects(pass(f));
    assert.equal(await open(), 250);
  }
  assert.equal(await f.spent(), 0, "nothing charged from half a listing");

  second = () => Response.json({ sandboxes: whole.slice(200), pageInfo: { hasMore: false } });
  await pass(f);
  assert.equal(await open(), 250);
  assert.equal(await f.spent(), 250 * 100);
  f.done();
});

test("a row a listing misses ends only when a listing of that row alone agrees", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const row = await f.row();
  f.advance(10 * 60_000);
  f.state.hidden.add(row.id);
  await pass(f);
  assert.equal((await f.row()).ended_at, null, "still there when asked by name");
  f.state.hidden.clear();
  f.machines.clear();
  await pass(f);
  assert.ok((await f.row()).ended_at);
  f.done();
});

test("an agent revoked, purged, expired or deleted takes its machine with it at the next pass, charged up to then; others keep theirs", async () => {
  const agents = ["gone-revoked", "gone-purged", "gone-expired", "gone-deleted", "stays"];
  const f = await fixture({ extraAgents: agents });
  for (const agent of agents) { await f.connect("payg", agent); await f.start("payg", agent, `start-${agent}`); }
  f.advance(60_000);
  await f.db.query("update agents set revoked=true where id='gone-revoked'");
  await f.db.query("update agents set purged_at=$1 where id='gone-purged'", [f.now()]);
  await f.db.query("update agents set expires_at=$1 where id='gone-expired'", [f.now() - 1]);
  await f.db.query("delete from agents where id='gone-deleted'");
  await pass(f);
  for (const agent of agents.slice(0, 4)) assert.ok((await f.row(agent)).ended_at, agent);
  assert.equal((await f.row("stays")).ended_at, null);
  assert.equal(f.state.removed.length, 4);
  assert.equal(await f.spent(), 5 * cost(60_000));
  assert.equal(f.logged.filter(line => line.type === "computer_agent_gone").length, 4);
  f.done();
});

test("Lambda uses runtime credentials, inherits into separate subagent sessions and stops at its fixed TTL", async () => {
  const f = await fixture({ platformKey: false, extraAgents: ["child"] });
  try {
    const service = new Computers({ ...f.service.options, provider: "lambda" });
    await service.create("payg", { agent: "a", provider: "lambda", leaseSeconds: 86400 });
    await service.call("payg", "a", "computer_start", {}, "start");
    const parent = await f.row();
    assert.equal(parent.provider, "lambda");
    assert.equal(parent.deadline - parent.created_at, 28800000);
    assert.deepEqual([...new Set(f.keys)], ["aws"]);
    await service.inherit("payg", "a", "child", f.db);
    await service.call("payg", "child", "computer_start", {}, "child-start");
    const child = await f.row("child");
    assert.equal(child.provider, "lambda");
    assert.notEqual(child.machine, parent.machine);
    // Keep the fake provider machine present past TTL: the runtime must terminate it too.
    for (const machine of f.machines.values()) machine.ttlUntil += HOUR;
    f.advance(8 * HOUR);
    await service.managed.pass();
    assert.ok((await f.row()).ended_at);
    assert.ok((await f.row("child")).ended_at);
    assert.ok(f.state.removed.includes(parent.machine));
    assert.ok(f.state.removed.includes(child.machine));
  } finally { f.done(); }
});

test("switching the default to Lambda keeps existing Boat sessions on Boat", async () => {
  const f = await fixture();
  try {
    await f.connect(); await f.start();
    const before = await f.row();
    const service = new Computers({ ...f.service.options, provider: "lambda" });
    const status = await service.call("payg", "a", "computer_status", {}, "status");
    assert.equal(status.provider, "boat");
    await service.call("payg", "a", "computer_exec", { command: "true" }, "exec");
    assert.equal((await f.row()).machine, before.machine);
    assert.equal(f.keys.at(-1), "platform-key");
    await service.create("payg", { agent: "b", provider: "boat" });
    await service.call("payg", "b", "computer_start", {}, "start-b");
    assert.equal((await f.row("b")).provider, "lambda");
  } finally { f.done(); }
});


test("a sharing child's first exec starts and bills its owner's managed computer, but never undoes a stop", async () => {
  const f = await fixture({ extraAgents: ['child'] });
  try {
    await f.connect();
    await f.db.query("insert into computer_shares(tenant,agent,owner) values('payg','child','a')");
    assert.equal((await f.service.call('payg', 'child', 'computer_exec', { command: 'true' }, 'first') as any).exitCode, 0);
    assert.equal(f.state.creates, 1);
    assert.equal((await f.row()).agent, 'a');
    await f.stop();
    await assert.rejects(f.service.call('payg', 'child', 'computer_exec', { command: 'true' }, 'stopped'), (error: any) => error.code === 'COMPUTER_STOPPED');
    assert.equal(f.state.creates, 1);
  } finally { f.done(); }
});
