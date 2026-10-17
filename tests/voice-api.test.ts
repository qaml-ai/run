import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { fakeModel, until } from "./runtime-server.ts";
import { discordGrant, fakeRealtime, fakeTransport, speak } from "./voice-fakes.ts";

test("/v1/voice/sessions: create, read, list, update and end a session over HTTP", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "fixture-key" } } } }));
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_VOICE_SESSIONS_PER_TENANT: "1",
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
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_VOICE_SESSIONS_PER_TENANT: "1",
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

test("speak over HTTP: a request to any node plays on the node holding the call, made by OpenAI's speech API as streamed PCM", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-speak-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } } } }));
  // OpenAI's /v1/audio/speech: 0.5 s of PCM, sent in two halves.
  const asked: { body: any; authorization?: string }[] = [];
  const openai = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    asked.push({ body: JSON.parse(body), authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "audio/pcm" });
    res.write(Buffer.alloc(12_000 * 2 / 2, 0x11));
    await new Promise(resolve => setTimeout(resolve, 50));
    res.end(Buffer.alloc(12_000 * 2 / 2, 0x22));
  }).listen(0, "127.0.0.1");
  await once(openai, "listening");
  t.after(() => new Promise<void>(resolve => openai.close(() => resolve())));
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
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: secretsKey,
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: `http://127.0.0.1:${(openai.address() as { port: number }).port}/v1`,
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
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), speak: true, voice: "verse" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.join, { self_mute: false, self_deaf: false });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  // Node b does not hold the call: the request goes to the node that does.
  const spoken = await call(bases[1], "POST", `/v1/voice/sessions/${created.json.id}/speak`, { text: "Hello from camelRun.", instructions: "Calm." });
  assert.equal(spoken.status, 202, JSON.stringify(spoken.json));
  assert.equal(spoken.json.voice, "verse");
  await until(() => connection.played.length === 1 && !connection.playing, "the speech to play");
  assert.equal(connection.played[0].length, 25, "0.5 s: 25 packets of 20 ms");
  assert.deepEqual(asked[0].body, { model: "gpt-4o-mini-tts", input: "Hello from camelRun.", voice: "verse", response_format: "pcm", stream_format: "audio", instructions: "Calm." });
  assert.equal(asked[0].authorization, "Bearer tenant-openai-key");
  await until(async () => (await call(bases[1], "GET", `/v1/voice/sessions/${created.json.id}`)).json.speeches === 1, "the speech counted");
  const stopped = await call(bases[1], "DELETE", `/v1/voice/sessions/${created.json.id}/speak`);
  assert.deepEqual([stopped.status, stopped.json], [200, { stopped: 0 }]);
  const refused = await call(bases[0], "POST", `/v1/voice/sessions/${created.json.id}/speak`, { text: "" });
  assert.equal(refused.status, 400);
});

test("a session that speaks its agent's replies: the agent's run (on another node) streams back, and each sentence is spoken as it is whole", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-replies-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } } } }));
  const model = await fakeModel(t, () => ({ content: "Sure, **here** it is! The [docs](https://example.com/docs) say so.\n```js\nconsole.log('no');\n```\nAnything else?" }));
  // OpenAI: transcription (what the person said) and speech (0.2 s per request).
  const spoken: string[] = [];
  let batch = 0;
  const openai = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/audio/transcriptions")) { batch++; res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "Can you find the docs?", usage: { type: "duration", seconds: 1 } })); return; }
    spoken.push(JSON.parse(body).input);
    res.writeHead(200, { "Content-Type": "audio/pcm" }).end(Buffer.alloc(4_800 * 2));
  }).listen(0, "127.0.0.1");
  // Transcribed as it is spoken: OpenAI's Realtime transcription answers each commit.
  const realtime = fakeRealtime(openai, () => "Can you find the docs?");
  await once(openai, "listening");
  t.after(() => new Promise<void>(resolve => openai.close(() => resolve())));
  const openaiUrl = `http://127.0.0.1:${(openai.address() as { port: number }).port}/v1`;
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
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: secretsKey,
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url,
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: openaiUrl, AGENT_TRANSCRIPTION_URL: openaiUrl, AGENT_VOICE_LIVE_TRANSCRIPTION: "true",
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
  // The agent lives on node b; the call on node a.
  const agent = await call(bases[1], "POST", "/v1/agents", { name: "voice-agent" });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const refused = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000071" }), speak: { agentReplies: true } });
  assert.equal(refused.status, 400, "agentReplies needs deliver.agent");
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), speak: { agentReplies: true }, deliver: { agent: agent.json.id, webhooks: false }, silenceMs: 200 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual([created.json.speak, created.json.agentReplies], [true, true]);
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 0.6);
  await until(() => spoken.length === 3 && connection.played.length === 3 && !connection.playing, "the reply to be spoken");
  assert.deepEqual(spoken, ["Sure, here it is!", "The docs say so.", "Anything else?"], "markdown, the link's address and the code left out");
  const run = await call(bases[1], "GET", `/v1/agents/${agent.json.id}/requests/voice_${created.json.id.slice(3)}_1`);
  assert.equal(run.json.state, "completed");
  assert.match(run.json.outcome.result.reply, /console\.log/, "the whole reply is the run's");
  // The utterance went to OpenAI as it was spoken, and its commit was the transcript: never uploaded after.
  assert.deepEqual(realtime.urls, ["/v1/realtime?intent=transcription"]);
  assert.equal(realtime.auth[0], "Bearer tenant-openai-key");
  assert.deepEqual(realtime.sessions[0], { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } } });
  assert.equal(realtime.commits.length, 1);
  assert.equal(batch, 0, "not transcribed after");
  assert.ok(realtime.commits[0] >= 0.6 * 48_000, `the utterance's audio, 24 kHz mono (${realtime.commits[0]} bytes)`);
  const session = await call(bases[0], "GET", `/v1/voice/sessions/${created.json.id}`);
  assert.equal(session.json.utterances, 1);
});

