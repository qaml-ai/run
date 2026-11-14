import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentError, Agents } from "../clients/node.ts";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps } from "../src/node.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { fakeOpenAICalls } from "./voice-calls-fakes.ts";
import { discordGrant } from "./voice-fakes.ts";

test("the TypeScript SDK creates, lists and ends client-held calls", async t => {
  const openai = await fakeOpenAICalls(t);
  const root = await mkdtemp(join(tmpdir(), "agent-voice-calls-sdk-"));
  let closeNode: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await closeNode?.(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  const { url } = await testDatabase();
  const tenantsFile = join(root, "tenants.json");
  await writeFile(tenantsFile, JSON.stringify({ tenants: {
    alice: { tokenSha256: sha(token), apiKeys: { openai: "fixture-key", openrouter: "fixture-key" } },
  } }));
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANTS_FILE: tenantsFile, AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_OPENAI_REALTIME_URL: openai.url,
    });
    const made = await createNode(config, await nodeDeps(config));
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    closeNode = () => made.close();
    return `http://127.0.0.1:${port}`;
  });
  const agents = new Agents({ url: base, apiKey: token });
  t.after(() => agents.close());
  const agent = await agents.upsert("voice-agent");

  await assert.rejects(agents.voice.create({ discord: discordGrant() }),
    (error: unknown) => error instanceof AgentError && error.status === 404 && /Voice sessions are not enabled/.test(error.message));

  const sdp = "v=0\r\ns=offer\r\n";
  const call = await agents.voice.create({ agent: agent.id, provider: "openai", sdp, subject: "user-1" });
  assert.match(call.id, /^vc_[a-f0-9]{24}$/);
  assert.deepEqual(call.connect, { sdpAnswer: openai.answer });
  assert.equal(openai.offers[0]?.sdp, sdp);
  const live = await agents.voice.list({ state: "live" });
  assert.deepEqual(live.calls?.map(row => row.id), [call.id]);
  assert.deepEqual(live.sessions, []);
  assert.equal((await agents.voice.get(call.id)).state, "live");
  const speakers = { ana: "Ana" };
  assert.deepEqual((await agents.voice.update(call.id, { speakers })).speakers, speakers);

  await assert.rejects(agents.voice.transcript(call.id, { speaker: "ana", text: "Hello" }),
    (error: unknown) => error instanceof AgentError && error.status === 409 && error.code === "VOICE_TRANSCRIPT_SIDEBAND");
  const ended = await agents.voice.end(call.id, { reason: "channel_empty" });
  assert.equal(ended.state, "ended");
  assert.equal(ended.reason, "channel_empty");
});
