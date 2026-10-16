import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import { discordGrant, fakeTransport, speak } from "./voice-fakes.ts";

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

test("speak over HTTP: a request to any node plays on the node holding the call, made by OpenAI's speech API as streamed PCM", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-speak-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } } } }));
  // OpenAI's /v1/audio/speech: 0.5 s of PCM, sent in two halves.
  const asked: { body: any; authorization?: string }[] = [];
  const openai = createServer(async (req, res) => {
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
  assert.deepEqual(asked[0].body, { model: "gpt-4o-mini-tts", input: "Hello from camelRun.", voice: "verse", response_format: "pcm", instructions: "Calm." });
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
  const openai = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/audio/transcriptions")) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "Can you find the docs?", usage: { type: "duration", seconds: 1 } })); return; }
    spoken.push(JSON.parse(body).input);
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
});
