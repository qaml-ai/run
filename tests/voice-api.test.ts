import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { fakeModel, until } from "./runtime-server.ts";
import { discordGrant, fakeOpenAIRealtime, fakeTransport, realtimeAnswer, speak } from "./voice-fakes.ts";

test("/v1/voice/sessions: create, read, list, update and end a session over HTTP", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "fixture-key" } } } }));
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  const openai = await fakeOpenAIRealtime(t);
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_VOICE_SESSIONS_PER_TENANT: "1", AGENT_OPENAI_REALTIME_URL: openai.url,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };

  const grant = discordGrant();
  const created = await call("POST", "/v1/voice/sessions", { provider: "discord", discord: grant, subject: "user-1", silenceMs: 600, notice: "Recording for {bot}" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.silenceMs, 600);
  assert.equal(created.json.realtime.provider, "openai", "AGENT_VOICE_REALTIME unset: OpenAI");
  assert.deepEqual(created.json.notice, { required: true, channelId: grant.channelId, text: `Recording for ${grant.userId}` });
  const id = created.json.id;
  const connection = await until(() => fake.open()[0], "the connection");
  assert.equal(connection.credentials.token, grant.token);
  connection.handlers.ready();
  await until(async () => (await call("GET", `/v1/voice/sessions/${id}`)).json.state === "live", "live");

  const bad = await call("POST", "/v1/voice/sessions", { discord: { ...grant, endpoint: "example.com" } });
  assert.equal(bad.status, 400);
  const unknownField = await call("POST", "/v1/voice/sessions", { discord: grant, nope: true });
  assert.equal(unknownField.status, 400);
  const second = await call("POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000077" }) });
  assert.equal(second.status, 429);
  assert.equal(second.json.code, "VOICE_SESSION_LIMIT");
  const again = await call("POST", "/v1/voice/sessions", { discord: grant });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "VOICE_SESSION_EXISTS");
  assert.equal(again.json.session, id);

  const listed = await call("GET", "/v1/voice/sessions?state=live");
  assert.deepEqual(listed.json.sessions.map((session: any) => session.id), [id]);
  const patched = await call("PATCH", `/v1/voice/sessions/${id}`, { discord: { endpoint: "c-test-9.discord.media", token: "moved" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  await until(() => connection.updates.length === 1, "the reconnect");
  assert.equal(connection.credentials.token, "moved");

  // Nothing is playing to stop; POST …/speak is no more.
  assert.deepEqual(await call("DELETE", `/v1/voice/sessions/${id}/speak`), { status: 200, json: { stopped: 0 } });
  assert.equal((await call("POST", `/v1/voice/sessions/${id}/speak`, { text: "Hello" })).status, 404);
  assert.equal((await call("POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000078" }), speak: { agentReplies: true } })).status, 400, "agentReplies is gone");

  const ended = await call("DELETE", `/v1/voice/sessions/${id}`);
  assert.equal(ended.status, 200);
  assert.equal(ended.json.endReason, "requested");
  assert.equal(ended.json.leave.d.channel_id, null);
  await until(() => !fake.open().length, "the connection to close");
  assert.equal((await call("GET", "/v1/voice/sessions/vs_000000000000000000000000")).status, 404);
});

test("a tenant's maxVoiceSessions in the tenants file overrides AGENT_VOICE_SESSIONS_PER_TENANT", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-limit-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "fixture-key" }, maxVoiceSessions: 2 } } }));
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  const openai = await fakeOpenAIRealtime(t);
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_VOICE_SESSIONS_PER_TENANT: "1", AGENT_OPENAI_REALTIME_URL: openai.url,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const create = async (guildId: string) => {
    const response = await fetch(`${base}/v1/voice/sessions`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ discord: discordGrant({ guildId }) }),
    });
    return { status: response.status, json: await response.json() as any };
  };
  assert.equal((await create("100000000000000061")).status, 201);
  const second = await create("100000000000000062");
  assert.equal(second.status, 201, `the tenant's 2, not the runtime's 1: ${JSON.stringify(second.json)}`);
  const third = await create("100000000000000063");
  assert.equal(third.status, 429);
  assert.equal(third.json.code, "VOICE_SESSION_LIMIT");
  assert.equal(third.json.limit, 2);
});

/** Two nodes over one database and one fake Discord transport, OpenAI's Realtime API at `realtimeUrl`. */
async function twoNodes(t: { after(fn: () => unknown): void }, realtimeUrl: string, extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-nodes-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } } } }));
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  const nodes: RuntimeNode[] = [];
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  const secretsKey = randomBytes(32).toString("hex");
  const bases: string[] = [];
  for (let index = 0; index < 2; index++) bases.push(await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: secretsKey,
      AGENT_OPENAI_REALTIME_URL: realtimeUrl, ...extra,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    nodes.push(made);
    return `http://127.0.0.1:${port}`;
  }));
  const call = async (base: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };
  return { fake, bases, call };
}

