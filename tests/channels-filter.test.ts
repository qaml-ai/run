import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels, type ChannelInput, type Inbound } from "../src/channels.ts";
import { Outbound } from "../src/outbound.ts";
import { webhook } from "../src/channels-webhook.ts";
import { Decider, DecisionFailed, type DecisionItem, type DeciderOptions } from "../src/decisions.ts";
import { FILTER_TEXT_CHARS, channelFilter, filterState } from "../src/channel-filter.ts";
import type { Input } from "../src/inputs.ts";
import { AccountDeletions } from "../src/account-deletion.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";
import { free, listen, runtime, until as untilServer, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = "a-plain-shared-secret-0123456789";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async <V>(check: () => V | Promise<V>, what: string): Promise<V> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
};
const FILTER = { instructions: "This email is from a customer who needs a reply", criteria: { true: "A question or a problem", false: "Newsletters, receipts, spam" }, threshold: 0.7 };

type Options = { score?: (item: DecisionItem, signal: AbortSignal) => number | Promise<number>; decider?: Partial<DeciderOptions>; admit?: () => Promise<void>; channel?: Partial<ChannelInput>; inputs?: () => Input[]; createAgent?: () => void };

/** A webhook channel with the real Decider on a provider that answers `score`; prompts are collected. */
async function setup(t: { after(fn: () => void): void }, options: Options = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const asked: { state: any; questions: DecisionItem["questions"]; policy?: unknown }[] = [];
  const prompts: { agent: string; id: string; text: string }[] = [];
  const usage: any[] = [];
  const decider = new Decider({
    provider: {
      id: "openrouter", dataPolicy: true,
      async decide(item, model, _credentials, signal, policy) {
        asked.push({ state: item.state, questions: item.questions, policy });
        return { answers: { passes: { noul: await (options.score ?? (() => 0.9))(item, signal) } }, model, inputTokens: 100, outputTokens: 1, costUsd: 0.00001 };
      },
    },
    key: async () => ({ apiKey: "k", platform: true }),
    limits: { backoffMs: 1 },
    ...options.decider,
  });
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test", retryBaseMs: 10,
    providers: { webhook: webhook({ outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.0/8"] }) }) },
    createAgent: async (_tenant, _params, key) => { options.createAgent?.(); return { id: `client_${sha(key).slice(0, 40)}` }; },
    agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    submit: async (agent, _tenant, request) => {
      prompts.push({ agent, id: request.id, text: (request.params as { text: string }).text });
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
    ...(options.inputs ? { inputs: { pending: async () => options.inputs!(), answer: async () => ({}) } } : {}),
    decisions: { decider, admit: options.admit ?? (async () => {}), record: (_tenant, record) => usage.push(record) },
  });
  t.after(() => channels.stop());
  const channel = await channels.create("default", {
    type: "webhook", credentials: { secret: TOKEN }, settings: { signature: { type: "token", header: "x-token" }, prompt: "{{text}}", sender: "{{from}}", key: "{{thread}}", idPath: "id" }, filter: FILTER, ...options.channel,
  });
  const post = (payload: Record<string, unknown>) => channels.app.request(`/channels/webhook/${channel.id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify({ from: "ada@example.com", thread: "t1", ...payload }) });
  const events = async (query: { limit?: number; outcome?: string; before?: string } = {}) => (await channels.events("default", channel.id, query)).events;
  return { db, accounts, channels, channel, asked, prompts, usage, post, events };
}

const eventOf = async (r: Awaited<ReturnType<typeof setup>>, count = 1) => until(async () => { const list = await r.events(); return list.length >= count && list; }, "the verdict");

test("a filter is checked as it is given, and null removes it", async t => {
  assert.deepEqual(channelFilter({ instructions: "x" }), { instructions: "x", threshold: 0.5 });
  assert.deepEqual(channelFilter({ instructions: "x", criteria: { false: "y" }, threshold: 0 }), { instructions: "x", criteria: { false: "y" }, threshold: 0 });
  assert.throws(() => channelFilter({ instructions: "x", threshold: 1.5 }), /threshold is a probability/);
  assert.throws(() => channelFilter({ instructions: "x", type: "choice" }), /unknown fields: type/);
  assert.throws(() => channelFilter({ instructions: " " }), /filter\.instructions is a non-empty string/);
  assert.throws(() => channelFilter({ instructions: "x", criteria: {} }), /filter\.criteria is/);

  const r = await setup(t);
  assert.deepEqual(r.channel.filter, FILTER);
  assert.deepEqual((await r.channels.get("default", r.channel.id)).filter, FILTER);
  const moved = await r.channels.update("default", r.channel.id, { filter: { instructions: "y" } });
  assert.deepEqual(moved.filter, { instructions: "y", threshold: 0.5 });
  assert.deepEqual((await r.channels.update("default", r.channel.id, { name: "n" })).filter, moved.filter, "another change leaves it");
  assert.equal((await r.channels.update("default", r.channel.id, { filter: null })).filter, undefined);
  await r.post({ id: "after-removal", text: "hello" });
  await until(() => r.prompts.length === 1, "the prompt");
  assert.equal(r.asked.length, 0, "no filter, no question");
});

test("a channel cannot have a filter that could only fail: no key decisions could use", async t => {
  const r = await setup(t, { decider: { key: async () => undefined }, channel: { filter: undefined } });
  await assert.rejects(r.channels.update("default", r.channel.id, { filter: FILTER }), /A filter needs decisions/);
  await assert.rejects(r.channels.create("default", { type: "webhook", credentials: { secret: TOKEN }, filter: FILTER }), /A filter needs decisions/);
});

test("the state is the message as the agent gets it, bounded", () => {
  const long = "x".repeat(FILTER_TEXT_CHARS + 500);
  assert.deepEqual(filterState("email", { sender: { id: "ada@example.com", name: "Ada" }, text: long, title: "Help", unverified: true, files: [{ name: "a.pdf" }] }), {
    channel: "email", from: { id: "ada@example.com", name: "Ada" }, unverified: true, title: "Help", text: long.slice(0, FILTER_TEXT_CHARS), attachments: ["a.pdf"],
  });
});

test("a message at the threshold starts its run; below it none, and it is listed with its score and content", async t => {
  const r = await setup(t, { score: item => (item.state as { text: string }).text.startsWith("newsletter") ? 0.2 : 0.7 });
  await r.post({ id: "m1", text: "my order never came", thread: "t1" });
  await r.post({ id: "m2", text: "newsletter: october deals", thread: "t2" });
  await until(() => r.prompts.length === 1, "the passed message's prompt");
  const list = await eventOf(r, 2) as any[];
  const passed = list.find(event => event.outcome === "passed"), filtered = list.find(event => event.outcome === "filtered");
  assert.deepEqual([passed.reason, passed.score, passed.threshold, passed.message], ["score", 0.7, 0.7, undefined]);
  assert.equal(passed.id, r.prompts[0].id, "the event is its run's id");
  assert.ok(passed.agent);
  assert.deepEqual([filtered.reason, filtered.score, filtered.threshold, filtered.agent], ["score", 0.2, 0.7, undefined]);
  assert.deepEqual(filtered.message, { from: { id: "ada@example.com" }, title: "t2", text: "newsletter: october deals", files: [{ name: "payload.json", size: filtered.message.files[0].size }] });
  assert.ok(filtered.deliverableUntil > Date.now() + 13 * 86_400_000);
  assert.deepEqual(r.asked[0].questions, { passes: { type: "noul", instructions: FILTER.instructions, criteria: FILTER.criteria } });
  assert.deepEqual(r.asked[0].state, { channel: "webhook", from: { id: "ada@example.com" }, title: "t1", text: "my order never came", attachments: ["payload.json"] });
  assert.equal(r.usage.length, 2, "each decision is billed");
  assert.equal(r.usage[0].actor, `channel:${r.channel.id}`);
  assert.deepEqual((await r.events({ outcome: "filtered" })).map(event => event.outcome), ["filtered"]);
  assert.equal((await r.db.query("select count(*)::int as n from channel_conversations")).rows[0].n, 1, "a filtered message makes no agent");
  // No scan picks it up.
  await r.channels.scan();
  assert.equal(r.prompts.length, 1);
});

test("events page newest first", async t => {
  const r = await setup(t, { score: () => 0.1 });
  for (const id of ["a", "b", "c"]) { await r.post({ id, text: id }); await eventOf(r, ["a", "b", "c"].indexOf(id) + 1); }
  const first = await r.channels.events("default", r.channel.id, { limit: 2 });
  assert.deepEqual(first.events.map(event => event.message?.text), ["c", "b"]);
  const second = await r.channels.events("default", r.channel.id, { limit: 2, before: first.next });
  assert.deepEqual(second.events.map(event => event.message?.text), ["a"]);
  assert.equal(second.next, undefined);
  await assert.rejects(r.channels.events("default", r.channel.id, { before: "nonsense" }), /before is the next value/);
  await assert.rejects(r.channels.events("other", r.channel.id), /Unknown channel/);
});

test("delivering a filtered message starts its run once, without asking again", async t => {
  const r = await setup(t, { score: () => 0.1 });
  await r.post({ id: "m1", text: "actually important" });
  const [event] = await eventOf(r) as any[];
  assert.equal(r.prompts.length, 0);
  await assert.rejects(r.channels.deliverEvent("other", r.channel.id, event.id), /Unknown channel/);
  await assert.rejects(r.channels.deliverEvent("default", r.channel.id, "in_nope"), /Unknown event/);
  const delivered = await r.channels.deliverEvent("default", r.channel.id, event.id);
  assert.equal(delivered.id, event.id);
  await until(() => r.prompts.length === 1, "the delivered prompt");
  assert.deepEqual(r.prompts[0].id, event.id);
  assert.match(r.prompts[0].text, /^actually important/);
  // Again: the same answer, nothing more.
  assert.deepEqual(await r.channels.deliverEvent("default", r.channel.id, event.id), delivered);
  await r.channels.scan(Date.now() + 1000);
  assert.equal(r.asked.length, 1);
  assert.equal(r.usage.length, 1);
  assert.equal(r.prompts.filter(prompt => prompt.id === event.id).length, 1);
  const [after] = await r.events() as any[];
  assert.deepEqual([after.outcome, after.deliveredAt, after.message, !!after.agent], ["filtered", delivered.deliveredAt, undefined, true]);
});

test("delivering is not held to the sender's rate limit", async t => {
  const r = await setup(t, { score: () => 0.1, channel: { limits: { perSenderPerMinute: 1 } } });
  await r.post({ id: "m1", text: "one" });
  const [event] = await eventOf(r) as any[];
  await r.channels.deliverEvent("default", r.channel.id, event.id);
  await until(() => r.prompts.length === 1, "the delivered prompt");
});

test("a passed event cannot be delivered, and a filtered one expires with its content; its record stays longer than dedup", async t => {
  const r = await setup(t, { score: item => (item.state as { text: string }).text === "keep" ? 0.9 : 0.1 });
  await r.post({ id: "m1", text: "keep" });
  await until(() => r.prompts.length === 1, "the prompt");
  const [passed] = await eventOf(r) as any[];
  await assert.rejects(r.channels.deliverEvent("default", r.channel.id, passed.id), /passed the filter/);

  await r.post({ id: "m2", text: "drop" });
  const list = await eventOf(r, 2) as any[];
  const filtered = list.find(event => event.outcome === "filtered");
  await r.db.query("update channel_items set due = 1 where id = $1", [filtered.id]);
  await r.channels.scan();
  assert.equal((await r.db.query("select count(*)::int as n from channel_items where id = $1", [filtered.id])).rows[0].n, 0);
  const [gone] = (await r.events({ outcome: "filtered" })) as any[];
  assert.deepEqual([gone.id, gone.score, gone.message, gone.deliverableUntil], [filtered.id, 0.1, undefined, undefined]);
  await assert.rejects(r.channels.deliverEvent("default", r.channel.id, filtered.id), /time to be delivered is up/);
  assert.equal(r.prompts.length, 1);

  // Prune: dedup markers at 7 days, verdicts at 14.
  await r.db.query("insert into channel_seen (channel, message, seen_at) values ($1, 'old-plain', now() - interval '8 days')", [r.channel.id]);
  await r.db.query("update channel_seen set seen_at = now() - interval '8 days' where verdict->>'item' = $1", [filtered.id]);
  await r.db.query("update channel_seen set seen_at = now() - interval '15 days' where verdict->>'item' = $1", [passed.id]);
  (r.channels as any).prunedAt = 0;
  await r.channels.scan();
  assert.deepEqual((await r.events()).map(event => event.id), [filtered.id]);
  assert.equal((await r.db.query("select count(*)::int as n from channel_seen where message = 'old-plain'")).rows[0].n, 0);
});

test("when the decision fails the message goes on, and the failure is on record without its content", async t => {
  const logs: string[] = [];
  const { log, error } = console;
  console.log = (line: unknown) => { logs.push(String(line)); };
  console.error = (line: unknown) => { logs.push(String(line)); };
  t.after(() => { console.log = log; console.error = error; });

  const failing = await setup(t, { score: () => { throw new DecisionFailed(502, "OpenRouter failed the decision (HTTP 500: secret-body-text)", { transient: true }); } });
  await failing.post({ id: "m1", text: "secret-body-text" });
  await until(() => failing.prompts.length === 1, "the prompt");
  assert.equal(failing.asked.length, 3, "the usual retries, then on");
  const [event] = await eventOf(failing) as any[];
  assert.deepEqual([event.outcome, event.reason, event.error, event.score], ["passed", "decision_failed", { status: 502, code: "DECISION_FAILED" }, undefined]);
  assert.equal(failing.usage.length, 0, "nothing answered, nothing billed");

  const slow = await setup(t, { score: (_item, signal) => new Promise<number>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))), decider: { limits: { requestTimeoutMs: 50, attempts: 1 } } });
  await slow.post({ id: "m2", text: "secret-body-text" });
  await until(() => slow.prompts.length === 1, "the prompt after the timeout");
  assert.deepEqual(((await eventOf(slow)) as any[])[0].error, { status: 504 });

  const refused = await setup(t, { admit: async () => { throw Object.assign(new Error("spent"), { status: 402, code: "SPEND_LIMIT" }); } });
  await refused.post({ id: "m3", text: "secret-body-text" });
  await until(() => refused.prompts.length === 1, "the prompt when refused");
  assert.deepEqual(((await eventOf(refused)) as any[])[0].error, { status: 402, code: "SPEND_LIMIT" });

  assert.ok(logs.some(line => line.includes('"type":"channel_filter"') && line.includes('"reason":"decision_failed"')));
  assert.ok(!logs.some(line => line.includes("secret-body-text")), "no content in the logs");
});

test("a provider's retry decides nothing more, charges nothing more and starts nothing more", async t => {
  const r = await setup(t, { score: item => (item.state as { text: string }).text === "pass" ? 0.9 : 0.1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await r.post({ id: "m1", text: "pass" })).status, 200);
    assert.equal((await r.post({ id: "m2", text: "drop" })).status, 200);
  }
  await until(() => r.prompts.length === 1, "the prompt");
  await eventOf(r, 2);
  await r.channels.scan(Date.now() + 1000);
  assert.equal(r.asked.length, 2);
  assert.equal(r.usage.length, 2);
  assert.equal(r.prompts.length, 1);
  assert.equal((await r.events()).length, 2);
});

test("an item retried after its verdict does not ask again", async t => {
  let breaks = 1;
  const r = await setup(t, { createAgent: () => { if (breaks-- > 0) throw new Error("not yet"); } });
  await r.post({ id: "m1", text: "hello" });
  await eventOf(r);
  await until(async () => { await r.channels.scan(Date.now() + 60_000); return r.prompts.length === 1; }, "the retried prompt");
  assert.equal(r.asked.length, 1);
  assert.equal(r.usage.length, 1);
});

test("what no filter stands in front of: no text, an answer to a waiting input, a follow-up in a thread with an agent", async t => {
  const input = { id: "inp_1", kind: "approval", requestId: "r", message: "", detail: { tool: "x", source: "y" } } as unknown as Input;
  let waiting: Input[] = [];
  const r = await setup(t, { score: () => 0.1, inputs: () => waiting });
  const inbound = (messageId: string, text: string, extra: Partial<Inbound> = {}): Inbound => ({ conversationId: "t1", messageId, sender: { id: "ada" }, text, files: [], ...extra });
  await r.channels.inbound(r.channel.id, inbound("first", "", { files: [{ id: "f", name: "a.png", content: "" }] }));
  await until(() => r.prompts.length === 1, "the message with no text");
  assert.deepEqual((await eventOf(r) as any[])[0].reason, "no_text");

  waiting = [input];
  await r.channels.inbound(r.channel.id, inbound("answer", "approve"));
  await eventOf(r, 2);
  assert.equal((await r.events())[0].reason, "answers_input");
  waiting = [];

  await r.channels.inbound(r.channel.id, inbound("reply", "yes please", { followUp: true }));
  await until(() => r.prompts.length === 2, "the follow-up");
  assert.equal((await r.events())[0].reason, "follow_up");
  assert.equal(r.asked.length, 0);

  // Alone, each of these is asked about: a follow-up in a thread nobody answered, and any other message.
  await r.channels.inbound(r.channel.id, inbound("reply-2", "new", { conversationId: "t2", followUp: true }));
  await r.channels.inbound(r.channel.id, inbound("plain", "another message"));
  await until(() => r.asked.length === 2, "the questions");
  await eventOf(r, 5);
  assert.deepEqual((await r.events()).slice(0, 2).map(event => event.outcome), ["filtered", "filtered"]);
  assert.equal(r.prompts.length, 2);
});

test("a definition's dataCollection deny goes with the question", async t => {
  const r = await setup(t, { channel: { filter: undefined } });
  const definition = await new Definitions({ db: r.db }).create("default", { name: "d", dataCollection: "deny" } as never);
  await r.channels.update("default", r.channel.id, { definition: definition.id, filter: FILTER });
  await r.post({ id: "m1", text: "hello" });
  await until(() => r.asked.length === 1, "the question");
  assert.deepEqual(r.asked[0].policy, { dataCollection: "deny" });
});

test("deleting a channel removes its filtered messages and verdicts", async t => {
  const r = await setup(t, { score: () => 0.1 });
  await r.post({ id: "m1", text: "hello" });
  await eventOf(r);
  await r.channels.remove("default", r.channel.id);
  assert.equal((await r.db.query("select count(*)::int as n from channel_items")).rows[0].n, 0);
  assert.equal((await r.db.query("select count(*)::int as n from channel_seen")).rows[0].n, 0);
});

test("deleting a channel is all or nothing, so a retry finds what is left", async t => {
  const r = await setup(t, { score: () => 0.1 });
  await r.post({ id: "m1", text: "hello" });
  await eventOf(r);
  await r.db.query("alter table email_messages rename to email_messages_away");
  await assert.rejects(r.channels.remove("default", r.channel.id));
  await r.db.query("alter table email_messages_away rename to email_messages");
  assert.equal((await r.events()).length, 1, "the channel, its verdict and its message are all still there");
  assert.equal((await r.db.query("select count(*)::int as n from channel_items")).rows[0].n, 1);
  await r.channels.remove("default", r.channel.id);
  assert.equal((await r.db.query("select count(*)::int as n from channel_items")).rows[0].n, 0);
});

test("deleting an account deletes its filtered messages and their verdicts", async t => {
  const r = await setup(t, { score: () => 0.1 });
  await r.db.query("insert into tenants (id, created_at) values ('default', 1) on conflict do nothing");
  await r.post({ id: "m1", text: "a customer's words" });
  await eventOf(r);
  assert.equal((await r.db.query("select count(*)::int as n from channel_items where item->>'state' = 'filtered'")).rows[0].n, 1);
  const deletions = new AccountDeletions({ db: r.db, accounts: r.accounts, storage: memoryStorage(postgresTail(r.db)), channels: r.channels, deleteAgent: async () => {} });
  await deletions.request("default", "self");
  await until(async () => (await deletions.status("default"))?.state === "deleted" || (await deletions.next(), false), "the deletion");
  for (const table of ["channels", "channel_items", "channel_seen"]) assert.equal((await r.db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
});

// The real server: routes, billing and the decisions wire format, on a stand-in for OpenRouter.

const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";

test("over the API: an event is judged on the wire, billed like a decision, listed and delivered; the logs hold no content", async (t: T) => {
  const requests: any[] = [];
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ ...body, key: req.headers.authorization });
    const noul = body.state.text.includes("newsletter") ? 0.05 : 0.95;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers: { passes: { type: "noul", noul } }, usage: { input_tokens: 400, output_tokens: 1, cost: 0.01 } }));
  });
  const r = await runtime(t, free(() => ({ role: "assistant", content: "On it." })), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_DECISIONS_URL: base,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1",
  }, {
    tenants: {
      payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
      own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "own-openrouter-key" }, platformKeys: false },
      ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
    },
    platformKeys: { openrouter: "fixture-platform-model-key" },
  });
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const fields = { type: "webhook", credentials: { secret: TOKEN }, settings: { signature: { type: "token", header: "x-token" }, prompt: "{{text}}", key: "{{thread}}", idPath: "id" }, filter: FILTER };
  const bad = await r.call("/v1/channels", { body: { ...fields, filter: { instructions: "x", threshold: 2 } }, token: PAYG });
  assert.equal(bad.status, 400, bad.text);
  const created = await r.call("/v1/channels", { body: fields, token: PAYG });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.filter, FILTER);
  const id = created.json.id;
  const post = (body: object) => fetch(`${r.base}/channels/webhook/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify(body) });

  assert.equal((await post({ id: "a", thread: "t1", text: "newsletter secret-body-text" })).status, 200);
  const held = await untilServer(async () => { const page = await r.call(`/v1/channels/${id}/events`, { token: PAYG }); return page.json.events?.length === 1 && page.json.events[0]; }, "the filtered event");
  assert.deepEqual([held.outcome, held.score, held.threshold, held.reason, held.model, held.message.text], ["filtered", 0.05, 0.7, "score", "typesafe/jev-1.14-20261014", "newsletter secret-body-text"]);
  assert.equal(requests[0].key, "Bearer fixture-platform-model-key");
  assert.equal(requests[0].model, "typesafe/jev-1.14");
  assert.deepEqual(requests[0].questions.passes.criteria, FILTER.criteria);
  assert.equal(((await r.call("/v1/agents", { token: PAYG })).json as unknown[]).length, 0, "no agent for it");

  await untilServer(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 990_000, "the decision's charge");
  assert.equal((await r.call(`/v1/channels/${id}/events`, { token: OWN })).status, 404, "another tenant's channel");
  assert.equal((await r.call(`/v1/channels/${id}/events?limit=9999`, { token: PAYG })).status, 400);

  const delivered = await r.call(`/v1/channels/${id}/events/${held.id}/deliver`, { method: "POST", token: PAYG });
  assert.equal(delivered.status, 200, delivered.text);
  const agents = await untilServer(async () => { const list = (await r.call("/v1/agents", { token: PAYG })).json; return list.length === 1 && list; }, "the agent");
  await untilServer(async () => {
    const page = await r.call(`/v1/agents/${agents[0].id}/requests/${held.id}`, { token: PAYG });
    return page.status === 200 && page.json.state === "completed";
  }, "the delivered run");

  // A customer's own key pays for its own filter.
  const own = await r.call("/v1/channels", { body: fields, token: OWN });
  assert.equal(own.status, 201, own.text);
  await fetch(`${r.base}/channels/webhook/${own.json.id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify({ id: "b", thread: "t", text: "where is my order" }) });
  await untilServer(() => requests.length === 2, "its question");
  assert.equal(requests[1].key, "Bearer own-openrouter-key");

  assert.ok(r.logs.some(line => line.includes('"type":"channel_filter"')));
  assert.ok(!r.logs.some(line => line.includes("secret-body-text")), "no content in the logs");
});
