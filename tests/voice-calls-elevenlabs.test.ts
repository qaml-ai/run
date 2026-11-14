import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { UsageRecord } from "../src/client-sessions/state.ts";
import type { Db } from "../src/db.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { terminationReasonToEnd } from "../src/voice/calls/elevenlabs.ts";
import { ASK_AGENT, PENDING, STAY_SILENT } from "../src/voice/calls/prompts.ts";
import { enqueueEvents, type WebhookEvent } from "../src/webhooks.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";
import { fakeElevenLabs, fakeOpenAICalls, fakeSubmit, sign } from "./voice-calls-fakes.ts";

const path = "/v1/voice/sessions";
const inbound = "/v1/voice/providers/elevenlabs";
const minute = 60_000;

async function fixture(t: TestContext, options: { tenantKey?: boolean; balance?: number; metered?: boolean } = {}) {
  const initial = Date.now();
  let now = initial;
  const warn = t.mock.method(console, "warn", () => {});
  const info = t.mock.method(console, "info", () => {});
  const log = t.mock.method(console, "log", () => {});
  const rates = {
    AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "0.10",
    AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD: "0.02",
  };
  for (const [name, value] of Object.entries(rates)) {
    const prior = process.env[name];
    process.env[name] = value;
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  }
  const order: string[] = [];
  const eleven = await fakeElevenLabs(t, path => order.push(path));
  const openai = await fakeOpenAICalls(t);
  const submit = fakeSubmit([{ text: "It's noon." }, { text: "Later reply", delay: 250 }]);
  const root = await mkdtemp(join(tmpdir(), "agent-elevenlabs-calls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { url } = await testDatabase();
  await writeFile(join(root, "tenants.json"), JSON.stringify({
    tenants: { alice: { tokenSha256: sha(token), apiKeys: {
      openai: "fixture-openai-key", openrouter: "fixture-model-key", ...(options.tenantKey ? { elevenlabs: "fixture-tenant-key" } : {}),
    } } },
    platformKeys: { elevenlabs: "fixture-platform-key" },
  }));
  const events: WebhookEvent[] = [];
  const usage: UsageRecord[] = [];
  let node: RuntimeNode | undefined;
  let db!: Db;
  t.after(async () => { await node?.close(); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_OPENAI_REALTIME_URL: openai.url,
      AGENT_VOICE_REALTIME: "openai,elevenlabs", AGENT_ELEVENLABS_URL: eleven.url, AGENT_VOICE_SESSIONS_PER_TENANT: "10",
      ...rates,
    });
    const deps = await nodeDeps(config);
    db = deps.db;
    const credits = new EndUserCredits(db);
    await credits.setSettings("alice", { enabled: true });
    if (options.balance !== 0) {
      await credits.post("alice", "user-1", { kind: "grant", amount: options.balance ?? 30_000_000, key: "fixture-grant" });
    }
    const refusal = credits.refusal.bind(credits);
    t.mock.method(credits, "refusal", async (...args: Parameters<EndUserCredits["refusal"]>) => {
      order.push("refusal");
      return refusal(...args);
    });
    const hold = credits.hold.bind(credits);
    t.mock.method(credits, "hold", async (...args: Parameters<EndUserCredits["hold"]>) => {
      order.push("hold");
      return hold(...args);
    });
    const made = await createNode(config, {
      ...deps, voiceCallOverrides: {
        now: () => now, credit: options.metered === false ? undefined : credits, pendingMs: 100, lateMs: 3_000, submitStreaming: submit.submit,
        enqueue: async (batch, sql) => {
          await enqueueEvents(sql ?? db, batch);
          events.push(...batch);
        },
        record: (_tenant, record) => { usage.push(record); },
      },
    });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const request = (method: string, path: string, input?: unknown, headers?: Record<string, string>) =>
    fetch(base + path, {
      method, body: input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input),
      headers: { "Content-Type": "application/json", ...(headers ?? { Authorization: `Bearer ${token}` }) },
    });
  const http = async (...args: Parameters<typeof request>) => {
    const response = await request(...args);
    return { status: response.status, json: await response.json() as any };
  };
  const agent = await http("POST", "/v1/agents", { name: "voice-agent" });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const create = async (patch: Record<string, unknown> = {}, key?: string) => {
    const response = await request("POST", path, {
      agent: agent.json.id, provider: "elevenlabs", subject: "user-1", ...patch,
    }, key ? { Authorization: `Bearer ${token}`, "Idempotency-Key": key } : undefined);
    return { status: response.status, json: await response.json() as any, headers: response.headers };
  };
  const live = async (patch?: Record<string, unknown>) => {
    const result = await create(patch);
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json;
  };
  const post = (conversation: string, patch: Record<string, unknown> = {}, type = "post_call_transcription", signedAt = now, secret = eleven.webhookSecret) => {
    const agentId = eleven.signed[Number(conversation.split("_")[1]) - 1].get("agent_id");
    const body = JSON.stringify({ type, data: {
      agent_id: agentId, conversation_id: conversation, metadata: { call_duration_secs: 600 },
      transcript: [{ role: "user", message: "Provider words", time_in_call_secs: 3 }, { role: "agent", message: "Reply" }], ...patch,
    } });
    return http("POST", inbound + "/post-call", body, { "ElevenLabs-Signature": sign(secret, body, signedAt) });
  };
  const tool = (name: string, conversation_id: string, secret = eleven.tools[0].api_schema.request_headers["X-Voice-Tool-Secret"]) =>
    http("POST", inbound + "/tools/" + name, { request: "What time is it?", conversation_id }, { "X-Voice-Tool-Secret": secret });
  const byCall = (id: string, type: WebhookEvent["type"]) => events.filter(event => event.data.session === id && event.type === type).map(event => event.data);
  const balance = async () => (await db.query("select balance from end_users where tenant = 'alice' and id = 'user-1'")).rows[0].balance;
  const ledger = async (callId: string) => (await db.query("select raw, amount from end_user_ledger where idempotency_key = $1", [`voice_elevenlabs:${callId}`])).rows;
  return { base, warn, info, log, eleven, http, create, live, order, usage, submit, byCall, post, tool, balance, ledger, db,
    calls: node!.calls!, initial, advance: (minutes: number) => { now = initial + minutes * minute; } };
}

test("checks credit before provider requests and provisions webhook tools once per persona", async t => {
  const f = await fixture(t, { balance: 1 });
  const input = { maxMinutes: 45, instructions: "Talk like Ana." };
  const { status, json: call, headers } = await f.create(input, "create-call");
  assert.equal(status, 201);
  assert.equal(headers.get("Idempotency-Secret"), null);
  const retry = await f.create(input, "create-call");
  assert.deepEqual([retry.status, retry.json.code], [409, "IDEMPOTENCY_CONFLICT"]);
  assert.deepEqual(call.connect, {
    conversationId: "conv_1", signedUrl: "wss://fake/convai?agent_id=agent_1&conversation_signature=sig&conversation_id=conv_1",
  });
  assert.equal(f.eleven.signed[0].get("include_conversation_id"), "true");
  assert.equal(call.maxMinutes, 30);
  assert.equal(call.expiresAt - f.initial, 30 * minute);
  assert.equal(await f.balance(), 1);
  assert.equal((await f.db.query("select id from end_user_holds")).rowCount, 0);
  assert.deepEqual(f.order, ["refusal", "/v1/workspace/webhooks", "/v1/convai/tools", "/v1/convai/tools", "/v1/convai/agents/create", "/v1/convai/conversation/get-signed-url"]);
  assert.deepEqual(f.eleven.webhooks, [{ settings: {
    name: "camelRun voice calls", webhook_url: f.base + inbound + "/post-call", auth_type: "hmac",
  } }]);
  for (const [index, prompt] of [ASK_AGENT, STAY_SILENT].entries()) {
    const tool = f.eleven.tools[index];
    assert.equal(tool.type, "webhook");
    assert.equal(tool.name, prompt.name);
    assert.equal(tool.description, prompt.description);
    assert.equal(tool.response_timeout_secs, 60);
    assert.equal(tool.pre_tool_speech, index === 0 ? "force" : "off");
    assert.ok(tool.api_schema.request_headers["X-Voice-Tool-Secret"]);
    assert.equal(tool.api_schema.request_body_schema.properties.conversation_id.dynamic_variable, "system__conversation_id");
    assert.equal(tool.api_schema.request_body_schema.properties.request?.description,
      (prompt.parameters.properties as Record<string, { description: string }>).request?.description);
  }
  const stored = (await f.db.query("select tool_secret from elevenlabs_call_agents")).rows[0].tool_secret;
  assert.ok(!stored.includes(f.eleven.tools[0].api_schema.request_headers["X-Voice-Tool-Secret"]));
  const webhook = (await f.db.query("select secret from elevenlabs_call_webhooks")).rows[0].secret;
  assert.ok(!webhook.includes(f.eleven.webhookSecret));
  const agent = f.eleven.agents[0];
  assert.deepEqual(agent.conversation_config.agent.prompt.tool_ids, ["tool_1", "tool_2"]);
  assert.equal(agent.conversation_config.agent.prompt.tools, undefined);
  assert.match(agent.conversation_config.agent.prompt.prompt, /^Talk like Ana\./);
  assert.equal(agent.conversation_config.conversation.max_duration_seconds, 1800);
  assert.deepEqual(agent.platform_settings.overrides.conversation_config_override, { tts: { voice_id: true }, agent: { language: true } });
  assert.equal(agent.platform_settings.workspace_overrides.webhooks.post_call_webhook_id, "wh_1");
  const unkeyed = await f.create({ instructions: "Talk like Ana." });
  assert.equal(unkeyed.status, 201);
  assert.equal(unkeyed.headers.get("Idempotency-Secret"), null);
  assert.deepEqual([f.eleven.webhooks.length, f.eleven.tools.length, f.eleven.agents.length], [1, 2, 1]);
  await f.live({ instructions: "Talk like Bea." });
  assert.deepEqual([f.eleven.webhooks.length, f.eleven.tools.length, f.eleven.agents.length], [1, 4, 2]);
  const shorter = await f.live({ instructions: "Talk like Ana.", maxMinutes: 12 });
  assert.equal(shorter.maxMinutes, 12);
  assert.equal(shorter.expiresAt - f.initial, 12 * minute);
  assert.deepEqual([f.eleven.webhooks.length, f.eleven.tools.length, f.eleven.agents.length], [1, 4, 2]);
});

test("credit exhaustion and a tenant-owned key are refused before any provider call", async t => {
  await t.test("no credit left", async t => {
    const f = await fixture(t, { balance: 0 });
    const refused = await f.create();
    assert.equal(refused.status, 402);
    assert.equal(refused.json.code, "END_USER_CREDIT");
    assert.deepEqual(f.order, ["refusal"]);
    assert.equal((await f.db.query("select id from end_user_holds")).rowCount, 0);
    assert.equal((await f.db.query("select id from voice_calls")).rowCount, 0);
  });
  await t.test("tenant-owned key", async t => {
    const f = await fixture(t, { tenantKey: true });
    const result = await f.create();
    assert.equal(result.status, 400);
    assert.equal(result.json.code, "REALTIME_UNAVAILABLE");
    assert.deepEqual(f.order, []);
  });
});

test("a tenant-paid call defaults to thirty minutes and preserves a shorter cap", async t => {
  const f = await fixture(t, { metered: false });
  const call = await f.live();
  const shorter = await f.live({ maxMinutes: 4 });
  assert.equal(call.maxMinutes, 30);
  assert.equal(shorter.maxMinutes, 4);
  assert.equal(shorter.expiresAt - f.initial, 4 * minute);
  assert.equal(f.order.includes("refusal"), false);
  assert.equal(f.order.includes("hold"), false);
  assert.equal(f.eleven.agents.length, 1);
  assert.equal(f.eleven.agents[0].conversation_config.conversation.max_duration_seconds, 1800);
  assert.equal((await f.post(call.connect.conversationId)).status, 200);
  assert.equal(f.usage[0].usage.cost.total, 1.20);
  assert.deepEqual(await f.ledger(call.id), []);
});

test("client transcripts feed authenticated tools and late replies are sent as events", async t => {
  const f = await fixture(t);
  const call = await f.live({ speakers: { ana: "Ana" }, bucket: "bot:7" });
  const conv = call.connect.conversationId;
  assert.deepEqual(await f.tool("ask_agent", conv, "wrong-secret"), { status: 404, json: {} });
  assert.deepEqual(await f.tool("unknown", conv), { status: 404, json: {} });
  assert.deepEqual(await f.tool("stay_silent", conv), { status: 200, json: { ok: true } });
  const transcript = { speaker: "ana", text: "Can you check the time?", seconds: 2 };
  assert.deepEqual(await f.http("POST", `${path}/${call.id}/transcript`, transcript), { status: 202, json: { seq: 1 } });
  assert.equal(f.byCall(call.id, "voice.utterance")[0].reported, "client");
  assert.equal((await f.http("GET", `${path}/${call.id}`)).json.turns, 1);
  assert.deepEqual(await f.tool("ask_agent", conv), { status: 200, json: { reply: "It's noon." } });
  const params = f.submit.requests[0].params;
  assert.match(String(params.text), /^\[What was said in the call since your last request \(speakers not labeled\)\]\nAna: Can you check the time\?/);
  assert.deepEqual([params.metadata, params.endUser, params.bucket], [{ voiceCall: call.id, via: "voice" }, "user-1", "bot:7"]);
  assert.deepEqual(await f.tool("ask_agent", conv), { status: 200, json: { reply: PENDING } });
  await until(() => f.byCall(call.id, "voice.agent.replied").find(event => event.late === true && event.reply === "Later reply"), "late reply");
  assert.doesNotMatch(String(f.submit.requests[1].params.text), /since your last request/);
  const open = await f.live({ provider: "openai", sdp: "v=0\r\ns=offer\r\n" });
  const rejected = await f.http("POST", `${path}/${open.id}/transcript`, transcript);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.code, "VOICE_TRANSCRIPT_SIDEBAND");
});