test("a call over HTTP: the realtime brain answers on OpenAI with the tenant's key, on the node holding the call; DELETE …/speak from any node reaches it", async t => {
  // The second answer goes on for a while, to be stopped.
  const openai = await fakeOpenAIRealtime(t, {
    transcript: () => "Hi, are you there?",
    answer: (index, send) => { for (const event of realtimeAnswer(`resp_${index}`, { said: "Hello!", ms: index === 1 ? 400 : 20_000 })) send(event); },
  });
  const { fake, bases, call } = await twoNodes(t, openai.url);
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), voice: "verse", silenceMs: 200, realtime: { instructions: "You are Mochi." } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.join, { self_mute: false, self_deaf: false });
  assert.equal(created.json.realtime.voice, "verse");
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  await until(() => openai.of("session.update").length === 1, "the model's session");
  assert.match(openai.seen.urls[0], /^\/v1\/realtime\?model=gpt-realtime-2\.1/);
  assert.equal(openai.seen.auth[0], "Bearer tenant-openai-key");
  assert.equal(openai.of("session.update")[0].session.audio.output.voice, "verse");
  assert.match(openai.of("session.update")[0].session.instructions, /^You are Mochi\./);
  speak(connection, "400000000000000004", 0.6);
  await until(() => connection.played.length === 1 && !connection.playing, "the answer to play");
  assert.equal(connection.played[0].length, 20, "0.4 s: 20 packets of 20 ms");
  await until(async () => { const view = (await call(bases[1], "GET", `/v1/voice/sessions/${created.json.id}`)).json; return view.speeches === 1 && view.utterances === 1; }, "counted");
  // Node b does not hold the call: DELETE …/speak goes to the node that does, and stops what plays.
  speak(connection, "400000000000000004", 0.6);
  await until(() => connection.playing, "the second answer to play");
  const stopped = await call(bases[1], "DELETE", `/v1/voice/sessions/${created.json.id}/speak`);
  assert.deepEqual([stopped.status, stopped.json], [200, { stopped: 1 }]);
  await until(() => !connection.playing, "it stopped");
  assert.equal((await call(bases[1], "POST", `/v1/voice/sessions/${created.json.id}/speak`, { text: "Hello" })).status, 404, "POST …/speak is gone");
});

test("ask_agent across nodes: the agent's run (on another node) streams back, and goes to the model as the tool's result", async t => {
  const model = await fakeModel(t, () => ({ content: "The docs are at docs.example.com." }));
  const openai = await fakeOpenAIRealtime(t, {
    answer: (index, send) => {
      if (index > 1) { for (const event of realtimeAnswer(`resp_${index}`, { said: "They are at docs dot example dot com." })) send(event); return; }
      send({ type: "response.created", response: { id: "resp_1" } });
      send({ type: "response.function_call_arguments.done", response_id: "resp_1", call_id: "call_1", name: "ask_agent", arguments: JSON.stringify({ request: "Where are the docs?" }) });
      send({ type: "response.done", response: { id: "resp_1", status: "completed", usage: {} } });
    },
  });
  const { fake, bases, call } = await twoNodes(t, openai.url, { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" });
  // The agent lives on node b; the call on node a.
  const agent = await call(bases[1], "POST", "/v1/agents", { name: "voice-agent" });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), deliver: { agent: agent.json.id, webhooks: false }, silenceMs: 200 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  await until(() => openai.of("session.update").length === 1, "the model's session");
  assert.deepEqual(openai.of("session.update")[0].session.tools.map((tool: any) => tool.name), ["ask_agent", "stay_silent"]);
  speak(connection, "400000000000000004", 0.6);
  const result = await until(() => openai.of("conversation.item.create").find(event => event.item.type === "function_call_output"), "the tool's result");
  assert.equal(result.item.call_id, "call_1");
  assert.deepEqual(JSON.parse(result.item.output), { reply: "The docs are at docs.example.com." });
  await until(() => connection.played.length === 1 && !connection.playing, "the answer to play");
  // The agent was asked the model's request, marked as from the voice call.
  assert.match(JSON.stringify(model.bodies[0].messages), /Where are the docs\?/);
});

test("a session on the platform's OpenAI key talks to the platform's Azure deployment; the tenant's own key stays on OpenAI", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-azure-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key" } } }, platformKeys: { openai: "platform-openai-key" } }));
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  const openai = await fakeOpenAIRealtime(t);
  const azure = await fakeOpenAIRealtime(t);
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_OPENAI_REALTIME_URL: openai.url,
      AGENT_AZURE_OPENAI_ENDPOINT: new URL(azure.url).origin, AGENT_AZURE_OPENAI_API_KEY: "azure-test-key", AGENT_AZURE_REALTIME_DEPLOYMENT: "realtime-eastus2", AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT: "transcribe-eastus2",
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };

  const created = await call("POST", "/v1/voice/sessions", { discord: discordGrant() });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  (await until(() => fake.open()[0], "the connection")).handlers.ready();
  await until(() => azure.of("session.update").length === 1, "the model's session, on Azure");
  assert.deepEqual([azure.seen.urls, azure.seen.apiKeys, azure.seen.auth], [["/openai/v1/realtime?model=realtime-eastus2"], ["azure-test-key"], [""]]);
  assert.equal(azure.of("session.update")[0].session.audio.input.transcription.model, "transcribe-eastus2");
  assert.equal(openai.seen.urls.length, 0);
  assert.equal((await call("DELETE", `/v1/voice/sessions/${created.json.id}`)).status, 200);
  await until(() => !fake.open().length, "the connection to close");

  // The tenant's own OpenAI key: OpenAI, never Azure.
  assert.equal((await call("PUT", "/v1/providers/openai/key", { apiKey: "sk-own-openai", verify: false })).status, 200);
  const own = await call("POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000079" }) });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  (await until(() => fake.open()[0], "the second connection")).handlers.ready();
  await until(() => openai.of("session.update").length === 1, "the model's session, on OpenAI");
  assert.deepEqual([openai.seen.urls, openai.seen.auth], [["/v1/realtime?model=gpt-realtime-2.1"], ["Bearer sk-own-openai"]]);
  assert.equal(openai.of("session.update")[0].session.audio.input.transcription.model, "gpt-transcribe");
  assert.equal(azure.seen.urls.length, 1);
});

