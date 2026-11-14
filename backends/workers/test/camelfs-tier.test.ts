import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { handleCamelfsNotify, stageRepoMove, drainRepoMoves, type NotifyEnv, type RefMove } from "../src/camelfs/notify.ts";
import { TenantRepos } from "../src/repos/tenant-repos.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers')
    return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil=p=>p;', shortCircuit: true };
  if (specifier.endsWith("/security-services.ts"))
    return { url: "data:text/javascript,export const keyServices=async env=>({accounts:env.accounts});", shortCircuit: true };
  return next(specifier, context);
} });
const { runtimeSigner, runtimeJwks } = await import("../src/tool-identity.ts");
const { HttpRepoClient } = await import("../src/repos/http-client.ts");
const { createRepo, deleteRepo } = await import("../src/repos/registry.ts");
const { handleCamelfsSmoke } = await import("../src/camelfs/smoke.ts");
const { prepareMounts } = await import("../src/repos/mounts.ts");
const { repoTransportFailure } = await import("../src/repos/routes.ts");
const { TierError } = await import("../src/camelfs/tier.ts");
hooks.deregister();

test("runtime JWKS, repo HTTP methods, idempotency, quota and admin smoke against the strict tier", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "EdDSA" };
  const issuer = "https://run-pilot.camelai.dev";
  let beforeMove: (() => Promise<void>) | undefined;
  const fake = await serveFakeCamelfsd("old-token", {
    issuer, jwks: { keys: [jwk] },
    beforeWriteMove: async () => { const hook = beforeMove; beforeMove = undefined; await hook?.(); },
  });
  t.after(() => fake.close());
  const env = {
    AGENT_PUBLIC_URL: issuer, CAMELFS_URL: fake.url, ADMIN_TENANTS: "t",
    HYPERDRIVE: { connectionString: "" },
    accounts: {
      canStoreKeys: true,
      db: { query: async () => ({ rows: [{ kid: jwk.kid, public_jwk: jwk, retired_at: null }] }) },
      unseal: () => JSON.stringify(privateKey.export({ format: "jwk" })),
    },
  };
  const signer = await runtimeSigner(env, "https://fallback.example");
  assert.equal(signer.issuer, env.AGENT_PUBLIC_URL);
  const token = await signer.camelfsToken({ sub: "agent:caller", lin: "t:repo_r3", acc: "r" });
  const keys = createLocalJWKSet(await runtimeJwks(env));
  const options = { issuer, audience: "camelrun:camelfs", algorithms: ["EdDSA"], typ: "camelfs+jwt" };
  const { payload } = await jwtVerify(token, keys, options);
  assert.equal(payload.exp! - payload.iat!, 300);
  await assert.rejects(jwtVerify(token, keys, { ...options, typ: "file+jwt" }));
  await assert.rejects(jwtVerify(token, keys, { ...options, audience: "camelrun:file" }));

  const calls: { path: string; method: string; claims: ReturnType<typeof decodeJwt>; token: string }[] = [];
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization")!;
    assert.match(authorization, /^Bearer ey/);
    const jwt = authorization.slice(7);
    calls.push({ path: new URL(url as URL).pathname, method: init?.method ?? "GET", claims: decodeJwt(jwt), token: jwt });
    return fetchReal(url, init);
  };
  t.after(() => { globalThis.fetch = fetchReal; });
  const request = () => new Request("https://runtime/v1/internal/camelfs/smoke", { method: "POST" });
  const auth = { tenantId: "t", scopes: ["*"] };
  assert.equal((await handleCamelfsSmoke(request(), { ...env, CAMELFS_URL: undefined }, auth)).status, 404);
  assert.equal((await handleCamelfsSmoke(request(), env, { ...auth, scopes: [] })).status, 403);
  const response = await handleCamelfsSmoke(request(), env, auth);
  const smoke = await response.json() as { lineage: string; ok: boolean; timings: Record<string, number> };
  assert.equal(response.status, 200, JSON.stringify(smoke));
  assert.equal(smoke.ok, true);
  assert.match(smoke.lineage, /^smoke:/);
  assert.deepEqual(Object.keys(smoke.timings), ["putBlob", "commit", "readBatch", "getCommit"]);
  assert.deepEqual(calls.map(c => [c.method, c.claims.lin, c.claims.acc, c.claims.sub, c.claims.refs]), [
    ["PUT", smoke.lineage, "w", "runtime:camelfs-smoke", []],
    ["POST", smoke.lineage, "w", "runtime:camelfs-smoke", []],
    ["POST", smoke.lineage, "r", "runtime:camelfs-smoke", []],
    ["GET", smoke.lineage, "r", "runtime:camelfs-smoke", []],
  ]);

  const { camelfsStorage } = await import("../src/repos/storage.ts");
  const row = { id: "repo_r3", name: "r3", key: null, createdAt: 1, deletedAt: null, lineage: "t:repo_r3", files: 0, bytes: 0 };
  const repo = new HttpRepoClient(env, "t", row, "agent:caller");
  const storage = camelfsStorage(env, "agent:caller");
  const meta = { author: "agent:caller", message: "test", time: 1763046000, trailers: { "Camel-Op": "api" } };
  await repo.prepareLineage();
  const foreign = new HttpRepoClient(env, "another", row, "api:another");
  await assert.rejects(foreign.prepareLineage(), { code: "lineage_conflict", status: 409, detail: { tenant: "t" } });
  const seed = await storage.commit(row.lineage, { ...meta, parents: [], changes: [] });
  await repo.init(seed.commit);
  assert.equal((await repo.info()).name, "r3");
  assert.equal((await repo.refs()).length, 1);
  assert.equal(await repo.ref("missing"), null);
  assert.equal((await repo.resolve(seed.commit)).tree, seed.tree);
  assert.equal((await repo.resolve("main")).version, seed.commit);
  assert.equal(await repo.commit("f".repeat(40)), null);
  const write = { ...meta, ref: "main", changes: [{ path: "probe", text: "hello", expectBlob: "none" }], expect: seed.commit, idempotencyKey: "write" };
  const moved = await repo.write(write);
  assert.deepEqual(await repo.write(write), moved);
  assert.equal(moved.changed.probe?.size, 5);
  await assert.rejects(repo.write({ ...write, quota: { limitBytes: 4, otherBytes: 0 }, changes: [{ path: "large", text: "larger" }], expect: moved.version, idempotencyKey: "quota" }), { code: "storage_limit", status: 507 });
  assert.equal((await repo.ref("main"))?.version, moved.version);
  await repo.createRef({ name: "job/test", from: "main" });
  const holder = { host: "host", boot: 1, mount: "mount" };
  const lease = await repo.acquire({ ref: "job/test", holder, ttlMs: 1000 });
  const fence = { ref: "job/test", holder, epoch: lease.epoch };
  await repo.renew(fence, 1000);
  await repo.cas({ ref: fence.ref, fence, expect: moved.version, commit: moved.version });
  assert.deepEqual(calls.at(-1)?.claims.fence, { holder: "host:1:mount", epoch: lease.epoch });
  assert.deepEqual(calls.at(-1)?.claims.refs, ["job/test"]);
  await assert.rejects(repo.delete(), { code: "held", status: 409, detail: { held: ["job/test"] } });
  await repo.release(fence);
  await repo.watch("job/test", "workflow:x");
  await repo.unwatch("job/test", "workflow:x");
  const ff = await repo.merge("job/test", { ...meta, theirs: moved.version!, mode: "ff-only" });
  assert.deepEqual(ff.merged, []);
  await repo.restore("job/test", { ...meta, version: seed.commit });
  await repo.deleteRef("job/test");
  assert.deepEqual(await repo.deleteOwned("agent:unused"), { deleted: [], held: [] });
  await repo.delete();
  await repo.deleteLineage("delete");
  await repo.deleteLineage("delete");
  await assert.rejects(repo.deleteLineage("new-delete"), { code: "lineage_deleted", status: 410 });
  await assert.rejects(repo.ref("main"), { code: "lineage_deleted", status: 410 });
  const another = { ...row, id: "repo_retry", lineage: "t:repo_retry" };
  const retry = new HttpRepoClient(env, "t", another, "agent:caller");
  await retry.prepareLineage();
  const retrySeed = await storage.commit(another.lineage, { ...meta, parents: [], changes: [] });
  await retry.createRef({ name: "main", from: { version: retrySeed.commit } });
  const repos = fixtureIndex(t);
  repos.register({ ...row, bytes: 5, files: 1 });
  repos.register({ ...row, id: "fork", bytes: 5, files: 1 });
  repos.register(another);
  assert.equal(repos.used(), 5);
  const fitted = await retry.write({
    ...meta, ref: "main", changes: [{ path: "fit", text: "fits" }],
    quota: { limitBytes: 9, otherBytes: repos.used(another.lineage) },
  });
  assert.equal(fitted.bytes, 4);
  assert.equal((await retry.ref("main"))?.version, fitted.version);
  let concurrentVersion: string | null = null;
  beforeMove = async () => { concurrentVersion = (await retry.write({ ...meta, ref: "main", changes: [{ path: "concurrent", text: "one" }] })).version; };
  const retried = await retry.write({ ...meta, ref: "main", changes: [{ path: "probe", text: "two", expectBlob: "none" }] });
  assert.equal(retried.previous, concurrentVersion);
  assert.equal((await retry.ref("main"))?.version, retried.version);
  await t.test("mount validation reports an unreachable tier as a transport error", async t => {
    const scoped = { ...env, TENANTS: { getByName: () => ({ repoRow: async () => row }) } } as unknown as Parameters<typeof prepareMounts>[0];
    const cause = new TypeError("connection refused");
    t.mock.method(globalThis, "fetch", async () => { throw cause; });
    const prepared = prepareMounts(scoped, "t", "caller", [
      { repo: row.id, path: "/workspace", mode: "ro", notify: true },
    ]);
    const error: unknown = await prepared.then(() => assert.fail("mount should fail"), error => error);
    assert.ok(error instanceof Error && error.cause instanceof TierError);
    assert.equal(error.cause.cause, cause);
    const failure = repoTransportFailure(error);
    assert.ok(failure);
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: "camel-fs tier unreachable", code: "transport_error", stage: "fetch" });
  });
  await t.test("tier fetch rejects redirects without forwarding tokens", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
      assert.equal(init.redirect, "manual");
      return Response.redirect("https://other.example", 307);
    });
    await assert.rejects(retry.ref("main"), { status: 502, code: "transport_error", reason: "camel-fs tier returned a redirect" });
    assert.equal(fetch.mock.callCount(), 1);
  });
  await t.test("repo deletion and owner cleanup stay within each namespace", async () => {
    const index = fixtureIndex(t);
    const scoped = { ...env, TENANTS: { getByName: () => ({
      registerRepo: index.register.bind(index),
      repoRow: index.row.bind(index),
      markTierRepoDeleted: index.markTierRepoDeleted.bind(index),
    }) } } as unknown as Parameters<typeof createRepo>[0];
    const source = (await createRepo(scoped, "t", { key: "source" })).info;
    const from = { repo: source.id };
    const first = (await createRepo(scoped, "t", { key: "first-fork", from })).info;
    const last = (await createRepo(scoped, "t", { key: "last-fork", from })).info;
    const [sourceRepo, firstFork, lastFork] = [source, first, last].map(
      ({ id }) => new HttpRepoClient(env, "t", index.row(id)!, "api:t"),
    );
    for (const repo of [sourceRepo, firstFork, lastFork]) {
      await repo.createRef({ name: "topic", from: "main", owner: "agent:shared" });
    }
    assert.deepEqual(await firstFork.deleteOwned("agent:shared"), { deleted: ["topic"], held: [] });
    assert.equal(await firstFork.ref("topic"), null);
    assert.ok(await sourceRepo.ref("topic"));
    assert.ok(await lastFork.ref("topic"));
    assert.deepEqual(await sourceRepo.deleteOwned("agent:shared"), { deleted: ["topic"], held: [] });
    assert.ok(await lastFork.ref("topic"));

    await firstFork.createRef({ name: "z-topic", from: "main" });
    const forkLease = await firstFork.acquire({ ref: "main", holder, ttlMs: 60_000 });
    await assert.rejects(deleteRepo(scoped, "t", first.id), { status: 409, code: "held", detail: { held: ["main"] } });
    assert.equal(index.row(first.id)?.deletedAt, null);
    assert.ok(await firstFork.ref("z-topic"));
    await firstFork.release({ ref: "main", holder, epoch: forkLease.epoch });

    await deleteRepo(scoped, "t", first.id);
    assert.equal(await firstFork.ref("main"), null);
    assert.equal(await firstFork.ref("z-topic"), null);
    assert.ok(await sourceRepo.ref("main"));
    assert.ok(await lastFork.ref("main"));
    assert.equal(index.row(source.id)?.deletedAt, null);
    assert.equal(index.row(last.id)?.deletedAt, null);

    await deleteRepo(scoped, "t", source.id);
    assert.equal(await sourceRepo.ref("main"), null);
    assert.ok(await lastFork.ref("main"));
    assert.equal(index.row(last.id)?.deletedAt, null);

    await deleteRepo(scoped, "t", last.id);
    await assert.rejects(lastFork.ref("main"), { status: 410, code: "lineage_deleted" });
    assert.ok(index.row(last.id)?.deletedAt);
    await deleteRepo(scoped, "t", last.id);

    const recovery = (await createRepo(scoped, "t", { key: "recovery" })).info;
    const recoveryRepo = new HttpRepoClient(env, "t", index.row(recovery.id)!, "api:t");
    await recoveryRepo.delete();
    assert.equal(index.markTierRepoDeleted(recovery.id), true);
    await recoveryRepo.deleteLineage("external-delete");
    await deleteRepo(scoped, "t", recovery.id);
  });
  assert.equal(new Set(calls.map(c => c.token)).size, calls.length);
  for (const call of calls.filter(c => c.path.includes("repo_r3"))) {
    assert.equal(call.claims.lin, row.lineage);
    assert.equal(call.claims.acc, call.method === "GET" ? "r" : "w");
    const service = /\/lease(?:\/renew)?$/.test(call.path) ? "runtime:repo-leases"
      : call.path.includes("/watchers/") ? "runtime:repo-watchers"
        : call.path.endsWith(encodeURIComponent(row.lineage)) && call.method === "DELETE" ? "runtime:repo-delete" : call.claims.sub === "api:another" ? "api:another" : "agent:caller";
    assert.equal(call.claims.sub, service, call.path);
  }
});

