import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { openaiCalls, type SidebandEvents } from "../worker/src/voice/openai.ts";

function wsEncodeText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload]);
  if (len < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
    return Buffer.concat([hdr, payload]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81;
  hdr[1] = 127;
  hdr.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([hdr, payload]);
}

function attachWsClientFrames(socket: Duplex, onText: (text: string) => void) {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ buf[maskOffset + (i % 4)]!;
        }
      }
      buf = buf.subarray(offset + len);
      if (opcode === 1) onText(payload.toString("utf8"));
      if (opcode === 8) socket.end();
    }
  });
}

test("v2 VoiceCallDO: OpenAI WebRTC sideband + ask_agent + hangup AND ElevenLabs signedUrl + tools + HMAC post-call", async (t) => {
  const sidebandMessages: Array<Record<string, unknown>> = [];
  let sidebandSocket: Duplex | null = null;
  let hangupCalled = 0;
  let elevenToolSecret = "";
  const elevenWebhookSecret = "whsec_test_elevenlabs_secret_123";
  let elevenWebhookRegistered = 0;
  let elevenAgentCreated = 0;

  const mockUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // OpenAI WebRTC SDP broker
      if (req.method === "POST" && url.pathname === "/v1/realtime/calls") {
        assert.match(raw, /Content-Disposition: form-data; name="sdp"\r\n/);
        assert.doesNotMatch(raw, /name="sdp";\s*filename=/);
        res.writeHead(201, {
          "Content-Type": "application/sdp",
          Location: "https://api.openai.com/v1/realtime/calls/rtc_call_123",
        });
        res.end("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=answer\r\n");
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/realtime/calls/rtc_call_123/hangup") {
        hangupCalled++;
        res.writeHead(200);
        res.end("");
        return;
      }

      // ElevenLabs provisioning + signed URL
      if (req.method === "POST" && url.pathname === "/v1/workspace/webhooks") {
        elevenWebhookRegistered++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ webhook_id: "wh_el_1", webhook_secret: elevenWebhookSecret }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/tools") {
        const parsed = JSON.parse(raw) as {
          tool_config?: { name?: string; api_schema?: { request_headers?: Record<string, string> } };
        };
        if (parsed.tool_config?.api_schema?.request_headers?.["X-Voice-Tool-Secret"]) {
          elevenToolSecret = parsed.tool_config.api_schema.request_headers["X-Voice-Tool-Secret"];
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: `tool_${parsed.tool_config?.name ?? "x"}` }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/agents/create") {
        elevenAgentCreated++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ agent_id: "el_agt_1" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/conversation/get-signed-url") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?conversation_id=conv_el_999&sig=abc",
            conversation_id: "conv_el_999",
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  mockUpstream.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers["sec-websocket-key"];
    assert.ok(typeof key === "string");
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sidebandSocket = socket;
    attachWsClientFrames(socket, (text) => {
      sidebandMessages.push(JSON.parse(text) as Record<string, unknown>);
    });
  });

  await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sidebandSocket?.destroy();
    mockUpstream.close();
  });
  const port = (mockUpstream.address() as { port: number }).port;
  const mockOrigin = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-voice-calls-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-voice-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-voice-calls-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-voice-vault-32-bytes-minimum",
        DEFAULT_MODEL: "mock/default",
        OPENAI_API_KEY: "sk-test-openai-platform",
        ELEVENLABS_API_KEY: "sk-test-elevenlabs-platform",
        VOICE_OPENAI_BASE_URL: `${mockOrigin}/v1`,
        VOICE_ELEVENLABS_BASE_URL: mockOrigin,
        VOICE_PUBLIC_URL: "https://voice.test",
        AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "0.08",
        AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD: "0.001",
        AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD: "0.012",
        AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD: "0.003",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://voice.test";

  const createTenantRes = await worker.fetch(`${origin}/v2/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({ name: "voice-test", initialCreditsUsd: 50 }),
  });
  assert.equal(createTenantRes.status, 201);
  const { apiKey } = (await createTenantRes.json()) as { apiKey: string };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  // Create a native v2 agent backed by mock/default
  const agtRes = await worker.fetch(`${origin}/v2/agents/voice-bot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "You are a helpful bot." }),
  });
  assert.equal(agtRes.status, 201);
  const { id: agentId } = (await agtRes.json()) as { id: string };

  // ---- 1. OpenAI WebRTC call + sideband ask_agent + response.done billing + hangup ----
  const createOaiRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "alloy",
      subject: "discord:user_1",
      interruptResponse: false,
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n",
      speakers: { u1: "Alice" },
      metadata: { guildId: "g1" },
    }),
  });
  assert.equal(createOaiRes.status, 201, await createOaiRes.clone().text());
  const oaiCall = (await createOaiRes.json()) as {
    id: string;
    state: string;
    connect: { sdpAnswer: string };
  };
  assert.match(oaiCall.id, /^vc_[a-f0-9]{24}$/);
  assert.equal(oaiCall.state, "live");
  assert.ok(oaiCall.connect.sdpAnswer.includes("s=answer"));
  const socket = sidebandSocket as Duplex | null;
  assert.ok(socket, "Expected OpenAI sideband WebSocket to connect");

  // Trigger response.created + response.done + ask_agent + stay_silent over sideband
  socket.write(wsEncodeText(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })));
  socket.write(
    wsEncodeText(
      JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_token_details: { text_tokens: 100, audio_tokens: 200, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
            output_token_details: { text_tokens: 50, audio_tokens: 400 },
          },
        },
      }),
    ),
  );
  socket.write(
    wsEncodeText(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_1",
        call_id: "fc_ask_1",
        name: "ask_agent",
        arguments: JSON.stringify({ request: "What is 2+2?" }),
      }),
    ),
  );
  socket.write(
    wsEncodeText(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_1",
        call_id: "fc_silent_1",
        name: "stay_silent",
        arguments: "{}",
      }),
    ),
  );

  // Wait for ask_agent tool output + response.create to arrive on sideband
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (
      sidebandMessages.some(
        (m) => m.type === "conversation.item.create" && (m.item as { call_id?: string })?.call_id === "fc_ask_1",
      ) &&
      sidebandMessages.some(
        (m) => m.type === "conversation.item.create" && (m.item as { call_id?: string })?.call_id === "fc_silent_1",
      )
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const askOutput = sidebandMessages.find(
    (m) => m.type === "conversation.item.create" && (m.item as { call_id?: string })?.call_id === "fc_ask_1",
  ) as { item?: { output?: string } } | undefined;
  assert.ok(askOutput?.item?.output, "Expected ask_agent tool output on sideband");
  const parsedAsk = JSON.parse(askOutput.item.output) as { reply?: string };
  assert.ok(parsedAsk.reply && parsedAsk.reply.length > 0, `Unexpected ask_agent output: ${askOutput.item.output}`);

  // PATCH speakers & verify GET
  const patchRes = await worker.fetch(`${origin}/v2/voice/calls/${oaiCall.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ speakers: { u1: "Alice", u2: "Bob" } }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()) as { speakers: Record<string, string>; turns: number; asks: number };
  assert.deepEqual(patched.speakers, { u1: "Alice", u2: "Bob" });
  assert.equal(patched.asks, 1);
  assert.ok(patched.turns >= 1);

  // End OpenAI call → hangs up upstream and marks ended
  const endOaiRes = await worker.fetch(`${origin}/v2/voice/calls/${oaiCall.id}/end`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "requested" }),
  });
  assert.equal(endOaiRes.status, 200);
  const endedOai = (await endOaiRes.json()) as { state: string; reason: string };
  assert.equal(endedOai.state, "ended");
  assert.equal(endedOai.reason, "requested");
  assert.equal(hangupCalled, 1);

  // ---- 2. ElevenLabs ConvAI call + transcript + tool webhook + HMAC post-call ----
  const createElRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "elevenlabs",
      voice: "alloy",
      subject: "discord:user_2",
      speakers: { u2: "Bob" },
    }),
  });
  assert.equal(createElRes.status, 201, await createElRes.clone().text());
  const elCall = (await createElRes.json()) as {
    id: string;
    state: string;
    connect: { signedUrl: string; conversationId: string };
  };
  assert.equal(elCall.state, "live");
  assert.equal(elCall.connect.conversationId, "conv_el_999");
  assert.equal(elevenWebhookRegistered, 1);
  assert.equal(elevenAgentCreated, 1);
  assert.ok(elevenToolSecret.length > 10);

  // Client transcript accepted on ElevenLabs
  const trRes = await worker.fetch(`${origin}/v2/voice/calls/${elCall.id}/transcript`, {
    method: "POST",
    headers,
    body: JSON.stringify({ speaker: "u2", text: "Hey bot, check the weather", seconds: 2.5 }),
  });
  assert.equal(trRes.status, 202);

  // ElevenLabs inbound tool call with wrong secret → 404
  const badToolRes = await worker.fetch(`${origin}/v2/voice/providers/elevenlabs/tools/ask_agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Voice-Tool-Secret": "wrong-secret" },
    body: JSON.stringify({ conversation_id: "conv_el_999", request: "hello" }),
  });
  assert.equal(badToolRes.status, 404);

  // ElevenLabs inbound tool call with valid secret → executes AgentDO run and returns reply
  const goodToolRes = await worker.fetch(`${origin}/v2/voice/providers/elevenlabs/tools/ask_agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Voice-Tool-Secret": elevenToolSecret },
    body: JSON.stringify({ conversation_id: "conv_el_999", request: "Say hello to Bob" }),
  });
  assert.equal(goodToolRes.status, 200);
  const toolOut = (await goodToolRes.json()) as { reply?: string };
  assert.ok(toolOut.reply && toolOut.reply.length > 0);

  // ElevenLabs post-call with invalid signature → 400
  const postPayload = JSON.stringify({
    type: "post_call_transcription",
    data: {
      agent_id: "el_agt_1",
      conversation_id: "conv_el_999",
      metadata: { call_duration_secs: 42.3, termination_reason: "Client disconnected" },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const badSigRes = await worker.fetch(`${origin}/v2/voice/providers/elevenlabs/post-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": `t=${ts},v0=${"0".repeat(64)}` },
    body: postPayload,
  });
  assert.equal(badSigRes.status, 400);

  // ElevenLabs post-call with valid HMAC signature → settles duration and marks ended
  const validSig = createHmac("sha256", elevenWebhookSecret).update(`${ts}.`).update(postPayload).digest("hex");
  const goodPostRes = await worker.fetch(`${origin}/v2/voice/providers/elevenlabs/post-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": `t=${ts},v0=${validSig}` },
    body: postPayload,
  });
  assert.equal(goodPostRes.status, 200);

  const elAfterRes = await worker.fetch(`${origin}/v2/voice/calls/${elCall.id}`, { headers });
  assert.equal(elAfterRes.status, 200);
  const elAfter = (await elAfterRes.json()) as { state: string; reason: string; audioSeconds: number; costUsd: number };
  assert.equal(elAfter.state, "ended");
  assert.equal(elAfter.reason, "client");
  assert.equal(elAfter.audioSeconds, 43);
  assert.ok(elAfter.costUsd > 0);

  // Pending voice transcript notes are flushed immediately on call end without waiting for the alarm
  const historyRes = await worker.fetch(`${origin}/v2/agents/${agentId}/history`, { headers });
  assert.equal(historyRes.status, 200);
  const history = (await historyRes.json()) as { messages: Array<{ content?: { text?: string } }> };
  assert.ok(
    history.messages.some((m) => m.content?.text?.includes("Hey bot, check the weather")),
    "Expected voice transcript note to be flushed immediately when call finished",
  );

  // List calls
  const listRes = await worker.fetch(`${origin}/v2/voice/calls?state=ended`, { headers });
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { calls: Array<{ id: string }> };
  assert.equal(list.calls.length, 2);
});

test("VoiceCallDO alarm cadence stays <= 6/min, flushes notes on end, and bounds ended note retries", async (t) => {
  const elevenWebhookSecret = "whsec_alarm_cadence_test";
  let convSeq = 0;
  const mockUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/v1/workspace/webhooks") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ webhook_id: "wh_el_alarm", webhook_secret: elevenWebhookSecret }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/tools") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "tool_alarm" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/agents/create") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ agent_id: "el_agt_alarm" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/conversation/get-signed-url") {
        const convId = `conv_el_alarm_${++convSeq}`;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?conversation_id=${convId}`, conversation_id: convId }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    mockUpstream.closeAllConnections();
    mockUpstream.close();
  });
  const port = (mockUpstream.address() as { port: number }).port;
  const mockOrigin = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-voice-alarm-cadence-"));
  const indexEntry = fileURLToPath(new URL("../worker/src/index.ts", import.meta.url));
  const voiceDoEntry = fileURLToPath(new URL("../worker/src/voice-call-do.ts", import.meta.url));
  const wrapperPath = join(dir, "wrapper.ts");
  writeFileSync(
    wrapperPath,
    `
import app, { TenantDO, AgentDO as BaseAgentDO, VoiceCallDO as BaseVoiceCallDO } from ${JSON.stringify(indexEntry)};
import { NOTE_MS, NOTE_RETRY_MS, ENDING_RETRY_MS, CHARGE_RETRY_MS, ALARM_ERROR_RETRY_MS } from ${JSON.stringify(voiceDoEntry)};
export { TenantDO };

export class AgentDO extends BaseAgentDO {
  private failNotes = false;
  setFailNotes(fail: boolean): void { this.failNotes = fail; }
  override async appendPassiveNote(text: string, meta?: Record<string, unknown>): Promise<{ ok: true }> {
    if (this.failNotes) throw new Error("synthetic note failure");
    return super.appendPassiveNote(text, meta);
  }
}

export class VoiceCallDO extends BaseVoiceCallDO {
  async inspectAlarm(): Promise<{ alarm: number | null; noteKeys: number; noteAt?: number; noteFailures?: number; state?: string }> {
    const row = await this.ctx.storage.get<{ noteAt?: number; noteFailures?: number; call?: { state?: string } }>("call");
    const notes = await this.ctx.storage.list({ prefix: "note:" });
    return {
      alarm: await this.ctx.storage.getAlarm(),
      noteKeys: notes.size,
      noteAt: row?.noteAt,
      noteFailures: row?.noteFailures,
      state: row?.call?.state,
    };
  }
  async forceFlushAlarmNow(): Promise<void> {
    const row = await this.ctx.storage.get<Record<string, unknown>>("call");
    if (row && typeof row.noteAt === "number") {
      row.noteAt = Date.now() - 1;
      await this.ctx.storage.put("call", row);
    }
    await this.alarm();
  }
}

export default {
  ...app,
  async fetch(request: Request, env: Record<string, any>, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_test/constants") {
      return Response.json({ NOTE_MS, NOTE_RETRY_MS, ENDING_RETRY_MS, CHARGE_RETRY_MS, ALARM_ERROR_RETRY_MS });
    }
    if (url.pathname === "/_test/fail-notes") {
      const agentId = url.searchParams.get("agentId")!;
      const fail = url.searchParams.get("fail") === "1";
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId));
      await stub.setFailNotes(fail);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/_test/inspect-voice") {
      const callId = url.searchParams.get("callId")!;
      const stub = env.VOICE_CALL_DO.get(env.VOICE_CALL_DO.idFromName(callId));
      return Response.json(await stub.inspectAlarm());
    }
    if (url.pathname === "/_test/trigger-voice-alarm") {
      const callId = url.searchParams.get("callId")!;
      const stub = env.VOICE_CALL_DO.get(env.VOICE_CALL_DO.idFromName(callId));
      await stub.forceFlushAlarmNow();
      return Response.json(await stub.inspectAlarm());
    }
    return app.fetch(request, env, ctx);
  },
};
`,
  );

  const config = join(dir, "wrangler.json");
  const admin = "fixture-voice-alarm-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-voice-alarm-test",
      main: wrapperPath,
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-voice-vault-32-bytes-minimum",
        DEFAULT_MODEL: "mock/default",
        ELEVENLABS_API_KEY: "sk-test-elevenlabs-platform",
        VOICE_ELEVENLABS_BASE_URL: mockOrigin,
        VOICE_PUBLIC_URL: "https://voice-alarm.test",
        AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "0.08",
        AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD: "0.001",
        AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD: "0.012",
        AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD: "0.003",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://voice-alarm.test";

  const constantsRes = await worker.fetch(`${origin}/_test/constants`);
  const constants = (await constantsRes.json()) as Record<string, number>;
  assert.ok(constants.NOTE_MS! >= 10_000);
  assert.ok(constants.NOTE_RETRY_MS! >= 15_000);
  assert.ok(constants.ENDING_RETRY_MS! >= 10_000);
  assert.ok(constants.CHARGE_RETRY_MS! >= 10_000);
  assert.ok(constants.ALARM_ERROR_RETRY_MS! >= 15_000);

  const tenantRes = await worker.fetch(`${origin}/v2/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({ name: "voice-alarm-test", initialCreditsUsd: 50 }),
  });
  assert.equal(tenantRes.status, 201);
  const { apiKey } = (await tenantRes.json()) as { apiKey: string };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const agtRes = await worker.fetch(`${origin}/v2/agents/alarm-bot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "Voice alarm test bot." }),
  });
  assert.equal(agtRes.status, 201);
  const { id: agentId } = (await agtRes.json()) as { id: string };

  // 1. Live speech batches notes on a 10s cadence and flushes immediately on /end
  const createRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agentId, provider: "elevenlabs", subject: "user:1" }),
  });
  assert.equal(createRes.status, 201, await createRes.clone().text());
  const call1 = (await createRes.json()) as { id: string };

  const beforeUtterance = Date.now();
  for (let i = 1; i <= 5; i++) {
    const tr = await worker.fetch(`${origin}/v2/voice/calls/${call1.id}/transcript`, {
      method: "POST",
      headers,
      body: JSON.stringify({ speaker: "u1", text: `Line ${i}`, seconds: 1 }),
    });
    assert.equal(tr.status, 202);
  }
  const liveInspect = (await (await worker.fetch(`${origin}/_test/inspect-voice?callId=${call1.id}`)).json()) as {
    alarm: number | null;
    noteKeys: number;
    noteAt?: number;
  };
  assert.equal(liveInspect.noteKeys, 5);
  assert.ok(liveInspect.alarm !== null && liveInspect.alarm >= beforeUtterance + 9_000, `Expected >=10s note alarm, got ${liveInspect.alarm! - beforeUtterance}ms`);
  assert.equal(liveInspect.alarm, liveInspect.noteAt);

  // Ending the call flushes all 5 notes immediately and schedules only the 15-min grace deadline
  const endRes = await worker.fetch(`${origin}/v2/voice/calls/${call1.id}/end`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "requested" }),
  });
  assert.equal(endRes.status, 200);
  const endingInspect = (await (await worker.fetch(`${origin}/_test/inspect-voice?callId=${call1.id}`)).json()) as {
    alarm: number | null;
    noteKeys: number;
    noteAt?: number;
    state?: string;
  };
  assert.equal(endingInspect.state, "ending");
  assert.equal(endingInspect.noteKeys, 0);
  assert.equal(endingInspect.noteAt, undefined);
  assert.ok(endingInspect.alarm !== null && endingInspect.alarm > Date.now() + 600_000, "Expected 15-minute grace alarm, not a short poll");

  const histRes = await worker.fetch(`${origin}/v2/agents/${agentId}/history`, { headers });
  const hist = (await histRes.json()) as { messages: Array<{ content?: { text?: string } }> };
  assert.ok(hist.messages.some((m) => m.content?.text?.includes("Line 5")), "Expected all queued notes flushed on /end");

  // 2. Transient note flush failures back off >= 15s and stop retrying on ended calls
  const createRes2 = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agentId, provider: "elevenlabs", subject: "user:2" }),
  });
  assert.equal(createRes2.status, 201);
  const call2 = (await createRes2.json()) as { id: string; connect: { conversationId: string } };

  await worker.fetch(`${origin}/_test/fail-notes?agentId=${agentId}&fail=1`);
  const tr2 = await worker.fetch(`${origin}/v2/voice/calls/${call2.id}/transcript`, {
    method: "POST",
    headers,
    body: JSON.stringify({ speaker: "u2", text: "Will fail flush", seconds: 1 }),
  });
  assert.equal(tr2.status, 202);

  // First flush failure while live backs off by >= 15s
  const beforeFail = Date.now();
  const afterFail1 = (await (await worker.fetch(`${origin}/_test/trigger-voice-alarm?callId=${call2.id}`)).json()) as {
    alarm: number | null;
    noteKeys: number;
    noteFailures?: number;
  };
  assert.equal(afterFail1.noteKeys, 1);
  assert.equal(afterFail1.noteFailures, 1);
  assert.ok(afterFail1.alarm !== null && afterFail1.alarm >= beforeFail + 14_000, `Expected >=15s retry backoff, got ${afterFail1.alarm! - beforeFail}ms`);

  // Settle call via post-call -> finish() attempts flush (failure #2) and arms 15s retry
  const postPayload = JSON.stringify({
    type: "post_call_transcription",
    data: {
      agent_id: "el_agt_alarm",
      conversation_id: call2.connect.conversationId,
      metadata: { call_duration_secs: 10, termination_reason: "Client disconnected" },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", elevenWebhookSecret).update(`${ts}.`).update(postPayload).digest("hex");
  const postRes = await worker.fetch(`${origin}/v2/voice/providers/elevenlabs/post-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": `t=${ts},v0=${sig}` },
    body: postPayload,
  });
  assert.equal(postRes.status, 200);

  // Trigger final retry (#3) on ended call -> drops pending note and clears alarm completely
  const afterEndedCap = (await (await worker.fetch(`${origin}/_test/trigger-voice-alarm?callId=${call2.id}`)).json()) as {
    alarm: number | null;
    noteKeys: number;
    noteAt?: number;
    state?: string;
  };
  assert.equal(afterEndedCap.state, "ended");
  assert.equal(afterEndedCap.noteKeys, 0);
  assert.equal(afterEndedCap.noteAt, undefined);
  assert.equal(afterEndedCap.alarm, null);
});

test("ElevenLabs admin diagnostics, cache reset, and stale-agent 404 auto-reprovision", async (t) => {
  const elevenApiKey = "sk-test-elevenlabs-super-secret-key";
  const elevenWebhookSecret = "whsec_diag_super_secret";
  let lastToolSecret = "";
  let agentSeq = 0;
  let convSeq = 0;
  const deletedRemoteAgents = new Set<string>();

  const mockUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/v1/user/subscription") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            tier: "pro",
            status: "active",
            character_count: 600000,
            character_limit: 600000,
            can_extend_character_limit: false,
            allowed_to_extend_character_limit: false,
            next_character_count_reset_unix: 1797816239,
            currency: "usd",
            billing_period: "monthly_period",
            character_refresh_period: "monthly_period",
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/agents") {
        res.setHeader("Content-Type", "application/json");
        const agents = Array.from({ length: agentSeq }, (_, i) => `el_diag_agt_${i + 1}`)
          .filter((id) => !deletedRemoteAgents.has(id))
          .map((id) => ({ agent_id: id, name: `camelRun voice gemini-3.1-flash-lite ${id}`, archived: false }));
        res.end(JSON.stringify({ agents, has_more: false }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/convai/agents/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/convai/agents/".length));
        if (deletedRemoteAgents.has(id)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: { status: "not_found", message: "Agent not found" } }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            agent_id: id,
            name: `camelRun voice ${id}`,
            archived: false,
            conversation_config: {
              agent: { prompt: { llm: "gemini-3.1-flash-lite", tool_ids: ["tool_a", "tool_b"] } },
              tts: { model_id: "eleven_v4_turbo", voice_id: "cgSgspJ2msm6clMCkdW9" },
            },
            platform_settings: {
              auth: { enable_auth: true },
              workspace_overrides: { webhooks: { post_call_webhook_id: "wh_diag_1" } },
            },
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/conversations") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            conversations: [
              {
                conversation_id: "conv_failed_1",
                agent_id: "el_diag_agt_1",
                status: "failed",
                call_successful: "unknown",
                start_time_unix_secs: 1795559462,
                call_duration_secs: 0,
                message_count: 0,
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/conversations/conv_failed_1") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            conversation_id: "conv_failed_1",
            status: "failed",
            metadata: {
              termination_reason: "",
              error: {
                code: 3000,
                reason: "The AI agent you are trying to reach is not available.",
                error_type: "call_initialization_error",
              },
            },
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/workspace/webhooks") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ webhook_id: "wh_diag_1", webhook_secret: elevenWebhookSecret }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/tools") {
        const parsed = JSON.parse(raw) as {
          tool_config?: { name?: string; api_schema?: { request_headers?: Record<string, string> } };
        };
        if (parsed.tool_config?.api_schema?.request_headers?.["X-Voice-Tool-Secret"]) {
          lastToolSecret = parsed.tool_config.api_schema.request_headers["X-Voice-Tool-Secret"];
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: `tool_${parsed.tool_config?.name ?? "x"}` }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/convai/agents/create") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ agent_id: `el_diag_agt_${++agentSeq}` }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/convai/conversation/get-signed-url") {
        const agentId = url.searchParams.get("agent_id") ?? "";
        if (deletedRemoteAgents.has(agentId)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: { status: "not_found", message: "Agent not found" } }));
          return;
        }
        const convId = `conv_diag_${++convSeq}`;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&conversation_id=${convId}`,
            conversation_id: convId,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    mockUpstream.closeAllConnections();
    mockUpstream.close();
  });
  const port = (mockUpstream.address() as { port: number }).port;
  const mockOrigin = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-voice-eleven-diag-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-eleven-diag-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-voice-eleven-diag-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-voice-vault-32-bytes-minimum",
        DEFAULT_MODEL: "mock/default",
        ELEVENLABS_API_KEY: elevenApiKey,
        VOICE_ELEVENLABS_BASE_URL: mockOrigin,
        VOICE_PUBLIC_URL: "https://voice-diag.test",
        AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "0.08",
        AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD: "0.001",
        AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD: "0.012",
        AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD: "0.003",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://voice-diag.test";

  // Admin endpoints require X-Admin-Key
  assert.equal((await worker.fetch(`${origin}/v2/admin/voice/elevenlabs`)).status, 401);
  assert.equal((await worker.fetch(`${origin}/v2/admin/voice/elevenlabs/reset`, { method: "POST" })).status, 401);

  const tenantRes = await worker.fetch(`${origin}/v2/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({ name: "voice-diag-test", initialCreditsUsd: 50 }),
  });
  assert.equal(tenantRes.status, 201);
  const { apiKey } = (await tenantRes.json()) as { apiKey: string };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const agtRes = await worker.fetch(`${origin}/v2/agents/diag-bot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "Diag bot." }),
  });
  assert.equal(agtRes.status, 201);
  const { id: agentId } = (await agtRes.json()) as { id: string };

  // Provision first ElevenLabs agent
  const call1Res = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agentId, provider: "elevenlabs", subject: "u1" }),
  });
  assert.equal(call1Res.status, 201, await call1Res.clone().text());
  assert.equal(agentSeq, 1);

  // Inspect live diagnostics -> verifies subscription quota, conversations error, cache, and zero secret leaks
  const diagRes = await worker.fetch(`${origin}/v2/admin/voice/elevenlabs`, {
    headers: { "X-Admin-Key": admin },
  });
  assert.equal(diagRes.status, 200);
  const diagRaw = await diagRes.text();
  assert.ok(!diagRaw.includes(elevenApiKey), "Diagnostics must never leak ELEVENLABS_API_KEY");
  assert.ok(!diagRaw.includes(elevenWebhookSecret), "Diagnostics must never leak webhook secret");
  assert.ok(!diagRaw.includes(lastToolSecret), "Diagnostics must never leak tool secret");
  assert.ok(!diagRaw.includes("sealedToolSecret"), "Diagnostics must never expose sealedToolSecret");
  const diag = JSON.parse(diagRaw) as {
    configured: boolean;
    subscription: {
      ok: boolean;
      tier: string;
      characterCount: number;
      characterLimit: number;
      charactersRemaining: number;
      quotaExhausted: boolean;
      nextCharacterCountResetAt: string;
    };
    conversations: { ok: boolean; items: Array<{ error?: { code?: number; reason?: string } }> };
    cache: { ok: boolean; agents: Array<{ agentId: string; remoteStatus: string; remoteTtsModelId: string }> };
  };
  assert.equal(diag.configured, true);
  assert.equal(diag.subscription.ok, true);
  assert.equal(diag.subscription.tier, "pro");
  assert.equal(diag.subscription.characterCount, 600000);
  assert.equal(diag.subscription.characterLimit, 600000);
  assert.equal(diag.subscription.charactersRemaining, 0);
  assert.equal(diag.subscription.quotaExhausted, true);
  assert.equal(diag.subscription.nextCharacterCountResetAt, "2026-12-21T01:23:59.000Z");
  assert.equal(diag.conversations.items[0]?.error?.code, 3000);
  assert.equal(diag.cache.agents.length, 1);
  assert.equal(diag.cache.agents[0]?.agentId, "el_diag_agt_1");
  assert.equal(diag.cache.agents[0]?.remoteStatus, "ok");
  assert.equal(diag.cache.agents[0]?.remoteTtsModelId, "eleven_v4_turbo");

  // Simulate cached agent deleted remotely on ElevenLabs -> next call auto-evicts and reprovisions el_diag_agt_2
  deletedRemoteAgents.add("el_diag_agt_1");
  const call2Res = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agentId, provider: "elevenlabs", subject: "u2" }),
  });
  assert.equal(call2Res.status, 201, await call2Res.clone().text());
  const call2 = (await call2Res.json()) as { connect: { signedUrl: string } };
  assert.equal(agentSeq, 2);
  assert.ok(call2.connect.signedUrl.includes("agent_id=el_diag_agt_2"));

  // Admin reset clears cached agents -> subsequent call reprovisions el_diag_agt_3
  const resetRes = await worker.fetch(`${origin}/v2/admin/voice/elevenlabs/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({}),
  });
  assert.equal(resetRes.status, 200);
  const resetOut = (await resetRes.json()) as { ok: boolean; deletedAgents: number; deletedWebhooks: number };
  assert.equal(resetOut.ok, true);
  assert.equal(resetOut.deletedAgents, 1);
  assert.equal(resetOut.deletedWebhooks, 0);

  const call3Res = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agentId, provider: "elevenlabs", subject: "u3" }),
  });
  assert.equal(call3Res.status, 201, await call3Res.clone().text());
  assert.equal(agentSeq, 3);
});

test("openaiCalls Azure Realtime GA redacts both apiKey and ephemeralKey across all error paths", async () => {
  const apiKey = "az-secret-key-99";
  const ephemeralKey = "ek_ephem_77";
  const noopEvents: SidebandEvents = {
    responseStarted() {},
    responseDone() {},
    heard() {},
    said() {},
    toolCall() {},
    rateLimits() {},
    warning() {},
    closed() {},
  };

  // 1. Step 1 (client_secrets) error redacts apiKey
  const client1 = openaiCalls({
    baseUrl: "https://azure.example/openai/v1",
    azure: true,
    fetch: (async (input, init) => {
      const url = String(input);
      assert.equal(url, "https://azure.example/openai/v1/realtime/client_secrets");
      assert.equal((init?.headers as Record<string, string>)["api-key"], apiKey);
      return new Response(`bad request for key ${apiKey}`, { status: 400 });
    }) as typeof fetch,
  });
  await assert.rejects(
    client1.create(
      { sdp: "v=0\r\n", model: "gpt-realtime-2.1", voice: "alloy", instructions: "hi", tools: [], apiKey },
      noopEvents,
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 400/);
      assert.ok(!err.message.includes(apiKey), `Leaked apiKey in: ${err.message}`);
      return true;
    },
  );

  // 2. Step 2 (calls) error redacts both apiKey and ephemeralKey
  const client2 = openaiCalls({
    baseUrl: "https://azure.example/openai/v1",
    azure: true,
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/realtime/client_secrets")) {
        return Response.json({ value: ephemeralKey }, { status: 200 });
      }
      assert.equal(url, "https://azure.example/openai/v1/realtime/calls");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${ephemeralKey}`);
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/sdp");
      return new Response(`failed with ${apiKey} and ${ephemeralKey}`, { status: 422 });
    }) as typeof fetch,
  });
  await assert.rejects(
    client2.create(
      { sdp: "v=0\r\n", model: "gpt-realtime-2.1", voice: "alloy", instructions: "hi", tools: [], apiKey },
      noopEvents,
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 422/);
      assert.ok(!err.message.includes(apiKey), `Leaked apiKey in: ${err.message}`);
      assert.ok(!err.message.includes(ephemeralKey), `Leaked ephemeralKey in: ${err.message}`);
      return true;
    },
  );

  // 3. Step 3 (sideband) error redacts both keys and calls hangup with api-key
  let hangupApiKey = "";
  const client3 = openaiCalls({
    baseUrl: "https://azure.example/openai/v1",
    azure: true,
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/realtime/client_secrets")) {
        return Response.json({ value: ephemeralKey }, { status: 200 });
      }
      if (url.endsWith("/realtime/calls")) {
        return new Response("v=0\r\ns=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/realtime/calls/rtc_sb_fail" },
        });
      }
      if (url.includes("/realtime?call_id=rtc_sb_fail")) {
        assert.equal((init?.headers as Record<string, string>)["api-key"], apiKey);
        return new Response(`ws denied ${apiKey} ${ephemeralKey}`, { status: 403 });
      }
      if (url.endsWith("/realtime/calls/rtc_sb_fail/hangup")) {
        hangupApiKey = (init?.headers as Record<string, string>)["api-key"] ?? "";
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });
  await assert.rejects(
    client3.create(
      { sdp: "v=0\r\n", model: "gpt-realtime-2.1", voice: "alloy", instructions: "hi", tools: [], apiKey },
      noopEvents,
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 403/);
      assert.ok(!err.message.includes(apiKey), `Leaked apiKey in: ${err.message}`);
      assert.ok(!err.message.includes(ephemeralKey), `Leaked ephemeralKey in: ${err.message}`);
      return true;
    },
  );
  assert.equal(hangupApiKey, apiKey);

  // 4. Step 4 (hangup) error redacts apiKey
  const client4 = openaiCalls({
    baseUrl: "https://azure.example/openai/v1",
    azure: true,
    fetch: (async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>)["api-key"], apiKey);
      return new Response(`hangup error ${apiKey}`, { status: 500 });
    }) as typeof fetch,
  });
  await assert.rejects(client4.hangup("rtc_1", apiKey), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes(apiKey), `Leaked apiKey in: ${err.message}`);
    return true;
  });
});