test("signed post-call reports debit the full cost once and emit only one transcript source", async t => {
  const f = await fixture(t, { balance: 1_000_000 });
  const call = await f.live();
  const fallback = await f.live();
  const failed = await f.live();
  const conv = call.connect.conversationId;
  await f.http("POST", `${path}/${call.id}/transcript`, { speaker: "ana", text: "Client words" });
  assert.equal((await f.post(conv, {}, undefined, f.initial, "wrong-secret")).status, 400);
  assert.equal((await f.post(conv, {}, undefined, f.initial - 31 * minute)).status, 400);
  assert.equal((await f.post(conv, {}, "post_call_audio")).status, 200);
  assert.equal(f.usage.length, 0);
  assert.equal((await f.http("POST", `${path}/${call.id}/end`, {})).json.state, "ending");
  assert.equal(f.byCall(call.id, "voice.session.ended").length, 0);
  const deliveries = await Promise.all([f.post(conv), f.post(conv)]);
  assert.deepEqual(deliveries, [{ status: 200, json: {} }, { status: 200, json: {} }]);
  assert.equal(f.usage.length, 1);
  assert.equal(f.usage[0].audioSeconds, 600);
  assert.equal(f.usage[0].usage.cost.total, 1.20);
  assert.deepEqual(await f.ledger(call.id), [{ raw: 1_200_000, amount: -1_200_000 }]);
  assert.equal(f.byCall(call.id, "voice.session.ended")[0].reason, "requested");
  assert.deepEqual(f.byCall(call.id, "voice.utterance").map(event => event.reported), ["client"]);

  assert.equal(await f.balance(), -200_000);
  const refused = await f.create();
  assert.deepEqual([refused.status, refused.json.code], [402, "END_USER_CREDIT"]);

  assert.equal((await f.post(fallback.connect.conversationId, { metadata: { call_duration_secs: 600, termination_reason: "Max call duration exceeded" } })).status, 200);
  assert.deepEqual(f.byCall(fallback.id, "voice.utterance").map(({ text, reported, seq, secondsIntoCall }) =>
    ({ text, reported, seq, secondsIntoCall })), [{ text: "Provider words", reported: "provider", seq: 1, secondsIntoCall: 3 }]);
  assert.equal(f.byCall(fallback.id, "voice.session.ended")[0].reason, "max_duration");

  assert.equal((await f.post(failed.connect.conversationId, { failure_reason: "connection failed" }, "call_initiation_failure")).status, 200);
  assert.deepEqual(await f.ledger(failed.id), []);
  assert.equal(f.byCall(failed.id, "voice.session.ended")[0].reason, "error");
});

