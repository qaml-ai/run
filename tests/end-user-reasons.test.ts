import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, until } from "./runtime-server.ts";

// Every path that refuses or stops work for an end user's credit says why in code (end_user_credit, reason, bucket,
// endUser), never only in words: a run refused as it leaves the queue here; at submit, mid-way and over the SDKs in
// end-user-runs.test.ts.

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };
/** Calls charged at the provider's price (end-user-runs.test.ts). */
const AT_COST = { AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1", AGENT_MODEL: "openai/gpt-4.1" };

async function receiver(t: Parameters<typeof listen>[0]) {
  const received: any[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  return { url, find: (type: string, requestId: string) => received.find(event => event.type === type && event.data?.requestId === requestId) };
}

/**
 * Two messages to one agent spending from `bot:1`: the first is held at the provider (its hold a couple of cents, of a
 * free allowance of five), so the second is accepted and queued; the first then costs ten cents, more than was left,
 * and the second is refused as it comes to start. `setup` sets what refuses it.
 */
async function queuedRefusal(t: Parameters<typeof runtime>[0], setup: { settings: Record<string, unknown>; balance?: number }, sdk = false) {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const hook = await receiver(t);
  const r = await runtime(t, (_body: any, index: number) => ({ content: "ok", ...(index === 0 ? { wait: barrier } : {}), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 } }), { ...AT_COST, ...LOCAL });
  assert.equal((await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.failed"] } })).status, 201);
  assert.equal((await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, allowances: { "bot:*": 50_000 }, ...setup.settings } })).status, 200);
  if (setup.balance) assert.equal((await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: setup.balance, key: "pay" } })).status, 201);
  let agent: any;
  if (sdk) {
    const { Agents } = await import("../clients/node.ts");
    const agents = new Agents({ url: r.base, apiKey: (await import("./runtime-server.ts")).OPERATOR });
    t.after(() => agents.close());
    agent = await agents.upsert("person-bot", { subject: "person", bucket: "bot:1" });
  }
  const id: string = agent?.id ?? (await r.call("/v1/agents", { body: { subject: "person", bucket: "bot:1" } })).json.id;
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "one", requestId: "first" } })).status, 202);
  await until(async () => r.model.bodies.length >= 1, "the first call to reach the provider");
  let viaSdk: Promise<any> | undefined;
  if (agent) {
    viaSdk = agent.run("two", { idempotencyKey: "second", throwOnError: false });
    await until(async () => (await r.call(`/v1/agents/${id}/requests/second`)).status === 200, "the second to be queued");
  } else {
    const second = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "two", requestId: "second" } });
    assert.equal(second.status, 202, `accepted while credit is left: ${second.text}`);
  }
  release();
  const record = await until(async () => {
    const value = (await r.call(`/v1/agents/${id}/requests/second`)).json;
    return value.state === "completed" && value;
  }, "the second to end", 30_000);
  const event = await until(async () => hook.find("run.failed", "second"), "run.failed", 30_000);
  return { r, id, record, event, run: await viaSdk };
}

const CASES: { name: string; setup: { settings: Record<string, unknown>; balance?: number }; reason: string; words?: RegExp }[] = [
  { name: "no balance", setup: { settings: {} }, reason: "balance" },
  { name: "the daily limit", setup: { settings: { dailyLimit: 10_000 }, balance: 1_000_000 }, reason: "daily_limit" },
  { name: "a bucket limit above 0", setup: { settings: { bucketLimits: { "bot:*": 10_000 } }, balance: 1_000_000 }, reason: "bucket_limit" },
  // Its words differ from the others' ("This end user ..."): code that matched them saw an unknown failure.
  { name: "a bucket limit of 0", setup: { settings: { bucketLimits: { "bot:*": 0 } }, balance: 1_000_000 }, reason: "bucket_limit", words: /^"bot:1" spends no paid credit/ },
];

for (const { name, setup, reason, words } of CASES) {
  test(`a queued run refused as it starts for ${name} carries end_user_credit and ${reason}: its record, request and run.failed`, async t => {
    const { record, event } = await queuedRefusal(t, setup);
    const result = record.outcome.result;
    assert.ok(result, JSON.stringify(record.outcome));
    assert.deepEqual([record.status, result.code, result.stopped, result.limit, result.reason, result.bucket, result.endUser], ["failed", "end_user_credit", "spend_limit", "end_user", reason, "bot:1", "person"], JSON.stringify(record));
    assert.equal(record.error, result.error, "its words are on the record, for people");
    if (words) assert.match(result.error, words);
    assert.deepEqual([event.data.code, event.data.limit, event.data.reason, event.data.bucket, event.data.endUser], ["end_user_credit", "end_user", reason, "bot:1", "person"], JSON.stringify(event));
    assert.equal(event.data.error, result.error);
  });
}

test("the TypeScript SDK: a queued run refused as it starts is a failed run with code end_user_credit and its reason, not runtime_error", async t => {
  const { endUserCredit } = await import("../clients/typescript.ts");
  const { run } = await queuedRefusal(t, CASES[3].setup, true);
  assert.equal(run.status, "failed");
  assert.deepEqual([run.error.code, run.error.limit, run.error.reason, run.error.bucket, run.error.endUser], ["end_user_credit", "end_user", "bucket_limit", "bot:1", "person"], JSON.stringify(run.error));
  assert.deepEqual(endUserCredit(run), { code: "end_user_credit", reason: "bucket_limit", bucket: "bot:1", endUser: "person", message: run.error.message });
});

test("a queued run refused as it starts for the agent's spend limit carries spend_limit and which limit", async t => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(t, (_body: any, index: number) => ({ content: "ok", ...(index === 0 ? { wait: barrier } : {}), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 } }), AT_COST);
  const { id } = (await r.call("/v1/agents", { body: { spendLimit: { usd: 0.05 } } })).json;
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "one", requestId: "first" } })).status, 202);
  await until(async () => r.model.bodies.length >= 1, "the first call to reach the provider");
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "two", requestId: "second" } })).status, 202);
  release();
  const record = await until(async () => {
    const value = (await r.call(`/v1/agents/${id}/requests/second`)).json;
    return value.state === "completed" && value;
  }, "the second to end", 30_000);
  assert.deepEqual([record.status, record.outcome.result?.code, record.outcome.result?.limit], ["failed", "spend_limit", "agent"], JSON.stringify(record));
});