test("VoiceCallDO Azure OpenAI Realtime GA via AZURE_OPENAI_LUNA_* without OPENAI_API_KEY", async (t) => {
  const azureApiKey = "az-luna-realtime-secret-key";
  const ephemeralKey = "ek_azure_luna_ephemeral_123";
  let failStep2WithSecrets = false;
  const sidebandMessages: Array<Record<string, unknown>> = [];
  let sidebandSocket: Duplex | null = null;
  let clientSecretsCalls = 0;
  let sdpCalls = 0;
  let wsUpgrades = 0;
  let hangupCalls = 0;

  const mockAzure = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // Step 1: POST /openai/v1/realtime/client_secrets with api-key
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/client_secrets") {
        clientSecretsCalls++;
        assert.equal(req.headers["api-key"], azureApiKey);
        assert.equal(req.headers.authorization, undefined);
        assert.match(String(req.headers["content-type"] ?? ""), /^application\/json/i);
        const body = JSON.parse(raw) as {
          session?: {
            type?: string;
            model?: string;
            output_modalities?: string[];
            audio?: { input?: { transcription?: { model?: string } }; output?: { voice?: string } };
            tools?: Array<{ name?: string }>;
          };
        };
        assert.equal(body.session?.type, "realtime");
        assert.equal(body.session?.model, "gpt-realtime-2.1");
        assert.deepEqual(body.session?.output_modalities, ["audio"]);
        assert.equal(body.session?.audio?.input?.transcription?.model, "gpt-transcribe");
        assert.equal(body.session?.audio?.output?.voice, "alloy");
        assert.ok(body.session?.tools?.some((tool) => tool.name === "ask_agent"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: ephemeralKey }));
        return;
      }

      // Step 2: POST /openai/v1/realtime/calls with Bearer ephemeralKey + application/sdp
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/calls") {
        sdpCalls++;
        assert.equal(req.headers.authorization, `Bearer ${ephemeralKey}`);
        assert.equal(req.headers["api-key"], undefined);
        assert.match(String(req.headers["content-type"] ?? ""), /^application\/sdp/i);
        assert.ok(raw.startsWith("v=0\r\n"), `Expected raw SDP body, got: ${raw}`);
        if (failStep2WithSecrets) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`SDP rejected for ${azureApiKey} and ${ephemeralKey}`);
          return;
        }
        res.writeHead(201, {
          "Content-Type": "application/sdp",
          Location: "/v1/realtime/calls/rtc_azure_luna_1",
        });
        res.end("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=azure-answer\r\n");
        return;
      }

      // Step 4: POST /openai/v1/realtime/calls/:id/hangup with api-key
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/calls/rtc_azure_luna_1/hangup") {
        hangupCalls++;
        assert.equal(req.headers["api-key"], azureApiKey);
        assert.equal(req.headers.authorization, undefined);
        res.writeHead(200);
        res.end("");
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  // Step 3: GET /openai/v1/realtime?call_id=rtc_azure_luna_1 with api-key
  mockAzure.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    wsUpgrades++;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    assert.equal(url.pathname, "/openai/v1/realtime");
    assert.equal(url.searchParams.get("call_id"), "rtc_azure_luna_1");
    assert.equal(req.headers["api-key"], azureApiKey);
    assert.equal(req.headers.authorization, undefined);
    const key = req.headers["sec-websocket-key"];
    assert.ok(typeof key === "string");
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sidebandSocket = socket;
    attachWsClientFrames(socket, (text) => {
      sidebandMessages.push(JSON.parse(text) as Record<string, unknown>);
    });
  });

  await new Promise<void>((resolve) => mockAzure.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sidebandSocket?.destroy();
    mockAzure.closeAllConnections();
    mockAzure.close();
  });
  const azurePort = (mockAzure.address() as { port: number }).port;
  const mockAzureOrigin = `http://127.0.0.1:${azurePort}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-voice-azure-luna-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-azure-luna-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-voice-azure-luna-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-voice-vault-32-bytes-minimum",
        DEFAULT_MODEL: "mock/default",
        // Intentionally NO OPENAI_API_KEY and NO VOICE_OPENAI_BASE_URL
        AZURE_OPENAI_LUNA_ENDPOINT: mockAzureOrigin,
        AZURE_OPENAI_LUNA_API_KEY: azureApiKey,
        VOICE_PUBLIC_URL: "https://voice-azure.test",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://voice-azure.test";

  const createTenantRes = await worker.fetch(`${origin}/v2/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({ name: "azure-voice-test", initialCreditsUsd: 50 }),
  });
  assert.equal(createTenantRes.status, 201);
  const { apiKey } = (await createTenantRes.json()) as { apiKey: string };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const agtRes = await worker.fetch(`${origin}/v2/agents/azure-bot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "Azure voice bot." }),
  });
  assert.equal(agtRes.status, 201);
  const { id: agentId } = (await agtRes.json()) as { id: string };

  // 1. Platform gpt-realtime-2.1 succeeds via Azure even without OPENAI_API_KEY
  const createRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "alloy",
      subject: "user:azure-1",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n",
    }),
  });
  assert.equal(createRes.status, 201, await createRes.clone().text());
  const call = (await createRes.json()) as { id: string; state: string; connect: { sdpAnswer: string } };
  assert.equal(call.state, "live");
  assert.ok(call.connect.sdpAnswer.includes("s=azure-answer"));
  assert.equal(clientSecretsCalls, 1);
  assert.equal(sdpCalls, 1);
  assert.equal(wsUpgrades, 1);

  // Sideband ask_agent works over Azure sideband WS
  const socket = sidebandSocket as Duplex | null;
  assert.ok(socket);
  socket.write(
    wsEncodeText(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_az_1",
        call_id: "fc_az_1",
        name: "ask_agent",
        arguments: JSON.stringify({ request: "Say hi from Azure" }),
      }),
    ),
  );
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (
      sidebandMessages.some(
        (m) => m.type === "conversation.item.create" && (m.item as { call_id?: string })?.call_id === "fc_az_1",
      )
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    sidebandMessages.some(
      (m) => m.type === "conversation.item.create" && (m.item as { call_id?: string })?.call_id === "fc_az_1",
    ),
  );

  // Hangup hits Azure with api-key
  const endRes = await worker.fetch(`${origin}/v2/voice/calls/${call.id}/end`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "requested" }),
  });
  assert.equal(endRes.status, 200, await endRes.clone().text());
  assert.equal(hangupCalls, 1);

  // 2. gpt-realtime-2.1-mini is NOT routed to Azure -> fails 400 when OPENAI_API_KEY is absent
  const miniRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1-mini",
      subject: "user:azure-mini",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n",
    }),
  });
  assert.equal(miniRes.status, 400);
  const miniErr = (await miniRes.json()) as { error?: { code?: string } };
  assert.equal(miniErr.error?.code, "realtime_unavailable");
  assert.equal(clientSecretsCalls, 1);

  // 3. Step 2 failure redacts both Azure apiKey and ephemeralKey in API response
  failStep2WithSecrets = true;
  const failRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1",
      subject: "user:azure-fail",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=offer\r\n",
    }),
  });
  assert.equal(failRes.status, 502);
  const failText = await failRes.text();
  assert.ok(!failText.includes(azureApiKey), `Leaked azureApiKey: ${failText}`);
  assert.ok(!failText.includes(ephemeralKey), `Leaked ephemeralKey: ${failText}`);
});

test("VoiceCallDO routing isolation: Azure platform gpt-realtime-2.1 vs direct OpenAI mini and BYOK tenant key", async (t) => {
  const azureApiKey = "az-dedicated-rt-key";
  const ephemeralKey = "ek_dedicated_rt_456";
  const platformOpenAiKey = "sk-platform-direct-openai";
  const byokOpenAiKey = "sk-tenant-byok-openai";

  const azureLog: string[] = [];
  const directLog: Array<{ step: string; auth: string }> = [];
  const sockets: Duplex[] = [];

  const mockAzure = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/client_secrets") {
        assert.equal(req.headers["api-key"], azureApiKey);
        azureLog.push("client_secrets");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: ephemeralKey }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/calls") {
        assert.equal(req.headers.authorization, `Bearer ${ephemeralKey}`);
        azureLog.push("calls");
        res.writeHead(201, {
          "Content-Type": "application/sdp",
          Location: "/v1/realtime/calls/rtc_az_iso_1",
        });
        res.end("v=0\r\ns=az-iso-answer\r\n");
        return;
      }
      if (req.method === "POST" && url.pathname === "/openai/v1/realtime/calls/rtc_az_iso_1/hangup") {
        assert.equal(req.headers["api-key"], azureApiKey);
        azureLog.push("hangup");
        res.writeHead(200);
        res.end("");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  mockAzure.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    assert.equal(req.headers["api-key"], azureApiKey);
    azureLog.push("ws");
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
  });

  let directSeq = 0;
  const mockDirect = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/v1/realtime/calls") {
        assert.equal(req.headers["api-key"], undefined);
        assert.match(raw, /Content-Disposition: form-data; name="sdp"\r\n/);
        directLog.push({ step: "calls", auth: String(req.headers.authorization ?? "") });
        const id = `rtc_direct_${++directSeq}`;
        res.writeHead(201, {
          "Content-Type": "application/sdp",
          Location: `https://api.openai.com/v1/realtime/calls/${id}`,
        });
        res.end(`v=0\r\ns=direct-answer-${directSeq}\r\n`);
        return;
      }
      if (req.method === "POST" && /^\/v1\/realtime\/calls\/rtc_direct_\d+\/hangup$/.test(url.pathname)) {
        assert.equal(req.headers["api-key"], undefined);
        directLog.push({ step: "hangup", auth: String(req.headers.authorization ?? "") });
        res.writeHead(200);
        res.end("");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  mockDirect.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    assert.equal(req.headers["api-key"], undefined);
    directLog.push({ step: "ws", auth: String(req.headers.authorization ?? "") });
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
  });

  await Promise.all([
    new Promise<void>((resolve) => mockAzure.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => mockDirect.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(() => {
    for (const s of sockets) s.destroy();
    mockAzure.closeAllConnections();
    mockAzure.close();
    mockDirect.closeAllConnections();
    mockDirect.close();
  });
  const azureOrigin = `http://127.0.0.1:${(mockAzure.address() as { port: number }).port}`;
  const directOrigin = `http://127.0.0.1:${(mockDirect.address() as { port: number }).port}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-voice-routing-iso-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-routing-iso-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-voice-routing-iso-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-voice-vault-32-bytes-minimum",
        DEFAULT_MODEL: "mock/default",
        OPENAI_API_KEY: platformOpenAiKey,
        VOICE_OPENAI_BASE_URL: `${directOrigin}/v1`,
        AZURE_OPENAI_REALTIME_ENDPOINT: azureOrigin,
        AZURE_OPENAI_REALTIME_API_KEY: azureApiKey,
        VOICE_PUBLIC_URL: "https://voice-iso.test",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://voice-iso.test";

  const tenantRes = await worker.fetch(`${origin}/v2/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": admin },
    body: JSON.stringify({ name: "routing-iso-test", initialCreditsUsd: 50 }),
  });
  assert.equal(tenantRes.status, 201);
  const { apiKey } = (await tenantRes.json()) as { apiKey: string };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const agtRes = await worker.fetch(`${origin}/v2/agents/iso-bot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "Routing bot." }),
  });
  assert.equal(agtRes.status, 201);
  const { id: agentId } = (await agtRes.json()) as { id: string };

  // 1. Platform gpt-realtime-2.1 -> Azure Realtime
  const azCallRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1",
      subject: "u:platform-full",
      sdp: "v=0\r\ns=offer\r\n",
    }),
  });
  assert.equal(azCallRes.status, 201, await azCallRes.clone().text());
  const azCall = (await azCallRes.json()) as { id: string; connect: { sdpAnswer: string } };
  assert.ok(azCall.connect.sdpAnswer.includes("s=az-iso-answer"));
  assert.equal((await worker.fetch(`${origin}/v2/voice/calls/${azCall.id}/end`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.deepEqual(azureLog, ["client_secrets", "calls", "ws", "hangup"]);
  assert.equal(directLog.length, 0);

  // 2. Platform gpt-realtime-2.1-mini -> direct OpenAI with platform OPENAI_API_KEY
  const miniCallRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1-mini",
      subject: "u:platform-mini",
      sdp: "v=0\r\ns=offer\r\n",
    }),
  });
  assert.equal(miniCallRes.status, 201, await miniCallRes.clone().text());
  const miniCall = (await miniCallRes.json()) as { id: string; connect: { sdpAnswer: string } };
  assert.ok(miniCall.connect.sdpAnswer.includes("s=direct-answer-1"));
  assert.equal((await worker.fetch(`${origin}/v2/voice/calls/${miniCall.id}/end`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.deepEqual(directLog, [
    { step: "calls", auth: `Bearer ${platformOpenAiKey}` },
    { step: "ws", auth: `Bearer ${platformOpenAiKey}` },
    { step: "hangup", auth: `Bearer ${platformOpenAiKey}` },
  ]);
  assert.equal(azureLog.length, 4);

  // 3. BYOK tenant OpenAI key -> direct OpenAI with tenant's BYOK key (NOT Azure!)
  const byokRes = await worker.fetch(`${origin}/v2/providers/openai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ apiKey: byokOpenAiKey }),
  });
  assert.equal(byokRes.status, 200, await byokRes.clone().text());

  const byokCallRes = await worker.fetch(`${origin}/v2/voice/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: agentId,
      provider: "openai",
      model: "gpt-realtime-2.1",
      subject: "u:byok-full",
      sdp: "v=0\r\ns=offer\r\n",
    }),
  });
  assert.equal(byokCallRes.status, 201, await byokCallRes.clone().text());
  const byokCall = (await byokCallRes.json()) as { id: string; connect: { sdpAnswer: string } };
  assert.ok(byokCall.connect.sdpAnswer.includes("s=direct-answer-2"));
  assert.equal((await worker.fetch(`${origin}/v2/voice/calls/${byokCall.id}/end`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.deepEqual(directLog.slice(3), [
    { step: "calls", auth: `Bearer ${byokOpenAiKey}` },
    { step: "ws", auth: `Bearer ${byokOpenAiKey}` },
    { step: "hangup", auth: `Bearer ${byokOpenAiKey}` },
  ]);
  assert.equal(azureLog.length, 4);
});
