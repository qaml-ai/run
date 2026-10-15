import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";
import { discordGrant, fakeTransport } from "./voice-fakes.ts";

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
