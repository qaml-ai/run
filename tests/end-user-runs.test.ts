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

test("a long reply stops at the end of its end user's credit, mid-stream, and is not retried", async t => {
  let requests = 0, closed = false;
  const chunk = "x".repeat(100);
  const url = await listen(t, async (req, res) => {
    for await (const _ of req) { /* the request */ }
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.on("close", () => { closed = true; });
    // 50,000 characters, 100 at a time: about $4.50 at gpt-5.5-pro's output price, if it were all read.
    for (let index = 0; index < 500 && !res.destroyed; index++) {
      res.write(`data: ${JSON.stringify({ id: "long", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      await sleep(2);
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
  // $0.50 at 90 micro-USD a character (2 characters a token) is about 5,500 characters, less the input's estimate.
  assert.ok(entry.raw > 300_000 && entry.raw <= 500_000 + 100 * 90, `charged ${entry.raw} for what streamed before the line`);
  const person = (await r.call("/v1/end-users/reader")).json;
  assert.ok(person.balance >= -100 * 90, `balance ${person.balance}: at most one chunk past zero`);
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
  assert.ok(runs.every(run => run.outcome.result), JSON.stringify(runs.map(run => run.outcome)));
  assert.ok(reached < 4 && refused.length === 4 - reached, `${reached} calls made, ${refused.length} refused: ${JSON.stringify(runs.map(run => run.outcome.result))}`);
  const person = (await r.call("/v1/end-users/shared")).json;
  assert.deepEqual([person.balance, person.held], [150_000 - reached * 10_000, 0]);
});
