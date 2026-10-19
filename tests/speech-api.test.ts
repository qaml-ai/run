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
import { until } from "./runtime-server.ts";

test("POST /v1/speech: OpenAI by default, streamed as made (pcm or wav), billed per second made", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-speech-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: {
    alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } },
    bob: { tokenSha256: sha("bob-token-0123456789"), apiKeys: { openrouter: "fixture-key" } },
  } }));
  // OpenAI's /v1/audio/speech: 0.5 s of PCM in chunks of odd sizes (a sample split across two), or a refusal.
  const asked: { body: any; authorization?: string }[] = [];
  const openai = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    asked.push({ body: parsed, authorization: req.headers.authorization });
    if (parsed.input.includes("refuse")) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "no" } })); return; }
    res.writeHead(200, { "Content-Type": "audio/pcm" });
    res.write(Buffer.alloc(9_999, 0x11));
    await new Promise(resolve => setTimeout(resolve, 30));
    res.end(Buffer.alloc(24_000 - 9_999, 0x22));
  }).listen(0, "127.0.0.1");
  await once(openai, "listening");
  t.after(() => new Promise<void>(resolve => openai.close(() => resolve())));
  const { url: databaseUrl } = await testDatabase();
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "speech-api-session-secret-with-32-chars!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: `http://127.0.0.1:${(openai.address() as { port: number }).port}/v1`,
    });
    const made = await createNode(config, await nodeDeps(config));
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const speak = (body: unknown, bearer = token) => fetch(`${base}/v1/speech`, { method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" } });

  const pcm = await speak({ text: "Hello from the preview.", voice: "coral", instructions: "Warm.", subject: "user-1" });
  assert.equal(pcm.status, 200);
  assert.match(pcm.headers.get("content-type")!, /^audio\/pcm;rate=24000/);
  assert.equal(pcm.headers.get("x-speech-model"), "openai/gpt-4o-mini-tts");
  const audio = Buffer.from(await pcm.arrayBuffer());
  assert.equal(audio.length, 24_000, "0.5 s at 24 kHz, 16-bit: every byte, 16-bit aligned");
  assert.deepEqual(asked[0].body, { model: "gpt-4o-mini-tts", input: "Hello from the preview.", voice: "coral", response_format: "pcm", stream_format: "audio", instructions: "Warm." });
  assert.equal(asked[0].authorization, "Bearer tenant-openai-key");

  const wav = await speak({ text: "And as a WAV.", format: "wav" });
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  const file = Buffer.from(await wav.arrayBuffer());
  assert.equal(file.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(file.readUInt32LE(24), 24_000, "24 kHz");
  assert.equal(file.length, 44 + 24_000);

  // Billed as speech: a second each (billed per second started), with its subject.
  await until(async () => {
    const usage = await (await fetch(`${base}/v1/usage?days=1`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    return JSON.stringify(usage).includes("speech");
  }, "the usage");

  const refused = await speak({ text: "please refuse this" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as any).error, /would not make this speech/);
  assert.equal((await speak({ text: "  " })).status, 400);
  assert.equal((await speak({ text: "x", voice: "Not A Voice" })).status, 400);
  assert.equal((await speak({ text: "x", format: "mp3" })).status, 400);
  const noKey = await speak({ text: "Hello." }, "bob-token-0123456789");
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json() as any).code, "SPEECH_UNAVAILABLE");
});

test("POST /v1/speech through a chain of providers it names (or whose voices it names): the first with a key serves, and says so", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-speech-chain-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key", elevenlabs: "tenant-eleven-key" } } } }));
  const asked: { url: string; key?: string }[] = [];
  const fake = createServer(async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    asked.push({ url: req.url ?? "", key: (req.headers["xi-api-key"] ?? req.headers.authorization) as string | undefined });
    res.writeHead(200, { "Content-Type": "audio/pcm" }).end(Buffer.alloc(4_800, 0x10));
  }).listen(0, "127.0.0.1");
  await once(fake, "listening");
  t.after(() => new Promise<void>(resolve => fake.close(() => resolve())));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const { url: databaseUrl } = await testDatabase();
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "speech-api-session-secret-with-32-chars!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: `${fakeUrl}/v1`, AGENT_ELEVENLABS_URL: fakeUrl,
      AGENT_VOICE: "true", AGENT_VOICE_ISOLATION: "inline",
    });
    const made = await createNode(config, await nodeDeps(config));
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const response = await fetch(`${base}/v1/speech`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "From ElevenLabs.", speech: { providers: ["elevenlabs", "openai"], voices: { elevenlabs: "voice-123" } } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("x-speech-model")!, /^elevenlabs\//);
  assert.equal((await response.arrayBuffer()).byteLength, 4_800);
  assert.match(asked[0].url, /^\/v1\/text-to-speech\/voice-123\/stream/);
  assert.equal(asked[0].key, "tenant-eleven-key");

  // No providers, but voices for them (a voice preview): those providers in that order, then OpenAI.
  const voiced = await fetch(`${base}/v1/speech`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "A preview.", voice: "coral", speech: { voices: { elevenlabs: "voice-456", openai: "coral" } } }),
  });
  assert.equal(voiced.status, 200, await voiced.clone().text());
  assert.match(voiced.headers.get("x-speech-model")!, /^elevenlabs\//);
  await voiced.arrayBuffer();
  assert.match(asked[1].url, /^\/v1\/text-to-speech\/voice-456\/stream/);
});