test("notify requires a fresh signature and type, and records each watcher's delivery once", async () => {
  const key = "test-notify-key", now = 1763046000000;
  const inboxes = new Map<string, Map<string, unknown>>();
  async function stage(watcher: string, move: RefMove) {
    const rows = inboxes.get(watcher) ?? new Map();
    inboxes.set(watcher, rows);
    const storage = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => fn(storage),
      get: async (name: string) => rows.get(name),
      put: async (name: string, value: unknown) => { assert.equal(rows.has(name), false); rows.set(name, value); },
      delete: async (name: string) => rows.delete(name),
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([name]) => name.startsWith(prefix))),
      getAlarm: async () => null, setAlarm: async () => {},
    } as unknown as DurableObjectStorage;
    await stageRepoMove(storage, move);
    await drainRepoMoves(storage, async moves => assert.equal(moves.length, 1));
  }
  const env = {
    CAMELFS_NOTIFY_KEY: key,
    AGENTS: { getByName: (id: string) => ({ stageRepoMove: (move: RefMove) => stage("agent:" + id, move) }) },
    WORKFLOWS: { getByName: (id: string) => ({ stageRepoMove: (move: RefMove) => stage("workflow:" + id, move) }) },
  } as unknown as NotifyEnv;
  const body = { type: "ref.moved", id: "one", lineage: "t:repo", ref: "main", from: null, to: "v", tree: "t", by: "api:t", at: now, watchers: ["agent:alice", "workflow:wf"] };
  async function notify(time: number, payload = body, sign = key) {
    const raw = JSON.stringify(payload, null, 2), ts = time / 1000;
    const signature = createHmac("sha256", sign).update(ts + "." + raw).digest("hex");
    const request = new Request("https://runtime/v1/internal/camelfs/notify", {
      method: "POST", body: raw, headers: { "Camel-Signature": `t=${ts},v1=${signature}` },
    });
    return (await handleCamelfsNotify(request, env, now)).status;
  }
  assert.equal(await notify(now, body, "wrong"), 401);
  assert.equal(await notify(now - 301_000), 401);
  assert.equal(await notify(now + 6000), 401);
  assert.equal(await notify(now, { ...body, type: "unknown" }), 400);
  assert.equal(await notify(now, { ...body, type: undefined! }), 400);
  assert.equal(await notify(now), 204);
  assert.equal(await notify(now), 204);
  assert.deepEqual([...inboxes.keys()], ["agent:alice", "workflow:wf"]);
  assert.ok([...inboxes.values()].every(rows => rows.size === 1 && rows.has("camelfs:seen:one")));
});

function fixtureIndex(t: import("node:test").TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const storage = {
    transactionSync: (fn: () => unknown) => fn(),
    sql: { exec(sql: string, ...params: string[]) {
      const stmt = db.prepare(sql);
      return { toArray: () => stmt.all(...params), one: () => stmt.get(...params), ...(!stmt.columns().length && stmt.run(...params)) };
    } },
  } as unknown as DurableObjectStorage;
  const repos = new TenantRepos(storage);
  return repos;
}
