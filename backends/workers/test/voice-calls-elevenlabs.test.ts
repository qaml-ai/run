import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callFixture } from "./voice-call-fixture.ts";

const webhookSecret = "synthetic-webhook-secret";
const inbound = "/v1/voice/providers/elevenlabs";

test("ElevenLabs shares provisioning and settles signed reports and deadline once", { timeout: 120_000 }, async t => {
  let agents = 0, signed = 0, reads = 0;
  let hasDuration = true;
  let toolSecret: string;
  const provider = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const path = request.url!;
    const input = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    let body: unknown;
    if (path === "/v1/workspace/webhooks") body = { webhook_id: "webhook-1", webhook_secret: webhookSecret };
    else if (path === "/v1/convai/tools") {
      toolSecret = input.tool_config.api_schema.request_headers["X-Voice-Tool-Secret"];
      body = { id: input.tool_config.name };
    } else if (path === "/v1/convai/agents/create") {
      assert.equal(input.conversation_config.conversation.max_duration_seconds, 1800);
      agents++;
      body = { agent_id: "agent-1" };
    } else if (path.startsWith("/v1/convai/conversation/get-signed-url?")) {
      const conversation_id = `conversation-${++signed}`;
      body = { signed_url: `wss://fixture.invalid/signed?conversation_id=${conversation_id}`, conversation_id };
    } else if (path.startsWith("/v1/convai/conversations/")) {
      reads++;
      body = { status: "done", metadata: { ...(hasDuration ? { call_duration_secs: 72 } : {}), termination_reason: "end_call tool" } };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }).listen(0, "127.0.0.1");
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  await once(provider, "listening");
  const token = "local-integration-only-token-with-at-least-32-characters";
  const f = await callFixture(t, `http://127.0.0.1:${(provider.address() as { port: number }).port}`, {
    TEST_VOICE_CREDITS: "1",
    AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "0.08", AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD: "0.02",
    AGENT_TENANTS_JSON: JSON.stringify({ platformKeys: { elevenlabs: "synthetic-elevenlabs-key" }, tenants: {
      "camelrun-proto-local": { tokenSha256: createHash("sha256").update(token).digest("hex") },
    } }),
  });
  await f.db.query("create table voice_test_debits(key text primary key, usd double precision not null)");
  assert.equal((await f.create({ provider: "elevenlabs", subject: "empty" })).json.code, "END_USER_CREDIT");
  const notify = (event: unknown, valid = true) => {
    const time = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", valid ? webhookSecret : "wrong").update(`${time}.${JSON.stringify(event)}`).digest("hex");
    return f.request(inbound + "/post-call", "POST", event, { "ElevenLabs-Signature": `t=${time},v0=${signature}` }, false);
  };

  const make = async () => {
    const result = await f.create({ provider: "elevenlabs", maxMinutes: 40 });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    assert.equal(result.json.maxMinutes, 30);
    return result.json;
  };
  const first = await make();
  const path = `/v1/voice/sessions/${first.id}`;
  const conversation = { conversation_id: first.connect.conversationId };
  const tool = (secret: string) => f.request(inbound + "/tools/stay_silent", "POST", conversation, { "X-Voice-Tool-Secret": secret }, false);
  assert.equal((await tool("wrong")).status, 404);
  assert.deepEqual((await tool(toolSecret!)).json, { ok: true });
  assert.deepEqual((await f.request(path + "/transcript", "POST", { speaker: "unlabeled", text: "Client reported this", seconds: 1 })).json, { seq: 1 });
  const report = { type: "post_call_transcription", data: { agent_id: "agent-1", ...conversation } };
  assert.equal((await notify(report, false)).status, 400);
  assert.equal((await notify(report)).status, 200);
  assert.equal((await notify(report)).status, 200);
  const ended = (await f.request(path)).json;
  assert.equal(ended.reason, "agent");
  assert.equal(ended.audioSeconds, 72);
  assert.equal(reads, 1);

  const second = await make();
  assert.equal(agents, 1);
  const secondPath = `/v1/voice/sessions/${second.id}`;
  assert.equal((await f.request(secondPath, "DELETE")).json.state, "ending");
  assert.equal((await f.request(`/__test/voice-alarm?id=${second.id}&kind=deadline`, "POST")).status, 200);
  const deadline = (await f.request(secondPath)).json;
  assert.equal(deadline.reason, "requested");
  assert.equal(deadline.audioSeconds, 72);
  assert.equal(reads, 2);
  const third = await make();
  const thirdPath = `/v1/voice/sessions/${third.id}`;
  const thirdData = { agent_id: "agent-1", conversation_id: third.connect.conversationId,
    metadata: { call_duration_secs: 15, termination_reason: "client disconnected" } };
  assert.equal((await notify({ type: "post_call_transcription", data: thirdData })).status, 200);
  assert.equal((await f.request(thirdPath)).json.reason, "client");
  assert.equal(reads, 2, "reported duration takes precedence over conversation GET");

  hasDuration = false;
  const fourth = await make();
  const fourthPath = `/v1/voice/sessions/${fourth.id}`;
  const ending = (await f.request(fourthPath, "DELETE")).json;
  assert.equal((await notify({ type: "post_call_transcription", data: { agent_id: "agent-1", conversation_id: fourth.connect.conversationId } })).status, 200);
  const elapsed = (await f.request(fourthPath)).json;
  assert.equal(elapsed.audioSeconds, Math.ceil((ending.endedAt - fourth.startedAt) / 1000));
  assert.equal(reads, 3);

  const debits = (await f.db.query("select key, usd from voice_test_debits")).rows;
  const byCall = new Map(debits.map(({ key, usd }) => [key, usd]));
  assert.equal(byCall.size, 4);
  assert.equal(byCall.get(`voice_elevenlabs:${first.id}`), 0.12);
  assert.equal(byCall.get(`voice_elevenlabs:${second.id}`), 0.12);
  assert.equal(byCall.get(`voice_elevenlabs:${third.id}`), 0.025);

  // An ElevenLabs call with no per-minute price configured is refused at create, never priced at $0.
  await f.restart({ AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "" });
  const unpriced = await f.create({ provider: "elevenlabs" });
  assert.equal(unpriced.status, 400, JSON.stringify(unpriced.json));
  assert.equal(unpriced.json.code, "REALTIME_UNPRICED");
  assert.equal(signed, 4, "no provider traffic for an unpriced call");
});
