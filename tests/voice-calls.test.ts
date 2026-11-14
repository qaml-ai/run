import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { UsageRecord } from "../src/client-sessions/state.ts";
import { DEFAULT_BUCKET } from "../src/end-user-credits.ts";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type NodeDeps, type RuntimeNode } from "../src/node.ts";
import { REALTIME_PRICES } from "../src/voice/realtime/provider.ts";
import { enqueueEvents, type WebhookEvent } from "../src/webhooks.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";
import { fakeCredit, fakeOpenAICalls, fakeSubmit } from "./voice-calls-fakes.ts";
import { discordGrant, fakeTransport } from "./voice-fakes.ts";

const path = "/v1/voice/sessions";
const offer = "v=0\r\ns=offer\r\n";
const framing = "[A request from your voice in a live voice call. Do what it needs with your tools first; then answer in one to three plain spoken sentences (no markdown, lists, links or emoji), since your reply is read aloud]";
const talk = (id: string, transcript: string, seconds = 1.5) => ({
  type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript, usage: { type: "duration", seconds },
});
const tool = (id: string, name = "ask_agent") => ({
  type: "response.function_call_arguments.done", response_id: `response_${id}`, call_id: id, name, arguments: '{"request":"what time is it"}',
});

async function fixture(t: TestContext, overrides: NodeDeps["voiceCallOverrides"] = {}, discord = false) {
  const openai = await fakeOpenAICalls(t);
  const root = await mkdtemp(join(tmpdir(), "agent-voice-calls-"));
  const { url } = await testDatabase();
  await writeFile(join(root, "tenants.json"), JSON.stringify({ tenants: {
    alice: { tokenSha256: sha(token), apiKeys: { openai: "fixture-key", openrouter: "fixture-key" } },
  } }));
  const events: WebhookEvent[] = [];
  const usage: UsageRecord[] = [];
  let node: RuntimeNode | undefined;
  // The node is closed before its data directory goes: under process hosting its children still write until then.
  t.after(async () => {
    try { await node?.close(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_OPENAI_REALTIME_URL: openai.url,
      AGENT_VOICE_SESSIONS_PER_TENANT: discord ? "1" : "5",
    });
    const deps = await nodeDeps(config);
    const made = await createNode(config, {
      ...deps,
      voiceTransports: discord ? { discord: fakeTransport().transport } : undefined,
      voiceCallOverrides: {
        enqueue: async (batch, sql) => {
          await enqueueEvents(sql ?? deps.db, batch);
          events.push(...batch);
        },
        record: (_tenant, record) => { usage.push(record); },
        ...overrides,
      },
    });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };
  const agent = await http("POST", "/v1/agents", { name: "voice-agent" });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const create = (patch: Record<string, unknown> = {}) => http("POST", path, {
    agent: agent.json.id, provider: "openai", subject: "user-1", sdp: offer, ...patch,
  });
  const live = async (patch?: Record<string, unknown>) => {
    const result = await create(patch);
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json;
  };
  const event = (type: WebhookEvent["type"], id: string) => until(() => events.find(e => e.type === type && e.data.session === id)?.data, type);
  return { openai, http, create, live, events, event, usage, calls: node!.calls! };
}

test("client-held call brokers SDP and exposes the live row with AGENT_VOICE unset", async t => {
  const f = await fixture(t);
  assert.equal((await f.http("POST", path, { discord: discordGrant() })).status, 404);
  const call = await f.live({ language: "en", instructions: "Talk like Ana." });
  assert.match(call.id, /^vc_[a-f0-9]{24}$/);
  assert.deepEqual(call.connect, { sdpAnswer: f.openai.answer });
  const posted = f.openai.offers[0];
  assert.equal(posted.sdp, offer);
  assert.equal(posted.type, "application/sdp");
  assert.deepEqual(posted.session.audio.input.turn_detection, { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true });
  assert.deepEqual(posted.session.audio.input.transcription, { model: "gpt-transcribe", language: "en" });
  assert.deepEqual(posted.session.tools.map((tool: { name: string }) => tool.name), ["ask_agent", "stay_silent"]);
  assert.match(posted.session.instructions, /^Talk like Ana\.\n\nYou are speaking in a live voice call\./);
  assert.ok(posted.session.instructions.endsWith("- If someone talks over you, you were cut off at that point: do not repeat what you already said unless asked."));
  assert.deepEqual(f.openai.connections, [{ url: "/v1/realtime?call_id=call_1", auth: "Bearer fixture-key" }]);
  assert.equal((await f.event("voice.session.started", call.id)).provider, "openai");
  assert.equal((await f.http("GET", `${path}/${call.id}`)).json.state, "live");
  const list = await f.http("GET", `${path}?state=live&limit=1`);
  assert.deepEqual(list.json.sessions, []);
  assert.deepEqual(list.json.calls.map((row: { id: string }) => row.id), [call.id]);
  const patch = { metadata: { server: 7 }, speakers: { "123456789012345678": "Ana" } };
  const patched = await f.http("PATCH", `${path}/${call.id}`, patch);
  assert.deepEqual(patched.json.metadata, patch.metadata);
  assert.deepEqual(patched.json.speakers, patch.speakers);
  for (const [method, suffix] of [["POST", "say"], ["POST", "prompt"], ["DELETE", "speak"], ["GET", "audio"], ["POST", "recording"], ["POST", "browser-token"]]) {
    assert.equal((await f.http(method, `${path}/${call.id}/${suffix}`)).json.code, "VOICE_CALL_NO_AUDIO");
  }
});

test("responses hold, meter, settle or release, then hang up on a credit refusal", async t => {
  const credit = fakeCredit();
  const f = await fixture(t, { credit: credit.credit });
  const call = await f.live({ context: { team: "test" }, bucket: "bot:7" });
  const push = f.openai.script("call_1");
  push({ type: "response.created", response: { id: "r1" } });
  await until(() => credit.log.length === 2, "the hold");
  assert.deepEqual(credit.log[1], ["hold", "user-1", "bot:7", 0.05, "voice_realtime", { session: call.id }]);
  const usage = { input_token_details: { text_tokens: 100, audio_tokens: 50, cached_tokens_details: { text_tokens: 20 } }, output_token_details: { text_tokens: 10, audio_tokens: 80 } };
  push({ type: "response.done", response: { id: "r1", status: "completed", usage } });
  const price = REALTIME_PRICES[`openai/${call.model}`];
  assert.ok("outputAudio" in price);
  const expected = (80 * price.inputText + 20 * price.cachedText + 50 * price.inputAudio + 10 * price.outputText + 80 * price.outputAudio) / 1_000_000 / 1_000_000;
  await until(() => credit.log.some(entry => entry[0] === "settle"), "settlement");
  assert.deepEqual(credit.log[2], ["settle", expected]);
  assert.equal(f.usage[0].kind, "speech");
  assert.equal(f.usage[0].audioSeconds, 4);
  assert.deepEqual(f.usage[0].identity, { subject: "user-1", context: { team: "test", voiceCall: call.id } });
  const row = await until(async () => {
    const { json } = await f.http("GET", `${path}/${call.id}`);
    return json.turns === 1 && json;
  }, "the metered row");
  assert.equal(row.costUsd, Math.round(expected * 1_000_000) / 1_000_000);
  push({ type: "response.created", response: { id: "r2" } }, { type: "response.done", response: { id: "r2", status: "cancelled" } });
  await until(() => credit.log.some(entry => entry[0] === "release"), "release for zero cost");
  credit.refuse.hold = true;
  push({ type: "response.created", response: { id: "r3" } });
  const ended = await f.event("voice.session.ended", call.id);
  assert.deepEqual(f.openai.hangups, ["call_1"]);
  assert.equal(ended.reason, "budget");
  assert.equal(ended.limit, "end_user");
  assert.equal(ended.endUserReason, "balance");
  assert.equal(ended.bucket, "bot:7");
});

test("ask_agent includes only new transcripts and omits the payer without credit", async t => {
  const submit = fakeSubmit();
  const f = await fixture(t, { submitStreaming: submit.submit, credit: undefined });
  const call = await f.live();
  const push = f.openai.script("call_1");
  push(talk("i1", " First line. "), {
    type: "conversation.item.input_audio_transcription.failed", item_id: "failed",
  }, talk("i2", "Second line."), tool("a1"));
  const said = await until(() => f.events.find(e => e.type === "voice.utterance" && e.data.session === call.id && e.data.seq === 1)?.data, "first utterance");
  assert.equal(said.text, "First line.");
  assert.equal(said.reported, "sideband");
  assert.equal("speakerId" in said, false);
  const utterances = () => f.events.filter(e => e.type === "voice.utterance" && e.data.session === call.id);
  await until(() => utterances().some(e => e.data.text === "Second line."), "second utterance");
  assert.deepEqual(utterances().map(e => [e.data.seq, e.data.text]).sort(([a], [b]) => Number(a) - Number(b)), [
    [1, "First line."], [2, "Second line."],
  ]);
  assert.equal((await f.event("voice.agent.asked", call.id)).request, "what time is it");
  assert.equal((await f.event("voice.agent.replied", call.id)).outcome, "ok");
  const request = submit.requests[0];
  assert.match(request.id, /^voice_[a-f0-9]{24}_ask_[a-z0-9]+1$/);
  assert.deepEqual(request.params, {
    text: `[What was said in the call since your last request (speakers not labeled)]\nFirst line.\nSecond line.\n\n${framing}\nwhat time is it`,
    metadata: { voiceCall: call.id, via: "voice" }, allowDisconnected: true,
  });
  const messages = () => f.openai.events("call_1");
  await until(() => messages().length === 2, "the tool reply and response");
  assert.deepEqual(messages(), [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "a1", output: JSON.stringify({ reply: "It's noon." }) } },
    { type: "response.create" },
  ]);
  const read = () => f.http("GET", `${path}/${call.id}`);
  const row = await until(async () => { const { json } = await read(); return json.audioSeconds === 3 && json; }, "audio seconds");
  assert.equal(row.asks, 1);
  assert.equal(f.usage.length, 0);

  push(tool("a2"));
  await until(() => submit.requests.length === 2, "second prompt");
  assert.equal(submit.requests[1].params.text, `${framing}\nwhat time is it`);
  push(...Array.from({ length: 25 }, (_, n) => talk(`line_${n}`, `line ${n}`, 0)), tool("a3"));
  await until(() => submit.requests.length === 3, "third prompt");
  assert.equal(submit.requests[2].params.text, `[What was said in the call since your last request (speakers not labeled)]\n${Array.from({ length: 20 }, (_, n) => `line ${n + 5}`).join("\n")}\n\n${framing}\nwhat time is it`);
  await until(() => messages().length === 6, "three replies");
  push(tool("silent", "stay_silent"));
  await until(() => messages().length >= 7, "silent output");
  assert.deepEqual(messages().slice(6), [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "silent", output: '{"ok":true}' } },
  ]);
});

