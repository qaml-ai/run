import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-runs.test.ts");

import assert from "node:assert/strict";

import { listen, runtime, sleep, toolCall, until } from "../support.ts";

const AT_COST = { AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1" };

const looping = (_body: any, index: number) => ({ ...toolCall("codemode", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 } });

const settings = (r: Awaited<ReturnType<typeof runtime>>, body: Record<string, unknown>) => r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, ...body } });

const grant = (r: Awaited<ReturnType<typeof runtime>>, user: string, amount: number, key: string) =>
  r.call(`/v1/end-users/${encodeURIComponent(user)}/entries`, { body: { kind: amount > 0 ? "grant" : "adjustment", amount, key } });

const usage = async (r: Awaited<ReturnType<typeof runtime>>, user: string) =>
  (await r.call(`/v1/end-users/${encodeURIComponent(user)}/ledger?limit=200`)).json.entries.filter((entry: any) => entry.kind === "usage");

test("an end user's allowance pays first, then their balance; out of both, the turn stops and their next run is refused", async t => {
  const r = await runtime(t, looping, { ...AT_COST, AGENT_MODEL: "openai/gpt-5.5-pro" });
  assert.equal((await settings(r, { allowances: { builder: 250_000 }, markupBps: 2_500 })).status, 200);
  assert.equal((await grant(r, "person", 100_000, "pay-1")).status, 201);
  const { id, token } = (await r.call("/v1/agents", { body: { subject: "person", bucket: "builder" } })).json;
  assert.equal((await r.call(`/v1/agents/${id}`)).json.bucket, "builder");

  const run = await r.prompt(id, "go");
  const result = run.outcome.result;
  assert.deepEqual([result.stopped, result.code, result.limit, result.reason, result.bucket, result.endUser], ["spend_limit", "end_user_credit", "end_user", "balance", "builder", "person"], JSON.stringify(result));
  assert.match(result.error, /out of credit|too little credit/);
  const entries = await usage(r, "person");
  assert.equal(entries.length, r.model.bodies.length, "each response the provider made is posted once");
  assert.ok(entries.every((entry: any) => entry.bucket === "builder" && entry.raw === 100_000 && entry.metadata.requestId === run.id));
  const allowance = entries.reduce((total: number, entry: any) => total + entry.allowance, 0);
  const paid = entries.reduce((total: number, entry: any) => total - entry.amount, 0);
  assert.equal(allowance, 250_000, "the allowance is spent first, all of it");
  assert.equal(paid, (entries.length * 100_000 - 250_000) * 1.25, "the full marked-up remainder");
  const writtenOff = entries.reduce((total: number, entry: any) => total + entry.writtenOff, 0);
  assert.equal(writtenOff, 0);
  const person = (await r.call("/v1/end-users/person?buckets=builder")).json;
  assert.equal(person.balance, 100_000 - paid);
  assert.equal(person.today.buckets[0].allowanceLeft, 0);

  // Nothing left at all: the next run is refused before it starts, with why.
  const refused = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "again" } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.reason, refused.json.endUser, refused.json.bucket], [402, "END_USER_CREDIT", "balance", "person", "builder"], refused.text);

  // Credit added after a payment lets them go on; the agent's own token cannot pick a bucket with more allowance.
  await grant(r, "person", 100_000, "pay-2");
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "own", method: "prompt", params: { text: "x", bucket: "rich" } } })).status, 403);
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "conf", method: "configure", params: { bucket: "rich" } } })).status, 403);
  const again = await r.prompt(id, "go on");
  assert.equal(again.outcome.result.code, "end_user_credit");
});

test("a run's own bucket, the agent's bucket and a stateless run's each spend their own allowance", async t => {
  // gpt-4.1: a call needs about a cent of credit to start (its input, and 256 tokens of output at $8 a million).
  const r = await runtime(t, (_body: any) => ({ content: "done", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { ...AT_COST, AGENT_MODEL: "openai/gpt-4.1" });
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

test("an admitted long reply finishes after crossing zero and the next run is refused", async t => {
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
  const r = await runtime(t, () => ({ content: "unused" }), { ...AT_COST, AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BASE_URL: `${url}/v1` });
  await settings(r, {});
  await grant(r, "reader", 500_000, "pay");
  const { id } = (await r.call("/v1/agents", { body: { subject: "reader" } })).json;
  const run = await r.prompt(id, "write a lot");
  assert.equal(run.outcome.result.reply.length, 50_000);
  assert.equal(requests, 1);
  await until(() => closed, "the provider's stream to finish");
  const [entry] = await usage(r, "reader");
  assert.ok(entry.raw > 500_000);
  assert.equal(entry.writtenOff, 0);
  const person = (await r.call("/v1/end-users/reader")).json;
  assert.deepEqual([person.balance, person.held], [500_000 + entry.amount, 0]);
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "again" } })).status, 402);
});

test("the TypeScript SDK: endUsers configure, grant, get and ledger; an agent's bucket; a run out of credit fails with code end_user_credit", async t => {
  const { Agents } = await import("../../../clients/node.ts");
  const r = await runtime(t, () => ({ content: "seen", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { ...AT_COST, AGENT_MODEL: "openai/gpt-4.1" });
  const agents = new Agents({ url: r.base, apiKey: (await import("../support.ts")).OPERATOR });
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
  const { endUserCredit } = await import("../../../clients/typescript.ts");
  await assert.rejects(agent.run("three"), (error: any) => {
    assert.deepEqual([error.status, error.code, error.reason, error.bucket, error.endUser], [402, "END_USER_CREDIT", "balance", "bot:1", "owner"]);
    assert.deepEqual(endUserCredit(error), { code: "end_user_credit", reason: "balance", bucket: "bot:1", endUser: "owner", message: error.message });
    return true;
  });
  // A stateless run refused at submit: the same fields.
  await assert.rejects(agents.run({ input: "refused", subject: "owner", bucket: "bot:1" }), (error: any) => error.code === "END_USER_CREDIT" && error.reason === "balance" && error.bucket === "bot:1");
  // A stateless run spends from its own bucket.
  await agents.endUsers.update("owner", { allowances: { "bot:1": null } });
  const run = await agents.run({ input: "four", subject: "owner", bucket: "bot:2", throwOnError: false });
  assert.equal(run.error, null);
  assert.deepEqual((await agents.endUsers.list()).endUsers.map(user => user.id), ["owner"]);
  // A person's own low-balance threshold, and the sweep of those under theirs.
  const own = await agents.endUsers.update("owner", { lowBalance: 1_000_000 });
  assert.deepEqual([own.lowBalance, own.overrides.lowBalance], [1_000_000, 1_000_000]);
  assert.deepEqual((await agents.endUsers.list({ belowLowBalance: true })).endUsers.map(user => user.id), ["owner"]);
  assert.equal((await agents.endUsers.amend({ allowanceWarningPercent: 80 })).allowanceWarningPercent, 80);
});
