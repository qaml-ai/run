import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, sleep, toolCall, until } from "./runtime-server.ts";

const USD = 1_000_000;
/** Each response reports what OpenRouter charged for it: $0.10. The model keeps calling tools. */
const looping = (_body: any, index: number) => ({ ...toolCall("js_exec", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 } });
const settings = (r: Awaited<ReturnType<typeof runtime>>, body: Record<string, unknown>) => r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, ...body } });
const grant = (r: Awaited<ReturnType<typeof runtime>>, user: string, amount: number, key: string) =>
  r.call(`/v1/end-users/${encodeURIComponent(user)}/entries`, { body: { kind: amount > 0 ? "grant" : "adjustment", amount, key } });
const usage = async (r: Awaited<ReturnType<typeof runtime>>, user: string) =>
  (await r.call(`/v1/end-users/${encodeURIComponent(user)}/ledger?limit=200`)).json.entries.filter((entry: any) => entry.kind === "usage");
const settled = (r: Awaited<ReturnType<typeof runtime>>, path: string) => until(async () => {
  const record = (await r.call(path)).json;
  return record.state === "completed" && record;
}, "the run to end", 30_000);

test("an end user's allowance pays first, then their balance; out of both, the turn stops and their next run is refused", async t => {
  const r = await runtime(t, looping, { AGENT_MODEL: "openai/gpt-5.5-pro" });
  assert.equal((await settings(r, { allowances: { builder: 250_000 }, markupBps: 2_500 })).status, 200);
  assert.equal((await grant(r, "person", 100_000, "pay-1")).status, 201);
  const { id, token } = (await r.call("/v1/agents", { body: { subject: "person", bucket: "builder" } })).json;
  assert.equal((await r.call(`/v1/agents/${id}`)).json.bucket, "builder");

  const run = await r.prompt(id, "go");
  const result = run.outcome.result;
  assert.deepEqual([result.stopped, result.code, result.limit, result.reason], ["spend_limit", "end_user_credit", "end_user", "balance"], JSON.stringify(result));
  assert.match(result.error, /out of credit|too little credit/);
  const entries = await usage(r, "person");
  assert.equal(entries.length, r.model.bodies.length, "each response the provider made is posted once");
  assert.ok(entries.every((entry: any) => entry.bucket === "builder" && entry.raw === 100_000 && entry.metadata.requestId === run.id));
  const allowance = entries.reduce((total: number, entry: any) => total + entry.allowance, 0);
  const paid = entries.reduce((total: number, entry: any) => total - entry.amount, 0);
  assert.equal(allowance, 250_000, "the allowance is spent first, all of it");
  assert.equal(paid, Math.ceil((entries.length * 100_000 - 250_000) * 1.25), "the rest from the balance, marked up");
  const person = (await r.call("/v1/end-users/person?buckets=builder")).json;
  assert.equal(person.balance, 100_000 - paid);
  assert.ok(person.balance >= -125_000, "at most one response past the balance");
  assert.equal(person.today.buckets[0].allowanceLeft, 0);

  // Nothing left at all: the next run is refused before it starts, with why.
  await grant(r, "person", -person.balance, "zero");
  const refused = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "again" } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.reason, refused.json.endUser, refused.json.bucket], [402, "END_USER_CREDIT", "balance", "person", "builder"], refused.text);

  // Credit added after a payment lets them go on; the agent's own token cannot pick a bucket with more allowance.
  await grant(r, "person", 50_000, "pay-2");
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "own", method: "prompt", params: { text: "x", bucket: "rich" } } })).status, 403);
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "conf", method: "configure", params: { bucket: "rich" } } })).status, 403);
  const again = await r.prompt(id, "go on");
  assert.equal(again.outcome.result.code, "end_user_credit");
});

test("a run's own bucket, the agent's bucket and a stateless run's each spend their own allowance", async t => {
  // gpt-4.1: a call needs about a cent of credit to start (its input, and 256 tokens of output at $8 a million).
  const r = await runtime(t, (_body: any) => ({ content: "done", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { AGENT_MODEL: "openai/gpt-4.1" });
  await settings(r, { allowances: { "bot:*": 50_000, builder: 50_000 } });
  const { id } = (await r.call("/v1/agents", { body: { subject: "owner", bucket: "builder" } })).json;
  await r.prompt(id, "one");
  await r.prompt(id, "two", undefined, { bucket: "bot:7" });
  assert.equal((await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { bucket: "bot:8" } })).status, 202);
  await until(async () => (await r.call(`/v1/agents/${id}`)).json.bucket === "bot:8", "the bucket to change");
  await r.prompt(id, "three");
  const run = await r.call("/v1/runs?wait=30", { body: { input: "four", subject: "owner", bucket: "bot:9" } });
  assert.equal(run.status, 200, run.text);
  const buckets = (await usage(r, "owner")).map((entry: any) => entry.bucket).sort();
  assert.deepEqual(buckets, ["bot:7", "bot:8", "bot:9", "builder"]);
  const owner = (await r.call("/v1/end-users/owner")).json;
  assert.ok(owner.today.buckets.every((bucket: any) => bucket.allowanceSpent === 10_000 && bucket.paidSpent === 0), JSON.stringify(owner.today.buckets));
  assert.equal(owner.balance, 0, "all four were free");

  // Someone the tenant never credited, in a bucket with no allowance: a stateless run is refused at once.
  const broke = await r.call("/v1/runs", { body: { input: "five", subject: "stranger", bucket: "paid-only" } });
  assert.deepEqual([broke.status, broke.json.code], [402, "END_USER_CREDIT"], broke.text);
  // No subject: the tenant pays, nobody's credit is checked.
  assert.equal((await r.call("/v1/runs?wait=30", { body: { input: "six" } })).status, 200);
});