test("the deadline debits elapsed cost and drops late reports", async t => {
  const f = await fixture(t, { balance: 1_000_000 });
  const before = f.calls.stats().deadlineSettles;
  const call = await f.live();
  f.eleven.reports.set(call.connect.conversationId, 500);
  f.advance(10);
  await f.http("POST", `${path}/${call.id}/end`, {});
  assert.equal((await f.http("GET", `${path}/${call.id}`)).json.expiresAt, call.expiresAt);
  f.advance(25);
  await f.calls.sweep();
  assert.equal(f.usage.length, 0);
  f.advance(26);
  await f.calls.sweep();
  assert.equal(f.calls.stats().deadlineSettles, before + 1);
  assert.deepEqual(await f.ledger(call.id), [{ raw: 1_200_000, amount: -1_200_000 }]);
  assert.equal(f.usage[0].audioSeconds, 600);
  assert.deepEqual([f.usage[0].usage.cost.total, f.usage[0].usage.settled], [1.20, "deadline"]);
  assert.equal(f.byCall(call.id, "voice.session.ended")[0].reason, "requested");
  assert.ok(f.warn.mock.calls.some(call => {
    const log = JSON.parse(String(call.arguments[0]));
    return log.type === "voice_call_settled_deadline" && log.source === "elapsed";
  }));
  assert.deepEqual(f.eleven.conversations, [call.connect.conversationId]);
  assert.equal((await f.post(call.connect.conversationId)).status, 200);
  assert.equal(f.usage.length, 1);
  assert.equal(await f.balance(), -200_000);
  assert.ok(f.log.mock.calls.some(call => String(call.arguments[0]).includes("voice_call_post_call_late")));
  assert.equal(f.byCall(call.id, "voice.session.ended").length, 1);
});

