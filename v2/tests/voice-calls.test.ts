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

  // List calls
  const listRes = await worker.fetch(`${origin}/v2/voice/calls?state=ended`, { headers });
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { calls: Array<{ id: string }> };
  assert.equal(list.calls.length, 2);
});