test("a run's own bucket is what its start is checked against, and the runs after it that name none (the runtime's own too) inherit it, never \"default\"", async t => {
  // camel-bots' bot agents: no bucket of their own ("default", $0 under "*": 0), each prompt naming the bot's. The
  // queued run's start once checked the agent's bucket, and every such run failed before it began.
  const r = await runtime(t, (_body: any) => ({ content: "done", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { AGENT_MODEL: "openai/gpt-4.1" });
  await settings(r, { allowances: { "bot:*": 1_000_000, "*": 0 } });
  const { id } = (await r.call("/v1/agents", { body: { subject: "owner" } })).json;
  const accepted = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "hi", requestId: "own-bucket", bucket: "bot:7", spendLimit: { usd: 0.25 } } });
  assert.equal(accepted.status, 202, accepted.text);
  const record = await settled(r, `/v1/agents/${id}/requests/own-bucket`);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  assert.equal(record.outcome.result.reply, "done");
  assert.deepEqual((await usage(r, "owner")).map((entry: any) => entry.bucket), ["bot:7"]);
  // A run that names none spends from the bucket the agent's runs were last given, never "default" (no allowance).
  await r.prompt(id, "hi");
  // So does a run the runtime starts for it: a schedule's wake-up.
  const now = Date.now();
  await r.db.query("insert into schedules (id, agent, tenant, text, due_at, created_at) values (gen_random_uuid(), $1, 'alice', 'wake up', $2, $2)", [id, now - 10]);
  await until(async () => (await usage(r, "owner")).length === 3, "the schedule's run to spend");
  assert.deepEqual((await usage(r, "owner")).map((entry: any) => entry.bucket), ["bot:7", "bot:7", "bot:7"]);
  // An agent no run named a bucket for still has the default's (no allowance): refused at accept, saying which.
  const other = (await r.call("/v1/agents", { body: { subject: "owner" } })).json.id;
  const refused = await r.call(`/v1/agents/${other}/prompt`, { body: { text: "hi" } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.bucket], [402, "END_USER_CREDIT", "default"], refused.text);
});

