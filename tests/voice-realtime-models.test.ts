import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceSessions } from "../src/voice-sessions.ts";
import { HttpError } from "../src/http.ts";
import { elevenlabsAgents } from "../src/voice/realtime/elevenlabs.ts";
import { NO_USAGE, realtimeCost, realtimePrice } from "../src/voice/realtime/provider.ts";
import type { Socket } from "../src/voice-providers/socket.ts";
import { fakeRealtimeProvider, testBrain, until } from "./voice-realtime-fakes.ts";

process.env.AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD = "1";
process.env.AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD = "7";
process.env.AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD = "0.25";

for (const model of [undefined, "gemini-new_1.0", "another-model", "m".repeat(100)]) {
  for (const interruptible of [true, false]) test(`ElevenLabs model ${model ?? "default"}, interruptible ${interruptible}: validation and agent creation`, async t => {
    const created: any[] = [];
    const socket: Socket = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    const provider = elevenlabsAgents({
      socket: () => socket,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.includes("/agents?")) return Response.json({ agents: [], has_more: false });
        if (path.includes("/v2/voices?")) return Response.json({ voices: [{ voice_id: provider.voices[0] }], has_more: false });
        if (path.endsWith("/agents/create")) {
          created.push(JSON.parse(String(init?.body)));
          return Response.json({ agent_id: "new-agent" });
        }
        assert.match(path, /get-signed-url\?agent_id=new-agent$/);
        return Response.json({ signed_url: "wss://unused.test" });
      },
    });
    const sessions = new VoiceSessions({ realtime: { providers: { elevenlabs: provider } } } as any);
    const input = (sessions as any).realtimeInput({ realtime: { provider: "elevenlabs", ...(model === undefined ? {} : { model }) } }, "alloy");
    const expected = model ?? "gemini-3.1-flash-lite";
    assert.equal(input.model, expected);
    const connect = provider.connect.bind(provider);
    provider.connect = (config, credentials, events) => connect({ ...config, voice: input.voice, interruptible }, credentials, events);
    const state = testBrain({ provider, reference: `elevenlabs/${input.model}`, ownsTurns: true });
    t.after(() => state.brain.close());
    await until(() => socket.onopen !== null, "agent provisioned");
    assert.equal(created.length, 1);
    const body = created[0];
    assert.equal(body.name, `${model === undefined ? "camelRun realtime voice v6" : `camelRun realtime voice v6 ${model}`}${interruptible ? "" : " (no interruptions)"}`);
    assert.equal(body.conversation_config.agent.prompt.llm, expected);
    assert.equal(body.conversation_config.agent.prompt.thinking_budget, model === undefined ? 0 : undefined);
    assert.equal(body.conversation_config.conversation.client_events.includes("interruption"), interruptible);
    assert.equal(realtimeCost(`elevenlabs/${expected}`, NO_USAGE, 60), model === undefined ? 8 : 1.25);
  });
}

test("ElevenLabs rejects malformed model names with 400, while other providers keep their allowlists", () => {
  const provider = elevenlabsAgents();
  const sessions = new VoiceSessions({ realtime: { providers: { elevenlabs: provider, openai: fakeRealtimeProvider().provider } } } as any);
  for (const model of ["", "with space", "model/name", "model\n", "é", "m".repeat(101), null, 42, {}]) {
    assert.throws(() => (sessions as any).realtimeInput({ realtime: { provider: "elevenlabs", model } }, "alloy"),
      (error: HttpError) => error.status === 400 && error.message.startsWith("realtime.model"));
  }
  assert.throws(() => (sessions as any).realtimeInput({ realtime: { provider: "openai", model: "gemini-new_1.0" } }, "alloy"),
    (error: HttpError) => error.status === 400 && error.message.startsWith("realtime.model must be one of"));
});

test("unlisted ElevenLabs pricing defaults to 0.05 plus Agents, with a configurable other LLM rate", () => {
  const reference = "elevenlabs/gemini-new_1.0";
  assert.deepEqual(realtimePrice(reference, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1" }), { perMinute: 1_050_000, perTextInput: 0 });
  assert.deepEqual(realtimePrice(reference, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1", AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD: "0.25" }), { perMinute: 1_250_000, perTextInput: 0 });
  assert.equal(realtimePrice(reference, {}), undefined);
  for (const [model, rate] of [["gemini-2.5-flash-lite", "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD"], ["claude-haiku-5-5", "AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD"], ["gemini-3.1-flash-lite", "AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD"]]) {
    assert.deepEqual(realtimePrice(`elevenlabs/${model}`, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1", [rate]: "2" }), { perMinute: 3_000_000, perTextInput: 0 });
    assert.equal(realtimePrice(`elevenlabs/${model}`, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1", AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD: "2" }), undefined);
  }
  for (const rate of ["0", "-1", "invalid"]) assert.throws(() => realtimePrice(reference, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1", AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD: rate }), /AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD/);
});

for (const [status, model] of [[400, "gemini-refused"], [422, "m".repeat(100)]] as const) test(`ElevenLabs refused model HTTP ${status}: names the model and does not reconnect`, async t => {
  let attempts = 0;
  let detail: string | undefined;
  let retryable: boolean | undefined;
  let failure: string | undefined;
  const provider = elevenlabsAgents({ fetch: async url => {
    const path = String(url);
    if (path.includes("/agents?")) return Response.json({ agents: [], has_more: false });
    if (path.includes("/v2/voices?")) return Response.json({ voices: [{ voice_id: "marin" }], has_more: false });
    assert.match(path, /\/agents\/create$/);
    attempts++;
    return Response.json({ detail: "Unsupported LLM" }, { status });
  }, socket: () => { throw new Error("refused models must not open a socket"); } });
  const connect = provider.connect.bind(provider);
  provider.connect = (config, credentials, events) => connect(config, credentials, {
    ...events, closed: (reason, message, options) => {
      detail = message;
      retryable = options?.retryable;
      events.closed(reason, message, options);
    },
  });
  const state = testBrain({ provider, reference: `elevenlabs/${model}`, ownsTurns: true, failed: (_detail, error) => { failure = error; } });
  t.after(() => state.brain.close());
  await until(() => state.logs.some(log => log.type === "voice_realtime_lost"), "model refused");
  assert.equal(detail, `realtime.model ${model}: ElevenLabs Agents create agent (HTTP ${status}): Unsupported LLM`);
  assert.equal(failure, `realtime.model ${model}: ElevenLabs agent creation failed`);
  assert.equal(retryable, false);
  assert.equal(attempts, 1);
  assert.equal(state.logs.find(log => log.type === "voice_realtime_lost")?.fields?.retrying, false);
});
