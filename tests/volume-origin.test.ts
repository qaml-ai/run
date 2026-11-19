import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import pg from "pg";
import { AgentRuntime } from "../clients/node.ts";
import { memoryStorage } from "../shared/storage.ts";
import { Accounts } from "../src/accounts.ts";
import { FileLinks } from "../src/files.ts";
import { internalRequests } from "../src/internal-requests.ts";
import { postgresTail } from "../src/log-tail.ts";
import { StorageUsage } from "../src/storage-usage.ts";
import { Tenants } from "../src/tenants.ts";
import { Ownership } from "../src/ownership.ts";
import { clusterVolumes, VOLUME_ORIGIN_HEADER, volumeApp } from "../src/volume-app.ts";
import ingress, { fetchLegacyApi } from "../v2/ingress/index.ts";
import { testDatabase } from "./database.ts";

const sessionSecret = "separate fixture session secret";
const originToken = "separate fixture volume origin token";

test("volume origin with scoped SQL access takes over and rolls back existing drafts, versions, and receipts", async t => {
  const { db, url, schema } = await testDatabase();
  const role = `${schema}_volumes`;
  const password = randomUUID();
  await db.query(`create role ${role} login password '${password}'`);
  const login = new URL(url);
  login.username = role;
  login.password = password;
  const scopedDb = new pg.Pool({ connectionString: login.toString(), max: 4 });
  t.after(async () => {
    await scopedDb.end();
    await db.query(`drop owned by ${role}`);
    await db.query(`drop role ${role}`);
  });
  await db.query(`
    grant usage on schema public to ${role};
    grant select on tenants, api_tokens, account_deletions, console_sessions, agents,
      credit_accounts, credit_spend_minutes, billing_disputes, billing_jobs to ${role};
    grant select, insert, update on actor_owners, volumes, chunk_touches, storage_usage to ${role};
    grant select, insert, update, delete on runtime_nodes, volume_snapshots, idempotency_keys to ${role};
    grant select, insert, delete on log_records to ${role};
    grant select, delete on volume_watchers to ${role};
    grant insert on storage_gc to ${role};
  `);
  const objects = { logs: new Map<string, Map<string, string>>(), blobs: new Map<string, Uint8Array>() };
  const links = new FileLinks(sessionSecret, "https://run.camelai.test");
  const tokenSha256 = (token: string) => createHash("sha256").update(token).digest("hex");
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {
    bots: { tokenSha256: tokenSha256("bots-operator"), billing: "prepaid" },
    outsider: { tokenSha256: tokenSha256("outsider-operator") },
  } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants });
  const { token } = await accounts.createToken("bots", "existing drafts API key");
  await db.query("insert into credit_accounts (tenant, balance) values ('bots', 1000)");
  const auth = (apiKey = token) => new Headers({ authorization: `Bearer ${apiKey}`, [VOLUME_ORIGIN_HEADER]: originToken });
  const consoleAuth = { principal: async () => undefined, allowsMutation: () => false };

  async function start(volumeOnly: boolean) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const node = `http://127.0.0.1:${address.port}`;
    const nodeDb = volumeOnly ? scopedDb : db;
    const nodeAccounts = new Accounts({ db: nodeDb, tenants, flushReceipts: !volumeOnly });
    const storageUsage = new StorageUsage(nodeDb);
    const storage = memoryStorage(postgresTail(nodeDb), storageUsage.meter, objects);
    const ownership = new Ownership(nodeDb, { node, volumeOnly, alive: volumeOnly ? async () => false : undefined });
    const volumes = clusterVolumes({
      ownership, db: nodeDb, storage, sessionSecret,
      quota: async tenant => {
        const limit = await nodeAccounts.billing.storageLimit(tenant);
        return limit === undefined ? undefined : { limit, used: await storageUsage.tenantUsed(tenant) };
      },
    });
    const app = volumeApp({ accounts: nodeAccounts, consoleAuth, volumes, links, sessionSecret, originToken });
    server.on("request", getRequestListener(app.fetch));
    await ownership.start();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await volumes.close();
      await storageUsage.flush();
      await ownership.close();
    })();
    const call = (path: string, init?: RequestInit) => fetch(node + path, { ...init, headers: { ...Object.fromEntries(auth()), ...init?.headers } });
    return { node, ownership, call, close };
  }

  const legacy = await start(false);
  const origin = await start(true);
  try {
    await assert.rejects(scopedDb.query("update agents set revoked = true"), /permission denied/);
    assert.equal((await origin.call("/healthz")).status, 200);
    const latePeer = "http://127.0.0.1:1";
    await db.query("insert into runtime_nodes (node, session, expires_at) values ($1, $2, now() + interval '30 seconds')", [latePeer, randomUUID()]);
    assert.deepEqual(await origin.ownership.reap(), [], "the volume node leaves agent peer heartbeats alone");
    assert.equal((await db.query("delete from runtime_nodes where node = $1", [latePeer])).rowCount, 1);
    assert.equal(await legacy.ownership.peer(), undefined, "do not route new agent work to the volume origin");
    assert.equal(await origin.ownership.peer(), legacy.node);
    await assert.rejects(origin.ownership.acquire(`client_${"a".repeat(40)}`), /can only own volumes/);
    const create = await legacy.call("/v1/volumes", { method: "POST", body: '{"name":"draft","key":"bot-a"}' });
    assert.equal(create.status, 201, await create.clone().text());
    const { id } = await create.json();
    const volume = `/v1/volumes/${id}`;
    const file = `${volume}/files/src/package.json`;
    const first = await legacy.call(file, { method: "PUT", body: "old", headers: { "if-none-match": "*" } });
    assert.equal(first.status, 201, await first.clone().text());
    const fileVersion = (await first.json()).version;
    assert.equal(await origin.ownership.owner(id), legacy.node);
    assert.equal((await fetch(origin.node + file, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(origin.node + file, { headers: auth("outsider-operator") })).status, 404);
    assert.equal((await fetch(`${origin.node}/internal/volumes/${id}/ops`, { method: "POST", body: '{"tenant":"bots","op":"delete","args":{}}' })).status, 401);

    const pending = await Promise.all([
      legacy.call(file, { method: "PUT", body: "old worker", headers: { "if-match": String(fileVersion) } }),
      origin.call(file, { method: "PUT", body: "new origin", headers: { "if-match": String(fileVersion) } }),
    ]);
    assert.deepEqual(pending.map(res => res.status).sort(), [201, 412], (await Promise.all(pending.map(res => res.text()))).join("\n"));
    const before = await (await origin.call(file)).text();
    const makeSnapshot = { method: "POST", body: '{"name":"published","pinned":true}', headers: { "idempotency-key": "draft-publish" } };
    const snapshotResponse = await legacy.call(`${volume}/snapshots`, makeSnapshot);
    assert.equal(snapshotResponse.status, 201, await snapshotResponse.clone().text());
    const snapshot = await snapshotResponse.json();

    await legacy.close();
    origin.ownership.forget(id);
    const ingressEnv = {
      V2: { fetch: async () => { throw new Error("volume request was misrouted to the v2 agent runtime"); } },
      LEGACY_VOLUMES: {
        fetch: (request: Request, init?: RequestInit) => {
          const publicUrl = new URL(request.url);
          return fetch(new Request(origin.node + publicUrl.pathname + publicUrl.search, request), init);
        },
      },
      LEGACY_VOLUMES_ORIGIN_TOKEN: originToken,
    };
    const apiUrl = "https://run.camelai.com";
    const draft = new AgentRuntime({
      url: apiUrl, apiKey: token,
      fetch: (input, init) => ingress.fetch(new Request(input, init), ingressEnv),
    });
    try {
      const got = await draft.volume(id).read("src/package.json");
      assert.equal(new TextDecoder().decode(got.data), before);
      const edit = await origin.call(file, { method: "PUT", body: "after takeover", headers: { "if-match": String(got.version) } });
      assert.equal(edit.status, 201, await edit.clone().text());
      assert.equal(await origin.ownership.owner(id), origin.node);
      assert.equal(await (await fetchLegacyApi(new Request(apiUrl + file, { headers: { authorization: `Bearer ${token}` } }), ingressEnv)).text(), "after takeover");
      const link = await draft.volume(id).link("src/package.json");
      const download = await ingress.fetch(new Request(apiUrl + new URL(link.url).pathname), ingressEnv);
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "after takeover");
      assert.equal(await (await origin.call(`${file}?snapshot=${snapshot.id}`)).text(), before);
      const replay = await origin.call(`${volume}/snapshots`, makeSnapshot);
      assert.equal(replay.headers.get("idempotent-replayed"), "true");
      assert.deepEqual(await replay.json(), snapshot);

      // A still-active legacy agent writes to this actor through its ordinary signed peer protocol.
      const { signedPost } = internalRequests(sessionSecret);
      const peer = await signedPost(origin.node, `/internal/volumes/${id}/ops`, { tenant: "bots", op: "copy", args: { path: "/src/package.json", to: "/peer-edit" } });
      assert.equal(peer.status, 200, await peer.text());
    } finally {
      await origin.close();
    }
    const rollback = await start(false);
    try {
      assert.equal(await (await rollback.call(file)).text(), "after takeover");
      assert.equal(await (await rollback.call(`${volume}/files/peer-edit`)).text(), "after takeover");
      assert.equal(await (await rollback.call(`${file}?snapshot=${snapshot.id}`)).text(), before);
      const restored = await rollback.call(`${volume}/restore`, { method: "POST", body: JSON.stringify({ snapshot: snapshot.id }) });
      assert.equal(restored.status, 200, await restored.clone().text());
      assert.equal(await (await rollback.call(file)).text(), before);
    } finally { await rollback.close(); }
  } finally {
    await Promise.allSettled([legacy.close(), origin.close()]);
  }
});