test("a long reply stops at the end of its end user's credit, mid-stream, and is not retried", async t => {
  let requests = 0, closed = false;
  const chunk = "x".repeat(100);
  const url = await listen(t, async (req, res) => {
    for await (const _ of req) { /* the request */ }
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.on("close", () => { closed = true; });
    // 50,000 characters, 100 every 20 ms (5,000 a second, far faster than a model writes): about $4.50 at
    // gpt-5.5-pro's output price, if it were all read.
    for (let index = 0; index < 500 && !res.destroyed; index++) {
      res.write(`data: ${JSON.stringify({ id: "long", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      await sleep(20);
    }
    if (!res.destroyed) res.end(`data: ${JSON.stringify({ id: "long", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 12_500 } })}\n\ndata: [DONE]\n\n`);
  });
  const r = await runtime(t, () => ({ content: "unused" }), { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BASE_URL: `${url}/v1` });
  await settings(r, {});
  await grant(r, "reader", 500_000, "pay");
  const { id } = (await r.call("/v1/agents", { body: { subject: "reader" } })).json;
  const run = await r.prompt(id, "write a lot");
  const result = run.outcome.result;
  assert.deepEqual([result.stopped, result.code, result.reason], ["spend_limit", "end_user_credit", "balance"], JSON.stringify(result));
  assert.equal(requests, 1, "a turn its end user's credit stopped is not retried");
  await until(() => closed, "the provider's stream to be cut");
  const [entry] = await usage(r, "reader");
  // $0.50 at 90 micro-USD a character (2 characters a token) is about 5,500 characters, less the input's estimate. What
  // the provider streams while the line's credit check is answered is billed too (it was generated): a slow machine's
  // round trip, at this stream's pace, is a few chunks at most.
  const slack = 3 * 100 * 90;
  assert.ok(entry.raw > 300_000 && entry.raw <= 500_000 + slack, `charged ${entry.raw} for what streamed before the line`);
  const person = (await r.call("/v1/end-users/reader")).json;
  assert.ok(person.balance >= -slack, `balance ${person.balance}: at most a few chunks past zero`);
  assert.equal(person.held, 0);
  const history = (await r.call(`/v1/agents/${id}/history`)).json;
  const reply = JSON.stringify(history).match(/x{100,}/)?.[0] ?? "";
  assert.ok(reply.length > 1_000 && reply.length < 10_000, `what streamed before the cut is kept (${reply.length} characters)`);
});

test("concurrent replies for one end user share their credit: their holds never add up to more than it", async t => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(t, () => ({ content: "ok", wait: barrier, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { AGENT_MODEL: "openai/gpt-4.1" });
  await settings(r, {});
  // A gpt-4.1 call holds its input and 8,192 tokens of output at $8 a million: about $0.07. $0.15 holds two and a bit.
  await grant(r, "shared", 150_000, "pay");
  const agents: string[] = [];
  for (let index = 0; index < 4; index++) {
    const made = await r.call("/v1/agents", { body: { subject: "shared" } });
    assert.equal(made.status, 201, made.text);
    agents.push(made.json.id);
  }
  const accepted = await Promise.all(agents.map(agent => r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } })));
  assert.ok(accepted.every(answer => answer.status === 202), accepted.map(answer => answer.text).join("\n"));
  // Each call that could hold is waiting at the provider before any finishes; the rest were refused before theirs.
  await until(async () => r.model.bodies.length >= 2, "calls to reach the provider");
  await sleep(500);
  const reached = r.model.bodies.length;
  const held = Number((await r.db.query("select coalesce(sum(paid), 0)::bigint as paid from end_user_holds where end_user = 'shared'")).rows[0].paid);
  assert.ok(held <= 150_000, `${held} held of 150000`);
  release();
  const runs = await Promise.all(agents.map((agent, index) => settled(r, `/v1/agents/${agent}/requests/${accepted[index].json.id}`)));
  const refused = runs.filter(run => run.outcome.result?.code === "end_user_credit");
  assert.ok(runs.every(run => run.outcome.result), JSON.stringify({ outcomes: runs.map(run => run.outcome), logs: r.logs.filter(line => /error|failed|refused/i.test(line)).slice(-30) }));
  assert.ok(reached < 4 && refused.length === 4 - reached, `${reached} calls made, ${refused.length} refused: ${JSON.stringify(runs.map(run => run.outcome.result))}`);
  const person = (await r.call("/v1/end-users/shared")).json;
  assert.deepEqual([person.balance, person.held], [150_000 - reached * 10_000, 0]);
});

test("the TypeScript SDK: endUsers configure, grant, get and ledger; an agent's bucket; a run out of credit fails with code end_user_credit", async t => {
  const { Agents } = await import("../clients/node.ts");
  const r = await runtime(t, () => ({ content: "seen", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { AGENT_MODEL: "openai/gpt-4.1" });
  const agents = new Agents({ url: r.base, apiKey: (await import("./runtime-server.ts")).OPERATOR });
  t.after(() => agents.close());
  const settings = await agents.endUsers.configure({ enabled: true, allowances: { "bot:*": 15_000 }, markupBps: 2_000 });
  assert.deepEqual([settings.enabled, settings.markupBps], [true, 2_000]);
  const granted = await agents.endUsers.grant("owner", { amount: 50_000, key: "pi_1" });
  assert.equal((await agents.endUsers.grant("owner", { amount: 50_000, key: "pi_1" })).entry.id, granted.entry.id);
  const agent = await agents.upsert("bot-1", { subject: "owner", bucket: "bot:1" });
  assert.equal((await agent.run("one")).text, "seen");
  assert.equal((await agent.run("two")).text, "seen");
  const owner = await agents.endUsers.get("owner", { buckets: ["bot:1"] });
  assert.deepEqual([owner.today.buckets[0].allowanceSpent, owner.balance], [15_000, 50_000 - 6_000], "$0.015 free, the other $0.005 at +20% from the balance");
  const { entries } = await agents.endUsers.ledger("owner", { limit: 2 });
  assert.deepEqual(entries.map(entry => [entry.kind, entry.bucket, entry.raw]), [["usage", "bot:1", 10_000], ["usage", "bot:1", 10_000]]);
  await agents.endUsers.adjust("owner", { amount: -owner.balance, key: "zero" });
  await agents.endUsers.update("owner", { allowances: { "bot:1": 0 } });
  await assert.rejects(agent.run("three"), (error: any) => error.code === "END_USER_CREDIT" && error.status === 402);
  // A stateless run spends from its own bucket.
  await agents.endUsers.update("owner", { allowances: { "bot:1": null } });
  const run = await agents.run({ input: "four", subject: "owner", bucket: "bot:2", throwOnError: false });
  assert.equal(run.error, null);
  assert.deepEqual((await agents.endUsers.list()).endUsers.map(user => user.id), ["owner"]);
});