test("a prompt's speak: its run (on another node) is spoken in a session of the tenant's, sentence by sentence, without deliver.agent", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-prompt-speak-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: {
    alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } },
    bob: { tokenSha256: sha("bob-token-0123456789"), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } },
  } }));
  const model = await fakeModel(t, () => ({ content: "On it. The **build** passed!\n```sh\nnpm test\n```\nAnything else?" }));
  const spoken: { input: string; voice: string }[] = [];
  const openai = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { input, voice } = JSON.parse(body);
    spoken.push({ input, voice });
    res.writeHead(200, { "Content-Type": "audio/pcm" }).end(Buffer.alloc(4_800 * 2));
  }).listen(0, "127.0.0.1");
  await once(openai, "listening");
  t.after(() => new Promise<void>(resolve => openai.close(() => resolve())));
  const openaiUrl = `http://127.0.0.1:${(openai.address() as { port: number }).port}/v1`;
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
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: secretsKey,
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url,
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: openaiUrl, AGENT_TRANSCRIPTION_URL: openaiUrl,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    nodes.push(made);
    return `http://127.0.0.1:${port}`;
  }));
  const call = async (base: string, method: string, path: string, body?: unknown, bearer = token) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };
  // The agent lives on node b; the call is held on node a, and speaks without delivering utterances anywhere.
  const agent = await call(bases[1], "POST", "/v1/agents", { name: "voice-agent" });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant(), speak: true, voice: "coral" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const quiet = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000072" }) });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.json));
  const connection = await until(() => fake.open().find(open => open.credentials.guildId === "100000000000000001"), "the connection");
  connection.handlers.ready();

  const prompt = (body: Record<string, unknown>, base = bases[0], bearer = token) => call(base, "POST", `/v1/agents/${agent.json.id}/prompt`, body, bearer);
  assert.equal((await prompt({ text: "x", speak: { session: quiet.json.id } })).json.code, "VOICE_SPEAK_DISABLED", "a session that does not speak");
  assert.equal((await prompt({ text: "x", speak: { session: "vs_000000000000000000000000" } })).status, 404, "an unknown session");
  assert.equal((await prompt({ text: "x", speak: { session: created.json.id }, whileRunning: "steer" })).status, 400, "a steer joins another's turn");
  assert.equal((await prompt({ text: "x", speak: { session: created.json.id, voice: "Not A Voice" } })).status, 400, "a voice's name");
  assert.equal((await prompt({ text: "x", speak: { session: created.json.id, extra: 1 } })).status, 400, "only session, voice, interrupt");
  // Another tenant's agent cannot speak in alice's session.
  const bobs = await call(bases[1], "POST", "/v1/agents", { name: "bobs" }, "bob-token-0123456789");
  assert.equal((await call(bases[1], "POST", `/v1/agents/${bobs.json.id}/prompt`, { text: "x", speak: { session: created.json.id } }, "bob-token-0123456789")).status, 404, "another tenant's session is unknown");
  // An agent's own token (which may be in an end user's browser) speaks only in its subject's sessions.
  const asToken = (id: string, agentToken: string, session: string) => fetch(`${bases[0]}/clients/${id}/requests`, {
    method: "POST", headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: `tok-${randomBytes(4).toString("hex")}`, method: "prompt", params: { text: "x", speak: { session } } }),
  }).then(async response => ({ status: response.status, json: await response.json() as any }));
  const userA = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000073" }), speak: true, subject: "user_a" });
  const userB = await call(bases[0], "POST", "/v1/voice/sessions", { discord: discordGrant({ guildId: "100000000000000074" }), speak: true, subject: "user_b" });
  assert.equal(userB.status, 201, JSON.stringify(userB.json));
  const forA = await call(bases[1], "POST", "/v1/agents", { name: "for-a", subject: "user_a" });
  assert.equal(forA.status, 201, JSON.stringify(forA.json));
  const noSubject = await asToken(agent.json.id, agent.json.token, created.json.id);
  assert.deepEqual([noSubject.status, noSubject.json.code], [403, "VOICE_SPEAK_FORBIDDEN"], "an agent without a subject");
  const otherUser = await asToken(forA.json.id, forA.json.token, userB.json.id);
  assert.deepEqual([otherUser.status, otherUser.json.code], [403, "VOICE_SPEAK_FORBIDDEN"], "another user's session");
  assert.equal((await asToken(forA.json.id, forA.json.token, userA.json.id)).status, 202, "its own subject's session");
  // The tenant's key may name any of its sessions, whatever their subject.
  assert.equal((await prompt({ text: "x", speak: { session: userB.json.id } })).status, 202);
  for (const open of fake.open()) open.handlers.ready();
  // Both replies spoken whole (three sentences each), in their own sessions, before the next part.
  await until(() => spoken.length === 6 && fake.open().every(open => !open.playing), "the tenant's and user A's prompts to be spoken");
  spoken.length = 0;

  const accepted = await prompt({ text: "Did the build pass?", requestId: "speak-1", speak: { session: created.json.id, voice: "verse", interrupt: true } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  await until(() => spoken.length === 3 && connection.played.length === 3 && !connection.playing, "the reply to be spoken");
  assert.deepEqual(spoken.map(item => item.input), ["On it.", "The build passed!", "Anything else?"], "markdown and code left out");
  assert.deepEqual([...new Set(spoken.map(item => item.voice))], ["verse"], "the prompt's voice");
  const run = await call(bases[1], "GET", `/v1/agents/${agent.json.id}/requests/speak-1?wait=5`);
  assert.equal(run.json.state, "completed");
  assert.match(run.json.outcome.result.reply, /npm test/, "the whole reply is the run's");
  // Sent again with its id, the request is the same one: not spoken twice.
  assert.equal((await prompt({ text: "Did the build pass?", requestId: "speak-1", speak: { session: created.json.id, voice: "verse", interrupt: true } })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(spoken.length, 3, "a retry is not spoken again");
});

test("following a reply already partly written: the node a session is on reads what was written, then the rest as it comes", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-follow-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key" } } } }));
  // The model writes two deltas, then waits to be let go before the rest.
  const firstWritten = Promise.withResolvers<void>(), rest = Promise.withResolvers<void>();
  const model = createServer(async (req, res) => {
    for await (const _ of req) { /* the request */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", content: "The deploy " });
    chunk({ content: "finished. Two" });
    firstWritten.resolve();
    await rest.promise;
    chunk({ content: " checks failed." });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  }).listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(() => { rest.resolve(); return new Promise<void>(resolve => model.close(() => resolve())); });
  const { url: databaseUrl } = await testDatabase();
  const nodes: RuntimeNode[] = [];
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  const secret = "voice-api-session-secret-with-32-chars!!";
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: secret, AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
    });
    const made = await createNode(config, await nodeDeps(config));
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    nodes.push(made);
    return `http://127.0.0.1:${port}`;
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const agent = await (await fetch(`${base}/v1/agents`, { method: "POST", headers, body: JSON.stringify({ name: "follow" }) })).json() as any;
  assert.equal((await fetch(`${base}/v1/agents/${agent.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "How did the deploy go?", requestId: "run-1" }) })).status, 202);
  await firstWritten.promise;
  await new Promise(resolve => setTimeout(resolve, 300));
  // What a session's node asks the agent's (as followStreamingAnywhere does), signed as nodes sign.
  const path = `/internal/agents/${agent.id}/follow`;
  const body = JSON.stringify({ tenant: "alice", requestId: "run-1" });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`internal:${timestamp}:${path}:${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  const response = await fetch(base + path, { method: "POST", body, headers: { "Content-Type": "application/json", "x-agent-runtime-internal": `${timestamp}.${signature}` } });
  assert.equal(response.status, 200);
  const lines: any[] = [];
  let pending = "";
  const reader = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const next = async () => {
    for (;;) {
      const at = pending.indexOf("\n");
      if (at >= 0) { const line = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1); lines.push(line); return line; }
      const step = await reader.next();
      if (step.done) return undefined;
      pending += Buffer.from(step.value).toString("utf8");
    }
  };
  // What was written before the follow began comes first, whole.
  assert.deepEqual(await next(), { text: "The deploy finished. Two" });
  rest.resolve();
  while (!lines.at(-1)?.done) assert.ok(await next(), "the stream ended without done");
  assert.equal(lines.filter(line => line.text).map(line => line.text).join(""), "The deploy finished. Two checks failed.", "nothing missed, nothing twice");
});