test("say, prompt and audio over HTTP from a node that doesn't hold the call reach the one that does; an upload goes as the body", async t => {
  // OpenAI's speech API (text to speech, for say) and a file server (for audio by URL), on loopback.
  const spoken: { input: string; voice: string }[] = [];
  const pcm = Buffer.alloc(24_000, 0x22);
  const servers = createServer(async (req, res) => {
    if (req.url === "/v1/audio/speech") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      spoken.push({ input: body.input, voice: body.voice });
      res.writeHead(200, { "Content-Type": "audio/pcm" }).end(pcm);
      return;
    }
    if (req.url === "/song.wav") { res.writeHead(200, { "Content-Type": "audio/wav" }).end(wavFile(0.3)); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => servers.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => servers.close(resolve)));
  const local = `http://127.0.0.1:${(servers.address() as { port: number }).port}`;
  const openai = await fakeOpenAIRealtime(t);
  const { fake, bases, call } = await twoNodes(t, openai.url, { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: `${local}/v1` });
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), voice: "coral" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  const connection = await until(() => fake.open()[0], "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  await until(() => openai.of("session.update").length === 1, "the model's session");
  // say from node b: made by text to speech in the call's voice, played by node a.
  const said = await call(bases[1], "POST", `/v1/voice/sessions/${id}/say`, { text: "Welcome everyone" });
  assert.equal(said.status, 202, JSON.stringify(said.json));
  assert.match(said.json.id, /^say_/);
  await until(() => connection.played.length === 1 && !connection.playing, "the words played");
  assert.deepEqual(spoken, [{ input: "Welcome everyone", voice: "coral" }]);
  assert.equal(openai.seen.responses, 0, "the model made none of it");
  const prompted = await call(bases[1], "POST", `/v1/voice/sessions/${id}/prompt`, { instructions: "Greet the room." });
  assert.equal(prompted.status, 202);
  await until(() => openai.seen.responses === 1, "the model asked to speak up");
  await until(() => connection.played.length === 2 && !connection.playing, "its answer played");
  // An upload from node b, as the body; then a URL.
  const upload = await fetch(`${bases[1]}/v1/voice/sessions/${id}/audio?title=Intro`, {
    method: "POST", body: wavFile(0.3), headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
  });
  const queued = await upload.json() as any;
  assert.equal(upload.status, 202, JSON.stringify(queued));
  assert.equal(queued.track.title, "Intro");
  const byUrl = await call(bases[1], "POST", `/v1/voice/sessions/${id}/audio`, { url: `${local}/song.wav` });
  assert.equal(byUrl.status, 202, JSON.stringify(byUrl.json));
  await until(async () => (await call(bases[1], "GET", `/v1/voice/sessions/${id}`)).json.tracks === 2, "both played", 10_000);
  const state = await call(bases[1], "GET", `/v1/voice/sessions/${id}/audio`);
  assert.deepEqual([state.status, state.json.playing, state.json.queue], [200, null, []]);
  const control = await call(bases[1], "PATCH", `/v1/voice/sessions/${id}/audio`, { action: "pause", volume: 0.3 });
  assert.deepEqual([control.status, control.json.paused, control.json.volume], [200, true, 0.3]);
  const wrongType = await fetch(`${bases[0]}/v1/voice/sessions/${id}/audio`, { method: "POST", body: "hello", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" } });
  assert.equal(wrongType.status, 415);
});

/** A WAV file: `seconds` at 24 kHz mono 16-bit. */
function wavFile(seconds: number) {
  const data = Buffer.alloc(Math.round(seconds * 24_000) * 2, 0x10);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