test("ask_agent sends the payer with credit, and an end-user refusal stays in the call", async t => {
  const submit = fakeSubmit(["missing", { text: "Done." }]);
  const credit = fakeCredit();
  const f = await fixture(t, { credit: credit.credit, submitStreaming: submit.submit });
  const call = await f.live({ bucket: "bot:7" });
  f.openai.script("call_1")(tool("a1"));
  const reply = await f.event("voice.agent.replied", call.id);
  assert.equal(reply.outcome, "error");
  assert.equal(submit.requests[0].params.endUser, "user-1");
  assert.equal(submit.requests[0].params.bucket, "bot:7");
  const messages = await until(() => {
    const events = f.openai.events("call_1");
    return events.length === 2 && events;
  }, "the error output");
  assert.equal(JSON.parse(messages[0].item.output).error, "The agent could not do it just now.");
  assert.equal((await f.http("GET", `${path}/${call.id}`)).json.state, "live");
  const other = await f.live();
  f.openai.script("call_2")(tool("a2"));
  assert.equal((await f.event("voice.agent.replied", other.id)).outcome, "ok");
  assert.equal(submit.requests[1].params.endUser, "user-1");
  assert.equal("bucket" in submit.requests[1].params, false);
});

test("pending tools receive a late note or time out without another response", async t => {
  const submit = fakeSubmit([{ text: "Late answer.", delay: 100 }, "hang"]);
  const f = await fixture(t, { submitStreaming: submit.submit, pendingMs: 25, lateMs: 300 });
  const call = await f.live();
  const push = f.openai.script("call_1");
  push(tool("late"));
  const result = await f.event("voice.agent.replied", call.id);
  assert.equal(result.late, true);
  assert.equal(result.outcome, "ok");
  const messages = () => f.openai.events("call_1");
  await until(() => messages().length === 4, "pending and late response");
  assert.equal(JSON.parse(messages()[0].item.output).pending, "The agent is still working on it. Say it is taking a moment and you will tell them when it is done.");
  assert.equal(messages()[1].type, "response.create");
  assert.equal(messages()[2].item.content[0].text, '[The agent\'s late reply to "what time is it"]\nLate answer.');
  assert.deepEqual(messages()[3], { type: "response.create", response: { instructions: "The agent's reply to an earlier request just came in (the last note): tell them now, briefly, in your own words." } });
  push(tool("timeout"));
  const timeout = await until(() => f.events.find(e => e.type === "voice.agent.replied" && e.data.outcome === "timeout"), "timeout");
  assert.equal(timeout.data.late, true);
  assert.equal(messages().length, 6);
  assert.ok(JSON.parse(messages()[4].item.output).pending);
  assert.equal(messages()[5].type, "response.create");
});

