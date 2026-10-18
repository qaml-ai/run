import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { browserVoice, BROWSER_FRAME } from "../src/voice-browser.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";
import { fakeTransport, sleep } from "./voice-fakes.ts";

/** 20 ms of a 300 Hz tone (or silence), 16-bit PCM at 48 kHz mono, as a page's microphone gives it. */
function micFrame(index: number, loud = true) {
  const frame = Buffer.alloc(1 + 1_920);
  frame[0] = BROWSER_FRAME.pcm;
  for (let i = 0; i < 960; i++) frame.writeInt16LE(loud ? Math.round(10_000 * Math.sin(2 * Math.PI * 300 * (index * 960 + i) / 48_000)) : 0, 1 + i * 2);
  return frame;
}

/** A page's socket: what it got, text and binary. */
async function open(url: string) {
  const socket = new WebSocket(url);
  const events: any[] = [];
  const audio: Buffer[] = [];
  socket.on("message", (data, binary) => { if (binary) audio.push(data as Buffer); else events.push(JSON.parse(String(data))); });
  const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
  const failed = new Promise<number>(resolve => socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)));
  await Promise.race([once(socket, "open"), failed]);
  return { socket, events, audio, closed, failed };
}

test("a voice session from a browser: its socket (on any node) carries the page's speech in and the bot's out, and the session's events", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-browser-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key" } } } }));
  // OpenAI: transcriptions answer "hello there"; speech is 0.5 s of PCM.
  const openai = createServer(async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    if (req.url?.endsWith("/audio/transcriptions")) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "hello there", usage: { type: "duration", seconds: 1 } })); return; }
    res.writeHead(200, { "Content-Type": "audio/pcm" });
    const pcm = Buffer.alloc(24_000);
    for (let i = 0; i < 12_000; i++) pcm.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 220 * i / 24_000)), i * 2);
    res.end(pcm);
  }).listen(0, "127.0.0.1");
  await once(openai, "listening");
  t.after(() => new Promise<void>(resolve => openai.close(() => resolve())));
  const openaiUrl = `http://127.0.0.1:${(openai.address() as { port: number }).port}/v1`;
  const { url: databaseUrl } = await testDatabase();
  const nodes: RuntimeNode[] = [];
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  const secretsKey = randomBytes(32).toString("hex");
  const bases: string[] = [];
  for (let index = 0; index < 2; index++) bases.push(await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-browser-session-secret-32-chars!!!", AGENT_SECRETS_KEY: secretsKey,
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_SPEECH_URL: openaiUrl, AGENT_TRANSCRIPTION_URL: openaiUrl,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fakeTransport().transport, browser: browserVoice() } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    nodes.push(made);
    return `http://127.0.0.1:${port}`;
  }));
  const call = async (base: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
    return { status: response.status, json: await response.json() as any };
  };

  // A preview: no webhooks, no agent; the page is the only consumer.
  const created = await call(bases[0], "POST", "/v1/voice/sessions", { provider: "browser", speak: true, deliver: { webhooks: false }, silenceMs: 300, emptySeconds: 5, metadata: { preview: true } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.provider, "browser");
  const { url, token: socketToken, expiresAt } = created.json.browser;
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/voice\/sessions\/vs_[a-f0-9]{24}\/socket$/);
  assert.ok(expiresAt > Date.now());
  const id = created.json.id;
  // Node b does not hold the session: it relays the socket to node a.
  const onB = url.replace(new URL(bases[0]).host, new URL(bases[1]).host);
  assert.equal(await (await open(`${onB}?token=nope`)).failed, 401, "a bad token opens nothing");
  const page = await open(`${onB}?token=${encodeURIComponent(socketToken)}`);
  await until(() => page.events.some(event => event.type === "ready"), "ready");
  await until(async () => (await call(bases[1], "GET", `/v1/voice/sessions/${id}`)).json.state === "live", "live");
  // A second socket while one is open is refused.
  const second = await open(`${url}?token=${encodeURIComponent(socketToken)}`);
  assert.equal(await second.closed, 4009);

  // The page speaks (0.6 s of tone in real time, then quiet): the utterance comes back on the socket.
  page.socket.send(JSON.stringify({ type: "speaker", id: "tester" }));
  for (let index = 0; index < 30; index++) { page.socket.send(micFrame(index)); await sleep(20); }
  for (let index = 0; index < 5; index++) { page.socket.send(micFrame(index, false)); await sleep(20); }
  const utterance = await until(() => page.events.find(event => event.type === "utterance"), "the utterance", 15_000);
  assert.equal(utterance.text, "hello there");
  assert.equal(utterance.speakerId, "tester");
  assert.equal(utterance.seq, 1);
  assert.ok(utterance.transcriptMs >= 0 && utterance.endedAt > utterance.startedAt);

  // The bot speaks: Opus frames back, a frame every 20 ms, with its events.
  const spoken = await call(bases[1], "POST", `/v1/voice/sessions/${id}/speak`, { text: "Hi tester." });
  assert.equal(spoken.status, 202, JSON.stringify(spoken.json));
  await until(() => page.events.some(event => event.type === "speech" && event.state === "ended"), "the speech", 15_000);
  const opus = page.audio.filter(frame => frame[0] === BROWSER_FRAME.opus);
  assert.ok(opus.length >= 25, `0.5 s of speech as Opus (${opus.length} frames)`);
  const started = page.events.find(event => event.type === "speech" && event.state === "started");
  assert.ok(started.latencyMs >= 0 && started.startedAt > 0);
  assert.equal(page.events.find(event => event.type === "speech" && event.state === "ended").reason, "done");

  // Asked as PCM: 48 kHz mono 16-bit, 1,920 bytes a frame.
  page.socket.send(JSON.stringify({ type: "config", audio: "pcm" }));
  page.audio.length = 0;
  await call(bases[0], "POST", `/v1/voice/sessions/${id}/speak`, { text: "Again." });
  await until(() => page.events.filter(event => event.type === "speech" && event.state === "ended").length === 2, "the second speech", 15_000);
  assert.ok(page.audio.length >= 25 && page.audio.every(frame => frame[0] === BROWSER_FRAME.pcm && frame.length === 1 + 1_920));

  // Another token (the page reloads); hanging up empties the call, which ends after emptySeconds.
  const fresh = await call(bases[1], "POST", `/v1/voice/sessions/${id}/browser-token`);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.json.token, socketToken);
  page.socket.close();
  await until(async () => (await call(bases[0], "GET", `/v1/voice/sessions/${id}`)).json.endReason === "empty", "the session to end, empty", 20_000);
  // A Discord session still needs delivery somewhere, and discord.
  assert.equal((await call(bases[0], "POST", "/v1/voice/sessions", { deliver: { webhooks: false } })).status, 400);
});
