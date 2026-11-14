import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("mount preparation follows owner checks and an upsert preserves mounts read under the directory lock", { timeout: 90_000 }, async t => {
  const aliceToken = "fixture-alice-token-at-least-32-characters";
  const bobToken = "fixture-bob-token-at-least-32-characters";
  const f = await startFixture({ entrypoint:fileURLToPath(new URL("./camelfs-worker.ts",import.meta.url)),
    tenant: "alice", token: aliceToken,
    tenants: [{ id: "alice", token: aliceToken }, { id: "bob", token: bobToken }],
  });
  t.after(() => f.stop());
  const call = async (path: string, options: { method?: string; body?: unknown; token?: string; key?: string } = {}) => {
    const response = await fetch(f.url + path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${options.token ?? aliceToken}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const rejected=await call('/v1/agents',{body:{mounts:[{volumeId:'vol_'+ 'a'.repeat(24),path:'/workspace',mode:'rw'}]}});
  assert.equal(rejected.status,400);
  assert.equal(rejected.body.error,'Volumes are replaced by repos: mount { repo }');
  const created = await call("/v1/agents", { key: "owned", body: { mounts: [{ workspace: false }] } });
  assert.equal(created.status, 201, JSON.stringify(created));
  const unknown = { repo: `repo_${"f".repeat(24)}`, path: "/foreign", mode: "rw" };
  const foreign = await call("/v1/agents", { token: bobToken, key: created.body.id, body: { mounts: [unknown] } });
  assert.equal(foreign.status, 403, "ownership is checked before the missing-volume lookup");
  assert.equal((await f.db.query("select count(*)::int n from volumes where tenant='bob'")).rows[0].n, 0);
  assert.equal((await call(`/v1/agents/${created.body.id}`, { method: "DELETE" })).status, 200);
  const revoked = await call("/v1/agents", { key: created.body.id, body: { mounts: [unknown] } });
  assert.equal(revoked.status, 410, "revocation is checked before preparing mounts");

  const a = await call("/v1/repos", { body: { name: "a" } });
  const b = await call("/v1/repos", { body: { name: "b" } });
  const watcher = await call('/v1/agents', { key:'repo-watcher', body:{mounts:[{repo:a.body.id,path:'/memory',subpath:'/safe',mode:'ro',notify:true},{workspace:false}]} });
  assert.equal(watcher.status,201,JSON.stringify(watcher));
  const changed=await call(`/v1/repos/${a.body.id}/commit`,{body:{files:{'safe/note.txt':{text:'new memory'},'private.txt':{text:'hidden'}},message:'notify watcher'}});
  assert.equal(changed.status,200,JSON.stringify(changed));
  const notificationId=`repo-${a.body.id}-${changed.body.version}-/memory`;
  const notificationPath = `/v1/agents/${watcher.body.id}/requests/${notificationId}?wait=20`;
  const deadline = Date.now() + 20_000;
  let notified = await call(notificationPath);
  while (notified.body.state !== 'completed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    notified = await call(notificationPath);
  }
  assert.equal(notified.body.state,'completed',JSON.stringify(notified));
  const watcherHistory=(await call(`/v1/agents/${watcher.body.id}/history`)).body;
  assert.match(JSON.stringify(watcherHistory),/Files changed in a mounted volume/);
  assert.match(JSON.stringify(watcherHistory),/\/memory\/note.txt/);
  assert.doesNotMatch(JSON.stringify(watcherHistory),/private.txt/);
  assert.equal((await call(`/v1/agents/${watcher.body.id}`,{method:'DELETE'})).status,200);
  const mounted = await call("/v1/agents", { key: "preserve-mounts", body: { mounts: [{ repo: a.body.id, path: "/shared", mode: "rw" }, { workspace: false }] } });
  assert.equal(mounted.status, 201, JSON.stringify(mounted));
  const id = mounted.body.id;
  const lock = await f.db.connect();
  await lock.query("begin");
  try {
    await lock.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [id]);
    const updating = call("/v1/agents", { key: "preserve-mounts", body: { name: "renamed" } });
    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await f.db.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory') waiting")).rows[0].waiting;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting, "the competing upsert reached the directory lock");
    const latestMounts = [{ repo: b.body.id, path: "/latest", mode: "ro" }];
    await lock.query("update agents set header=jsonb_set(header::jsonb,'{config,mounts}',$2::jsonb) where id=$1", [id, JSON.stringify(latestMounts)]);
    await lock.query("commit");
    const updated = await updating;
    assert.equal(updated.status, 201, JSON.stringify(updated));
    assert.deepEqual((await call(`/v1/agents/${id}/mounts`)).body, latestMounts);
    const stored = (await f.db.query("select header from agents where id=$1", [id])).rows[0].header;
    assert.deepEqual(stored.config.mounts, latestMounts);
    assert.equal(stored.config.name, "renamed");
  } finally {
    await lock.query("rollback");
    lock.release();
  }
});