test("end is idempotent, sweep expires, and stopping hangs up live calls", async t => {
  let now = Date.now(), retiring = false;
  const f = await fixture(t, { now: () => now, retiring: () => retiring });
  const first = await f.live();
  assert.equal(f.calls.size, 1);
  const end = () => f.http("POST", `${path}/${first.id}/end`, { reason: "channel_empty" });
  const ended = await end();
  assert.equal(ended.status, 200);
  assert.equal(ended.json.reason, "channel_empty");
  assert.deepEqual(await end(), ended);
  assert.equal((await f.event("voice.session.ended", first.id)).reason, "channel_empty");
  assert.equal(f.calls.size, 0);
  const second = await f.live();
  assert.equal((await f.http("DELETE", `${path}/${second.id}`)).json.reason, "requested");
  const third = await f.live({ maxMinutes: 1 });
  now += 60_001;
  await f.calls.sweep();
  assert.equal((await f.event("voice.session.ended", third.id)).reason, "max_duration");
  const broken = await f.live();
  f.openai.disconnect("call_4", "test error sk-fixture-secret");
  const disconnected = await f.event("voice.session.ended", broken.id);
  assert.equal(disconnected.reason, "error");
  assert.equal(disconnected.detail, "The realtime connection closed (1011: test error [redacted])");
  assert.ok(f.openai.hangups.includes("call_4"));
  const last = await f.live();
  retiring = true;
  const refused = await f.create();
  assert.equal(refused.status, 503);
  assert.equal(refused.json.code, "NODE_RETIRING");
  await f.calls.stop();
  assert.equal((await f.event("voice.session.ended", last.id)).reason, "restarted");
  assert.equal(f.calls.size, 0);
  assert.deepEqual(f.openai.hangups, ["call_1", "call_2", "call_3", "call_4", "call_5"]);
  assert.equal((await f.http("POST", `${path}/vs_${"0".repeat(24)}/end`)).status, 404);
});

test("refusals happen before OpenAI traffic, including capacity shared with Discord", async t => {
  const credit = fakeCredit();
  const f = await fixture(t, { credit: credit.credit }, true);
  assert.equal((await f.create({ sdp: undefined })).status, 400);
  assert.equal((await f.create({ provider: "elevenlabs", sdp: undefined })).json.code, "REALTIME_UNAVAILABLE");
  assert.equal((await f.create({ agent: `client_${"0".repeat(40)}` })).json.code, "AGENT_NOT_FOUND");
  credit.refuse.create = true;
  const refused = await f.create();
  assert.equal(refused.status, 402);
  assert.equal(refused.json.code, "END_USER_CREDIT");
  assert.equal(refused.json.bucket, DEFAULT_BUCKET);
  credit.refuse.create = false;
  const discord = await f.http("POST", path, { discord: discordGrant() });
  assert.equal(discord.status, 201, JSON.stringify(discord.json));
  const full = await f.create();
  assert.equal(full.status, 429);
  assert.equal(full.json.code, "VOICE_SESSION_LIMIT");
  assert.equal(f.openai.offers.length, 0);
});
