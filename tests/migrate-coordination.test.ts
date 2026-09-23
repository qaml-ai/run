import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeDurableJson } from "../shared/durable-json.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { Accounts } from "../src/accounts.ts";
import { migrateCoordination, planCoordination, readLegacyDocuments } from "../src/migrate-coordination.ts";
import { configuredModel } from "../src/model.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (prefix: string, bytes: number) => `${prefix}_${randomBytes(bytes).toString("hex")}`;

/** Rows the legacy layout below becomes. */
const EXPECTED = {
  tenants: 1, provider_keys: 1, api_tokens: 1, usage: 1, agents: 3, schedules: 1, channels: 1, channel_conversations: 1, channel_agents: 1,
  channel_items: 1, channel_seen: 1, volumes: 1, volume_snapshots: 1, volume_watchers: 1,
};

/**
 * The layout the runtime wrote before Postgres: documents written with `put`
 * (`<key>.json` files, or S3 objects), next to the logs and blobs that stay.
 */
async function writeLegacyLayout(put: (key: string, value: unknown) => Promise<void> | void, storage: Storage, sealer: Accounts) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const model = configuredModel();

  await put("tenants/carol/tenant", { id: "carol", github: "Carol", createdAt: now - 1000 });
  await put("tenants/carol/keys", { [model.provider]: { ...sealer.seal(`carol:${model.provider}`, "sk-carol-provider-key-9876"), last4: "9876", setAt: now - 500 } });
  const secret = `art_${randomBytes(32).toString("hex")}`;
  const token = { id: randomUUID(), name: "ci", sha256: sha(secret), prefix: secret.slice(0, 8), createdAt: now - 400 };
  await put("tenants/carol/tokens", [token]);
  await put(`tokens/${token.sha256}`, { tenant: "carol", id: token.id });
  const totals = (responses: number, input: number) => ({ responses, input, output: 10 * responses, cacheRead: 0, cacheWrite: 0, cost: 0.25 * responses });
  await put(`tenants/carol/usage/${today}/http___10.0.0.1_8790`, { models: { "anthropic/claude-sonnet-5": totals(2, 100) } });
  await put(`tenants/carol/usage/${today}/http___10.0.0.2_8790`, { models: { "anthropic/claude-sonnet-5": totals(1, 50) } });
  const legacyUsage = storage.log<unknown>("tenants/carol/usage");
  legacyUsage.append({ at: now - 60_000, agent: "client_old", provider: "anthropic", model: "claude-sonnet-5", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
  await legacyUsage.flush(true);
  await legacyUsage.close();

  const header = (agent: string, extra: object = {}) => ({
    version: 3, id: agent, tenant: "carol", digest: sha("scoped-token"), expiresAt: null, revoked: false, metadata: { name: `Agent ${agent.slice(-4)}`, type: "support" },
    definitions: [], provisionHash: sha(agent), config: { model: { ...model } }, ...extra,
  });
  const agent = `client_${randomBytes(20).toString("hex")}`;
  await put(`client-sessions/${agent}`, header(agent));
  await put(`client-sessions/index/carol/${agent}`, { id: agent });
  const journal = storage.log<unknown>(`client-sessions/${agent}.journal`);
  journal.append({ t: "request", record: { id: "before-migration", method: "execute", fingerprint: "f", state: "completed", startedAt: now - 300, endedAt: now - 200, outcome: { result: { output: ["kept"] } } } });
  await journal.flush(true);
  await journal.close();
  const revoked = `client_${randomBytes(20).toString("hex")}`;
  await put(`client-sessions/${revoked}`, header(revoked, { revoked: true }));
  // Version 2 headers carried their requests inline; the migration moves them to the journal.
  const older = `client_${randomBytes(20).toString("hex")}`;
  const { version: _version, ...v3 } = header(older);
  await put(`client-sessions/${older}`, { ...v3, version: 2, cursor: 5, events: [], calls: {},
    requests: { inline: { id: "inline", method: "prompt", fingerprint: "g", state: "completed", startedAt: now - 900, endedAt: now - 800, outcome: { result: { reply: "hi" } } } } });

  const schedule = { id: randomUUID(), agent, tenant: "carol", text: "Check in", dueAt: now + 86_400_000, everySeconds: 3600, createdAt: now - 100 };
  await put(`schedules/${agent}/${schedule.id}`, schedule);
  await put(`timers/000000000000/${agent}.${schedule.id}`, { agent, id: schedule.id, dueAt: schedule.dueAt });

  const channel = id("ch", 10);
  await put(`channels/${channel}`, {
    id: channel, tenant: "carol", type: "telegram", name: "Support bot", webhookUrl: `https://agents.example.test/channels/telegram/${channel}`,
    template: { systemPrompt: "Be brief." }, access: { public: false, allow: ["@ada"] }, limits: { perSenderPerMinute: 10, turnsPerDay: 1000 },
    account: { id: "123", username: "fixture_bot" }, masked: { botToken: "123…XYZ" },
    sealed: sealer.seal(`channel:${channel}`, JSON.stringify({ credentials: { botToken: "123:secret" }, secret: "webhook-secret" })), createdAt: now - 50, updatedAt: now - 50,
  });
  await put(`channel-index/carol/${channel}`, {});
  await put(`channel-conversations/${channel}/42`, { agent, generation: 0 });
  await put(`channel-agents/${agent}`, { channel, tenant: "carol", conversationId: "42" });
  await put(`channel-seen/${channel}/${sha("17").slice(0, 40)}`, { at: now - 10 });
  await put(`channel-items/out_later`, { id: "out_later", channel, tenant: "carol", conversationId: "42", createdAt: now, state: "sending", text: "later", sent: 0, attempts: 1, due: now + 86_400_000, claim: { node: "http://dead", until: now } });

  const volume = id("vol", 12), snapshot = id("snap", 8);
  const content = Buffer.from("migrated contents");
  await storage.writeBlob(`chunks/carol/${sha(content).slice(0, 2)}/${sha(content)}`, content);
  const entry = { version: 1, size: content.length, chunks: [sha(content)], updatedAt: now - 30 };
  const tree = storage.log<unknown>(`volumes/${volume}/tree`);
  tree.append({ t: "put", seq: 1, path: "/notes.md", entry });
  await tree.flush(true);
  await tree.close();
  await put(`volumes/${volume}`, { version: 1, id: volume, tenant: "carol", name: "docs", createdAt: now - 40 });
  await put(`volumes/index/carol/${volume}`, { id: volume, name: "docs", createdAt: now - 40 });
  await put(`volumes/${volume}/snapshots/${snapshot}`, { id: snapshot, volume, name: "first", seq: 1, createdAt: now - 20, files: 1, bytes: content.length });
  await put(`volumes/${volume}/snapshot-files/${snapshot}`, { "/notes.md": entry });
  await put(`volumes/${volume}/watchers/${agent}`, { agent, tenant: "carol", mounts: [{ path: "/docs", subpath: "/" }] });
  await put(`leases/${agent}`, { agent, owner: "http://dead", epoch: 4, expiresAt: now });

  return { now, model, secret, token, agent, older, schedule, channel, volume, snapshot };
}

test("coordination documents from the storage layout move into Postgres once, and the runtime serves them", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { db, url } = await testDatabase();
  const secretsKey = randomBytes(32).toString("hex");
  const sealer = new Accounts({ tenants: new Tenants({ legacyToken: "unused-legacy-token-24-chars" }), db, secretsKey });
  const storage = fileStorage(root);
  const put = (key: string, value: unknown) => writeDurableJson(join(root, `${key}.json`), value);
  const { now, model, secret, token, agent, older, schedule, channel, volume, snapshot } = await writeLegacyLayout(put, storage, sealer);

  const documents = await readLegacyDocuments({ kind: "file", root });
  assert.deepEqual((await planCoordination(documents, storage)).counts, EXPECTED);
  assert.deepEqual(await migrateCoordination(documents, db, storage), EXPECTED);
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

test("--dry-run reports the rows the documents would become and writes nothing", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-migrate-dry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { db, url } = await testDatabase({ migrate: false });
  const sealer = new Accounts({ tenants: new Tenants({ legacyToken: "unused-legacy-token-24-chars" }), db, secretsKey: randomBytes(32).toString("hex") });
  const { older } = await writeLegacyLayout((key, value) => writeDurableJson(join(root, `${key}.json`), value), fileStorage(root), sealer);
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/migrate-coordination.ts", import.meta.url)), "--dry-run"],
    { env: { PATH: process.env.PATH, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: url } });
  const report = JSON.parse(stdout);
  assert.equal(report.type, "coordination_dry_run");
  assert.deepEqual(report.rows, EXPECTED);
  assert.equal((await db.query("select count(*) as count from information_schema.tables where table_schema = current_schema()")).rows[0].count, 0, "not even the schema was created");
  assert.equal(await fileStorage(root).hasLog(`client-sessions/${older}.journal`), false, "nor the converted journal");
});

