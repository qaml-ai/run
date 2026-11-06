import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { FILTER_TEXT_CHARS, channelFilter, filterState } from "../../../src/core/channels/filter.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { contractTest, free, listen, lastUser, OPERATOR, sleep, toolCall, toolResults, until, type T } from "../support.ts";
import { asked as agentAsked, fakeSlack, slackChannels, type FakeSlack } from "../channel-service-fakes.ts";

/**
 * Channel filters on either backend. A stand-in for OpenRouter's decisions API answers the filter's question
 * (AGENT_DECISIONS_URL); the fixture's model plays the agent. Webhook channels are the vehicle unless a case needs a
 * channel type with threads and files (Slack).
 */

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = "a-plain-shared-secret-0123456789";
const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";
const KEYLESS = "keyless-operator-token-at-least-24-chars";
const BROKE = "broke-operator-token-at-least-24-chars";
const FILTER = { instructions: "This email is from a customer who needs a reply", criteria: { true: "A question or a problem", false: "Newsletters, receipts, spam" }, threshold: 0.7 };

const tenantsFile = {
  tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    // Prepaid with no credit: the platform's key cannot be used, so a decision is refused for lack of it.
    broke: { tokenSha256: sha(BROKE), apiKeys: {}, billing: "prepaid" },
    own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "own-openrouter-key" }, platformKeys: false },
    // Keys of its own for another provider only, and none of the platform's: no OpenRouter key decisions could use.
    keyless: { tokenSha256: sha(KEYLESS), apiKeys: { anthropic: "keyless-anthropic-key" }, platformKeys: false },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-model-key" },
};

type Score = (state: any, signal: AbortSignal) => number | Promise<number>;
type Asked = { key: string; model: string; state: any; questions: any; provider?: unknown };

/** A stand-in for OpenRouter's decisions API that answers `passes` with `score`; a score that throws is an HTTP 500. */
async function fakeDecisions(t: T, initial: Score, cost: number) {
  const asked: Asked[] = [];
  const state = { score: initial };
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    asked.push({ key: String(req.headers.authorization), model: body.model, state: body.state, questions: body.questions, ...(body.provider ? { provider: body.provider } : {}) });
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    try {
      const noul = await state.score(body.state, gone.signal);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers: { passes: { type: "noul", noul } }, usage: { input_tokens: 100, output_tokens: 1, cost } }));
    } catch (error) {
      if (!gone.signal.aborted) res.writeHead(500, { "Content-Type": "text/plain" }).end((error as Error).message);
    }
  });
  return { base, asked, state };
}

const never = (signal: AbortSignal) => new Promise<number>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const text = (state: any) => String(state.text);

type Webhooks = { url: string; deliveries: any[] };
type R = ContractFixture & {
  asked: Asked[]; decisions: { score: Score }; hooks: Webhooks;
  /** A webhook channel with the filter, made as `token`'s tenant; its deliveries are `post`ed. */
  channel(fields?: object, token?: string): Promise<any>;
  post(channel: { id: string }, payload: Record<string, unknown>): Promise<Response>;
  events(channel: { id: string }, query?: string, token?: string): Promise<{ events: any[]; next?: string }>;
  settled(channel: { id: string }, count?: number, token?: string): Promise<any[]>;
  /** What each decision was billed as: the usage events the platform sent. */
  decisionUsage(): any[];
  turns(): number;
};

