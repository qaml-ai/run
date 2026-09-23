import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDurableJson } from "../shared/durable-json.ts";
import { fileStorage } from "../shared/storage.ts";
import { Accounts } from "../src/accounts.ts";
import { migrateCoordination, readLegacyDocuments } from "../src/migrate-coordination.ts";
import { configuredModel } from "../src/model.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (prefix: string, bytes: number) => `${prefix}_${randomBytes(bytes).toString("hex")}`;

test("coordination documents from the storage layout move into Postgres once, and the runtime serves them", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { db, url } = await testDatabase();
  const secretsKey = randomBytes(32).toString("hex");
  const sealer = new Accounts({ tenants: new Tenants({ legacyToken: "unused-legacy-token-24-chars" }), db, secretsKey });
  const storage = fileStorage(root);
  // The layout the runtime wrote before Postgres: `<key>.json` documents next to the logs and blobs that stay.
  const put = (key: string, value: unknown) => writeDurableJson(join(root, `${key}.json`), value);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const model = configuredModel();

  put("tenants/carol/tenant", { id: "carol", github: "Carol", createdAt: now - 1000 });
  put("tenants/carol/keys", { [model.provider]: { ...sealer.seal(`carol:${model.provider}`, "sk-carol-provider-key-9876"), last4: "9876", setAt: now - 500 } });
  const secret = `art_${randomBytes(32).toString("hex")}`;
  const token = { id: randomUUID(), name: "ci", sha256: sha(secret), prefix: secret.slice(0, 8), createdAt: now - 400 };
  put("tenants/carol/tokens", [token]);
  put(`tokens/${token.sha256}`, { tenant: "carol", id: token.id });
  const totals = (responses: number, input: number) => ({ responses, input, output: 10 * responses, cacheRead: 0, cacheWrite: 0, cost: 0.25 * responses });
  put(`tenants/carol/usage/${today}/http___10.0.0.1_8790`, { models: { "anthropic/claude-sonnet-5": totals(2, 100) } });
  put(`tenants/carol/usage/${today}/http___10.0.0.2_8790`, { models: { "anthropic/claude-sonnet-5": totals(1, 50) } });
  const legacyUsage = storage.log<unknown>("tenants/carol/usage");
  legacyUsage.append({ at: now - 60_000, agent: "client_old", provider: "anthropic", model: "claude-sonnet-5", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
  await legacyUsage.flush(true);

  const header = (agent: string, extra: object = {}) => ({
    version: 3, id: agent, tenant: "carol", digest: sha("scoped-token"), expiresAt: null, revoked: false, metadata: { name: `Agent ${agent.slice(-4)}`, type: "support" },
    definitions: [], provisionHash: sha(agent), config: { model: { ...model } }, ...extra,
  });
  const agent = `client_${randomBytes(20).toString("hex")}`;
  put(`client-sessions/${agent}`, header(agent));
  put(`client-sessions/index/carol/${agent}`, { id: agent });
  const journal = storage.log<unknown>(`client-sessions/${agent}.journal`);
  journal.append({ t: "request", record: { id: "before-migration", method: "execute", fingerprint: "f", state: "completed", startedAt: now - 300, endedAt: now - 200, outcome: { result: { output: ["kept"] } } } });
  await journal.flush(true);
  const revoked = `client_${randomBytes(20).toString("hex")}`;
  put(`client-sessions/${revoked}`, header(revoked, { revoked: true }));
  // Version 2 headers carried their requests inline; the migration moves them to the journal.
  const older = `client_${randomBytes(20).toString("hex")}`;
  const { version: _version, ...v3 } = header(older);
  put(`client-sessions/${older}`, { ...v3, version: 2, cursor: 5, events: [], calls: {},
    requests: { inline: { id: "inline", method: "prompt", fingerprint: "g", state: "completed", startedAt: now - 900, endedAt: now - 800, outcome: { result: { reply: "hi" } } } } });

  const schedule = { id: randomUUID(), agent, tenant: "carol", text: "Check in", dueAt: now + 86_400_000, everySeconds: 3600, createdAt: now - 100 };
  put(`schedules/${agent}/${schedule.id}`, schedule);
  put(`timers/000000000000/${agent}.${schedule.id}`, { agent, id: schedule.id, dueAt: schedule.dueAt });

  const channel = id("ch", 10);
  put(`channels/${channel}`, {
    id: channel, tenant: "carol", type: "telegram", name: "Support bot", webhookUrl: `https://agents.example.test/channels/telegram/${channel}`,
    template: { systemPrompt: "Be brief." }, access: { public: false, allow: ["@ada"] }, limits: { perSenderPerMinute: 10, turnsPerDay: 1000 },
    account: { id: "123", username: "fixture_bot" }, masked: { botToken: "123…XYZ" },
    sealed: sealer.seal(`channel:${channel}`, JSON.stringify({ credentials: { botToken: "123:secret" }, secret: "webhook-secret" })), createdAt: now - 50, updatedAt: now - 50,
  });
  put(`channel-index/carol/${channel}`, {});
  put(`channel-conversations/${channel}/42`, { agent, generation: 0 });
  put(`channel-agents/${agent}`, { channel, tenant: "carol", conversationId: "42" });
  put(`channel-seen/${channel}/${sha("17").slice(0, 40)}`, { at: now - 10 });
  put(`channel-items/out_later`, { id: "out_later", channel, tenant: "carol", conversationId: "42", createdAt: now, state: "sending", text: "later", sent: 0, attempts: 1, due: now + 86_400_000, claim: { node: "http://dead", until: now } });

  const volume = id("vol", 12), snapshot = id("snap", 8);
  const content = Buffer.from("migrated contents");
  await storage.writeBlob(`chunks/carol/${sha(content).slice(0, 2)}/${sha(content)}`, content);
  const entry = { version: 1, size: content.length, chunks: [sha(content)], updatedAt: now - 30 };
  const tree = storage.log<unknown>(`volumes/${volume}/tree`);
  tree.append({ t: "put", seq: 1, path: "/notes.md", entry });
  await tree.flush(true);
  put(`volumes/${volume}`, { version: 1, id: volume, tenant: "carol", name: "docs", createdAt: now - 40 });
  put(`volumes/index/carol/${volume}`, { id: volume, name: "docs", createdAt: now - 40 });
  put(`volumes/${volume}/snapshots/${snapshot}`, { id: snapshot, volume, name: "first", seq: 1, createdAt: now - 20, files: 1, bytes: content.length });
  put(`volumes/${volume}/snapshot-files/${snapshot}`, { "/notes.md": entry });
  put(`volumes/${volume}/watchers/${agent}`, { agent, tenant: "carol", mounts: [{ path: "/docs", subpath: "/" }] });
  put(`leases/${agent}`, { agent, owner: "http://dead", epoch: 4, expiresAt: now });

  const documents = await readLegacyDocuments({ kind: "file", root });
  const first = await migrateCoordination(documents, db, storage);
  assert.deepEqual(first, {
    tenants: 1, provider_keys: 1, api_tokens: 1, usage: 1, agents: 3, schedules: 1, channels: 1, channel_conversations: 1, channel_agents: 1,
    channel_items: 1, channel_seen: 1, volumes: 1, volume_snapshots: 1, volume_watchers: 1,
  });
  const again = await migrateCoordination(await readLegacyDocuments({ kind: "file", root }), db, storage);
  assert.ok(Object.values(again).every(count => count === 0), "a second run inserts nothing");
  assert.equal(await sealer.apiKey("carol", model.provider), "sk-carol-provider-key-9876", "keys stay sealed under AGENT_SECRETS_KEY");

  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: {} }));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: url, PORT: "0", HOST: "127.0.0.1", AGENT_TENANTS_FILE: join(root, "tenants.json"),
      AGENT_SESSION_SECRET: "migration-test-session-secret-32-chars", AGENT_SECRETS_KEY: secretsKey } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; } });
  const [line] = await once(child.stdout!, "data");
  const base = `http://127.0.0.1:${JSON.parse(String(line).split("\n")[0]).address.port}`;
  const get = async (path: string) => {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return response.headers.get("content-type")?.includes("json") ? response.json() as Promise<any> : response.text();
  };

  assert.deepEqual(await get("/v1/me"), { tenant: "carol", via: "token", canStoreKeys: true });
  const key = (await get("/v1/providers")).find((provider: any) => provider.id === model.provider).key;
  assert.deepEqual([key.source, key.last4], ["tenant", "9876"]);
  assert.deepEqual((await get("/v1/tokens")).map((entry: any) => entry.id), [token.id]);
  const usage = await get("/v1/usage?days=30");
  assert.deepEqual(usage.totals, { responses: 4, input: 157, output: 33, cacheRead: 0, cacheWrite: 0, cost: 1.25 });

  const agents = await get("/v1/agents");
  assert.deepEqual(agents.map((entry: any) => entry.id).sort(), [agent, older].sort(), "the revoked agent is not listed");
  assert.ok((await get(`/v1/agents/${agent}`)).requests.some((request: any) => request.id === "before-migration"), "the journal still loads");
  assert.ok((await get(`/v1/agents/${older}`)).requests.some((request: any) => request.id === "inline"), "a version 2 header's requests moved to the journal");
  assert.deepEqual((await get(`/v1/agents/${agent}/schedules`)).map((entry: any) => [entry.id, entry.dueAt]), [[schedule.id, schedule.dueAt]]);

  const [listed] = await get("/v1/channels");
  assert.deepEqual([listed.id, listed.name, listed.credentials], [channel, "Support bot", { botToken: "123…XYZ" }]);
  assert.equal((await db.query("select claimed_by from channel_items where id = 'out_later'")).rows[0].claimed_by, null);

  assert.deepEqual((await get("/v1/volumes")).map((entry: any) => entry.id), [volume]);
  assert.equal(await get(`/v1/volumes/${volume}/files/notes.md`), "migrated contents");
  assert.deepEqual((await get(`/v1/volumes/${volume}/snapshots`)).map((entry: any) => entry.id), [snapshot]);
  const fork = await fetch(`${base}/v1/volumes/${volume}/fork`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ snapshot }) });
  assert.equal(fork.status, 201);
  assert.equal(await get(`/v1/volumes/${(await fork.json() as any).id}/files/notes.md`), "migrated contents", "a fork reads the snapshot's file map");
});