// Set AGENT_TEST_S3_BUCKET (and AWS credentials) to read the layout the S3 backend wrote from a real bucket.
test("coordination documents move from S3 objects, in the key layout the S3 backend wrote", { skip: !process.env.AGENT_TEST_S3_BUCKET, timeout: 120_000 }, async t => {
  const { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const { s3Storage } = await import("../shared/s3-storage.ts");
  const bucket = process.env.AGENT_TEST_S3_BUCKET!, region = process.env.AWS_REGION ?? "us-west-2", prefix = `tests/migrate-${randomUUID()}`;
  const client = new S3Client({ region });
  t.after(async () => {
    for (let token: string | undefined, first = true; first || token; first = false) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
      if (page.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })), Quiet: true } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    }
  });
  const { db } = await testDatabase();
  const sealer = new Accounts({ tenants: new Tenants({ legacyToken: "unused-legacy-token-24-chars" }), db, secretsKey: randomBytes(32).toString("hex") });
  const storage = s3Storage({ bucket, prefix, region, client });
  const put = async (key: string, value: unknown) => { await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}.json`, Body: JSON.stringify(value), ContentType: "application/json" })); };
  const { agent, older, volume, snapshot, token } = await writeLegacyLayout(put, storage, sealer);

  const documents = await readLegacyDocuments({ kind: "s3", bucket, prefix, region });
  assert.ok(documents.has(`client-sessions/${agent}`) && documents.has(`volumes/${volume}/snapshot-files/${snapshot}`));
  assert.equal([...documents.keys()].some(key => key.startsWith("leases/") || key.startsWith("timers/")), false, "only coordination prefixes are read");
  assert.deepEqual((await planCoordination(documents, storage)).counts, EXPECTED);
  assert.deepEqual(await migrateCoordination(documents, db, storage), EXPECTED);
  assert.ok(Object.values(await migrateCoordination(documents, db, storage)).every(count => count === 0), "a second run inserts nothing");

  assert.equal((await db.query("select tenant from api_tokens where sha256 = $1", [token.sha256])).rows[0].tenant, "carol");
  assert.equal((await db.query("select header from agents where id = $1", [agent])).rows[0].header.id, agent);
  assert.deepEqual((await storage.log<any>(`client-sessions/${older}.journal`).read()).map(record => record.record.id), ["inline"], "the version 2 journal was written to S3");
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from((await storage.readBlob(`volumes/${volume}/snapshots/${snapshot}`))!).toString())), ["/notes.md"], "the snapshot file map is a blob now");
});
