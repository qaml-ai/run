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
  if (specifier.endsWith("/security-services.ts"))
    return { url: "data:text/javascript,export const keyServices=async env=>({accounts:env.accounts});", shortCircuit: true };
  return next(specifier, context);
} });
const { runtimeSigner, runtimeJwks } = await import("../src/tool-identity.ts");
const { HttpRepoClient } = await import("../src/repos/http-client.ts");
const { handleCamelfsSmoke } = await import("../src/camelfs/smoke.ts");
hooks.deregister();

test("runtime JWKS, repo HTTP methods, idempotency, quota and admin smoke against the strict tier", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "EdDSA" };
  const issuer = "https://run-pilot.camelai.dev";
  const fake = await serveFakeCamelfsd("old-token", { issuer, jwks: { keys: [jwk] } });
  t.after(() => fake.close());
  const env = {
    AGENT_PUBLIC_URL: issuer, CAMELFS_URL: fake.url, ADMIN_TENANTS: "t",
    CAMELFS_API_TOKEN: "old-token", CAMELFS: { fetch: () => assert.fail("legacy binding used") },
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
  const seed = await storage.commit(row.lineage, { ...meta, parents: [], changes: [] });
  await repo.init({ ...row, tenant: "t", seed: { version: { ...meta, version: seed.commit, tree: seed.tree, at: seed.time * 1000, parents: [] }, entries: [] } });
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
  await repo.createRef({ name: "job/test", from: "main", who: meta.author, why: "test" });
  const holder = { host: "host", boot: 1, mount: "mount" };
  const lease = await repo.acquire({ ref: "job/test", holder, ttlMs: 1000 });
  const fence = { ref: "job/test", holder, epoch: lease.epoch };
  await repo.renew(fence, 1000);
  await repo.cas({ ...fence, expect: moved.version, commit: (await repo.commit(moved.version!))!, who: meta.author, why: "test" });
  assert.deepEqual(calls.at(-1)?.claims.fence, { holder, epoch: lease.epoch });
  assert.deepEqual(calls.at(-1)?.claims.refs, ["job/test"]);
  await assert.rejects(repo.delete(), { code: "held", status: 409 });
  await repo.release(fence);
  await repo.watch("job/test", "workflow:x");
  await repo.unwatch("job/test", "workflow:x");
  await repo.merge("job/test", { ...meta, theirs: moved.version!, mode: "ff-only" });
  await repo.restore("job/test", { ...meta, version: seed.commit });
  await repo.deleteRef("job/test");
  assert.deepEqual(await repo.deleteOwned("agent:unused"), { deleted: [], held: [] });
  await repo.delete();
  await assert.rejects(repo.ref("main"), { code: "lineage_deleted", status: 410 });
  assert.equal(new Set(calls.map(c => c.token)).size, calls.length);
  for (const call of calls.filter(c => c.path.includes("repo_r3"))) {
    assert.equal(call.claims.lin, row.lineage);
    assert.equal(call.claims.acc, call.method === "GET" ? "r" : "w");
    const service = /\/lease(?:\/renew)?$/.test(call.path) ? "runtime:repo-leases"
      : call.path.includes("/watchers/") ? "runtime:repo-watchers"
        : call.path.endsWith(encodeURIComponent(row.lineage)) && call.method === "DELETE" ? "runtime:repo-delete" : "agent:caller";
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

test("quota counts each live lineage once and can exclude the caller's lineage", t => {
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
  for (const [id, lineage, bytes] of [["repo", "one", 5], ["fork", "one", 5], ["other", "two", 2]] as const)
    repos.register({ id, lineage, bytes, files: 1, name: id, key: null, createdAt: 1, deletedAt: null });
  assert.equal(repos.used(), 7);
  assert.equal(repos.used("two"), 5);
  assert.ok(repos.used("two") + 4 <= 9);
});