/** A channel case with the decisions stand-in, a usage-event receiver, and PAYG funded; `score` answers the question about each message. */
function filterTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions & { score?: Score; cost?: number; timeout?: number } = {}) {
  let decisions: Awaited<ReturnType<typeof fakeDecisions>>;
  const deliveries: any[] = [];
  let hooks: string;
  contractTest("channels", source, name, async (t, fixture) => {
    assert.equal((await fixture.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
    assert.equal((await fixture.call("/v1/webhooks", { body: { url: hooks + "/usage", events: ["usage.recorded"] }, token: PAYG })).status, 201);
    const channel: R["channel"] = async (fields = {}, token = PAYG) => {
      const created = await fixture.call("/v1/channels", { body: { type: "webhook", credentials: { secret: TOKEN }, settings: { signature: { type: "token", header: "x-token" }, prompt: "{{text}}", sender: "{{from}}", key: "{{thread}}", idPath: "id" }, filter: FILTER, ...fields }, token });
      assert.equal(created.status, 201, created.text);
      return created.json;
    };
    const post: R["post"] = (target, payload) => fetch(`${fixture.base}/channels/webhook/${target.id}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify({ from: "ada@example.com", thread: "t1", ...payload }),
    });
    const events: R["events"] = async (target, query = "", token = PAYG) => {
      const page = await fixture.call(`/v1/channels/${target.id}/events${query}`, { token });
      assert.equal(page.status, 200, page.text);
      return page.json;
    };
    const settled: R["settled"] = (target, count = 1, token = PAYG) => until(async () => { const list = (await events(target, "", token)).events; return list.length >= count && list; }, "the verdict");
    const r = Object.assign(fixture, {
      asked: decisions.asked, decisions: decisions.state, hooks: { url: hooks, deliveries }, channel, post, events, settled,
      decisionUsage: () => deliveries.filter(event => event.data?.kind === "decision"),
      turns: () => fixture.model.bodies.length,
    });
    await body(t, r);
  }, {
    respond: free(() => ({ role: "assistant", content: "On it." })), tenants: tenantsFile, ...options,
    env: {
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
      AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1", AGENT_CHANNEL_RETRY_MS: "100", ...options.env,
    },
    prepare: async t => {
      decisions = await fakeDecisions(t, options.score ?? (() => 0.9), options.cost ?? 0.00001);
      hooks = await listen(t, async (req, res) => { let body = ""; for await (const chunk of req) body += chunk; deliveries.push(JSON.parse(body)); res.writeHead(204).end(); });
      return { AGENT_DECISIONS_URL: decisions.base, ...await options.prepare?.(t) };
    },
  });
}

filterTest("tests/channels-filter.test.ts:77", "a filter is checked as it is given, and null removes it", async (_t, r) => {
  // The checks are shared by both backends' channels.
  assert.deepEqual(channelFilter({ instructions: "x" }), { instructions: "x", threshold: 0.5 });
  assert.deepEqual(channelFilter({ instructions: "x", criteria: { false: "y" }, threshold: 0 }), { instructions: "x", criteria: { false: "y" }, threshold: 0 });
  assert.throws(() => channelFilter({ instructions: "x", threshold: 1.5 }), /threshold is a probability/);
  assert.throws(() => channelFilter({ instructions: "x", type: "choice" }), /unknown fields: type/);
  assert.throws(() => channelFilter({ instructions: " " }), /filter\.instructions is a non-empty string/);
  assert.throws(() => channelFilter({ instructions: "x", criteria: {} }), /filter\.criteria is/);

  const channel = await r.channel();
  assert.deepEqual(channel.filter, FILTER);
  assert.deepEqual((await r.call(`/v1/channels/${channel.id}`, { token: PAYG })).json.filter, FILTER);
  const update = (body: object) => r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body, token: PAYG });
  const moved = (await update({ filter: { instructions: "y" } })).json;
  assert.deepEqual(moved.filter, { instructions: "y", threshold: 0.5 });
  assert.deepEqual((await update({ name: "n" })).json.filter, moved.filter, "another change leaves it");
  assert.equal((await update({ filter: null })).json.filter, undefined);
  await r.post(channel, { id: "after-removal", text: "hello" });
  await until(() => r.turns() === 1, "the prompt");
  assert.equal(r.asked.length, 0, "no filter, no question");
});

filterTest("tests/channels-filter.test.ts:97", "a channel cannot have a filter that could only fail: no key decisions could use", async (_t, r) => {
  const channel = await r.channel({ filter: undefined }, KEYLESS);
  const update = await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { filter: FILTER }, token: KEYLESS });
  assert.equal(update.status, 400);
  assert.match(update.json.error, /A filter needs decisions/);
  const created = await r.call("/v1/channels", { body: { type: "webhook", credentials: { secret: TOKEN }, filter: FILTER }, token: KEYLESS });
  assert.equal(created.status, 400);
  assert.match(created.json.error, /A filter needs decisions/);
});

contractTest("channels", "tests/channels-filter.test.ts:103", "the state is the message as the agent gets it, bounded", (_t) => {
  const long = "x".repeat(FILTER_TEXT_CHARS + 500);
  assert.deepEqual(filterState("email", { sender: { id: "ada@example.com", name: "Ada" }, text: long, title: "Help", unverified: true, files: [{ name: "a.pdf" }] }), {
    channel: "email", from: { id: "ada@example.com", name: "Ada" }, unverified: true, title: "Help", text: long.slice(0, FILTER_TEXT_CHARS), attachments: ["a.pdf"],
  });
});

filterTest("tests/channels-filter.test.ts:110", "a message at the threshold starts its run; below it none, and it is listed with its score and content", async (_t, r) => {
  const channel = await r.channel();
  await r.post(channel, { id: "m1", text: "my order never came", thread: "t1" });
  await r.post(channel, { id: "m2", text: "newsletter: october deals", thread: "t2" });
  await until(() => r.turns() === 1, "the passed message's prompt");
  const list = await r.settled(channel, 2);
  const passed = list.find(event => event.outcome === "passed"), filtered = list.find(event => event.outcome === "filtered");
  assert.deepEqual([passed.reason, passed.score, passed.threshold, passed.message], ["score", 0.7, 0.7, undefined]);
  // The event is its run's id.
  assert.equal((await r.call(`/v1/agents/${passed.agent}/requests/${passed.id}`, { token: PAYG })).status, 200);
  assert.ok(passed.agent);
  assert.deepEqual([filtered.reason, filtered.score, filtered.threshold, filtered.agent], ["score", 0.2, 0.7, undefined]);
  assert.deepEqual(filtered.message, { from: { id: "ada@example.com" }, title: "t2", text: "newsletter: october deals", files: [{ name: "payload.json", size: filtered.message.files[0].size }] });
  assert.ok(filtered.deliverableUntil > Date.now() + 13 * 86_400_000);
  const first = r.asked.find(entry => text(entry.state) === "my order never came")!;
  assert.deepEqual(first.questions, { passes: { type: "noul", instructions: FILTER.instructions, criteria: FILTER.criteria } });
  assert.deepEqual(first.state, { channel: "webhook", from: { id: "ada@example.com" }, title: "t1", text: "my order never came", attachments: ["payload.json"] });
  // Each decision is billed (as a usage event of the channel's actor).
  await until(() => r.decisionUsage().length === 2, "the decisions' usage");
  assert.equal(r.decisionUsage()[0].data.actor, `channel:${channel.id}`);
  assert.deepEqual((await r.events(channel, "?outcome=filtered")).events.map(event => event.outcome), ["filtered"]);
  assert.equal(Number((await r.channelQuery("select count(*) as n from channel_conversations")).rows[0].n), 1, "a filtered message makes no agent");
  // Nothing picks it up later.
  await sleep(1000);
  assert.equal(r.turns(), 1);
}, { score: state => text(state).startsWith("newsletter") ? 0.2 : 0.7 });

filterTest("tests/channels-filter.test.ts:134", "events page newest first", async (_t, r) => {
  const channel = await r.channel();
  for (const [index, id] of ["a", "b", "c"].entries()) { await r.post(channel, { id, text: id }); await r.settled(channel, index + 1); }
  const first = await r.events(channel, "?limit=2");
  assert.deepEqual(first.events.map(event => event.message?.text), ["c", "b"]);
  const second = await r.events(channel, `?limit=2&before=${encodeURIComponent(first.next!)}`);
  assert.deepEqual(second.events.map(event => event.message?.text), ["a"]);
  assert.equal(second.next, undefined);
  const nonsense = await r.call(`/v1/channels/${channel.id}/events?before=nonsense`, { token: PAYG });
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.json.error, /before is the next value/);
  const other = await r.call(`/v1/channels/${channel.id}/events`, { token: OWN });
  assert.equal(other.status, 404);
  assert.match(other.json.error, /Unknown channel/);
}, { score: () => 0.1 });

filterTest("tests/channels-filter.test.ts:146", "delivering a filtered message starts its run once, without asking again", async (_t, r) => {
  const channel = await r.channel();
  await r.post(channel, { id: "m1", text: "actually important" });
  const [event] = await r.settled(channel);
  assert.equal(r.turns(), 0);
  const deliver = (id: string, token = PAYG) => r.call(`/v1/channels/${channel.id}/events/${id}/deliver`, { method: "POST", token });
  const other = await deliver(event.id, OWN);
  assert.equal(other.status, 404);
  assert.match(other.json.error, /Unknown channel/);
  const unknown = await deliver("in_nope");
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /Unknown event/);
  const delivered = await deliver(event.id);
  assert.equal(delivered.status, 200, delivered.text);
  assert.equal(delivered.json.id, event.id);
  await until(() => r.turns() === 1, "the delivered prompt");
  const agent = (await r.call("/v1/agents", { token: PAYG })).json[0].id;
  assert.equal((await r.call(`/v1/agents/${agent}/requests/${event.id}`, { token: PAYG })).status, 200);
  assert.match(agentAsked(r.model.bodies[0]).text, /^actually important/);
  // Again: the same answer, nothing more.
  assert.deepEqual((await deliver(event.id)).json, delivered.json);
  await sleep(1000);
  assert.equal(r.asked.length, 1);
  await until(() => r.decisionUsage().length === 1, "the decision's usage");
  assert.equal(r.decisionUsage().length, 1);
  assert.equal(r.turns(), 1);
  const [after] = (await r.events(channel)).events;
  assert.deepEqual([after.outcome, after.deliveredAt, after.message, !!after.agent], ["filtered", delivered.json.deliveredAt, undefined, true]);
}, { score: () => 0.1 });

filterTest("tests/channels-filter.test.ts:168", "delivering is not held to the sender's rate limit", async (_t, r) => {
  const channel = await r.channel({ limits: { perSenderPerMinute: 1 } });
  await r.post(channel, { id: "m1", text: "one" });
  const [event] = await r.settled(channel);
  assert.equal((await r.call(`/v1/channels/${channel.id}/events/${event.id}/deliver`, { method: "POST", token: PAYG })).status, 200);
  await until(() => r.turns() === 1, "the delivered prompt");
}, { score: () => 0.1 });

/** The fault the original cases injected into the host, made through the channel tables: new conversations cannot be recorded until `heal`. */
const faulty = (r: R) => ({
  break: () => r.channelQuery("alter table channel_conversations add constraint conversations_fail check (false) not valid"),
  heal: () => r.channelQuery("alter table channel_conversations drop constraint conversations_fail"),
});
const count = async (r: R, table: string, where = "") => Number((await r.channelQuery(`select count(*) as n from ${table} ${where}`)).rows[0].n);

filterTest("tests/channels-filter.test.ts:176", "a passed event cannot be delivered, and a filtered one expires with its content; its record stays longer than dedup", async (_t, r) => {
  const channel = await r.channel();
  const deliver = (id: string) => r.call(`/v1/channels/${channel.id}/events/${id}/deliver`, { method: "POST", token: PAYG });
  await r.post(channel, { id: "m1", text: "keep" });
  await until(() => r.turns() === 1, "the prompt");
  const [passed] = await r.settled(channel);
  const refused = await deliver(passed.id);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /passed the filter/);

  await r.post(channel, { id: "m2", text: "drop" });
  const list = await r.settled(channel, 2);
  const filtered = list.find(event => event.outcome === "filtered");
  await r.channelQuery("update channel_items set due = 1 where id = $1", [filtered.id]);
  // Prune: dedup markers at 7 days, verdicts at 14.
  await r.channelQuery("insert into channel_seen (channel, message, seen_at) values ($1, 'old-plain', now() - interval '8 days')", [channel.id]);
  await r.channelQuery("update channel_seen set seen_at = now() - interval '8 days' where verdict->>'item' = $1", [filtered.id]);
  await r.channelQuery("update channel_seen set seen_at = now() - interval '15 days' where verdict->>'item' = $1", [passed.id]);
  // The backend scans for due work and prunes when it starts (and, on Workers, when a retry wakes it): start it again, and give it a retry to wake on.
  await r.restart();
  const fault = faulty(r);
  await fault.break();
  const waking = await r.channel({ filter: undefined, settings: { signature: { type: "token", header: "x-token" }, prompt: "{{text}}", key: "{{thread}}", idPath: "id" } });
  await r.post(waking, { id: "w1", text: "wake the scan", thread: "waking" });
  await until(async () => await count(r, "channel_items", `where id = '${filtered.id}'`) === 0, "the expired message to go", 30_000);
  await fault.heal();
  const [gone] = (await r.events(channel, "?outcome=filtered")).events;
  assert.deepEqual([gone.id, gone.score, gone.message, gone.deliverableUntil], [filtered.id, 0.1, undefined, undefined]);
  const late = await deliver(filtered.id);
  assert.equal(late.status, 409);
  assert.match(late.json.error, /time to be delivered is up/);
  assert.equal(r.turns(), 1);

  await until(async () => (await r.events(channel)).events.length === 1, "the old verdict to be pruned", 30_000);
  assert.deepEqual((await r.events(channel)).events.map(event => event.id), [filtered.id]);
  assert.equal(await count(r, "channel_seen", "where message = 'old-plain'"), 0);
}, { score: state => text(state) === "keep" ? 0.9 : 0.1, timeout: 120_000 });

filterTest("tests/channels-filter.test.ts:204", "when the decision fails the message goes on, and the failure is on record without its content", async (_t, r) => {
  // One provider that fails, one that never answers, one a tenant cannot pay for.
  r.decisions.score = (state, signal) => {
    if (text(state).startsWith("fail")) throw new Error("OpenRouter failed the decision (HTTP 500: secret-body-text)");
    if (text(state).startsWith("hang")) return never(signal);
    return 0.9;
  };
  const failing = await r.channel();
  await r.post(failing, { id: "m1", text: "fail secret-body-text" });
  await until(() => r.turns() === 1, "the prompt");
  assert.equal(r.asked.length, 3, "the usual retries, then on");
  const [event] = await r.settled(failing);
  assert.deepEqual([event.outcome, event.reason, event.error, event.score], ["passed", "decision_failed", { status: 502, code: "DECISION_FAILED" }, undefined]);
  await sleep(500);
  assert.equal(r.decisionUsage().length, 0, "nothing answered, nothing billed");

  const slow = await r.channel({}, PAYG);
  await r.post(slow, { id: "m2", text: "hang secret-body-text", thread: "t2" });
  await until(() => r.turns() === 2, "the prompt after the timeout", 40_000);
  assert.deepEqual((await r.settled(slow))[0].error, { status: 504 });

  const refused = await r.channel({}, BROKE);
  await r.post(refused, { id: "m3", text: "plain secret-body-text" });
  // It goes on all the same (this tenant has no credit to run it with, so no turn follows).
  const [refusal] = await r.settled(refused, 1, BROKE);
  assert.deepEqual([refusal.outcome, refusal.reason, refusal.error], ["passed", "decision_failed", { status: 402, code: "INSUFFICIENT_CREDIT" }]);

  assert.ok(r.logs.some(line => line.includes('"type":"channel_filter"') && line.includes('"reason":"decision_failed"')));
  assert.ok(!r.logs.some(line => line.includes("secret-body-text")), "no content in the logs");
}, { timeout: 120_000 });

filterTest("tests/channels-filter.test.ts:233", "a provider's retry decides nothing more, charges nothing more and starts nothing more", async (_t, r) => {
  const channel = await r.channel();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await r.post(channel, { id: "m1", text: "pass" })).status, 200);
    assert.equal((await r.post(channel, { id: "m2", text: "drop" })).status, 200);
  }
  await until(() => r.turns() === 1, "the prompt");
  await r.settled(channel, 2);
  await sleep(1000);
  assert.equal(r.asked.length, 2);
  await until(() => r.decisionUsage().length === 2, "the decisions' usage");
  assert.equal(r.decisionUsage().length, 2);
  assert.equal(r.turns(), 1);
  assert.equal((await r.events(channel)).events.length, 2);
}, { score: state => text(state) === "pass" ? 0.9 : 0.1 });

filterTest("tests/channels-filter.test.ts:248", "an item retried after its verdict does not ask again", async (_t, r) => {
  const fault = faulty(r);
  await fault.break();
  const channel = await r.channel();
  await r.post(channel, { id: "m1", text: "hello" });
  await r.settled(channel);
  await sleep(500);
  assert.equal(r.turns(), 0, "the agent could not be started yet");
  await fault.heal();
  await until(() => r.turns() === 1, "the retried prompt", 30_000);
  assert.equal(r.asked.length, 1);
  await until(() => r.decisionUsage().length === 1, "the decision's usage");
  assert.equal(r.decisionUsage().length, 1);
}, { timeout: 60_000 });

let slack: FakeSlack;
const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }], allowOther: true }] };
filterTest("tests/channels-filter.test.ts:258", "what no filter stands in front of: no text, an answer to a waiting input, a follow-up in a thread with an agent", async (_t, r) => {
  // Slack stands in for the channel with threads and files; the agent asks a question when it gets the file.
  r.setModel(free(body => !/pass: start|yes please/.test(lastUser(body)) && toolResults(body).length === 0 ? toolCall("ask_user", ASK, "call_ask") : { role: "assistant", content: "On it." }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] }, token: PAYG })).json;
  const api = slackChannels({ call: (path, init) => r.call(path, { ...init, token: PAYG }), base: r.base });
  const channel = await api.createChannel({ access: { public: true }, definition: definition.id, filter: FILTER });
  const reasons = async () => (await r.events(channel)).events.map(event => event.reason);
  const send = (fields: Record<string, unknown>) => api.event(channel, { user: "U_ADA", ...fields });

  // A thread the agent is in: it passed the filter once.
  r.decisions.score = state => text(state).startsWith("pass") ? 0.9 : 0.1;
  await send({ type: "app_mention", channel: "C1", ts: "100.1", text: "<@UBOT> pass: start" });
  await until(() => r.turns() === 1, "the first prompt");
  assert.equal(r.asked.length, 1);

  await send({ type: "message", channel_type: "im", channel: "D1", ts: "200.1", subtype: "file_share", text: "", files: [{ url_private_download: `${slack.url}/files/a.png`, name: "a.png" }] });
  await until(() => r.turns() === 2, "the message with no text");
  assert.deepEqual((await reasons())[0], "no_text");
  // The agent's question is waiting for an answer.
  await until(async () => {
    for (const agent of (await r.call("/v1/agents", { token: PAYG })).json as { id: string }[]) if (((await r.call(`/v1/agents/${agent.id}/inputs?state=pending`, { token: PAYG })).json as unknown[]).length) return true;
    return false;
  }, "the pending question");

  await send({ type: "message", channel_type: "im", channel: "D1", ts: "200.2", text: "EU" });
  await r.settled(channel, 3);
  assert.equal((await reasons())[0], "answers_input");

  await send({ type: "message", channel_type: "channel", channel: "C1", thread_ts: "100.1", ts: "100.2", text: "yes please" });
  await until(async () => (await reasons())[0] === "follow_up", "the follow-up's verdict");
  assert.equal(r.asked.length, 1, "none of these asked");

  // Alone, any other message is asked about.
  // (the answered question and the follow-up each run a turn: let them end first)
  for (let seen = -1; seen !== r.turns();) { seen = r.turns(); await sleep(1500); }
  const before = r.turns();
  await send({ type: "message", channel_type: "im", channel: "D2", ts: "300.1", text: "another message" });
  await until(() => r.asked.length === 2, "the question");
  await r.settled(channel, 5);
  assert.deepEqual((await r.events(channel)).events.slice(0, 1).map(event => event.outcome), ["filtered"]);
  await sleep(500);
  assert.equal(r.turns(), before + 0, "the asked message did not start a run");
}, { prepare: async t => { slack = await fakeSlack(t); return { AGENT_SLACK_API_URL: slack.url }; }, timeout: 90_000 });

filterTest("tests/channels-filter.test.ts:287", "a definition's dataCollection deny goes with the question", async (_t, r) => {
  const channel = await r.channel({ filter: undefined });
  const definition = await r.call("/v1/definitions", { body: { name: "d", dataCollection: "deny" }, token: PAYG });
  assert.equal(definition.status, 201, definition.text);
  const updated = await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { definition: definition.json.id, filter: FILTER }, token: PAYG });
  assert.equal(updated.status, 200, updated.text);
  await r.post(channel, { id: "m1", text: "hello" });
  await until(() => r.asked.length === 1, "the question");
  assert.deepEqual(r.asked[0]!.provider, { data_collection: "deny" });
});

filterTest("tests/channels-filter.test.ts:296", "deleting a channel removes its filtered messages and verdicts", async (_t, r) => {
  const channel = await r.channel();
  await r.post(channel, { id: "m1", text: "hello" });
  await r.settled(channel);
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "DELETE", token: PAYG })).status, 200);
  assert.equal(await count(r, "channel_items"), 0);
  assert.equal(await count(r, "channel_seen"), 0);
}, { score: () => 0.1 });

filterTest("tests/channels-filter.test.ts:305", "deleting a channel is all or nothing, so a retry finds what is left", async (_t, r) => {
  const channel = await r.channel();
  await r.post(channel, { id: "m1", text: "hello" });
  await r.settled(channel);
  await r.channelQuery("alter table email_messages rename column channel to channel_away");
  const failed = await r.call(`/v1/channels/${channel.id}`, { method: "DELETE", token: PAYG });
  await r.channelQuery("alter table email_messages rename column channel_away to channel");
  assert.ok(failed.status >= 400, failed.text);
  assert.equal((await r.events(channel)).events.length, 1, "the channel, its verdict and its message are all still there");
  assert.equal(await count(r, "channel_items"), 1);
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "DELETE", token: PAYG })).status, 200);
  assert.equal(await count(r, "channel_items"), 0);
}, { score: () => 0.1 });

filterTest("tests/channels-filter.test.ts:318", "deleting an account deletes its filtered messages and their verdicts", async (_t, r) => {
  const { token } = await r.seedTenant("carol", { operator: false, credits: 5_000_000 });
  const channel = await r.channel({}, token);
  await r.post(channel, { id: "m1", text: "a customer's words" });
  await until(async () => (await r.events(channel, "", token)).events.length === 1, "the verdict");
  assert.equal(await count(r, "channel_items", "where item->>'state' = 'filtered'"), 1);
  const deleting = await r.call("/v1/tenants/carol", { method: "DELETE", token: OPS });
  assert.equal(deleting.status, 202, deleting.text);
  await until(async () => (await r.call("/v1/tenants/carol/deletion", { token: OPS })).json.state === "deleted", "the deletion", 60_000);
  for (const table of ["channels", "channel_items", "channel_seen"]) assert.equal(await count(r, table), 0, table);
}, { score: () => 0.1, timeout: 120_000 });

// The whole path: routes, billing and the decisions wire format, on a stand-in for OpenRouter.

filterTest("tests/channels-filter.test.ts:336", "over the API: an event is judged on the wire, billed like a decision, listed and delivered; the logs hold no content", async (_t, r) => {
  const requests = r.asked;
  const fields = { type: "webhook", credentials: { secret: TOKEN }, settings: { signature: { type: "token", header: "x-token" }, prompt: "{{text}}", key: "{{thread}}", idPath: "id" }, filter: FILTER };
  const bad = await r.call("/v1/channels", { body: { ...fields, filter: { instructions: "x", threshold: 2 } }, token: PAYG });
  assert.equal(bad.status, 400, bad.text);
  const created = await r.call("/v1/channels", { body: fields, token: PAYG });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.filter, FILTER);
  const id = created.json.id;
  const post = (body: object) => fetch(`${r.base}/channels/webhook/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify(body) });

  assert.equal((await post({ id: "a", thread: "t1", text: "newsletter secret-body-text" })).status, 200);
  const held = await until(async () => { const page = await r.call(`/v1/channels/${id}/events`, { token: PAYG }); return page.json.events?.length === 1 && page.json.events[0]; }, "the filtered event");
  assert.deepEqual([held.outcome, held.score, held.threshold, held.reason, held.model, held.message.text], ["filtered", 0.05, 0.7, "score", "typesafe/jev-1.14-20261014", "newsletter secret-body-text"]);
  assert.equal(requests[0]!.key, "Bearer fixture-platform-model-key");
  assert.equal(requests[0]!.model, "typesafe/jev-1.14");
  assert.deepEqual(requests[0]!.questions.passes.criteria, FILTER.criteria);
  assert.equal(((await r.call("/v1/agents", { token: PAYG })).json as unknown[]).length, 0, "no agent for it");

  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 990_000, "the decision's charge");
  assert.equal((await r.call(`/v1/channels/${id}/events`, { token: OWN })).status, 404, "another tenant's channel");
  assert.equal((await r.call(`/v1/channels/${id}/events?limit=9999`, { token: PAYG })).status, 400);

  const delivered = await r.call(`/v1/channels/${id}/events/${held.id}/deliver`, { method: "POST", token: PAYG });
  assert.equal(delivered.status, 200, delivered.text);
  const agents = await until(async () => { const list = (await r.call("/v1/agents", { token: PAYG })).json; return list.length === 1 && list; }, "the agent");
  await until(() => r.turns() === 1, "the delivered turn");
  await until(async () => {
    const page = await r.call(`/v1/agents/${agents[0].id}/requests/${held.id}`, { token: PAYG });
    return page.status === 200 && page.json.state === "completed";
  }, "the delivered run");

  // A customer's own key pays for its own filter.
  const own = await r.call("/v1/channels", { body: fields, token: OWN });
  assert.equal(own.status, 201, own.text);
  await fetch(`${r.base}/channels/webhook/${own.json.id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": TOKEN }, body: JSON.stringify({ id: "b", thread: "t", text: "where is my order" }) });
  await until(() => requests.length === 2, "its question");
  assert.equal(requests[1]!.key, "Bearer own-openrouter-key");

  assert.ok(r.logs.some(line => line.includes('"type":"channel_filter"')));
  assert.ok(!r.logs.some(line => line.includes("secret-body-text")), "no content in the logs");
}, { score: state => text(state).includes("newsletter") ? 0.05 : 0.95, cost: 0.01 });