test("maps ElevenLabs termination reasons from observed provider text", () => {
  assert.deepEqual([
    "Max call duration exceeded",
    "Client disconnected: 1000",
    "client disconnected",
    "the conversation was ended by the user",
    "end_call tool was called",
    "LLM request failed",
    "",
  ].map(terminationReasonToEnd), ["max_duration", "client", "client", "client", "agent", "provider", "provider"]);
});

test("post-call duration falls back to the conversation lookup, then elapsed time", async t => {
  const f = await fixture(t);
  const call = await f.live();
  f.eleven.reports.set(call.connect.conversationId, { status: "done", metadata: { call_duration_secs: 540 } });
  assert.equal((await f.post(call.connect.conversationId, { metadata: { termination_reason: "Client disconnected: 1000" } })).status, 200);
  assert.deepEqual(f.eleven.conversations, [call.connect.conversationId]);
  assert.equal(f.usage[0].audioSeconds, 540);
  assert.deepEqual(await f.ledger(call.id), [{ raw: 1_080_000, amount: -1_080_000 }]);
  assert.equal(f.byCall(call.id, "voice.session.ended")[0].reason, "client");
  assert.ok(f.info.mock.calls.some(call => String(call.arguments[0]).includes('"source":"conversation"')));

  const fallback = await f.live();
  f.advance(4);
  await f.http("POST", `${path}/${fallback.id}/end`, {});
  f.advance(6);
  assert.equal((await f.post(fallback.connect.conversationId, { metadata: { call_duration_secs: "unavailable" } })).status, 200);
  assert.deepEqual(f.eleven.conversations, [call.connect.conversationId, fallback.connect.conversationId]);
  assert.equal(f.usage[1].audioSeconds, 240);
  assert.deepEqual(await f.ledger(fallback.id), [{ raw: 480_000, amount: -480_000 }]);
  assert.ok(f.warn.mock.calls.some(call => {
    const log = JSON.parse(String(call.arguments[0]));
    return log.type === "voice_call_duration_missing" && log.source === "elapsed";
  }));
});

test("the deadline bills the conversation duration when ElevenLabs returns it", async t => {
  const f = await fixture(t);
  const before = f.calls.stats().deadlineSettles;
  const call = await f.live();
  f.eleven.reports.set(call.connect.conversationId, { status: "done", metadata: { call_duration_secs: 120 } });
  for (const time of [8, 16, 24, 32, 40, 46]) {
    f.advance(time);
    await f.calls.sweep();
  }
  assert.deepEqual(f.eleven.conversations, [call.connect.conversationId]);
  assert.equal(f.calls.stats().deadlineSettles, before + 1);
  assert.deepEqual(await f.ledger(call.id), [{ raw: 240_000, amount: -240_000 }]);
  assert.equal(f.usage[0].audioSeconds, 120);
  assert.deepEqual([f.usage[0].usage.cost.total, f.usage[0].usage.settled], [0.24, "deadline"]);
  assert.equal(f.byCall(call.id, "voice.session.ended")[0].detail, "settled at the deadline: no post-call report");
  assert.ok(f.warn.mock.calls.some(call => {
    const log = JSON.parse(String(call.arguments[0]));
    return log.type === "voice_call_settled_deadline" && log.source === "conversation";
  }));
});
