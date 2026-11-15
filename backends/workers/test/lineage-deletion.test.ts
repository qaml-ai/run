import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { repoSqliteStorage } from "./repo-sqlite-storage.ts";
import { hookTierServices, tierIdentity } from "./tier-env.ts";

const hooks = hookTierServices();
const { TenantAdmission } = await import("../src/tenant.ts");
const { deleteRepo } = await import("../src/repos/registry.ts");
hooks.deregister();

function fixture(t: TestContext) {
  const { storage, alarmWrites } = repoSqliteStorage(t);
  const { issuer, accounts } = tierIdentity();
  const env = {
    AGENT_PUBLIC_URL: issuer, CAMELFS_URL: "https://tier.test", accounts,
    TENANTS: { getByName: () => tenant },
  };
  const tenant = new TenantAdmission({ storage } as never, env);
  const deleteReplies: (Response | Error)[] = [];
  const deletes: string[] = [];
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (init.method === "GET" && url.pathname.endsWith("/refs")) return Response.json({ refs: [] });
    assert.equal(init.method, "DELETE");
    const lin = decodeURIComponent(url.pathname.split("/").at(-1)!);
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), `delete:${lin}`);
    deletes.push(lin);
    const reply = deleteReplies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? Response.json({ deleted: true });
  });
  return {
    tenant, storage, alarmWrites, deleteReplies, deletes,
    register(id: string, lineage = `t:${id}`, sourceId?: string) {
      tenant.registerRepo({ id, lineage, name: id, key: null, createdAt: now, deletedAt: null, bytes: 0, files: 0 }, sourceId);
    },
    pending: () => storage.sql.exec("SELECT * FROM lineage_deletions ORDER BY lineage").toArray().map(row => ({ ...row })),
    delete: (id: string) => deleteRepo(env as never, "t", id),
    now: () => now,
    advance: (ms: number) => { now += ms; },
    async fire() {
      await storage.deleteAlarm(); // Cloudflare consumes the alarm on delivery.
      await tenant.alarm();
    },
  };
}

const reply = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

test("the last tombstone and deletion row commit together", async t => {
  const f = fixture(t);
  f.register("source");
  f.register("fork", "t:source", "source");
  assert.equal(await f.tenant.markTierRepoDeleted("source", "t"), false);
  assert.deepEqual(f.pending(), []);
  assert.equal(await f.storage.getAlarm(), null);
  f.storage.sql.exec(`CREATE TRIGGER abort_deletion BEFORE INSERT ON lineage_deletions
    BEGIN SELECT RAISE(ABORT, 'cannot record deletion'); END`);
  await assert.rejects(f.tenant.markTierRepoDeleted("fork", "t"), /cannot record deletion/);
  assert.equal(f.tenant.repoRow("fork")?.deletedAt, null);
  f.storage.sql.exec("DROP TRIGGER abort_deletion");
  assert.equal(await f.tenant.markTierRepoDeleted("fork", "t"), true);
  assert.equal(f.tenant.repoRow("fork")?.deletedAt, f.now());
  assert.deepEqual(f.pending(), [{ lineage: "t:source", tenant: "t", repo: "fork", attempts: 0, nextAt: f.now() + 30_000 }]);
  assert.equal(await f.storage.getAlarm(), f.now() + 30_000);
  assert.deepEqual(f.deletes, []);
  f.advance(30_000);
  await f.fire();
  assert.deepEqual(f.deletes, ["t:source"]);
  assert.deepEqual(f.pending(), []);
});

test("inline DELETE preserves its error and a repeat resumes from the tombstone", async t => {
  const f = fixture(t);
  f.register("repo");
  f.deleteReplies.push(reply(409, "held"));
  await assert.rejects(f.delete("repo"), { status: 409, code: "held" });
  assert.deepEqual(f.pending(), [{ lineage: "t:repo", tenant: "t", repo: "repo", attempts: 1, nextAt: f.now() + 30_000 }]);
  assert.equal(await f.storage.getAlarm(), f.now() + 30_000);
  assert.deepEqual(await f.delete("repo"), { deleted: true });
  assert.deepEqual(f.deletes, ["t:repo", "t:repo"]);
  assert.deepEqual(f.pending(), []);
  assert.equal(await f.storage.getAlarm(), null);
});

test("the alarm retries only due rows and caps the backoff", async t => {
  const f = fixture(t);
  f.register("first");
  f.register("second");
  f.deleteReplies.push(new DOMException("timed out", "TimeoutError"));
  await assert.rejects(f.delete("first"), { status: 502, code: "transport_error" });
  f.advance(5_000);
  await f.tenant.markTierRepoDeleted("second", "t");
  assert.equal(await f.storage.getAlarm(), f.now() + 25_000);
  f.advance(25_000);
  f.deleteReplies.push(reply(503, "unavailable"));
  await f.fire();
  assert.deepEqual(f.deletes, ["t:first", "t:first"]);
  assert.deepEqual(f.pending()[0], { lineage: "t:first", tenant: "t", repo: "first", attempts: 2, nextAt: f.now() + 60_000 });
  assert.equal(await f.storage.getAlarm(), f.now() + 5_000);
  f.advance(5_000);
  await f.fire();
  assert.equal(f.deletes.at(-1), "t:second");
  assert.equal(await f.storage.getAlarm(), f.now() + 55_000);
  f.advance(55_000);
  for (const delay of [120_000, 240_000, 480_000, 600_000, 600_000]) {
    f.deleteReplies.push(reply(503, "unavailable"));
    await f.fire();
    assert.equal(await f.storage.getAlarm(), f.now() + delay);
    f.advance(delay);
  }
  await f.fire();
  assert.deepEqual(f.pending(), []);
  assert.equal(await f.storage.getAlarm(), null);
  const writes = f.alarmWrites();
  await f.tenant.alarm();
  assert.equal(f.alarmWrites(), writes);
});

test("410 lineage_deleted and 404 not_found complete deletion inline and on alarm", async t => {
  const f = fixture(t);
  for (const [status, code] of [[410, "lineage_deleted"], [404, "not_found"]] as const) {
    f.register(`inline-${status}`);
    f.register(`alarm-${status}`);
    f.deleteReplies.push(reply(status, code));
    assert.deepEqual(await f.delete(`inline-${status}`), { deleted: true });
    assert.deepEqual(f.pending(), []);
    await f.tenant.markTierRepoDeleted(`alarm-${status}`, "t");
    f.deleteReplies.push(reply(status, code));
    f.advance(30_000);
    await f.fire();
    assert.deepEqual(f.pending(), []);
    assert.equal(await f.storage.getAlarm(), null);
  }
});

test("account purge preserves pending work and succeeds once the tier confirms deletion", async t => {
  const f = fixture(t);
  f.register("repo");
  await f.tenant.markTierRepoDeleted("repo", "t");
  const pending = f.pending();
  await assert.rejects(f.tenant.purgeAccountData(), /pending lineage deletions/);
  assert.deepEqual(f.pending(), pending);
  assert.equal(await f.storage.getAlarm(), f.now() + 30_000);
  f.advance(30_000);
  await f.fire();
  await f.tenant.purgeAccountData();
  assert.equal(f.tenant.repoRow("repo"), null);
  assert.deepEqual(f.pending(), []);
});
